// Lecture des conversations Claude Code stockées dans ~/.claude/projects/<dossier>/<id>.jsonl.
// Aucun appel à l'API vscode ici : ce module se teste avec `node test.js`.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 512 * 1024;

const metaCache = new Map(); // fichier -> { key, meta }
const textCache = new Map(); // fichier -> { key, text }

function cacheKey(st) {
  return st.mtimeMs + ':' + st.size;
}

// Texte tapé par l'utilisateur, mise en forme conservée, ou null si le message n'en est pas un
// (résultat d'outil, commande slash, message système…).
function rawPrompt(o) {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message && o.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) t = c.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
  if (!t) return null;
  if (/^\s*<(local-command|command-name|command-message|command-args|bash-|task-notification)/.test(t)) return null;
  if (/^\s*Caveat:/.test(t)) return null;
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
  return t || null;
}

function promptText(o) {
  const t = rawPrompt(o);
  return t ? t.replace(/\s+/g, ' ') : null;
}

// Résumé d'un appel d'outil en une ligne : « Bash — Liste les fichiers ».
function toolLine(b) {
  const i = b.input || {};
  const d = i.description || i.file_path || i.path || i.pattern || i.command || i.url || i.query || i.prompt || '';
  return { kind: 'tool', name: b.name || 'outil', detail: String(d).replace(/\s+/g, ' ').slice(0, 200) };
}

// Décode une ligne seulement si c'est un message (utilisateur ou Claude).
// Le champ "type" d'un message peut se trouver n'importe où dans la ligne (après "message" pour
// les réponses de Claude) ; les autres enregistrements, eux, commencent par {"type":"…"} et sont
// écartés sans être décodés, ce qui compte pour les blobs de requête de plusieurs Mo.
function parseMessage(line) {
  if (!line || line.length > 4 * 1024 * 1024) return null;
  if (line.startsWith('{"type":"') && !/^\{"type":"(user|assistant)"/.test(line)) return null;
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  return o && (o.type === 'user' || o.type === 'assistant') ? o : null;
}

// La conversation sous forme de discussion : un message par prise de parole.
// Les réponses de Claude regroupent, dans l'ordre, leurs textes et leurs appels d'outils.
async function readConversation(file) {
  const messages = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const o = parseMessage(line);
    if (!o || o.isSidechain) continue;
    if (o.type === 'user') {
      const t = rawPrompt(o);
      if (!t) continue;
      if (/^\[Request interrupted/.test(t)) messages.push({ role: 'note', text: 'Interrompu par l\'utilisateur', ts: o.timestamp });
      else messages.push({ role: 'user', text: t, ts: o.timestamp });
      continue;
    }
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      let part = null;
      if (b && b.type === 'text' && b.text && b.text.trim()) part = { kind: 'text', text: b.text };
      else if (b && b.type === 'tool_use') part = toolLine(b);
      if (!part) continue;
      let last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') {
        last = { role: 'assistant', parts: [], ts: o.timestamp };
        messages.push(last);
      }
      const prev = last.parts[last.parts.length - 1];
      if (part.kind === 'text' && prev && prev.kind === 'text') prev.text += '\n\n' + part.text;
      else last.parts.push(part);
    }
  }
  return messages;
}

function assistantText(o) {
  const c = o && o.message && o.message.content;
  if (!Array.isArray(c)) return '';
  return c.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
}

// Lit le début du fichier ligne à ligne jusqu'au premier vrai message utilisateur.
// Une ligne peut peser plusieurs Mo (texte collé) : on ne coupe donc pas à un nombre d'octets.
async function readHead(file) {
  const res = { firstPrompt: null, cwd: null, branch: null, firstTs: null, entrypoint: null };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 3000) break;
      if (!line || !/"type":"user"/.test(line.slice(0, 400))) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!res.cwd && o.cwd) res.cwd = o.cwd;
      if (!res.branch && o.gitBranch) res.branch = o.gitBranch;
      if (!res.firstTs && o.timestamp) res.firstTs = o.timestamp;
      if (!res.entrypoint && o.entrypoint) res.entrypoint = o.entrypoint;
      const t = promptText(o);
      if (t) { res.firstPrompt = t; break; }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return res;
}

