(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const $list = $('list'), $q = $('q'), $count = $('count'), $tools = $('tools');

  const saved = vscode.getState() || {};
  $tools.checked = !!saved.tools;

  let messages = [];
  let marks = [];
  let current = -1;
  let debounce = null;

  const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normChar = c => c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  // Markdown réduit : blocs de code, `code`, **gras**, titres. Le reste reste du texte brut.
  function md(text) {
    return text.split('```').map((p, i) => {
      if (i % 2) {
        const nl = p.indexOf('\n');
        const code = nl >= 0 && /^[\w+#.-]*$/.test(p.slice(0, nl).trim()) ? p.slice(nl + 1) : p;
        return '<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>';
      }
      const h = esc(p)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6} (.*)$/gm, '<strong class="h">$1</strong>');
      return h.trim() ? '<div class="txt">' + h.replace(/^\n+|\n+$/g, '') + '</div>' : '';
    }).join('');
  }

  const LONG = 1500;

  function render() {
    const showTools = $tools.checked;
    let html = '';
    for (const m of messages) {
      if (m.role === 'note') {
        html += '<div class="note">— ' + esc(m.text) + ' —</div>';
        continue;
      }
      if (m.role === 'user') {
        const long = m.text.length > LONG;
        html += '<div class="msg user' + (long ? ' collapsed' : '') + '">' +
          '<div class="who">Toi <span class="ts">' + esc(when(m.ts)) + '</span></div>' +
          '<div class="body">' + md(m.text) + '</div>' +
          (long ? '<button class="more">Afficher tout</button>' : '') + '</div>';
        continue;
      }
      let body = '';
      let tools = [];
      const flush = () => {
        if (!tools.length) return;
        if (showTools) body += '<div class="tools">' + tools.map(t =>
          '<div class="tool"><span class="tname">' + esc(t.name) + '</span> ' + esc(t.detail) + '</div>').join('') + '</div>';
        else body += '<div class="tools-hidden">' + tools.length + (tools.length > 1 ? ' actions' : ' action') + '</div>';
        tools = [];
      };
      for (const p of m.parts) {
        if (p.kind === 'tool') { tools.push(p); continue; }
        flush();
        body += md(p.text);
      }
      flush();
      html += '<div class="msg claude"><div class="who">Claude <span class="ts">' + esc(when(m.ts)) + '</span></div>' +
        '<div class="body">' + body + '</div></div>';
    }
    $list.innerHTML = html || '<div class="empty">Conversation vide.</div>';
  }

  // Surligne chaque mot de la recherche (sans tenir compte des majuscules ni des accents).
  function highlight() {
    const words = $q.value.split(/\s+/).map(w => [...w].map(normChar).join('')).filter(Boolean);
    marks = [];
    current = -1;
    if (!words.length) { $count.textContent = ''; return; }

    const walker = document.createTreeWalker($list, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement && !n.parentElement.closest('.who, .more, .tools-hidden')) nodes.push(n);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      let norm = '';
      const map = [];
      for (let i = 0; i < text.length; i++) {
        for (const ch of normChar(text[i])) { norm += ch; map.push(i); }
      }
      const ranges = [];
      for (const w of words) {
        let k = norm.indexOf(w);
        while (k !== -1) {
          ranges.push([map[k], map[k + w.length - 1] + 1]);
          k = norm.indexOf(w, k + w.length);
        }
      }
      if (!ranges.length) continue;
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
      }
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [a, b] of merged) {
        if (a > pos) frag.appendChild(document.createTextNode(text.slice(pos, a)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(a, b);
        frag.appendChild(mark);
        marks.push(mark);
        pos = b;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
    if (marks.length) go(0); else $count.textContent = 'aucun résultat';
  }

  function go(i) {
    if (!marks.length) return;
    if (current >= 0 && marks[current]) marks[current].classList.remove('current');
    current = (i + marks.length) % marks.length;
    const m = marks[current];
    m.classList.add('current');
    const msg = m.closest('.msg.collapsed');
    if (msg) expand(msg);
    m.scrollIntoView({ block: 'center' });
    $count.textContent = (current + 1) + ' / ' + marks.length;
  }

  function expand(msg) {
    msg.classList.remove('collapsed');
    const b = msg.querySelector('.more');
    if (b) b.remove();
  }

  function search() {
    render();
    highlight();
  }

  $q.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(search, 200);
  });
  $q.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); go(current + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { $q.value = ''; search(); }
  });
  $('next').addEventListener('click', () => go(current + 1));
  $('prev').addEventListener('click', () => go(current - 1));
  $tools.addEventListener('change', () => { vscode.setState({ tools: $tools.checked }); search(); });
  $('resume').addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  $('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  $('raw').addEventListener('click', () => vscode.postMessage({ type: 'raw' }));
  $list.addEventListener('click', e => {
    if (e.target.classList.contains('more')) expand(e.target.closest('.msg'));
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $q.focus(); $q.select(); }
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'conversation') {
      const s = m.session;
      messages = m.messages;
      $('title').textContent = s.title;
      const where = (s.cwd || '?').split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
      const n = messages.filter(x => x.role === 'user').length;
      $('meta').innerHTML =
        (s.active ? '<span class="live">● en cours</span> ' : '') +
        '<span class="where">' + esc(where) + '</span> · ⎇ ' + esc(s.branch || '—') +
        ' · ' + n + ' message' + (n > 1 ? 's' : '') + ' de ta part';
      $('meta').title = s.cwd + '\nID : ' + s.id;
      if (m.query) $q.value = m.query;
      search();
      if (!marks.length) window.scrollTo(0, document.body.scrollHeight);
    }
    if (m.type === 'query') { $q.value = m.query; search(); }
  });

  vscode.postMessage({ type: 'ready' });
})();
