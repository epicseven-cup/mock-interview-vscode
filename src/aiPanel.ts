import * as vscode from 'vscode';
import * as nodeCrypto from 'crypto';

export type UserMessageHandler = (text: string) => void;
export type ModeChangeHandler = (mode: string) => void;

export class AiPanel {
  static currentPanel: AiPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly nonce: string;
  private cancelSource: vscode.CancellationTokenSource | undefined;
  private userMessageHandler: UserMessageHandler | undefined;
  private reviewHandler: (() => void) | undefined;
  private modeChangeHandler: ModeChangeHandler | undefined;
  private selectModelHandler: (() => void) | undefined;

  static createOrShow(extensionUri: vscode.Uri): AiPanel {
    if (AiPanel.currentPanel) {
      AiPanel.currentPanel.panel.reveal(vscode.ViewColumn.Two);
      return AiPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'mockInterviewAi',
      'Interview AI',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    AiPanel.currentPanel = new AiPanel(panel);
    return AiPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.nonce = nodeCrypto.randomBytes(16).toString('hex');
    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'userMessage') this.userMessageHandler?.(msg.text);
      else if (msg.type === 'requestReview') this.reviewHandler?.();
      else if (msg.type === 'modeChange') this.modeChangeHandler?.(msg.mode);
      else if (msg.type === 'selectModel') this.selectModelHandler?.();
    });
    this.panel.onDidDispose(() => {
      AiPanel.currentPanel = undefined;
    });
  }

  onUserMessage(handler: UserMessageHandler): void {
    this.userMessageHandler = handler;
  }

  onReviewRequest(handler: () => void): void {
    this.reviewHandler = handler;
  }

  onModeChange(handler: ModeChangeHandler): void {
    this.modeChangeHandler = handler;
  }

  setMode(mode: string): void {
    this.panel.webview.postMessage({ type: 'setMode', mode });
  }

  onSelectModel(handler: () => void): void {
    this.selectModelHandler = handler;
  }

  setModelLabel(label: string): void {
    this.panel.webview.postMessage({ type: 'setModelLabel', label });
  }

  getCancelToken(): vscode.CancellationToken {
    this.cancelSource?.cancel();
    this.cancelSource = new vscode.CancellationTokenSource();
    return this.cancelSource.token;
  }

  showThinking(label: string): void {
    this.panel.webview.postMessage({ type: 'thinking', label });
  }

  showMessage(label: string, text: string, role: 'assistant' | 'user' = 'assistant'): void {
    this.panel.webview.postMessage({ type: 'message', label, text, role });
  }

  showError(message: string): void {
    this.panel.webview.postMessage({ type: 'error', message });
  }

  private getHtml(): string {
    const csp = this.panel.webview.cspSource;
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${this.nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interview AI</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }

  /* scrollable message list */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* empty state */
  .empty-state {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 32px 24px;
    opacity: 0.65;
  }
  .empty-state svg { opacity: 0.4; }
  .empty-state p { font-size: 12px; max-width: 220px; }

  /* message rows */
  .row { display: flex; flex-direction: column; gap: 4px; }
  .row.user  { align-items: flex-end; }
  .row.assistant { align-items: flex-start; }
  .row.error { align-items: flex-start; }

  .sender {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.45;
    padding: 0 4px;
  }

  .bubble {
    max-width: 90%;
    padding: 10px 14px;
    border-radius: 12px;
    word-break: break-word;
    font-size: 13px;
  }
  .row.user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-radius: 14px 14px 4px 14px;
  }
  .row.assistant .bubble {
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.15));
    border-radius: 4px 14px 14px 14px;
  }
  .row.error .bubble {
    background: var(--vscode-inputValidation-errorBackground, rgba(255,60,60,0.1));
    border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255,60,60,0.5));
    border-radius: 4px 14px 14px 14px;
    color: var(--vscode-errorForeground);
    font-size: 12px;
  }

  /* markdown content */
  .bubble p { margin: 0 0 8px; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble ul, .bubble ol { padding-left: 18px; margin: 4px 0 8px; }
  .bubble li { margin: 2px 0; }
  .bubble h1, .bubble h2, .bubble h3 {
    font-size: 13px;
    font-weight: 700;
    margin: 12px 0 4px;
  }
  .bubble h1:first-child,
  .bubble h2:first-child,
  .bubble h3:first-child { margin-top: 0; }
  .bubble pre {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2));
    border-radius: 6px;
    padding: 10px 12px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
  }
  .bubble pre:last-child { margin-bottom: 0; }
  .bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--vscode-textPreformat-background, rgba(127,127,127,0.15));
    padding: 1px 5px;
    border-radius: 3px;
  }
  .bubble pre code { background: none; padding: 0; }
  .bubble strong { font-weight: 600; }
  .bubble em { font-style: italic; }
  .bubble hr { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2)); margin: 8px 0; }

  /* thinking */
  .thinking-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    padding: 2px 4px;
  }
  .dot-pulse { display: flex; gap: 4px; align-items: center; }
  .dot-pulse span {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .dot-pulse span:nth-child(2) { animation-delay: 0.2s; }
  .dot-pulse span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse {
    0%, 80%, 100% { transform: scale(0.5); opacity: 0.3; }
    40% { transform: scale(1); opacity: 1; }
  }

  /* mode bar */
  #mode-bar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
    background: var(--vscode-editor-background);
  }
  #mode-bar span {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.45;
    margin-right: 2px;
  }
  .mode-pill {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 20px;
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.1s;
  }
  .mode-pill:hover { opacity: 0.85; }
  .mode-pill.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
    opacity: 1;
  }
  #model-btn {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.6;
    white-space: nowrap;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #model-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

  /* bottom chrome */
  #bottom {
    flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  #review-btn {
    width: 100%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  #review-btn:hover { background: var(--vscode-button-hoverBackground); }
  #review-btn:disabled { opacity: 0.4; cursor: default; }

  #input-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }
  #user-input {
    flex: 1;
    resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
    border-radius: 6px;
    padding: 7px 10px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
    outline: none;
    min-height: 34px;
    max-height: 120px;
    overflow-y: auto;
  }
  #user-input::placeholder { opacity: 0.45; }
  #user-input:focus { border-color: var(--vscode-focusBorder); }
  #send-btn {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.15));
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #send-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.25)); }
  #send-btn:disabled { opacity: 0.35; cursor: default; }
