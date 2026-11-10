(function () {
  const vscode = acquireVsCodeApi();
  const $q = document.getElementById('q');
  const $content = document.getElementById('content');
  const $here = document.getElementById('here');
  const $favs = document.getElementById('favs');
  const $list = document.getElementById('list');
  const $count = document.getElementById('count');

  const saved = vscode.getState() || {};
  $q.value = saved.q || '';
  $content.checked = !!saved.content;
  $here.checked = !!saved.here;
  $favs.checked = !!saved.favs;

  let sessions = [];
  let workspace = [];
  let contentHits = null; // { id: extrait } quand la recherche plein texte est active
  let searching = false;
  let debounce = null;

  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "à l'instant";
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h';
    const d = Math.round(h / 24);
    return d === 1 ? 'hier' : d + ' j';
  }

  function group(s) {
    if (s.favorite) return '★ Favoris';
    if (s.active) return 'En cours';
    const d = new Date(s.mtime);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t = d.getTime();
    if (t >= today.getTime()) return "Aujourd'hui";
    if (t >= today.getTime() - 86400000) return 'Hier';
    if (t >= today.getTime() - 6 * 86400000) return 'Cette semaine';
    if (t >= today.getTime() - 30 * 86400000) return 'Ce mois-ci';
    return 'Plus ancien';
  }

  function place(cwd) {
    if (!cwd) return { name: '?', parent: '' };
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return { name: parts[parts.length - 1], parent: parts[parts.length - 2] || '' };
  }

  const isHere = s => s.cwd && workspace.some(w => s.cwd.toLowerCase().startsWith(w.toLowerCase()));

  function save() {
    vscode.setState({ q: $q.value, content: $content.checked, here: $here.checked, favs: $favs.checked });
  }

  function render() {
    const words = norm($q.value).split(/\s+/).filter(Boolean);
    // Favoris en tête, le reste par date (l'ordre reçu est déjà du plus récent au plus ancien).
    let list = [...sessions.filter(s => s.favorite), ...sessions.filter(s => !s.favorite)];
    if ($here.checked) list = list.filter(isHere);
    if ($favs.checked) list = list.filter(s => s.favorite);
    if (words.length) {
      list = list.filter(s => {
        if (contentHits && contentHits[s.id]) return true;
        const hay = norm([s.title, s.autoTitle, s.cwd, s.branch, s.firstPrompt, s.lastPrompt, s.id].join(' '));
        return words.every(w => hay.includes(w));
      });
    }
    $count.textContent = searching ? 'recherche…' : list.length + ' / ' + sessions.length;

    if (!list.length) {
      const msg = !sessions.length ? 'Chargement…'
        : $favs.checked && !words.length ? 'Aucun favori. Clique sur ☆ à côté d\'une conversation pour l\'ajouter.'
        : 'Aucune conversation ne correspond.';
      $list.innerHTML = '<div class="empty">' + esc(msg) + '</div>';
      return;
    }

    let html = '';
    let current = null;
    for (const s of list) {
      const g = group(s);
      if (g !== current) { current = g; html += '<div class="group">' + esc(g) + '</div>'; }
      const p = place(s.cwd);
      const snippet = contentHits && contentHits[s.id] ? contentHits[s.id] : (s.lastPrompt || s.firstPrompt);
      const branch = s.branch && s.branch !== 'HEAD' ? s.branch : (s.branch === 'HEAD' ? 'HEAD' : '—');
      html +=
        '<div class="card' + (s.active ? ' active' : '') + (s.cwdExists ? '' : ' gone') + '" data-id="' + esc(s.id) + '" title="' +
        esc((s.renamed ? 'Titre automatique : ' + s.autoTitle + '\n' : '') + s.cwd + '\nBranche : ' + (s.branch || '—') +
          '\nID : ' + s.id + '\nCliquer pour reprendre, double-cliquer sur le titre pour renommer') + '">' +
          '<div class="row1">' +
            (s.active ? '<span class="dot" title="Modifiée il y a moins de quelques minutes : probablement ouverte ailleurs"></span>' : '') +
            '<span class="title' + (s.renamed ? ' renamed' : '') + '">' + esc(s.title) + '</span>' +
            '<span class="time">' + esc(ago(s.mtime)) + '</span>' +
            '<button class="star' + (s.favorite ? ' on' : '') + '" data-act="favorite" title="' +
              (s.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris') + '">' + (s.favorite ? '★' : '☆') + '</button>' +
          '</div>' +
          '<div class="row2">' +
            '<span class="where">' + (p.parent ? '<span class="parent">' + esc(p.parent) + ' /</span> ' : '') + esc(p.name) + '</span>' +
            '<span class="branch">⎇ ' + esc(branch) + '</span>' +
            (isHere(s) ? '<span class="tag">ce dossier</span>' : '') +
            (s.cwdExists ? '' : '<span class="tag warn">dossier supprimé</span>') +
          '</div>' +
          (snippet ? '<div class="snippet">' + esc(snippet) + '</div>' : '') +
          '<div class="actions">' +
            '<button data-act="resume">▶ Reprendre</button>' +
            '<button data-act="rename">Renommer</button>' +
            '<button data-act="open">Ouvrir le dossier</button>' +
            '<button data-act="copy">Copier la commande</button>' +
            '<button data-act="transcript">Transcript</button>' +
          '</div>' +
        '</div>';
    }
    $list.innerHTML = html;
  }

  function onQuery() {
    save();
    contentHits = null;
    render();
    clearTimeout(debounce);
    if ($content.checked && $q.value.trim().length >= 2) {
      debounce = setTimeout(() => vscode.postMessage({ type: 'search', query: $q.value.trim() }), 350);
    } else {
      searching = false;
    }
  }

  $q.addEventListener('input', onQuery);
  $content.addEventListener('change', onQuery);
  $here.addEventListener('change', () => { save(); render(); });
  $favs.addEventListener('change', () => { save(); render(); });
  $q.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = $list.querySelector('.card');
      if (first) vscode.postMessage({ type: 'resume', id: first.dataset.id });
    }
    if (e.key === 'Escape') { $q.value = ''; onQuery(); }
  });

  // Un clic simple sur une carte reprend la conversation ; on le retarde un peu pour
  // qu'un double-clic sur le titre renomme sans lancer aussi la reprise.
  let clickTimer = null;
  $list.addEventListener('dblclick', e => {
    const card = e.target.closest('.card');
    if (!card || !e.target.closest('.title')) return;
    clearTimeout(clickTimer);
    vscode.postMessage({ type: 'rename', id: card.dataset.id });
  });

  $list.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (!e.target.closest('button') && e.target.closest('.title')) {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => vscode.postMessage({ type: 'resume', id: card.dataset.id }), 250);
      return;
    }
    const btn = e.target.closest('button');
    vscode.postMessage({ type: btn ? btn.dataset.act : 'resume', id: card.dataset.id });
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'sessions') { sessions = m.sessions; workspace = m.workspace || []; render(); }
    if (m.type === 'searching') { searching = true; render(); }
    if (m.type === 'contentHits' && m.query === $q.value.trim()) { searching = false; contentHits = m.hits; render(); }
  });

  render();
  vscode.postMessage({ type: 'ready' });
  if ($content.checked && $q.value.trim()) onQuery();
})();
