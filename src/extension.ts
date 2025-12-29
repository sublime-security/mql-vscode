import * as vscode from 'vscode';
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
import { createEmbeddedMQLMiddleware, setupEmbeddedMQL, cleanupEmbeddedMQL } from './embeddedMQL';

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
		documentSelector: [
			{
				language: languageID
			},
			{
				language: 'yaml'
			}
		],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.mql')
		},
		middleware: createEmbeddedMQLMiddleware()
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		languageID,
		'Sublime Security - Message Query Language (MQL)',
		serverOptions,
		clientOptions
	);

	// Set up embedded MQL support BEFORE starting the client
	// (middleware needs these references during client initialization)
	setupEmbeddedMQL(client, languageID);

	// Start the client. This will also launch the server
	client.start().catch((error) => {
		console.error('Failed to start MQL language server:', error);
	});
}


function deactivateLanguageServer(): Thenable<void> | undefined {
	// Clean up embedded MQL resources
	cleanupEmbeddedMQL();

	if (!client) {
		return undefined;
	}
	return client.stop();
}

export function activate(context: vscode.ExtensionContext) {
	activateLanguageServer(context);
}

export function deactivate() {
	deactivateLanguageServer();
}