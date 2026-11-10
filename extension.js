'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const S = require('./sessions');
const L = require('./live');

const DEFAULT_TAGS = ['à reprendre', 'en pause', 'bloqué', 'terminé'];

let sessions = [];
let provider;
let bar;
let ctxRef;

// Liens conversation → onglet de terminal, retrouvés par l'arbre des processus :
// le processus claude d'une conversation ouverte descend du shell de son terminal.
const termOf = new Map();
let parents = new Map();
let parentsAt = 0;

// État « à traiter » au rafraîchissement précédent, pour ne notifier que les changements.
let previous = null;

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeSessions');
  return {
    max: c.get('maxSessions', 300),
    activeMinutes: c.get('activeMinutes', 3),
    openOnStartup: c.get('openOnStartup', true),
    notifications: c.get('notifications', 'autorisations'),
  };
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
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
}

const find = id => sessions.find(x => x.id === id);

// ------------------------------------------------------------------ terminaux

async function linkTerminals(live) {
  termOf.clear();
  const shells = new Map();
  await Promise.all(vscode.window.terminals.map(async t => {
    try { const pid = await t.processId; if (pid) shells.set(pid, t); } catch { /* terminal fermé */ }
  }));
  const entries = Object.entries(live);
  if (!shells.size || !entries.length) return;
  // Un processus claude inconnu : on relit l'arbre des processus (au plus toutes les 5 s).
  if (entries.some(([, s]) => !parents.has(s.pid)) && Date.now() - parentsAt > 5000) {
    parentsAt = Date.now();
    parents = await L.processParents();
  }
  const targets = new Set(shells.keys());
  for (const [id, s] of entries) {
    const shell = L.findAncestor(s.pid, parents, targets);
    if (shell) termOf.set(id, shells.get(shell));
  }
}

function sessionOfTerminal(t) {
  for (const [id, term] of termOf) if (term === t) return id;
  return null;
}

// ------------------------------------------------------------------ état « à traiter »
//   waiting  : Claude attend ton autorisation ou ta réponse (orange)
//   question : Claude a fini son tour sur une question (orange, jusqu'à ta réponse)
//   done     : Claude a fini, tu n'as pas encore regardé (vert, jusqu'au clic)
//   working  : Claude travaille
//   open     : ouverte, rien à faire
function attentionOf(s, li, seen, registry) {
  if (li) {
    if (li.status === 'waiting') return 'waiting';
    if (li.status === 'busy') return 'working';
    if (s.asks) return 'question';
    return (seen[s.id] || 0) >= (s.lastMessageAt || 0) ? 'open' : 'done';
  }
  // Sans registre (ancienne version de Claude Code) : on se contente de l'activité du fichier.
  if (!registry && s.active) return 'working';
  return null;
}

let running = null;
let again = false;

function refresh() {
  if (running) { again = true; return running; }
  running = doRefresh()
    .catch(err => console.error('[claude-sessions]', err))
    .finally(() => {
      running = null;
      if (again) { again = false; refresh(); }
    });
  return running;
}

async function doRefresh() {
  const { max, activeMinutes } = cfg();
  const favs = S.readFavorites();
  const archived = S.readArchived();
  const names = S.readNames();
  const tags = S.readTags();
  const live = await L.readLive();
  await linkTerminals(live.sessions).catch(() => {});

  // Les conversations ouvertes et les favoris sont listés même au-delà de la limite.
  const keep = new Set([...favs, ...Object.keys(live.sessions)]);
  const list = await S.listSessions({ max, activeMinutes, keep });

  let seen = S.readSeen();
  const watching = vscode.window.state.focused ? vscode.window.activeTerminal : null;
  sessions = list.map(s => {
    const li = live.sessions[s.id];
    let attention = attentionOf(s, li, seen, live.available);
    const term = termOf.get(s.id);
    // Claude finit pendant que tu regardes son terminal : c'est vu.
    if (attention === 'done' && term && term === watching) {
      S.markSeen(s.id);
      seen = S.readSeen();
      attention = 'open';
    }
    const p = L.projectOf(s.cwd);
    return {
      ...s,
      favorite: favs.has(s.id),
      archived: archived.has(s.id),
      tags: tags[s.id] || [],
      autoTitle: s.title,
      title: names[s.id] || s.title,
      renamed: !!names[s.id],
      live: !!li,
      attention,
      waitingFor: li ? li.waitingFor : null,
      hasTerminal: !!term,
      project: p.project,
      worktree: p.worktree,
    };
  });

  notifyChanges();
  updateIndicators();
  if (provider) provider.post({ type: 'sessions', sessions, workspace: workspaceFolders(), tagPalette: DEFAULT_TAGS });
}

