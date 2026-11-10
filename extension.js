'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  PROJECTS, FAVORITES, NAMES,
  listSessions, searchContent,
  readFavorites, toggleFavorite, readNames, setName,
} = require('./sessions');

let sessions = [];
let provider;

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeSessions');
  return {
    max: c.get('maxSessions', 300),
    activeMinutes: c.get('activeMinutes', 3),
    openOnStartup: c.get('openOnStartup', true),
  };
}

async function refresh() {
  const { max, activeMinutes } = cfg();
  const favs = readFavorites();
  const names = readNames();
  sessions = (await listSessions({ max, activeMinutes, keep: favs }))
    .map(s => ({
      ...s,
      favorite: favs.has(s.id),
      autoTitle: s.title,
      title: names[s.id] || s.title,
      renamed: !!names[s.id],
    }));
  if (provider) provider.post({ type: 'sessions', sessions, workspace: workspaceFolders() });
  return sessions;
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hier' : `il y a ${d} j`;
}

function shortPath(p) {
  if (!p) return '?';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(' / ');
}

async function resume(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  if (!s.cwd || !fs.existsSync(s.cwd)) {
    vscode.window.showErrorMessage(`Le dossier de cette conversation n'existe plus : ${s.cwd || '(inconnu)'}`);
    return;
  }
  if (s.active) {
    const go = await vscode.window.showWarningMessage(
      `« ${s.title} » a été modifiée ${ago(s.mtime)} : elle est sans doute ouverte dans une autre instance de Claude. ` +
      'La reprendre en double fait écrire deux sessions dans le même historique.',
      { modal: true },
      'Reprendre quand même'
    );
    if (go !== 'Reprendre quand même') return;
  }
  const term = vscode.window.createTerminal({
    name: `Claude · ${s.title.slice(0, 28)}`,
    cwd: s.cwd,
    iconPath: new vscode.ThemeIcon('comment-discussion'),
  });
  term.show();
  term.sendText(`claude --resume ${s.id}`);
}

async function rename(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  const name = await vscode.window.showInputBox({
    title: 'Renommer la conversation',
    value: s.title,
    prompt: `Titre automatique : « ${s.autoTitle} ». Laisser vide pour y revenir.`,
    placeHolder: s.autoTitle,
  });
  if (name === undefined) return; // Échap
  setName(id, name);
  await refresh();
}

function openFolder(id) {
  const s = sessions.find(x => x.id === id);
  if (!s || !s.cwd) return;
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.cwd), { forceNewWindow: true });
}

async function copyCommand(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  await vscode.env.clipboard.writeText(`cd "${s.cwd}"; claude --resume ${s.id}`);
  vscode.window.setStatusBarMessage('Commande copiée', 2000);
}

function openTranscript(id) {
  const s = sessions.find(x => x.id === id);
  if (s) vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: true });
}

async function quickSearch() {
  if (!sessions.length) await refresh();
  const ws = workspaceFolders().map(f => f.toLowerCase());
  const ordered = [...sessions.filter(s => s.favorite), ...sessions.filter(s => !s.favorite)];
  const items = ordered.map(s => ({
    label: `${s.favorite ? '$(star-full) ' : ''}${s.active ? '$(circle-filled) ' : ''}${s.title}`,
    description: `${shortPath(s.cwd)}  $(git-branch) ${s.branch || '—'}  · ${ago(s.mtime)}`,
    detail: s.lastPrompt || s.firstPrompt,
    id: s.id,
    here: s.cwd && ws.some(w => s.cwd.toLowerCase().startsWith(w)),
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Chercher une conversation (titre, dossier, branche, message)…',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) resume(pick.id);
}

class SessionsView {
  constructor(ctx) {
    this.ctx = ctx;
    this.view = null;
    this.searchSeq = 0;
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview, this.ctx.extensionUri);
    view.webview.onDidReceiveMessage(async m => {
      switch (m.type) {
        case 'ready': await refresh(); break;
        case 'refresh': await refresh(); break;
        case 'resume': resume(m.id); break;
        case 'open': openFolder(m.id); break;
        case 'copy': copyCommand(m.id); break;
        case 'transcript': openTranscript(m.id); break;
        case 'favorite': toggleFavorite(m.id); await refresh(); break;
        case 'rename': await rename(m.id); break;
        case 'search': {
          const seq = ++this.searchSeq;
          this.post({ type: 'searching', query: m.query });
          const hits = await searchContent(sessions, m.query);
          if (seq === this.searchSeq) this.post({ type: 'contentHits', query: m.query, hits });
          break;
        }
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) refresh(); });
    view.onDidDispose(() => { this.view = null; });
  }
}

function html(webview, extUri) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'view.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'view.css'));
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head><body>
<div class="top">
  <input id="q" type="search" placeholder="Rechercher : titre, dossier, branche, message…" autofocus>
  <div class="filters">
    <label><input type="checkbox" id="content"> dans tout le contenu</label>
    <label><input type="checkbox" id="here"> ce dossier</label>
    <label><input type="checkbox" id="favs"> favoris</label>
    <span id="count"></span>
  </div>
</div>
<div id="list"></div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
}

function activate(ctx) {
  provider = new SessionsView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeSessions.list', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeSessions.search', quickSearch),
    vscode.commands.registerCommand('claudeSessions.refresh', refresh),
    vscode.commands.registerCommand('claudeSessions.focus', () =>
      vscode.commands.executeCommand('workbench.view.extension.claudeSessions'))
  );

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.text = '$(comment-discussion) Conversations';
  bar.tooltip = 'Conversations Claude récentes (Ctrl+Alt+C pour chercher)';
  bar.command = 'claudeSessions.focus';
  bar.show();
  ctx.subscriptions.push(bar);

  // Rafraîchit quand une conversation est écrite, et toutes les 30 s pour l'état « en cours ».
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (provider.view && provider.view.visible) refresh(); }, 1500); };
  try {
    const w = fs.watch(PROJECTS, { recursive: true }, (_e, f) => { if (f && f.endsWith('.jsonl')) later(); });
    ctx.subscriptions.push({ dispose: () => w.close() });
    // Un favori ou un nom changé dans une autre fenêtre VS Code apparaît ici aussi.
    const shared = [path.basename(FAVORITES), path.basename(NAMES)];
    const fw = fs.watch(path.dirname(FAVORITES), (_e, f) => { if (shared.includes(f)) later(); });
    ctx.subscriptions.push({ dispose: () => fw.close() });
  } catch { /* dossier absent : pas de surveillance */ }
  const tick = setInterval(() => { if (provider.view && provider.view.visible) refresh(); }, 30000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });

  if (cfg().openOnStartup) vscode.commands.executeCommand('workbench.view.extension.claudeSessions');

  // Indexe le contenu en arrière-plan pour que la première recherche plein texte soit instantanée.
  setTimeout(async () => {
    try { await refresh(); await searchContent(sessions, '\u0000'); } catch { /* sans importance */ }
  }, 8000);
}

function deactivate() {}

module.exports = { activate, deactivate };
