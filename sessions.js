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

// Texte tapé par l'utilisateur, ou null si le message n'en est pas un
// (résultat d'outil, commande slash, message système…).
function promptText(o) {
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
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
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
    if (!line) continue;
    const head = line.slice(0, 400);
    if (!/"type":"(user|assistant|ai-title|custom-title|summary)"/.test(head)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) res.title = o.aiTitle;
    else if (o.type === 'custom-title' && o.customTitle) res.customTitle = o.customTitle;
    else if (o.type === 'summary' && o.summary && !res.title) res.title = o.summary;
    if (o.type === 'user' || o.type === 'assistant') {
      if (o.cwd) res.cwd = o.cwd;
      if (o.gitBranch) res.branch = o.gitBranch;
      if (o.timestamp) res.lastTs = o.timestamp;
      const t = promptText(o);
      if (t) res.lastPrompt = t;
    }
  }
  return res;
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
    if (!line || line.length > 4 * 1024 * 1024) continue;
    const m = /"type":"(user|assistant)"/.exec(line.slice(0, 400));
    if (!m) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const t = m[1] === 'user' ? promptText(o) : assistantText(o);
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

// Favoris : un fichier JSON partagé par toutes les fenêtres VS Code.
const FAVORITES = path.join(os.homedir(), '.claude', 'claude-sessions-favoris.json');

function readFavorites() {
  try {
    const v = JSON.parse(fs.readFileSync(FAVORITES, 'utf8'));
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

function toggleFavorite(id) {
  const favs = readFavorites();
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  fs.writeFileSync(FAVORITES, JSON.stringify([...favs], null, 2));
  return favs;
}

// Noms donnés à la main : { id: nom }, partagés eux aussi par toutes les fenêtres.
const NAMES = path.join(os.homedir(), '.claude', 'claude-sessions-noms.json');

function readNames() {
  try {
    const v = JSON.parse(fs.readFileSync(NAMES, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Un nom vide rend à la conversation son titre automatique.
function setName(id, name) {
  const names = readNames();
  const n = (name || '').trim();
  if (n) names[id] = n; else delete names[id];
  fs.writeFileSync(NAMES, JSON.stringify(names, null, 2));
  return names;
}

module.exports = {
  PROJECTS, FAVORITES, NAMES,
  listSessions, searchContent, normalize,
  readFavorites, toggleFavorite, readNames, setName,
};
