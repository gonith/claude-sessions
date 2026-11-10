// Sessions Claude ouvertes en ce moment, et projet git de chaque dossier.
// Aucun appel à l'API vscode ici.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// Claude Code tient un registre de ses processus : ~/.claude/sessions/<pid>.json, avec
// l'identifiant de la conversation et un statut : « busy » (il travaille), « waiting »
// (il attend une autorisation ou une réponse, détail dans waitingFor) ou « idle » (tour terminé).
// Ce format est interne à Claude Code : s'il change, l'extension retombe sur les transcripts.
const REGISTRY = path.join(os.homedir(), '.claude', 'sessions');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// { sessionId: { pid, status, waitingFor, since, cwd } } pour les sessions dont le processus vit.
async function readLive() {
  let names;
  try { names = await fsp.readdir(REGISTRY); } catch { return { available: false, sessions: {} }; }
  const sessions = {};
  await Promise.all(names.filter(n => /^\d+\.json$/.test(n)).map(async n => {
    let o;
    try { o = JSON.parse(await fsp.readFile(path.join(REGISTRY, n), 'utf8')); } catch { return; }
    if (!o || !o.sessionId || !o.pid || !alive(o.pid)) return;
    const prev = sessions[o.sessionId];
    if (prev && prev.since > (o.statusUpdatedAt || 0)) return;
    sessions[o.sessionId] = {
      pid: o.pid,
      status: o.status || null,
      waitingFor: o.waitingFor || null,
      since: o.statusUpdatedAt || o.updatedAt || 0,
      cwd: o.cwd,
    };
  }));
  return { available: true, sessions };
}

// Parent de chaque processus, pour remonter de claude jusqu'au shell de son terminal.
function processParents() {
  return new Promise(resolve => {
    const done = out => {
      const map = new Map();
      for (const line of (out || '').split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) map.set(Number(m[1]), Number(m[2]));
      }
      resolve(map);
    };
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
        { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => done(err ? '' : out));
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 15000 }, (err, out) => done(err ? '' : out));
    }
  });
}

// Le premier ancêtre de `pid` qui fait partie de `targets` (les shells des terminaux), ou null.
function findAncestor(pid, parents, targets) {
  let cur = pid;
  for (let i = 0; i < 12 && cur; i++) {
    if (targets.has(cur)) return cur;
    cur = parents.get(cur);
  }
  return null;
}

// Projet git d'un dossier : { project, worktree }. Pour un worktree, le projet est le dépôt
// commun (le dossier qui contient .git ou .bare), le worktree est le dossier de travail.
const projectCache = new Map();

function projectOf(cwd) {
  if (!cwd) return { project: '?', worktree: null };
  if (projectCache.has(cwd)) return projectCache.get(cwd);
  let res = { project: path.basename(cwd), worktree: null, root: cwd };
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* pas ici */ }
    if (st && st.isDirectory()) {
      res = { project: path.basename(dir), worktree: null, root: dir };
      break;
    }
    if (st && st.isFile()) {
      let common = null;
      try {
        const m = fs.readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
        if (m) {
          const gitdir = path.resolve(dir, m[1].trim());
          const k = gitdir.replace(/\\/g, '/').lastIndexOf('/worktrees/');
          common = k >= 0 ? gitdir.slice(0, k) : gitdir;
        }
      } catch { /* illisible */ }
      let repoDir = common ? path.dirname(common) : dir;
      // .git ou .bare dans le dossier du projet : le projet porte le nom de ce dossier.
      if (common && !['.git', '.bare'].includes(path.basename(common))) repoDir = common;
      res = { project: path.basename(repoDir), worktree: path.basename(dir), root: dir };
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  projectCache.set(cwd, res);
  return res;
}

module.exports = { readLive, processParents, findAncestor, projectOf };