function notifyChanges() {
  const now = new Map(sessions.map(s => [s.id, s.attention]));
  const before = previous;
  previous = now;
  if (!before) return; // premier chargement : rien de « nouveau »
  const mode = cfg().notifications;
  if (mode === 'aucune') return;
  for (const s of sessions) {
    const cur = s.attention;
    if (cur === before.get(s.id) || !['waiting', 'question', 'done'].includes(cur)) continue;
    if (mode === 'autorisations' && cur !== 'waiting') continue;
    // Seule la fenêtre qui a le terminal notifie, sinon chaque fenêtre VS Code le ferait.
    const term = termOf.get(s.id);
    if (!term) continue;
    if (vscode.window.state.focused && vscode.window.activeTerminal === term) continue;
    const msg = cur === 'waiting' ? `Claude attend ton feu vert : « ${s.title} »${s.waitingFor ? ` (${s.waitingFor})` : ''}`
      : cur === 'question' ? `Claude te pose une question : « ${s.title} »`
      : `Claude a terminé : « ${s.title} »`;
    const show = cur === 'done' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    show(msg, 'Y aller').then(c => { if (c) goTo(s.id); });
  }
}

function updateIndicators() {
  const orange = sessions.filter(s => s.attention === 'waiting' || s.attention === 'question').length;
  const green = sessions.filter(s => s.attention === 'done').length;
  const working = sessions.filter(s => s.attention === 'working').length;
  const parts = [];
  if (orange) parts.push(`$(bell-dot) ${orange} t'attend${orange > 1 ? 'ent' : ''}`);
  if (green) parts.push(`$(check) ${green} terminée${green > 1 ? 's' : ''}`);
  if (working) parts.push(`$(sync~spin) ${working}`);
  bar.text = parts.length ? parts.join('  ') : '$(comment-discussion) Conversations';
  bar.backgroundColor = orange ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  bar.tooltip = parts.length
    ? `${orange} conversation(s) attendent ta réponse, ${green} terminée(s) pas encore vue(s), ${working} en cours. Cliquer pour ouvrir le panneau.`
    : 'Conversations Claude récentes (Ctrl+Alt+C pour chercher)';
  if (provider && provider.view) {
    provider.view.badge = orange + green
      ? { value: orange + green, tooltip: `${orange} t'attendent, ${green} terminées` }
      : undefined;
  }
}

// ------------------------------------------------------------------ actions

// Clic sur une conversation : son terminal s'il est ouvert ici, sinon on la reprend.
async function goTo(id) {
  const s = find(id);
  if (!s) return;
  const term = termOf.get(id);
  if (term) {
    term.show();
    S.markSeen(id);
    refresh();
    return;
  }
  resume(id);
}

