import * as vscode from 'vscode';

/**
 * Builds the HTML shell for the React panel.
 *
 * Only the CSP and the resource URIs live here; everything visible comes from the bundle.
 */
export function buildReactHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const root = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
  const nonce = createNonce();

  // Fixed filenames, so the host never has to parse a build manifest. The query string is
  // a cache bust: webview resources are cached aggressively and unhashed names would
  // otherwise serve a stale bundle after an update.
  const bust = Date.now().toString(36);
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));

  const csp = [
    `default-src 'none'`,
    // 'unsafe-inline' is required for styles and cannot be replaced by a nonce: nonces do
    // not cover style-src-attr, and React sets inline style *attributes*. Without it,
    // popovers and the auto-sizing textarea break.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // Deliberately no 'unsafe-inline' here — CSP3 ignores it when a nonce is present, so
    // it would be both unsafe and inert.
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}?v=${bust}">
  <title>Repo Intelligence</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}?v=${bust}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/** Whether the React panel is enabled. Defaults on; the legacy UI remains as a fallback. */
export function isReactUiEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('repo-intelligence')
    .get<boolean>('ui.reactPanel', true);
}
