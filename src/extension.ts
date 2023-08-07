import * as vscode from 'vscode';
import { AxiosResponse } from 'axios';
import { Configuration, OpenAIApi, CreateCompletionResponse } from "openai";
import {
	LanguageClient,
	LanguageClientOptions,
	PartialMessageInfo,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';
import { Disposable, ExtensionContext, workspace } from 'vscode';
import { WebSocket, Data as WebSocketData, MessageEvent, ErrorEvent } from 'ws';
import { Emitter, Event, MessageReader, MessageWriter, Message } from 'vscode-jsonrpc';

let client: LanguageClient;

const configName = 'sublimeSecurity.messageQueryLanguage';
const languageID = 'messageQueryLanguage';

class WebSocketMessageReader implements MessageReader {
	private errorEmitter = new Emitter<Error>();
	private closeEmitter = new Emitter<void>();
	private messageEmitter = new Emitter<Message>();

	constructor(private socket: WebSocket) {
		this.socket.on('message', data => this.handleData(data));
		this.socket.on('error', error => this.errorEmitter.fire(error));
		this.socket.on('close', () => this.closeEmitter.fire());
	}

	dispose(): void {
		this.messageEmitter.dispose();
		this.errorEmitter.dispose();
		this.closeEmitter.dispose();
	}

	private handleData(data: WebSocketData): void {
		this.messageEmitter.fire(JSON.parse(data.toString()));
	}

	get onError(): Event<Error> {
		return this.errorEmitter.event;
	}

	get onClose(): Event<void> {
		return this.closeEmitter.event;
	}

	get onPartialMessage(): Event<PartialMessageInfo> {
		return Event.None; // not handling partial messages in this example
	}

	listen(callback: (message: Message) => void): Disposable {
		return this.messageEmitter.event(message => callback(message));
	}
}

class WebSocketMessageWriter implements MessageWriter {
	private errorEmitter = new Emitter<[Error, Message | undefined, number | undefined]>();
	private closeEmitter = new Emitter<void>();

	constructor(private socket: WebSocket) {
		this.socket.on('error', error => this.errorEmitter.fire([error, undefined, undefined]));
		this.socket.on('close', () => this.closeEmitter.fire());
	}

	public end(): void {
		// throw new Error('Method not implemented.');
	}

	get onError(): Event<[Error, Message | undefined, number | undefined]> {
		return this.errorEmitter.event;
	}

	get onClose(): Event<void> {
		return this.closeEmitter.event;
	}

	public write(message: Message): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket.send(JSON.stringify(message), error => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	public dispose(): void {
		this.errorEmitter.dispose();
		this.closeEmitter.dispose();
		this.socket.close();
	}
}


function activateLanguageServer(context: ExtensionContext) {
	// The server is implemented in node
	const languageServerConfigName = configName + ".languageServer";
	const config = vscode.workspace.getConfiguration(languageServerConfigName);
	const serverEnabled = config.get('enabled');
	const serverHost = config.get('host');
	if (!serverEnabled || !serverHost) {
		return;
	}

	const serverURL = `wss://${config.get('host')}/v1/ws/language-server`;
	const serverAPIKey = config.get('apiKey');

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used

	const serverOptions: ServerOptions = async () => {
		const socket = new WebSocket(serverURL);


		// Wait until the socket is open
		await new Promise((resolve, reject) => {
			socket.on('open', resolve);
			socket.on('error', reject);
		});

		// Prepare for the authentication success message
		const authResponsePromise = new Promise<void>((resolve, reject) => {
			socket.once('message', (data: WebSocketData) => {
				const response = JSON.parse(data.toString());
				if (response.authenticated === true) {
					resolve();
				} else {
					vscode.window.showErrorMessage(`Unable to connect to language server at ${serverURL}: ${data.toString()}`);
					reject(new Error(response.message));
				}
			});
		});

		// Send the authentication message
		const authMessage = { token: serverAPIKey };
		socket.send(JSON.stringify(authMessage));

		// Wait for the authentication success message
		await authResponsePromise;

		const reader = new WebSocketMessageReader(socket);
		const writer = new WebSocketMessageWriter(socket);
		return { reader, writer };
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [
			{
				// all instances of MQL, not just saved files. this means scratch/unsaved files work too
				language: languageID
			}
		],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.mql')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		languageID,
		'Sublime Security - Message Query Language (MQL)',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

function deactivateLanguageServer(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

function getOpenAIClient(): OpenAIApi | undefined {
	const openAIConfigName = configName + ".openAI";
	const config = vscode.workspace.getConfiguration(openAIConfigName);
	const apiKey = config.get('apiKey');
	const completionModel = config.get('completionModel');
	const enabled = config.get('enabled');

	if (!enabled) {
		return;
	}

	if (!apiKey) {
		vscode.window.showWarningMessage(`OpenAI code completion currently disabled. No OpenAI API token found in the ${openAIConfigName}.apiKey setting or disable using the ${openAIConfigName}.enabled setting.`);
		return;
	}

	if (!completionModel) {
		vscode.window.showWarningMessage(`OpenAI code completion currently disabled. No completion model specified in the ${openAIConfigName}.completionModel setting.`);
		return;
	}

	return new OpenAIApi(new Configuration({
		apiKey: apiKey as string,
	}));
}

export function activateOpenAI(context: vscode.ExtensionContext) {
	let openAIClient: OpenAIApi | undefined = undefined;
	let loadedClient = false;

	vscode.workspace.onDidChangeTextDocument(handleTextDocumentChange, null, context.subscriptions);

	async function handleTextDocumentChange(event: vscode.TextDocumentChangeEvent) {
		const editor = vscode.window.activeTextEditor;
		if (editor && event.contentChanges.length > 0) {
			const contentChange = event.contentChanges.find(change => change.text.includes('\n'));

			if (contentChange) {
				const currentLine = contentChange.range.start.line;
				const line = editor.document.lineAt(currentLine);
				const comment = extractComment(line.text);

				if (comment) {
					// Lazily load the OpenAI client after commments are triggered
					if (!loadedClient) {
						loadedClient = true;
						openAIClient = getOpenAIClient();
					}

					if (!openAIClient) {
						return;
					}

					const mqlTranslation = await requestMqlTranslation(comment);

					if (mqlTranslation && mqlTranslation.length > 0) {
						// Insert translation on the next line
						const positionToInsert = new vscode.Position(currentLine + 1, 0);
						insertMqlTranslation(editor, mqlTranslation, positionToInsert);
					}
				}
			}
		}
	}

	function extractComment(lineText: string): string | null {
		const regex = /^\s*\/\/\s*(.+)$/;
		const match = lineText.match(regex);
		if (match && match[1]) {
			return match[1].trim();
		}
		return null;
	}

	async function requestMqlTranslation(comment: string): Promise<string> {
		return openAIClient
			.createCompletion({
				model: "curie:ft-sublime-security-2023-08-05-00-34-40",
				max_tokens: 128,
				temperature: 0.3,
				stop: ["\n"],
				prompt: `${comment.replace("'", "\"")} ->`,
			})
			.catch((err: any) => {
				vscode.window.showErrorMessage("Error fetching MQL translation: ", err);
			})
			.then((res) => {
				if (res && res.data && res.data.choices && res.data.choices.length > 0) {
					return res.data.choices[0].text.trim();
				} else {
					return "";
				}
			});
	}

	function insertMqlTranslation(editor: vscode.TextEditor, mqlTranslation: string, positionToInsert: vscode.Position) {
		editor.edit((editBuilder) => {
			editBuilder.insert(positionToInsert, mqlTranslation);
		});
	}
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivateOpenAI() { }


export function activate(context: vscode.ExtensionContext) {
	console.debug("activating nowzor");

	activateLanguageServer(context);
	activateOpenAI(context);
}

export function deactivate() {
	deactivateLanguageServer();
	deactivateOpenAI();
}