async function resume(id) {
  const s = find(id);
  if (!s) return;
  if (!s.cwd || !fs.existsSync(s.cwd)) {
    vscode.window.showErrorMessage(`Le dossier de cette conversation n'existe plus : ${s.cwd || '(inconnu)'}`);
    return;
  }
  if (s.live || (s.attention === 'working' && !s.live)) {
    const go = await vscode.window.showWarningMessage(
      `« ${s.title} » est déjà ouverte dans un autre terminal (une autre fenêtre VS Code ou un terminal extérieur). ` +
      'La reprendre en double fait écrire deux sessions dans le même historique.',
      { modal: true },
      'Lire', 'Reprendre quand même'
    );
    if (go === 'Lire') return openReader(id);
    if (go !== 'Reprendre quand même') return;
  }
  const term = vscode.window.createTerminal({
    name: `Claude · ${s.title.slice(0, 28)}`,
    cwd: s.cwd,
    iconPath: new vscode.ThemeIcon('comment-discussion'),
  });
  term.show();
  term.sendText(`claude --resume ${s.id}`);
  S.markSeen(id);
  setTimeout(refresh, 4000); // le temps que claude démarre et s'inscrive au registre
}

async function rename(id) {
  const s = find(id);
  if (!s) return;
  const name = await vscode.window.showInputBox({
    title: 'Renommer la conversation',
    value: s.title,
    prompt: `Titre automatique : « ${s.autoTitle} ». Laisser vide pour y revenir.`,
    placeHolder: s.autoTitle,
  });
  if (name === undefined) return; // Échap
  S.setName(id, name);
  await refresh();
}

async function editTags(id) {
  const s = find(id);
  if (!s) return;
  const all = new Set(DEFAULT_TAGS);
  for (const x of sessions) x.tags.forEach(t => all.add(t));
  const NEW = { label: '$(add) Nouvelle étiquette…', alwaysShow: true };
  const items = [...all].map(t => ({ label: t, picked: s.tags.includes(t) }));
  const picked = await vscode.window.showQuickPick([...items, NEW], {
    canPickMany: true,
    title: `Étiquettes de « ${s.title} »`,
    placeHolder: 'Coche les étiquettes, puis Entrée',
  });
  if (!picked) return;
  const tags = picked.filter(p => p !== NEW).map(p => p.label);
  if (picked.includes(NEW)) {
    const v = await vscode.window.showInputBox({
      title: 'Nouvelle étiquette',
      prompt: 'Une ou plusieurs, séparées par des virgules',
    });
    if (v) tags.push(...v.split(','));
  }
  S.setTags(id, tags);
  await refresh();
}

function openFolder(id) {
  const s = find(id);
  if (!s || !s.cwd) return;
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.cwd), { forceNewWindow: true });
}

async function copyCommand(id) {
  const s = find(id);
  if (!s) return;
  await vscode.env.clipboard.writeText(`cd "${s.cwd}"; claude --resume ${s.id}`);
  vscode.window.setStatusBarMessage('Commande copiée', 2000);
}

function openTranscript(id) {
  const s = find(id);
  if (s) vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: true });
}

async function moreActions(id) {
  const s = find(id);
  if (!s) return;
  const actions = [
    { label: '$(edit) Renommer', run: () => rename(id) },
    { label: '$(tag) Étiquettes…', run: () => editTags(id) },
    { label: s.archived ? '$(inbox) Désarchiver' : '$(archive) Archiver', description: s.archived ? '' : 'la masque de la liste ; la recherche la retrouve', run: async () => { S.toggleArchived(id); await refresh(); } },
    { label: s.favorite ? '$(star-empty) Retirer des favoris' : '$(star-full) Ajouter aux favoris', run: async () => { S.toggleFavorite(id); await refresh(); } },
    { label: '$(folder-opened) Ouvrir le dossier dans une nouvelle fenêtre', run: () => openFolder(id) },
    { label: '$(copy) Copier la commande de reprise', run: () => copyCommand(id) },
    { label: '$(json) Ouvrir le fichier brut (.jsonl)', run: () => openTranscript(id) },
  ];
  const pick = await vscode.window.showQuickPick(actions, { title: s.title, placeHolder: 'Action' });
  if (pick) pick.run();
}

// ------------------------------------------------------------------ fenêtre de lecture

const readers = new Map();

