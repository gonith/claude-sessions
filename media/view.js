(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const $q = $('q'), $content = $('content'), $here = $('here'), $favs = $('favs'), $arch = $('arch');
  const $list = $('list'), $count = $('count'), $group = $('group');

  const saved = vscode.getState() || {};
  $q.value = saved.q || '';
  $content.checked = !!saved.content;
  $here.checked = !!saved.here;
  $favs.checked = !!saved.favs;
  $arch.checked = !!saved.arch;
  let groupMode = saved.group || 'date';
  const $compact = $('compact');
  $compact.checked = !!saved.compact;
  document.body.classList.toggle('compact', $compact.checked);

  let sessions = [];
  let workspace = [];
  let contentHits = null; // { id: extrait } quand la recherche plein texte est active
  let searching = false;
  let debounce = null;

  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  function dateGroup(s) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t = s.mtime, d0 = today.getTime(), day = 86400000;
    if (t >= d0) return "Aujourd'hui";
    if (t >= d0 - day) return 'Hier';
    if (t >= d0 - 6 * day) return 'Cette semaine';
    if (t >= d0 - 30 * day) return 'Ce mois-ci';
    return 'Plus ancien';
  }

  const isHere = s => s.cwd && workspace.some(w => s.cwd.toLowerCase().startsWith(w.toLowerCase()));
  const needsYou = s => s.attention === 'waiting' || s.attention === 'question' || s.attention === 'done';

  // Couleur stable par étiquette.
  function tagClass(t) {
    let h = 0;
    for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return 'c' + (h % 6);
  }

  function save() {
    vscode.setState({ q: $q.value, content: $content.checked, here: $here.checked, favs: $favs.checked, arch: $arch.checked, group: groupMode, compact: $compact.checked });
  }

  function filtered() {
    const words = norm($q.value).split(/\s+/).filter(Boolean);
    return sessions.filter(s => {
      if ($here.checked && !isHere(s)) return false;
      if ($favs.checked && !s.favorite) return false;
      // Les archives sont masquées, sauf avec la case « archives » ou une recherche.
      if ($arch.checked) { if (!s.archived) return false; }
      else if (s.archived && !words.length && !needsYou(s)) return false;
      if (!words.length) return true;
      if (contentHits && contentHits[s.id]) return true;
      const hay = norm([s.title, s.autoTitle, s.cwd, s.branch, s.project, s.worktree, s.firstPrompt, s.lastPrompt, s.id,
        s.tags.map(t => '#' + t).join(' ')].join(' '));
      return words.every(w => hay.includes(w));
    });
  }

  // Sections : ce qui t'attend, ce qui tourne, les favoris, puis le reste par date ou par projet.
  function sections(list) {
    const out = [];
    const used = new Set();
    const take = (title, cls, pred) => {
      const items = list.filter(s => !used.has(s.id) && pred(s));
      items.forEach(s => used.add(s.id));
      if (items.length) out.push({ title, cls, items });
    };
    take("À toi de jouer", 'g-you', needsYou);
    take('Claude travaille', 'g-work', s => s.attention === 'working');
    take('★ Favoris', 'g-fav', s => s.favorite);
    const rest = list.filter(s => !used.has(s.id));
    if (groupMode === 'project') {
      const byProject = new Map();
      for (const s of rest) {
        const key = s.project || '?';
        if (!byProject.has(key)) byProject.set(key, new Map());
        const wt = byProject.get(key);
        const wkey = s.worktree || '';
        if (!wt.has(wkey)) wt.set(wkey, []);
        wt.get(wkey).push(s);
      }
      for (const [project, wts] of byProject) {
        const showSub = wts.size > 1 || [...wts.keys()][0] !== '';
        const n = [...wts.values()].reduce((a, b) => a + b.length, 0);
        out.push({ title: project, cls: 'g-project', count: n, items: [] });
        for (const [wt, items] of wts) {
          if (showSub) out.push({ title: wt || '(racine)', cls: 'g-worktree', items });
          else out[out.length - 1].items = items;
        }
      }
    } else {
      let cur = null;
      for (const s of rest) {
        const g = dateGroup(s);
        if (!cur || cur.title !== g) { cur = { title: g, cls: 'g-date', items: [] }; out.push(cur); }
        cur.items.push(s);
      }
    }
    return out;
  }

  const STATE = {
    waiting: { icon: '●', text: s => "Attend ton feu vert" + (s.waitingFor ? ' — ' + s.waitingFor : '') },
    question: { icon: '?', text: () => "T'a posé une question" },
    done: { icon: '✓', text: () => 'Terminé — pas encore vu' },
    working: { icon: '⟳', text: () => 'Travaille…' },
  };

  function card(s) {
    const st = STATE[s.attention];
    const snippet = contentHits && contentHits[s.id] ? contentHits[s.id]
      : (s.attention === 'question' || s.attention === 'done' || s.attention === 'waiting') && s.lastReply ? 'Claude : ' + s.lastReply
      : (s.lastPrompt || s.firstPrompt);
    const branch = s.branch || '—';
    const where = s.worktree ? s.project + ' / ' + s.worktree : (s.cwd || '?').split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
    const go = s.hasTerminal ? '▶ Aller au terminal' : '▶ Reprendre';
    return '<div class="card att-' + (s.attention || 'none') + (s.cwdExists ? '' : ' gone') + (s.archived ? ' archived' : '') +
      '" data-id="' + esc(s.id) + '" title="' +
      esc((s.renamed ? 'Titre automatique : ' + s.autoTitle + '\n' : '') + s.cwd + '\nBranche : ' + branch + '\nID : ' + s.id +
        '\n' + (s.hasTerminal ? 'Cliquer pour aller à son terminal' : 'Cliquer pour reprendre') + ', double-cliquer sur le titre pour renommer') + '">' +
      '<div class="row1">' +
        (st ? '<span class="state" title="' + esc(st.text(s)) + '">' + st.icon + '</span>' : '') +
        '<span class="title' + (s.renamed ? ' renamed' : '') + '">' + esc(s.title) + '</span>' +
        '<span class="time">' + esc(ago(s.mtime)) + '</span>' +
        '<button class="star' + (s.favorite ? ' on' : '') + '" data-act="favorite" title="' +
          (s.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris') + '">' + (s.favorite ? '★' : '☆') + '</button>' +
      '</div>' +
      (st ? '<div class="stateline">' + esc(st.text(s)) + '</div>' : '') +
      '<div class="row2">' +
        '<span class="where">' + esc(where) + '</span>' +
        '<span class="branch">⎇ ' + esc(branch) + '</span>' +
        (s.hasTerminal ? '<span class="tag term" title="Ouverte dans un terminal de cette fenêtre">⌨ terminal</span>' : s.live ? '<span class="tag term" title="Ouverte ailleurs : autre fenêtre VS Code ou terminal extérieur">⌨ ailleurs</span>' : '') +
        s.tags.map(t => '<span class="tag chip ' + tagClass(t) + '" data-tag="' + esc(t) + '" title="Filtrer sur cette étiquette">#' + esc(t) + '</span>').join('') +
        (s.archived ? '<span class="tag">archivée</span>' : '') +
        (isHere(s) ? '<span class="tag">ce dossier</span>' : '') +
        (s.cwdExists ? '' : '<span class="tag warn">dossier supprimé</span>') +
      '</div>' +
      (snippet ? '<div class="snippet">' + esc(snippet) + '</div>' : '') +
      '<div class="actions">' +
        '<button data-act="resume">' + go + '</button>' +
        '<button data-act="read">Lire</button>' +
        '<button data-act="tags">Étiquettes</button>' +
        '<button data-act="archive">' + (s.archived ? 'Désarchiver' : 'Archiver') + '</button>' +
        '<button data-act="more" title="Renommer, ouvrir le dossier, copier la commande…">⋯</button>' +
      '</div>' +
    '</div>';
  }

  function render() {
    for (const b of $group.querySelectorAll('button')) b.classList.toggle('on', b.dataset.group === groupMode);
    const list = filtered();
    const visible = sessions.filter(s => !s.archived).length;
    $count.textContent = searching ? 'recherche…' : list.length + ' / ' + visible;
    if (!list.length) {
      const msg = !sessions.length ? 'Chargement…'
        : $favs.checked ? "Aucun favori ici. Clique sur ☆ à côté d'une conversation pour l'ajouter."
        : $arch.checked ? 'Aucune conversation archivée.'
        : 'Aucune conversation ne correspond.';
      $list.innerHTML = '<div class="empty">' + esc(msg) + '</div>';
      return;
    }
    let html = '';
    for (const sec of sections(list)) {
      html += '<div class="group ' + sec.cls + '">' + esc(sec.title) +
        (sec.cls === 'g-you' || sec.count ? ' <span class="n">' + (sec.count || sec.items.length) + '</span>' : '') + '</div>';
      for (const s of sec.items) html += card(s);
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
  for (const el of [$here, $favs, $arch]) el.addEventListener('change', () => { save(); render(); });
  $compact.addEventListener('change', () => {
    document.body.classList.toggle('compact', $compact.checked);
    save();
  });
  $group.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    groupMode = b.dataset.group;
    save();
    render();
  });
  $q.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = $list.querySelector('.card');
      if (first) vscode.postMessage({ type: 'resume', id: first.dataset.id });
    }
    if (e.key === 'Escape') { $q.value = ''; onQuery(); }
  });

  // Un clic simple sur le titre reprend la conversation ; on le retarde un peu pour qu'un
  // double-clic renomme sans lancer aussi la reprise.
  let clickTimer = null;
  $list.addEventListener('dblclick', e => {
    const c = e.target.closest('.card');
    if (!c || !e.target.closest('.title')) return;
    clearTimeout(clickTimer);
    vscode.postMessage({ type: 'rename', id: c.dataset.id });
  });

  $list.addEventListener('click', e => {
    const c = e.target.closest('.card');
    if (!c) return;
    const chip = e.target.closest('.chip');
    if (chip) {
      $q.value = '#' + chip.dataset.tag;
      onQuery();
      return;
    }
    const btn = e.target.closest('button');
    const msg = { type: btn ? btn.dataset.act : 'resume', id: c.dataset.id, query: $q.value.trim() };
    if (!btn && e.target.closest('.title')) {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => vscode.postMessage(msg), 250);
      return;
    }
    vscode.postMessage(msg);
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