</style>
</head>
<body>
<div id="mode-bar">
  <span>Mode</span>
  <button class="mode-pill active" data-mode="hint">Hint</button>
  <button class="mode-pill" data-mode="harsh">Harsh</button>
  <button class="mode-pill" data-mode="followup">Follow-up</button>
  <div style="flex:1"></div>
  <button id="model-btn" title="Switch AI model">⚙ <span id="model-label">vscode-lm</span></button>
</div>
<div id="messages">
  <div class="empty-state">
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/>
      <path d="M12 8V12"/>
      <path d="M12 16H12.01"/>
    </svg>
    <p>Click <strong>Ready for Review</strong> below when you want feedback on your solution.</p>
  </div>
</div>
<div id="bottom">
  <button id="review-btn">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
    Ready for Review
  </button>
  <div id="input-row">
    <textarea id="user-input" rows="1" placeholder="Ask the interviewer..."></textarea>
    <button id="send-btn" title="Send (Enter)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
      </svg>
    </button>
  </div>
</div>
<script nonce="${this.nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl    = document.getElementById('user-input');
  const sendBtn    = document.getElementById('send-btn');
  const reviewBtn  = document.getElementById('review-btn');
  let thinkingEl   = null;

  function esc(t) {
    return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function md(raw) {
    const out = [];
    const fence = /^\`\`\`[\\w]*\\n?([\\s\\S]*?)\`\`\`$/gm;
    let last = 0, hit;
    while ((hit = fence.exec(raw)) !== null) {
      if (hit.index > last) out.push(prose(raw.slice(last, hit.index)));
      out.push('<pre><code>' + esc(hit[1].replace(/\\n$/, '')) + '</code></pre>');
      last = hit.index + hit[0].length;
    }
    if (last < raw.length) out.push(prose(raw.slice(last)));
    return out.join('');
  }

  function prose(t) {
    let h = esc(t);
    h = h.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    h = h.replace(/\\*\\*(.+?)\\*\\*/gs, '<strong>$1</strong>');
    h = h.replace(/\\*(.+?)\\*/gs,      '<em>$1</em>');
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
    h = h.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
    h = h.replace(/^---+$/gm, '<hr>');
    h = h.replace(/^[*\\-] (.+)$/gm, '<li>$1</li>');
    // wrap adjacent <li> in <ul>
    h = h.replace(/(<li>.*<\\/li>\\n?)+/g, s => '<ul>' + s + '</ul>');
    // paragraphs from blank-line separated blocks
    const blocks = h.split(/\\n{2,}/);
    return blocks.map(b => {
      b = b.trim();
      if (!b) return '';
      if (/^<(h[123]|ul|pre|hr)/.test(b)) return b;
      return '<p>' + b.replace(/\\n/g, '<br>') + '</p>';
    }).join('');
  }

  function clearEmpty() {
    const e = messagesEl.querySelector('.empty-state');
    if (e) e.remove();
  }
  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }
  function scrollBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }
  function setWorking(on) {
    sendBtn.disabled = on;
    reviewBtn.disabled = on;
  }

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.type === 'setMode') { activatePill(msg.mode); return; }
    if (msg.type === 'setModelLabel') { modelLabel.textContent = msg.label; return; }
    if (msg.type === 'thinking') {
      clearEmpty();
      removeThinking();
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking-row';
      thinkingEl.innerHTML =
        '<span>' + esc(msg.label) + '...</span>'
        + '<span class="dot-pulse"><span></span><span></span><span></span></span>';
      messagesEl.appendChild(thinkingEl);
      scrollBottom();
      setWorking(true);
    } else if (msg.type === 'message') {
      clearEmpty();
      removeThinking();
      setWorking(false);
      const row = document.createElement('div');
      row.className = 'row ' + (msg.role || 'assistant');
      const senderLabel = msg.role === 'user' ? 'You' : esc(msg.label);
      const content = msg.role === 'user' ? esc(msg.text) : md(msg.text);
      row.innerHTML = '<div class="sender">' + senderLabel + '</div>'
                    + '<div class="bubble">' + content + '</div>';
      messagesEl.appendChild(row);
      scrollBottom();
    } else if (msg.type === 'error') {
      clearEmpty();
      removeThinking();
      setWorking(false);
      const row = document.createElement('div');
      row.className = 'row error';
      row.innerHTML = '<div class="sender">Error</div><div class="bubble">' + esc(msg.message) + '</div>';
      messagesEl.appendChild(row);
      scrollBottom();
    }
  });

  function send() {
    const text = inputEl.value.trim();
    if (!text || sendBtn.disabled) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    vscode.postMessage({ type: 'userMessage', text });
  }

  const pills = document.querySelectorAll('.mode-pill');
  function activatePill(mode) {
    pills.forEach(p => p.classList.toggle('active', p.dataset.mode === mode));
  }
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      activatePill(pill.dataset.mode);
      vscode.postMessage({ type: 'modeChange', mode: pill.dataset.mode });
    });
  });

  const modelBtn = document.getElementById('model-btn');
  const modelLabel = document.getElementById('model-label');
  modelBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));

  reviewBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestReview' }));
  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
</script>
</body>
</html>`;
  }
}