function readerHtml(webview, extUri) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'reader.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'reader.css'));
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head><body>
<header>
  <div class="head">
    <div class="info"><h1 id="title">Chargement…</h1><div id="meta"></div></div>
    <div class="buttons">
      <button id="resume" class="primary">▶ Reprendre</button>
      <button id="reload" title="Recharger la conversation">⟳</button>
      <button id="raw" title="Ouvrir le fichier .jsonl brut">Fichier brut</button>
    </div>
  </div>
  <div class="search">
    <input id="q" type="search" placeholder="Rechercher dans la conversation…  (Ctrl+F)">
    <span id="count"></span>
    <button id="prev" title="Précédent (Maj+Entrée)">↑</button>
    <button id="next" title="Suivant (Entrée)">↓</button>
    <label title="Afficher les appels d'outils de Claude"><input type="checkbox" id="tools"> outils</label>
  </div>
</header>
<main id="list"></main>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
}

async function openReader(id, query) {
  const s = find(id);
  if (!s) return;
  if (s.attention === 'done') { S.markSeen(id); refresh(); }
  const existing = readers.get(id);
  if (existing) {
    existing.reveal();
    if (query) existing.webview.postMessage({ type: 'query', query });
    return;
  }
  const ext = ctxRef.extensionUri;
  const short = t => (t.length > 40 ? t.slice(0, 39) + '…' : t);
  const panel = vscode.window.createWebviewPanel(
    'claudeSessions.reader',
    short(s.title),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ext, 'media')] }
  );
  panel.iconPath = vscode.Uri.joinPath(ext, 'media', 'icon.svg');
  readers.set(id, panel);
  panel.onDidDispose(() => readers.delete(id));

  const load = async q => {
    const cur = find(id) || s;
    const messages = await S.readConversation(cur.file);
    panel.title = short(cur.title);
    panel.webview.postMessage({
      type: 'conversation',
      session: { id: cur.id, title: cur.title, cwd: cur.cwd, branch: cur.branch, mtime: cur.mtime, active: cur.attention === 'working' },
      messages,
      query: q,
    });
  };

  panel.webview.onDidReceiveMessage(async m => {
    if (m.type === 'ready') await load(query);
    if (m.type === 'reload') { await refresh(); await load(); }
    if (m.type === 'resume') goTo(id);
    if (m.type === 'raw') openTranscript(id);
  });
  panel.webview.html = readerHtml(panel.webview, ext);
}

// ------------------------------------------------------------------ recherche rapide (Ctrl+Alt+C)

const ICON = { waiting: '$(bell-dot) ', question: '$(question) ', done: '$(check) ', working: '$(sync~spin) ' };

