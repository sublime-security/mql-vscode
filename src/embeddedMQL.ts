/**
 * Embedded MQL support for YAML documents
 *
 * This module provides language server support for MQL code embedded within YAML files
 * (specifically within `source: |` blocks). It handles document masking, position routing,
 * and feature provider implementations for embedded MQL regions.
 */

import * as vscode from "vscode";
import {
  LanguageClient,
  DocumentHighlightKind as LSPDocumentHighlightKind,
  Middleware,
} from "vscode-languageclient/node";

export interface EmbeddedMQLRegion {
  startLine: number;
  endLine: number;
}

interface EmbeddedMQLDocumentCache {
  version: number;
  region: EmbeddedMQLRegion | undefined; // Only one region per file
  maskedText: string;
}

// Cache for computed regions and masked documents for embedded MQL in YAML
const embeddedMQLDocumentCache = new Map<string, EmbeddedMQLDocumentCache>();

// Track which YAML documents have been opened on the MQL server for embedded MQL
const embeddedMQLOpenedYAMLDocuments = new Set<string>();

// Reference to the language client (set during setup)
let client: LanguageClient;
let languageID: string;

/**
 * Detects the single MQL region in a YAML document.
 * Looks for a block scalar under the 'source: |' key.
 * Returns undefined if no MQL region is found.
 */
function detectMQLRegion(text: string): EmbeddedMQLRegion | undefined {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for block scalar headers like "source: |" or "source: >"
    const match = line.match(/^(\s*)source:\s*[|>][-+]?\s*$/);
    if (!match) {
      continue;
    }

    const keyIndent = match[1].length;
    const contentIndent = keyIndent + 2; // YAML requires at least 1 space, typically 2

    // Find the start of the content (next line)
    const startLine = i + 1;
    if (startLine >= lines.length) {
      return undefined;
    }

    // Find the end of the block (first line that's not indented enough)
    let endLine = startLine;

    for (let j = startLine; j < lines.length; j++) {
      const contentLine = lines[j];

      // Empty lines are part of the block
      if (contentLine.trim() === "") {
        endLine = j;
        continue;
      }

      // Count leading spaces
      const leadingSpaces = contentLine.match(/^\s*/)?.[0].length ?? 0;

      // If not indented enough, block ends
      if (leadingSpaces < contentIndent) {
        break;
      }

      // This line is part of the block
      endLine = j;
    }

    // Return the region if it has content
    if (endLine >= startLine) {
      return {
        startLine,
        endLine,
      };
    }
  }

  return undefined;
}

/**
 * Creates a masked version of the document where only the MQL region contains text.
 * All other lines are replaced with empty strings.
 * This preserves line count and UTF-16 positions.
 */
function maskDocument(
  text: string,
  region: EmbeddedMQLRegion | undefined,
): string {
  if (!region) {
    return text
      .split("\n")
      .map(() => "")
      .join("\n");
  }

  const lines = text.split("\n");
  const maskedLines = lines.map(() => "");

  // Restore original text for lines inside the MQL region
  for (
    let lineNum = region.startLine;
    lineNum <= region.endLine && lineNum < lines.length;
    lineNum++
  ) {
    maskedLines[lineNum] = lines[lineNum];
  }

  return maskedLines.join("\n");
}

/**
 * Checks if a position is inside the embedded MQL region
 */
function isInsideEmbeddedMQLRegion(
  position: vscode.Position,
  region: EmbeddedMQLRegion | undefined,
): boolean {
  if (!region) {
    return false;
  }
  return position.line >= region.startLine && position.line <= region.endLine;
}

/**
 * Checks if a document and optional position should allow MQL language server requests.
 *
 * For non-YAML documents: always returns true (no restrictions)
 * For YAML documents without position (document-level): returns true only if MQL region exists
 * For YAML documents with position: returns true only if position is inside MQL region
 */
function isInsideValidMQLRegion(
  document: vscode.TextDocument,
  position?: vscode.Position,
): boolean {
  // Non-YAML documents are always valid (no MQL region restrictions)
  if (document.languageId !== "yaml") {
    return true;
  }

  const cache = getEmbeddedMQLCachedDocumentData(document);

  // Document-level request: check if region exists
  if (position === undefined) {
    return cache.region !== undefined;
  }

  // Position-based request: check if position is in region
  return isInsideEmbeddedMQLRegion(position, cache.region);
}

/**
 * Gets or computes cached document data for embedded MQL
 */
function getEmbeddedMQLCachedDocumentData(
  document: vscode.TextDocument,
): EmbeddedMQLDocumentCache {
  const uri = document.uri.toString();
  const cached = embeddedMQLDocumentCache.get(uri);

  if (cached && cached.version === document.version) {
    return cached;
  }

  // Compute fresh data
  const text = document.getText();
  const region = detectMQLRegion(text);
  const maskedText = maskDocument(text, region);

  const cache: EmbeddedMQLDocumentCache = {
    version: document.version,
    region,
    maskedText,
  };

  embeddedMQLDocumentCache.set(uri, cache);
  return cache;
}