async function readTail(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await fsp.open(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // ligne coupée
  const res = { title: null, customTitle: null, lastPrompt: null, cwd: null, branch: null, lastTs: null };
  for (const line of lines) {
    let o = null;
    if (/^\{"type":"(ai-title|custom-title|summary)"/.test(line)) {
      try { o = JSON.parse(line); } catch { continue; }
    } else {
      o = parseMessage(line);
    }
    if (!o) continue;
    if (o.type === 'ai-title' && o.aiTitle) res.title = o.aiTitle;
    else if (o.type === 'custom-title' && o.customTitle) res.customTitle = o.customTitle;
    else if (o.type === 'summary' && o.summary && !res.title) res.title = o.summary;
    if (o.type === 'user' || o.type === 'assistant') {
      if (o.cwd) res.cwd = o.cwd;
      if (o.gitBranch) res.branch = o.gitBranch;
      if (o.timestamp) res.lastTs = o.timestamp;
      const t = promptText(o);
      if (t) res.lastPrompt = t;
      if (!o.isSidechain) trackEnding(res, o);
    }
  }
  return res;
}

// Ce sur quoi la conversation s'arrête : une réponse de Claude (et finit-elle par une question ?),
// une question posée avec l'outil AskUserQuestion, ou un échange encore en cours.
function trackEnding(res, o) {
  const c = o.message && Array.isArray(o.message.content) ? o.message.content : null;
  if (o.type === 'user') {
    res.lastKind = c && c.some(b => b && b.type === 'tool_result') ? 'tool' : 'prompt';
    return;
  }
  if (!c) return;
  if (c.some(b => b && b.type === 'tool_use' && b.name === 'AskUserQuestion')) { res.lastKind = 'ask'; return; }
  if (c.some(b => b && b.type === 'tool_use')) { res.lastKind = 'tool'; return; }
  const text = c.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
  if (text) { res.lastKind = 'reply'; res.lastReply = text; }
}

function endsWithQuestion(text) {
  const lines = (text || '').split('\n').map(l => l.replace(/[*_`>\s]+$/g, '').trim()).filter(Boolean);
  return lines.length > 0 && /\?$/.test(lines[lines.length - 1]);
}

async function readMeta(file, st, projectDir) {
  const [head, tail] = await Promise.all([readHead(file), readTail(file, st.size)]);
  const cwd = tail.cwd || head.cwd;
  const firstPrompt = head.firstPrompt;
  if (!firstPrompt && !tail.lastPrompt) return null; // session vide
  const title = tail.customTitle || tail.title || (firstPrompt || tail.lastPrompt).slice(0, 90);
  return {
    id: path.basename(file, '.jsonl'),
    file,
    projectDir,
    cwd,
    branch: tail.branch || head.branch,
    title,
    firstPrompt: firstPrompt ? firstPrompt.slice(0, 400) : '',
    lastPrompt: tail.lastPrompt ? tail.lastPrompt.slice(0, 400) : '',
    createdAt: head.firstTs,
    entrypoint: head.entrypoint,
    lastMessageAt: tail.lastTs ? Date.parse(tail.lastTs) : 0,
    lastReply: tail.lastReply ? tail.lastReply.replace(/\s+/g, ' ').slice(-300) : '',
    // Claude a terminé son tour en te posant une question.
    asks: tail.lastKind === 'ask' || (tail.lastKind === 'reply' && endsWithQuestion(tail.lastReply)),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch { out[k] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function listFiles() {
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS, { withFileTypes: true }); } catch { return []; }
  const files = [];
  await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => {
    const dir = path.join(PROJECTS, d.name);
    let names;
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const n of names) if (n.endsWith('.jsonl')) files.push({ file: path.join(dir, n), projectDir: d.name });
  }));
  await mapLimit(files, 32, async f => { f.st = await fsp.stat(f.file); });
  return files.filter(f => f.st);
}

// `keep` : identifiants toujours listés même au-delà de `max` (les favoris).
async function listSessions({ max = 300, activeMinutes = 3, keep = new Set() } = {}) {
  const files = (await listFiles())
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .filter((f, i) => i < max || keep.has(path.basename(f.file, '.jsonl')));
  const now = Date.now();
  const metas = await mapLimit(files, 8, async f => {
    const key = cacheKey(f.st);
    const hit = metaCache.get(f.file);
    let meta;
    if (hit && hit.key === key) meta = hit.meta;
    else {
      meta = await readMeta(f.file, f.st, f.projectDir);
      metaCache.set(f.file, { key, meta });
    }
    if (!meta) return null;
    return {
      ...meta,
      mtime: f.st.mtimeMs,
      size: f.st.size,
      active: now - f.st.mtimeMs < activeMinutes * 60 * 1000,
      cwdExists: !!meta.cwd && fs.existsSync(meta.cwd),
    };
  });
  return metas.filter(Boolean);
}

// Texte complet (messages utilisateur + réponses) d'une conversation, en minuscules, mis en cache.
async function fullText(file) {
  const st = await fsp.stat(file);
  const key = cacheKey(st);
  const hit = textCache.get(file);
  if (hit && hit.key === key) return hit.text;
  const parts = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const o = parseMessage(line);
    if (!o || o.isSidechain) continue;
    const t = o.type === 'user' ? promptText(o) : assistantText(o);
    if (t) parts.push(t);
  }
  const text = parts.join('\n').toLowerCase();
  textCache.set(file, { key, text });
  return text;
}

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Recherche dans le contenu complet ; renvoie { id: extrait } pour les conversations qui contiennent tous les mots.
async function searchContent(sessions, query) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return {};
  const hits = {};
  await mapLimit(sessions, 4, async s => {
    const raw = await fullText(s.file);
    const text = normalize(raw);
    if (!words.every(w => text.includes(w))) return;
    const i = text.indexOf(words[0]);
    const a = Math.max(0, i - 60);
    hits[s.id] = (a > 0 ? '…' : '') + raw.slice(a, i + 120).replace(/\s+/g, ' ') + '…';
  });
  return hits;
}

// Données de l'extension : de petits fichiers JSON dans ~/.claude, partagés par toutes les fenêtres
// VS Code (l'état interne de VS Code, lui, est propre à chaque fenêtre).
const DATA_DIR = path.join(os.homedir(), '.claude');
const STORES = {
  favorites: path.join(DATA_DIR, 'claude-sessions-favoris.json'),   // [id]
  names: path.join(DATA_DIR, 'claude-sessions-noms.json'),          // { id: nom }
  tags: path.join(DATA_DIR, 'claude-sessions-etiquettes.json'),     // { id: [étiquette] }
  archived: path.join(DATA_DIR, 'claude-sessions-archives.json'),   // [id]
  seen: path.join(DATA_DIR, 'claude-sessions-vu.json'),             // { id: horodatage ms }
};

function readStore(name, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(STORES[name], 'utf8'));
    return Array.isArray(fallback) === Array.isArray(v) && v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(name, value) {
  fs.writeFileSync(STORES[name], JSON.stringify(value, null, 2));
}

function readFavorites() {
  return new Set(readStore('favorites', []));
}

function toggleFavorite(id) {
  const favs = readFavorites();
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  writeStore('favorites', [...favs]);
}

function readArchived() {
  return new Set(readStore('archived', []));
}

function toggleArchived(id) {
  const set = readArchived();
  if (set.has(id)) set.delete(id); else set.add(id);
  writeStore('archived', [...set]);
}

function readNames() {
  return readStore('names', {});
}

// Un nom vide rend à la conversation son titre automatique.
function setName(id, name) {
  const names = readNames();
  const n = (name || '').trim();
  if (n) names[id] = n; else delete names[id];
  writeStore('names', names);
}

function readTags() {
  return readStore('tags', {});
}

function setTags(id, tags) {
  const all = readTags();
  const clean = [...new Set(tags.map(t => t.trim()).filter(Boolean))];
  if (clean.length) all[id] = clean; else delete all[id];
  writeStore('tags', all);
}

function readSeen() {
  return readStore('seen', {});
}

function markSeen(id) {
  const seen = readSeen();
  seen[id] = Date.now();
  writeStore('seen', seen);
}

module.exports = {
  PROJECTS, DATA_DIR, STORES,
  listSessions, searchContent, normalize, readConversation,
  readFavorites, toggleFavorite, readArchived, toggleArchived,
  readNames, setName, readTags, setTags, readSeen, markSeen,
};