async function quickSearch() {
  if (!sessions.length) await refresh();
  const rank = s => (s.attention === 'waiting' || s.attention === 'question' ? 0 : s.attention === 'done' ? 1 : s.favorite ? 2 : 3);
  const ordered = sessions.filter(s => !s.archived).sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
  const items = ordered.map(s => ({
    label: `${ICON[s.attention] || ''}${s.favorite ? '$(star-full) ' : ''}${s.title}`,
    description: `${shortPath(s.cwd)}  $(git-branch) ${s.branch || '—'}  · ${ago(s.mtime)}${s.tags.length ? '  · #' + s.tags.join(' #') : ''}`,
    detail: s.lastPrompt || s.firstPrompt,
    id: s.id,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Chercher une conversation (titre, dossier, branche, étiquette, message)…',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) goTo(pick.id);
}

// ------------------------------------------------------------------ panneau latéral

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
    view.webview.html = sidebarHtml(view.webview, this.ctx.extensionUri);
    view.webview.onDidReceiveMessage(async m => {
      switch (m.type) {
        case 'ready': await refresh(); break;
        case 'refresh': await refresh(); break;
        case 'resume': goTo(m.id); break;
        case 'read': openReader(m.id, m.query); break;
        case 'more': moreActions(m.id); break;
        case 'favorite': S.toggleFavorite(m.id); await refresh(); break;
        case 'archive': S.toggleArchived(m.id); await refresh(); break;
        case 'rename': await rename(m.id); break;
        case 'tags': await editTags(m.id); break;
        case 'search': {
          const seq = ++this.searchSeq;
          this.post({ type: 'searching', query: m.query });
          const hits = await S.searchContent(sessions, m.query);
          if (seq === this.searchSeq) this.post({ type: 'contentHits', query: m.query, hits });
          break;
        }
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) refresh(); });
    view.onDidDispose(() => { this.view = null; });
    updateIndicators();
  }
}

function sidebarHtml(webview, extUri) {
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
  <input id="q" type="search" placeholder="Rechercher : titre, dossier, branche, #étiquette…" autofocus>
  <div class="filters full-only">
    <label><input type="checkbox" id="content"> dans tout le contenu</label>
    <label><input type="checkbox" id="here"> ce dossier</label>
    <label><input type="checkbox" id="favs"> favoris</label>
    <label><input type="checkbox" id="arch"> archives</label>
  </div>
  <div class="filters">
    <label title="Une ligne par conversation : son état et son titre"><input type="checkbox" id="compact"> compact</label>
    <span class="seg" id="group">
      <button data-group="date">Par date</button><button data-group="project">Par projet</button>
    </span>
    <span id="count"></span>
  </div>
</div>
<div id="list"></div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
}

// ------------------------------------------------------------------ activation

function activate(ctx) {
  ctxRef = ctx;
  provider = new SessionsView(ctx);

  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.text = '$(comment-discussion) Conversations';
  bar.command = 'claudeSessions.focus';
  bar.show();

  ctx.subscriptions.push(
    bar,
    vscode.window.registerWebviewViewProvider('claudeSessions.list', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeSessions.search', quickSearch),
    vscode.commands.registerCommand('claudeSessions.refresh', refresh),
    vscode.commands.registerCommand('claudeSessions.focus', () =>
      vscode.commands.executeCommand('workbench.view.extension.claudeSessions')),
    // Cliquer sur l'onglet d'un terminal dont Claude a terminé : c'est vu, le vert s'en va.
    vscode.window.onDidChangeActiveTerminal(t => {
      const id = t && sessionOfTerminal(t);
      const s = id && find(id);
      if (s && s.attention === 'done') { S.markSeen(id); refresh(); }
    }),
    vscode.window.onDidChangeWindowState(st => { if (st.focused) refresh(); }),
    vscode.window.onDidOpenTerminal(() => setTimeout(refresh, 3000)),
    vscode.window.onDidCloseTerminal(() => refresh())
  );

  // Rafraîchit quand une conversation est écrite, quand une session change de statut, et quand
  // une autre fenêtre change un favori, un nom, une étiquette… ; et toutes les 15 s.
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 800); };
  const watch = (dir, opts, keep) => {
    try {
      const w = fs.watch(dir, opts, (_e, f) => { if (f && keep(f)) later(); });
      ctx.subscriptions.push({ dispose: () => w.close() });
    } catch { /* dossier absent */ }
  };
  watch(S.PROJECTS, { recursive: true }, f => f.endsWith('.jsonl'));
  watch(path.join(S.DATA_DIR, 'sessions'), {}, f => f.endsWith('.json'));
  const stores = new Set(Object.values(S.STORES).map(p => path.basename(p)));
  watch(S.DATA_DIR, {}, f => stores.has(f));
  const tick = setInterval(refresh, 15000);
  ctx.subscriptions.push({ dispose: () => clearInterval(tick) });

  refresh();
  if (cfg().openOnStartup) vscode.commands.executeCommand('workbench.view.extension.claudeSessions');

  // Indexe le contenu en arrière-plan pour que la première recherche plein texte soit instantanée.
  setTimeout(async () => {
    try { await refresh(); await S.searchContent(sessions, '\u0000'); } catch { /* sans importance */ }
  }, 8000);
}

function deactivate() {}

module.exports = { activate, deactivate };