/**
 * Creates middleware for the LanguageClient to handle embedded MQL in YAML.
 * This middleware can intercept document lifecycle events and formatting requests to mask away YAML content,
 * and force formatting changes to be re-indented properly within the YAML block.
 */
export function createEmbeddedMQLMiddleware(): Middleware {
  return {
    // Document synchronization middleware masks away YAML content
    didOpen: async (document, next) => {
      if (document.languageId !== "yaml") {
        return await next(document);
      }

      const uri = document.uri.toString();
      if (embeddedMQLOpenedYAMLDocuments.has(uri)) {
        return;
      }

      const cache = getEmbeddedMQLCachedDocumentData(document);
      if (!cache.region) {
        return;
      }

      await client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: uri,
          languageId: languageID,
          version: document.version,
          text: cache.maskedText,
        },
      });

      embeddedMQLOpenedYAMLDocuments.add(uri);
    },
    didChange: async (event, next) => {
      if (event.document.languageId !== "yaml") {
        return await next(event);
      }

      const document = event.document;
      const uri = document.uri.toString();
      const cache = getEmbeddedMQLCachedDocumentData(document);

      // If no MQL region and never opened, do nothing
      if (!cache.region && !embeddedMQLOpenedYAMLDocuments.has(uri)) {
        return;
      }

      // If not yet opened, send didOpen first. This would happen if the MQL region was added in this change,
      // because `source: |` wasn't present on the initial open.
      if (!embeddedMQLOpenedYAMLDocuments.has(uri)) {
        if (cache.region) {
          // Manually send didOpen with masked content. We can't modify `document` to pass to `next`,
          // so we have to manually send the notification.
          await client.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri: uri,
              languageId: languageID,
              version: document.version,
              text: cache.maskedText,
            },
          });
          embeddedMQLOpenedYAMLDocuments.add(uri);
        }
        return;
      }

      // Manually send didChange with masked content. We can't modify `document` to pass to `next`,
      // so we have to manually send the notification.
      await client.sendNotification("textDocument/didChange", {
        textDocument: {
          uri: uri,
          version: document.version,
        },
        contentChanges: [
          {
            text: cache.maskedText,
          },
        ],
      });
    },
    didClose: async (document, next) => {
      if (document.languageId === "yaml") {
        // Let standard close happen, then clean up local state
        await next(document);
        const uri = document.uri.toString();
        embeddedMQLOpenedYAMLDocuments.delete(uri);
        embeddedMQLDocumentCache.delete(uri);
        return;
      }

      return await next(document);
    },

    provideDocumentFormattingEdits: async (document, options, token, next) => {
      if (!isInsideValidMQLRegion(document)) {
        // No formatting requests are performed outside MQL regions. Other extensions can handle these requests.
        return undefined;
      }

      // Get formatting from MQL server
      const edits = await next(document, options, token);
      if (!edits || edits.length === 0) {
        return edits;
      }

      // For masked YAML documents, the server will autoformat everything to line: 1, column: 1.
      // We need to unmask and re-indent the formatted code for YAML block indentation
      if (document.languageId === "yaml") {
        const cache = getEmbeddedMQLCachedDocumentData(document);
        const region = cache.region!;

        // Server should return exactly one edit covering the entire masked document
        if (edits.length !== 1) {
          return undefined;
        }

        const edit = edits[0];

        const sourceLine = document.lineAt(region.startLine - 1);
        const sourceIndent = sourceLine.text.match(/^(\s*)/)?.[0] || "";
        const blockIndent = sourceIndent + "  ";

        const formattedLines = edit.newText.split("\n");
        const reindentedText = formattedLines
          .map((line: string) =>
            line.trim() === "" ? "" : blockIndent + line,
          )
          .join("\n");

        // Create range covering only the MQL region in the YAML file
        const startPos = new vscode.Position(region.startLine, 0);
        const endLine = document.lineAt(region.endLine);
        const endPos = new vscode.Position(region.endLine, endLine.text.length);
        const mqlRegionRange = new vscode.Range(startPos, endPos);

        return [new vscode.TextEdit(mqlRegionRange, reindentedText)];
      }

      return edits;
    },
  };
}

/**
 * Sets up middleware for the LSP server/client. Full MQL documents are handled normally,
 * but embedded MQL in YAML documents are masked and synced appropriately.
 */
export function setupEmbeddedMQL(
  languageClient: LanguageClient,
  mqlLanguageID: string,
): void {
  client = languageClient;
  languageID = mqlLanguageID;
}

/**
 * Cleans up embedded MQL resources
 */
export function cleanupEmbeddedMQL(): void {
  embeddedMQLDocumentCache.clear();
  embeddedMQLOpenedYAMLDocuments.clear();
}
