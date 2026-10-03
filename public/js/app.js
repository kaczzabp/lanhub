

'use strict';

let me = null;
let isAdmin = false;
let socket = null;
let serverInfo = null;
let polls = [];
let buttons = [];
let checklist = null;
let onlineUsers = [];
let showingMatrix = false;
let currentAnnouncement = null;
let dismissedAnnouncement = Number(sessionStorage.getItem('lansite-dismissed-ann')) || null;
let clockModeEnabled = false;

// Menu state
let menu = null;
let myMenuOrder = []; // array of selected item IDs
let menuPage = 0;    // current left-page index (0-based, step by 2 on desktop)
let menuSaveTimer = null;
let menuSections = []; // builder state

let langData = {};

(async function init() {
  await loadLanguage();
  startClock();
  await checkSession();
})();

function startClock() {
  function tick() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('clock-time').textContent = `${h}:${m}:${s}`;
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    const dateStr = now.toLocaleDateString(undefined, opts);
    document.getElementById('clock-date').textContent = dateStr;

    // Clock Mode Elements
    const cmTime = document.getElementById('clock-mode-time');
    if (cmTime) cmTime.textContent = `${h}:${m}:${s}`;
    const cmDate = document.getElementById('clock-mode-date');
    if (cmDate) cmDate.textContent = dateStr;
  }
  tick();
  setInterval(tick, 1000);
}

async function checkSession() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.loggedIn) {
      me = data.user;
      isAdmin = data.isAdmin;
      enterApp();
    }

  } catch (e) {

  }
}

function switchLoginTab(tab) {
  document.getElementById('tab-guest').classList.toggle('active', tab === 'guest');
  document.getElementById('tab-admin').classList.toggle('active', tab === 'admin');
  document.getElementById('login-guest-form').classList.toggle('hidden', tab !== 'guest');
  document.getElementById('login-admin-form').classList.toggle('hidden', tab !== 'admin');
  document.getElementById('login-error').textContent = '';
}

async function doGuestLogin() {
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) { showLoginError('Enter your code'); return; }
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) { showLoginError(data.error || 'Login failed'); return; }
    me = data.user; isAdmin = false;
    enterApp();
  } catch (e) { showLoginError('Server error'); }
}

async function doAdminLogin() {
  const pass = document.getElementById('input-admin-pass').value;
  if (!pass) { showLoginError('Enter password'); return; }
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: pass }),
    });
    const data = await res.json();
    if (!res.ok) { showLoginError(data.error || 'Wrong password'); return; }
    me = data.user; isAdmin = true;
    enterApp();
  } catch (e) { showLoginError('Server error'); }
}

function showLoginError(msg) {
  document.getElementById('login-error').textContent = '✕ ' + msg;
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

async function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('header').classList.remove('hidden');
  document.getElementById('main').classList.remove('hidden');

  const userEl = document.getElementById('header-user');
  const seatStr = me.seat ? ` · <span class="text-muted">Seat ${me.seat}</span>` : '';
  userEl.innerHTML = `${t('header.logged_in_as', 'Logged in as')} <strong>${escHtml(me.name)}</strong>${seatStr}`;

  if (isAdmin) {
    document.getElementById('btn-admin-toggle').style.display = '';
  }

  await loadServerInfo();

  await Promise.all([loadChat(), loadPolls(), loadButtons(), loadChecklist(), loadAnnouncement(), loadSections(), loadMenu(), loadClockMode()]);
  if (isAdmin) { await loadCodes(); renderMenuAdmin(); }

  connectSocket();
}

async function loadServerInfo() {
  try {
    const res = await fetch('/api/info');
    serverInfo = await res.json();
    const ipEl = document.getElementById('header-ip');
    ipEl.title = 'Click to copy: ' + serverInfo.url;

    const sidebarIp = document.getElementById('sidebar-ip');
    sidebarIp.innerHTML = `<div style="color:var(--text-muted);font-size:0.75rem;">${escHtml(serverInfo.url)}</div>`;
  } catch (e) {   }
}

function copyIP() {
  if (serverInfo) {

    const toCopy = "http://lan.local";
    navigator.clipboard.writeText(toCopy).catch(() => {});
    const el = document.getElementById('header-ip');
    const orig = el.textContent;
    el.textContent = '✓ Copied!';
    setTimeout(() => el.textContent = orig, 1500);
  }
}

function connectSocket() {
  socket = io({ reconnectionDelay: 1000 });

  socket.on('connect', () => {});

  socket.on('presence', ({ online }) => {
    onlineUsers = online;
    renderOnlineList();
    document.getElementById('chat-online-count').textContent = `${online.length} online`;
  });

  socket.on('chat:message', (msg) => {
    appendChatMessage(msg);
    scrollChatToBottom();
  });

  socket.on('polls:update', (updated) => {
    const wasEmpty = polls.length === 0;
    const newPoll = updated.length > polls.length;
    polls = updated;
    renderPolls();
    if (newPoll && !wasEmpty) partyFlash();
  });

  socket.on('buttons:update', (updated) => {
    buttons = updated;
    renderButtons();
    if (isAdmin) renderAdminButtons();
  });

  socket.on('checklist:update', (updated) => {
    checklist = updated;
    renderChecklist();
  });

  socket.on('announcement:update', (ann) => {
    showAnnouncement(ann, true);
  });

  socket.on('sections:update', ({ hiddenSections: updated }) => {
    hiddenSections = updated;
    applyHiddenSections();
  });

  socket.on('menu:update', (updated) => {
    menu = updated;
    menuPage = 0;
    renderMenu();
    if (isAdmin) renderMenuExisting();
  });

  socket.on('menu:orders:update', (allOrders) => {
    // Update our own order display (in case another tab updated it)
    if (me) myMenuOrder = allOrders[me.code] || [];
    renderMenu();
    if (isAdmin) renderOrderSummary();
  });

  socket.on('clockmode:update', ({ enabled }) => {
    clockModeEnabled = enabled;
    renderClockMode();
  });
}

function renderOnlineList() {
  const el = document.getElementById('online-list');
  if (!onlineUsers.length) {
    el.innerHTML = '<div class="text-muted text-sm">No one yet</div>';
    return;
  }
  el.innerHTML = onlineUsers.map(u => `
    <div class="online-user">
      <span class="online-dot"></span>
      <span class="user-name truncate">${escHtml(u.name)}</span>
      ${u.seat ? `<span class="user-meta">${escHtml(u.seat)}</span>` : ''}
    </div>
  `).join('');
}

async function loadChat() {
  try {
    const res = await fetch('/api/chat');
    const history = await res.json();
    const el = document.getElementById('chat-messages');
    el.innerHTML = '';
    history.forEach(msg => appendChatMessage(msg));
    scrollChatToBottom();
  } catch (e) {   }
}

function appendChatMessage(msg) {
  const el = document.getElementById('chat-messages');
  const ts = new Date(msg.timestamp);
  const timeStr = `${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
  const isHost = msg.user === 'Host';
  const div = document.createElement('div');
  div.className = `chat-msg slide-in${isHost ? ' chat-host' : ''}`;
  div.innerHTML = `
    <span class="chat-ts">${timeStr}</span>
    <span class="chat-user truncate">${escHtml(msg.user)}</span>
    <span class="chat-text">${escHtml(msg.text)}</span>
  `;
  el.appendChild(div);
}

function scrollChatToBottom() {
  const el = document.getElementById('chat-messages');
  el.scrollTop = el.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:send', { text });
  input.value = '';
}

async function loadPolls() {
  try {
    const res = await fetch('/api/polls');
    polls = await res.json();
    renderPolls();
  } catch (e) {   }
}

function renderPolls() {
  const el = document.getElementById('polls-list');
  if (!polls.length) {
    el.innerHTML = '<div class="empty-state"><span class="empty-icon">🗳</span>No polls yet.</div>';
    return;
  }

  const sorted = [...polls].reverse();
  el.innerHTML = sorted.map(poll => renderPoll(poll)).join('');
}

function renderPoll(poll) {
  const totalVotes = Object.keys(poll.votes).length;
  const myVote = me ? poll.votes[me.code] : undefined;
  const isOpen = poll.status === 'open';

  const optionsHtml = poll.options.map((opt, i) => {
    const count = Object.values(poll.votes).filter(v => v === i).length;
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const isMyVote = myVote === i;
    const voted = myVote !== undefined;
    const barClass = isMyVote ? 'poll-option-bar voted' : 'poll-option-bar';

    const voteBtn = (!voted && isOpen)
      ? `<button class="poll-vote-btn" onclick="castVote('${poll.id}', ${i})">Vote</button>`
      : (isMyVote ? `<span class="tag" style="border-color:var(--accent2);color:var(--accent2);">✓ your vote</span>` : '');

    return `
      <div class="poll-option">
        <span class="poll-option-label">${escHtml(opt)}</span>
        <div class="poll-option-bar-wrap">
          <div class="${barClass}" style="width:${pct}%"></div>
        </div>
        <span class="poll-option-pct">${pct}%</span>
        <span class="poll-option-count">(${count})</span>
        ${voteBtn}
      </div>
    `;
  }).join('');

  const adminControls = isAdmin ? `
    <button class="btn btn-sm btn-secondary" onclick="togglePollStatus('${poll.id}', '${isOpen ? 'closed' : 'open'}')">
      ${isOpen ? '🔒 Close' : '🔓 Reopen'}
    </button>
    <button class="btn btn-sm btn-danger" onclick="deletePoll('${poll.id}')">🗑 Delete</button>
  ` : '';

  return `
    <div class="poll-card slide-in">
      <div class="poll-question">
        ${escHtml(poll.question)}
        <span class="poll-status ${poll.status}">${poll.status.toUpperCase()}</span>
      </div>
      <div class="poll-options">${optionsHtml}</div>
      <div class="poll-meta">
        <span>${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</span>
        ${adminControls}
      </div>
    </div>
  `;
}

async function castVote(pollId, optionIndex) {
  try {
    const res = await fetch(`/api/polls/${pollId}/vote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionIndex }),
    });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error || 'Vote failed');
    }
  } catch (e) { alert('Error'); }
}

async function togglePollStatus(id, status) {
  await fetch(`/api/polls/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

async function deletePoll(id) {
  if (!confirm('Delete this poll?')) return;
  await fetch(`/api/polls/${id}`, { method: 'DELETE' });
}

async function createPoll() {
  const question = document.getElementById('poll-question').value.trim();
  const optionsText = document.getElementById('poll-options').value.trim();
  const options = optionsText.split('\n').map(o => o.trim()).filter(Boolean);
  if (!question || options.length < 2) { alert('Need a question and at least 2 options'); return; }
  const res = await fetch('/api/polls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, options }),
  });
  if (res.ok) {
    document.getElementById('poll-question').value = '';
    document.getElementById('poll-options').value = '';
  } else {
    const d = await res.json();
    alert(d.error || 'Failed');
  }
}

async function loadButtons() {
  try {
    const res = await fetch('/api/buttons');
    buttons = await res.json();
    renderButtons();
    if (isAdmin) renderAdminButtons();
  } catch (e) {   }
}

function renderButtons() {
  const el = document.getElementById('buttons-bar');
  const sorted = [...buttons].sort((a, b) => a.order - b.order);
  if (!sorted.length) {
    el.innerHTML = '<div class="text-muted text-sm">No links yet — host will add them.</div>';
    return;
  }
  el.innerHTML = sorted.map(btn => {
    if (btn.type === 'file') {
      return `<a class="link-btn" href="/uploads/${escHtml(btn.filename)}" download="${escHtml(btn.originalName || btn.label)}">
        <span class="btn-type-icon">⬇</span>${escHtml(btn.label)}
      </a>`;
    } else {
      return `<a class="link-btn" href="${escHtml(btn.url)}" target="_blank" rel="noopener">
        <span class="btn-type-icon">↗</span>${escHtml(btn.label)}
      </a>`;
    }
  }).join('');
}

function toggleBtnType() {
  const type = document.getElementById('btn-type').value;
  document.getElementById('btn-url-group').classList.toggle('hidden', type !== 'link');
  document.getElementById('btn-file-group').classList.toggle('hidden', type !== 'file');
}

async function addButton() {
  const label = document.getElementById('btn-label').value.trim();
  const type = document.getElementById('btn-type').value;
  if (!label) { alert('Label required'); return; }

  const formData = new FormData();
  formData.append('label', label);
  formData.append('type', type);
  if (type === 'link') {
    formData.append('url', document.getElementById('btn-url').value.trim());
  } else {
    const file = document.getElementById('btn-file').files[0];
    if (!file) { alert('Select a file'); return; }
    formData.append('file', file);
  }

  const res = await fetch('/api/buttons', { method: 'POST', body: formData });
  if (res.ok) {
    document.getElementById('btn-label').value = '';
    document.getElementById('btn-url').value = '';
    document.getElementById('btn-file').value = '';
  } else {
    const d = await res.json();
    alert(d.error || 'Failed');
  }
}

async function removeButton(id) {
  if (!confirm('Remove this button?')) return;
  await fetch(`/api/buttons/${id}`, { method: 'DELETE' });
}

function renderAdminButtons() {
  const el = document.getElementById('admin-btn-list');
  const sorted = [...buttons].sort((a, b) => a.order - b.order);
  if (!sorted.length) {
    el.innerHTML = '<div class="text-muted text-sm mt">No buttons yet.</div>';
    return;
  }
  el.innerHTML = sorted.map((btn, idx) => `
    <div class="btn-list-item" draggable="true"
         data-id="${btn.id}"
         ondragstart="dragStart(event)"
         ondragover="dragOver(event)"
         ondrop="dragDrop(event)"
         ondragleave="dragLeave(event)">
      <span class="btn-drag-handle">⠿</span>
      <span class="btn-list-label truncate">${escHtml(btn.label)}</span>
      <span class="btn-list-type">${btn.type === 'file' ? '⬇ file' : '↗ link'}</span>
      <button class="btn btn-icon btn-sm" onclick="removeButton('${btn.id}')">✕</button>
    </div>
  `).join('');
}

let dragSrcId = null;

function dragStart(e) {
  dragSrcId = e.currentTarget.dataset.id;
  e.currentTarget.style.opacity = '0.5';
}

function dragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function dragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function dragDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.remove('drag-over');
  const targetId = target.dataset.id;
  if (dragSrcId === targetId) return;

  const sorted = [...buttons].sort((a, b) => a.order - b.order);
  const srcIdx = sorted.findIndex(b => b.id === dragSrcId);
  const tgtIdx = sorted.findIndex(b => b.id === targetId);
  const [moved] = sorted.splice(srcIdx, 1);
  sorted.splice(tgtIdx, 0, moved);
  const ids = sorted.map(b => b.id);

  await fetch('/api/buttons/reorder', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  dragSrcId = null;
  document.querySelectorAll('.btn-list-item').forEach(el => el.style.opacity = '');
}

async function loadChecklist() {
  try {
    const res = await fetch('/api/checklist');
    checklist = await res.json();
    renderChecklist();
  } catch (e) {   }
}

function renderChecklist() {
  const view = document.getElementById('checklist-view');
  const matrixBtn = document.getElementById('btn-toggle-matrix');

  if (!checklist) {
    view.innerHTML = '<div class="empty-state"><span class="empty-icon">☑</span>No checklist yet.</div>';
    matrixBtn.style.display = 'none';
    return;
  }

  matrixBtn.style.display = '';

  const myTicks = (checklist.ticks && me) ? (checklist.ticks[me.code] || []) : [];

  view.innerHTML = `
    <div id="checklist-title">${escHtml(checklist.title)}</div>
    <div class="checklist-items">
      ${checklist.items.map((item, i) => {
        const ticked = myTicks.includes(i);
        return `
          <div class="checklist-item${ticked ? ' ticked' : ''}" onclick="toggleTick(${i})">
            <input type="checkbox" ${ticked ? 'checked' : ''} onclick="event.stopPropagation();toggleTick(${i})" />
            <span class="checklist-item-label">${escHtml(item)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;

  renderMatrix();
}

async function toggleTick(itemIndex) {
  if (!checklist) return;
  const myTicks = (checklist.ticks && me) ? (checklist.ticks[me.code] || []) : [];
  const ticked = !myTicks.includes(itemIndex);
  try {
    await fetch('/api/checklist/tick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIndex, ticked }),
    });
  } catch (e) {   }
}

function toggleMatrix() {
  showingMatrix = !showingMatrix;
  document.getElementById('checklist-view').classList.toggle('hidden', showingMatrix);
  document.getElementById('matrix-view').classList.toggle('hidden', !showingMatrix);
  document.getElementById('btn-toggle-matrix').textContent = showingMatrix ? '☑ My List' : '📊 Matrix View';
  if (showingMatrix) renderMatrix();
}

function renderMatrix() {
  if (!checklist) return;
  const container = document.getElementById('matrix-container');

  const tickMap = checklist.ticks || {};
  const allCodes = [...new Set([...(me ? [me.code] : []), ...Object.keys(tickMap)])];

  const codeToName = {};
  if (me) codeToName[me.code] = me.name;
  onlineUsers.forEach(u => { codeToName[u.code] = u.name; });

  const tickedIndices = checklist.items.reduce((acc, item, i) => {
    if (item.startsWith('──')) return acc;
    const anyoneTicked = allCodes.some(code => (tickMap[code] || []).includes(i));
    if (anyoneTicked) acc.push(i);
    return acc;
  }, []);

  if (!tickedIndices.length) {
    container.innerHTML = '<div class="text-muted text-sm">No ticks recorded yet.</div>';
    return;
  }

  const headerRow = `<tr><th>Person</th>${tickedIndices.map(i => `<th>${escHtml(checklist.items[i])}</th>`).join('')}</tr>`;
  const rows = allCodes.map(code => {
    const ticks = tickMap[code] || [];
    if (!tickedIndices.some(i => ticks.includes(i))) return '';
    const name = codeToName[code] || code;
    const cells = tickedIndices.map(i =>
      ticks.includes(i)
        ? `<td><span class="matrix-tick">✓</span></td>`
        : `<td><span class="matrix-empty">·</span></td>`
    ).join('');
    return `<tr><td>${escHtml(name)}</td>${cells}</tr>`;
  }).filter(Boolean).join('');

  if (!rows) {
    container.innerHTML = '<div class="text-muted text-sm">No ticks recorded yet.</div>';
    return;
  }

  container.innerHTML = `<table class="matrix-table"><thead>${headerRow}</thead><tbody>${rows}</tbody></table>`;
}

async function createChecklist() {
  const title = document.getElementById('cl-title').value.trim();
  const itemsText = document.getElementById('cl-items').value.trim();
  const items = itemsText.split('\n').map(i => i.trim()).filter(Boolean);
  if (!title || !items.length) { alert('Title and at least 1 item required'); return; }
  const res = await fetch('/api/checklist', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, items }),
  });
  if (res.ok) {
    document.getElementById('cl-title').value = '';
    document.getElementById('cl-items').value = '';
  } else {
    const d = await res.json();
    alert(d.error || 'Failed');
  }
}

async function loadAnnouncement() {
  try {
    const res = await fetch('/api/announcement');
    const ann = await res.json();
    showAnnouncement(ann, false);
  } catch (e) {   }
}

function showAnnouncement(ann, flash) {
  const bar = document.getElementById('announcement-bar');
  if (!ann) {
    currentAnnouncement = null;
    bar.classList.add('hidden');
    renderClockModeAnnouncement();
    return;
  }
  currentAnnouncement = ann;
  if (ann.createdAt === dismissedAnnouncement) {
    bar.classList.add('hidden');
  } else {
    document.getElementById('ann-text').textContent = ann.text;
    bar.classList.remove('hidden');
    if (flash) partyFlash();
  }
  renderClockModeAnnouncement();
}

function dismissAnnouncement() {
  const bar = document.getElementById('announcement-bar');
  bar.classList.add('hidden');

  if (currentAnnouncement && currentAnnouncement.createdAt) {
    dismissedAnnouncement = currentAnnouncement.createdAt;
    try { sessionStorage.setItem('lansite-dismissed-ann', String(dismissedAnnouncement)); } catch (_) {}
  }
  renderClockModeAnnouncement();
}

async function postAnnouncement() {
  const text = document.getElementById('admin-ann-text').value.trim();
  if (!text) { alert('Enter announcement text'); return; }
  await fetch('/api/announcement', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  document.getElementById('admin-ann-text').value = '';
}

async function clearAnnouncement() {
  await fetch('/api/announcement', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  });
}

async function loadCodes() {
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    renderCodeList(users);
  } catch (e) {   }
}

function renderCodeList(users) {
  const el = document.getElementById('codes-list');
  if (!users.length) {
    el.innerHTML = '<div class="text-muted text-sm">No codes yet.</div>';
    return;
  }
  el.innerHTML = users.map(u => `
    <div class="code-row">
      <span class="code-badge">${escHtml(u.code)}</span>
      <span class="code-name">${escHtml(u.name)}${u.seat ? ` · ${escHtml(u.seat)}` : ''}</span>
      ${u.online ? '<span class="code-online">● online</span>' : ''}
      <button class="btn btn-icon btn-sm" onclick="revokeCode('${u.code}')" title="Delete Code">✕</button>
    </div>
  `).join('');
}

async function generateCode() {
  const name = document.getElementById('gen-name').value.trim();
  const seat = document.getElementById('gen-seat').value.trim();
  const handle = document.getElementById('gen-handle').value.trim();
  if (!name) { alert('Name required'); return; }
  const res = await fetch('/api/users/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, seat, handle }),
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('gen-result').textContent = `Code: ${data.code}`;
    document.getElementById('gen-name').value = '';
    document.getElementById('gen-seat').value = '';
    document.getElementById('gen-handle').value = '';
    await loadCodes();
  } else {
    alert(data.error || 'Failed');
  }
}

async function revokeCode(code) {
  if (!confirm(`Delete code ${code}?`)) return;
  await fetch(`/api/users/${code}`, { method: 'DELETE' });
  await loadCodes();
}

function toggleAdmin() {
  const panel = document.getElementById('admin-panel');
  const btn = document.getElementById('btn-admin-toggle');
  const isOpen = panel.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
  if (isOpen) loadCodes();
}

function partyFlash() {
  document.body.classList.remove('party-flash');
  void document.body.offsetWidth;
  document.body.classList.add('party-flash');
  setTimeout(() => document.body.classList.remove('party-flash'), 1200);
}

const SECTION_META = {
  buttons:   { label: 'Links & Downloads', el: 'section-buttons'  },
  chat:      { label: 'Chat',              el: 'section-chat'     },
  polls:     { label: 'Polls',             el: 'section-polls'    },
  checklist: { label: 'Checklist',         el: 'section-checklist'},
  menu:      { label: 'Menu',              el: 'section-menu'     },
};

async function loadSections() {
  try {
    const res = await fetch('/api/sections');
    const data = await res.json();
    hiddenSections = data.hiddenSections || [];
    applyHiddenSections();
  } catch (e) {   }
}

function applyHiddenSections() {
  for (const [id, meta] of Object.entries(SECTION_META)) {
    const card = document.getElementById(meta.el);
    if (!card) continue;
    const isHidden = hiddenSections.includes(id);

    if (isAdmin) {
      card.style.opacity = isHidden ? '0.45' : '';
      card.style.filter  = isHidden ? 'grayscale(0.5)' : '';
    } else {
      card.classList.toggle('hidden', isHidden);
    }

    if (isAdmin) injectSectionToggle(id, meta, card, isHidden);
  }
}

function injectSectionToggle(id, meta, card, isHidden) {
  const header = card.querySelector('.card-header');
  if (!header) return;

  let btn = header.querySelector('.section-toggle-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-icon section-toggle-btn';
    btn.style.cssText = 'margin-left:auto;flex-shrink:0;font-size:0.78rem;';
    btn.onclick = () => toggleSection(id);

    const actions = header.querySelector('.card-actions');
    if (actions) header.insertBefore(btn, actions);
    else header.appendChild(btn);
  }

  btn.title    = isHidden ? `Show "${meta.label}" for guests` : `Hide "${meta.label}" from guests`;
  btn.textContent = isHidden ? '👁 Show' : '🙈 Hide';
  btn.style.color  = isHidden ? 'var(--success)' : 'var(--text-muted)';
  btn.style.borderColor = isHidden ? 'var(--success)' : 'var(--border)';
}

async function toggleSection(id) {
  const isHidden = hiddenSections.includes(id);
  try {
    await fetch(`/api/sections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: !isHidden }),
    });

  } catch (e) { alert('Failed to toggle section'); }
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  const codeInput = document.getElementById('input-code');
  if (codeInput) {
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doGuestLogin(); });
  }
  const passInput = document.getElementById('input-admin-pass');
  if (passInput) {
    passInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdminLogin(); });
  }
});

/* ═══════════════════════════════════════════════════════════════
   MENU WIDGET
   ═══════════════════════════════════════════════════════════════ */

async function loadMenu() {
  try {
    const [menuRes, orderRes] = await Promise.all([
      fetch('/api/menu'),
      fetch('/api/menu/orders'),
    ]);
    menu = await menuRes.json();
    myMenuOrder = await orderRes.json();
    menuPage = 0;
    renderMenu();
  } catch (e) { /* no menu yet */ }
}

function renderMenu() {
  const el = document.getElementById('menu-widget');
  if (!el) return;

  if (!menu) {
    el.innerHTML = '<div class="empty-state"><span class="empty-icon">🍽</span>No menu yet — host will set it up.</div>';
    // Update card actions
    const actions = document.getElementById('menu-card-actions');
    if (actions) actions.innerHTML = '';
    return;
  }

  const secs = menu.sections || [];
  const totalPages = Math.ceil(secs.length / 2);
  if (menuPage >= totalPages) menuPage = Math.max(0, totalPages - 1);

  // Which two sections to show (left page = menuPage*2, right = menuPage*2+1)
  const leftIdx  = menuPage * 2;
  const rightIdx = menuPage * 2 + 1;
  const leftSec  = secs[leftIdx];
  const rightSec = secs[rightIdx];

  // Build running total
  const orderSet = new Set(myMenuOrder);
  let total = 0;
  secs.forEach(sec => sec.items.forEach(item => {
    if (orderSet.has(item.id)) total += item.price;
  }));

  function pageHtml(sec, side, animate) {
    if (!sec) return '';
    const itemsHtml = sec.items.map(item => {
      const sel = orderSet.has(item.id);
      const closed = !menu.open;
      return `
        <div class="menu-item-row${sel ? ' selected' : ''}" onclick="${closed ? '' : `toggleMenuItem('${item.id}')`}">
          <input type="checkbox" class="menu-item-check" ${sel ? 'checked' : ''}
            ${closed ? 'disabled' : ''}
            onclick="event.stopPropagation();${closed ? '' : `toggleMenuItem('${item.id}')`}" />
          <span class="menu-item-name" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
          <span class="menu-item-dots"></span>
          <span class="menu-item-price">${item.price.toLocaleString('hu-HU')} Ft</span>
        </div>
      `;
    }).join('');
    return `
      <div class="menu-page menu-page-${side}${animate ? ' anim-forward' : ''}">
        <div class="menu-section-title">${escHtml(sec.title)}</div>
        <div class="menu-items">${itemsHtml || '<div class="text-muted text-sm">No items</div>'}</div>
      </div>
    `;
  }

  const closedBadge = !menu.open
    ? '<span class="menu-closed-badge">🔒 CLOSED</span>'
    : '';

  el.innerHTML = `
    <div class="menu-book" id="menu-book-inner">
      ${pageHtml(leftSec, 'left', false)}
      <div class="menu-spine"></div>
      ${rightSec ? pageHtml(rightSec, 'right', false) : '<div class="menu-page menu-page-right"></div>'}
    </div>
    <div class="menu-nav">
      <button class="menu-nav-btn" onclick="menuNavPage(-1)" id="menu-btn-prev" ${menuPage === 0 ? 'disabled' : ''}>◀ Prev</button>
      <div class="menu-nav-center">
        <span class="menu-page-indicator">PAGE ${menuPage + 1} / ${totalPages || 1}</span>
        <span class="menu-total">Your total: ${total.toLocaleString('hu-HU')} Ft</span>
        ${closedBadge}
      </div>
      <button class="menu-nav-btn" onclick="menuNavPage(1)" id="menu-btn-next" ${menuPage >= totalPages - 1 ? 'disabled' : ''}>Next ▶</button>
    </div>
  `;

  // Update card actions with menu title
  const actions = document.getElementById('menu-card-actions');
  if (actions) {
    actions.innerHTML = `<span class="text-muted text-sm" style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(menu.title)}</span>`;
  }
}

function menuNavPage(dir) {
  const secs = (menu && menu.sections) || [];
  const totalPages = Math.ceil(secs.length / 2);
  const newPage = menuPage + dir;
  if (newPage < 0 || newPage >= totalPages) return;

  menuPage = newPage;

  // Apply animation
  renderMenu();
  // Apply directional animation class after render
  const book = document.getElementById('menu-book-inner');
  if (book) {
    const pages = book.querySelectorAll('.menu-page');
    pages.forEach(p => {
      p.classList.remove('anim-forward', 'anim-backward');
      p.classList.add(dir > 0 ? 'anim-forward' : 'anim-backward');
      setTimeout(() => p.classList.remove('anim-forward', 'anim-backward'), 300);
    });
  }
}

function toggleMenuItem(itemId) {
  if (!menu || !menu.open) return;
  const idx = myMenuOrder.indexOf(itemId);
  if (idx === -1) {
    myMenuOrder.push(itemId);
  } else {
    myMenuOrder.splice(idx, 1);
  }
  renderMenu(); // instant visual update
  // Debounced save
  clearTimeout(menuSaveTimer);
  menuSaveTimer = setTimeout(saveMenuOrder, 500);
}

async function saveMenuOrder() {
  try {
    await fetch('/api/menu/orders', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: myMenuOrder }),
    });
  } catch (e) { /* silent */ }
}

/* ── Admin: Menu Builder ─────────────────────────────────────── */

function renderMenuAdmin() {
  renderMenuExisting();
}

function addMenuSection() {
  menuSections.push({ title: '', items: [{ name: '', price: '' }] });
  renderMenuBuilder();
}

function removeMenuSection(sIdx) {
  menuSections.splice(sIdx, 1);
  renderMenuBuilder();
}

function addMenuItemToSection(sIdx) {
  menuSections[sIdx].items.push({ name: '', price: '' });
  renderMenuBuilder();
}

function removeMenuItemFromSection(sIdx, iIdx) {
  menuSections[sIdx].items.splice(iIdx, 1);
  renderMenuBuilder();
}

function syncMenuBuilder() {
  // Read current DOM state back into menuSections
  const builderEl = document.getElementById('menu-sections-builder');
  if (!builderEl) return;
  builderEl.querySelectorAll('.menu-builder-section').forEach((secEl, sIdx) => {
    if (!menuSections[sIdx]) return;
    const titleInput = secEl.querySelector('.sec-title-input');
    if (titleInput) menuSections[sIdx].title = titleInput.value;
    secEl.querySelectorAll('.menu-builder-item-row').forEach((rowEl, iIdx) => {
      if (!menuSections[sIdx].items[iIdx]) return;
      const nameIn = rowEl.querySelector('.item-name-input');
      const priceIn = rowEl.querySelector('.item-price-input');
      if (nameIn) menuSections[sIdx].items[iIdx].name = nameIn.value;
      if (priceIn) menuSections[sIdx].items[iIdx].price = priceIn.value;
    });
  });
}

function renderMenuBuilder() {
  const el = document.getElementById('menu-sections-builder');
  if (!el) return;
  el.innerHTML = menuSections.map((sec, sIdx) => `
    <div class="menu-builder-section">
      <div class="menu-builder-section-header">
        <span style="opacity:0.5;font-size:0.7rem">§</span>
        <input class="sec-title-input" type="text" value="${escHtml(sec.title)}" placeholder="Section title (e.g. ITALOK)" oninput="menuSections[${sIdx}].title=this.value" />
        <button class="btn btn-icon btn-sm" onclick="removeMenuSection(${sIdx})" title="Remove section">✕</button>
      </div>
      <div class="menu-builder-items">
        ${sec.items.map((item, iIdx) => `
          <div class="menu-builder-item-row">
            <input class="item-name-input" type="text" value="${escHtml(item.name)}" placeholder="Item name" oninput="menuSections[${sIdx}].items[${iIdx}].name=this.value" />
            <input class="item-price-input" type="number" value="${item.price}" placeholder="Price (Ft)" min="0" oninput="menuSections[${sIdx}].items[${iIdx}].price=this.value" />
            <button class="btn btn-icon btn-sm" onclick="removeMenuItemFromSection(${sIdx},${iIdx})">✕</button>
          </div>
        `).join('')}
        <button class="btn btn-secondary btn-sm" style="margin-top:0.25rem;font-size:0.75rem" onclick="addMenuItemToSection(${sIdx})">+ Add item</button>
      </div>
    </div>
  `).join('');
}

async function publishMenu() {
  const title = document.getElementById('menu-title').value.trim();
  if (!title) { alert('Enter a menu title'); return; }
  if (!menuSections.length) { alert('Add at least one section'); return; }

  const sections = menuSections.map(sec => ({
    title: sec.title,
    items: sec.items
      .filter(i => (i.name || '').trim())
      .map(i => ({ name: i.name.trim(), price: Number(i.price) || 0 })),
  })).filter(s => s.title.trim());

  if (!sections.length) { alert('Add at least one named section with items'); return; }

  const res = await fetch('/api/menu', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, sections }),
  });
  if (res.ok) {
    menuSections = [];
    renderMenuBuilder();
    document.getElementById('menu-title').value = '';
    await loadMenu();
    renderMenuExisting();
    await renderOrderSummary();
  } else {
    const d = await res.json();
    alert(d.error || 'Failed to publish menu');
  }
}

function renderMenuExisting() {
  const el = document.getElementById('admin-menu-existing');
  const headerActions = document.getElementById('admin-menu-header-actions');
  if (!el) return;

  if (!menu) {
    el.innerHTML = '<div class="text-muted text-sm">No menu published yet.</div>';
    if (headerActions) headerActions.innerHTML = '';
    return;
  }

  const openLabel = menu.open
    ? '<span class="menu-closed-badge" style="background:rgba(34,197,94,0.12);border-color:rgba(34,197,94,0.35);color:var(--success)">✓ OPEN</span>'
    : '<span class="menu-closed-badge">🔒 CLOSED</span>';

  el.innerHTML = `
    <div class="order-summary-section">
      <div class="order-summary-header">
        <span>📋 Current Menu: ${escHtml(menu.title)}</span>
        ${openLabel}
      </div>
      <div style="padding:0.5rem 1rem;display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn-sm btn-secondary" onclick="toggleMenuOpen()">${menu.open ? '🔒 Close Orders' : '🔓 Open Orders'}</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMenu()">🗑 Delete Menu</button>
        <button class="btn btn-sm btn-secondary" onclick="renderOrderSummary()">📊 Refresh Orders</button>
        <button class="btn btn-sm btn-secondary" onclick="exportOrderTxt()">⬇ Export TXT</button>
      </div>
      <div id="order-summary-body"></div>
    </div>
  `;

  if (headerActions) headerActions.innerHTML = '';

  renderOrderSummary();
}

async function toggleMenuOpen() {
  if (!menu) return;
  await fetch('/api/menu', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ open: !menu.open }),
  });
}

async function deleteMenu() {
  if (!confirm('Delete the entire menu and all orders? This cannot be undone.')) return;
  await fetch('/api/menu', { method: 'DELETE' });
}

async function renderOrderSummary() {
  const body = document.getElementById('order-summary-body');
  if (!body || !menu) return;

  try {
    const res = await fetch('/api/menu/orders/all');
    const data = await res.json();
    if (!data.menu) { body.innerHTML = '<div class="text-muted text-sm" style="padding:0.75rem 1rem">No menu.</div>'; return; }

    const { perUser, aggregate } = data;

    // Aggregate section
    let aggHtml = '';
    if (aggregate.length) {
      aggHtml = `
        <div class="order-summary-header" style="font-size:0.7rem;letter-spacing:0.08em;background:transparent;border-top:1px solid var(--border)">AGGREGATE ORDER</div>
        ${aggregate.sort((a, b) => b.count - a.count).map(entry => `
          <div class="order-agg-item">
            <span class="order-agg-count">${entry.count}×</span>
            <span class="order-agg-name">${escHtml(entry.item.name)}</span>
            <span class="order-agg-total">${(entry.item.price * entry.count).toLocaleString('hu-HU')} Ft</span>
          </div>
        `).join('')}
      `;
    } else {
      aggHtml = '<div class="text-muted text-sm" style="padding:0.75rem 1rem">No orders yet.</div>';
    }

    // Per-person section
    let personHtml = '';
    let grandTotal = 0;
    const entries = Object.entries(perUser).filter(([, v]) => v.items.length > 0);
    if (entries.length) {
      personHtml = `
        <div class="order-summary-header" style="font-size:0.7rem;letter-spacing:0.08em;background:transparent;border-top:1px solid var(--border)">PER PERSON</div>
        ${entries.map(([code, u]) => {
          grandTotal += u.total;
          return `
            <div class="order-person-block">
              <div class="order-person-name">${escHtml(u.name)}${u.seat ? `<span class="order-person-seat">SEAT ${escHtml(u.seat)}</span>` : ''}</div>
              <div class="order-person-items">${u.items.map(i => `${escHtml(i.name)} <span style="color:var(--text-muted);font-family:var(--font-mono);font-size:0.75rem">${i.price.toLocaleString('hu-HU')} Ft</span>`).join(', ')}</div>
              <div class="order-person-total">Total: ${u.total.toLocaleString('hu-HU')} Ft</div>
            </div>

          `;
        }).join('')}
        <div class="order-grand-total">Grand Total: ${grandTotal.toLocaleString('hu-HU')} Ft</div>
      `;
    }

    body.innerHTML = aggHtml + personHtml;
  } catch (e) {
    body.innerHTML = '<div class="text-muted text-sm" style="padding:0.75rem 1rem">Failed to load orders.</div>';
  }
}

async function exportOrderTxt() {
  if (!menu) return;
  try {
    const res = await fetch('/api/menu/orders/all');
    const data = await res.json();
    if (!data.menu) { alert('No menu data'); return; }

    const { perUser, aggregate } = data;
    const lines = [];
    const pad = (str, len) => String(str).padEnd(len);
    const padL = (str, len) => String(str).padStart(len);

    lines.push(`=== ${menu.title.toUpperCase()} — ORDER SUMMARY ===`);
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    lines.push('');

    lines.push('── AGGREGATE ORDER ──────────────────────────────────────');
    if (aggregate.length) {
      aggregate.sort((a, b) => b.count - a.count).forEach(entry => {
        const name = pad(entry.item.name, 40);
        const each = padL(`${entry.item.price.toLocaleString('hu-HU')} Ft`, 10);
        const qty  = padL(`${entry.count}×`, 4);
        const tot  = padL(`${(entry.item.price * entry.count).toLocaleString('hu-HU')} Ft`, 12);
        lines.push(`  ${qty} ${name} ${each} = ${tot}`);
      });
    } else {
      lines.push('  (no orders)');
    }
    lines.push('');

    lines.push('── PER PERSON ───────────────────────────────────────────');
    let grandTotal = 0;
    const entries = Object.entries(perUser).filter(([, v]) => v.items.length > 0);
    if (entries.length) {
      entries.forEach(([code, u]) => {
        grandTotal += u.total;
        lines.push(`  ${u.name}${u.seat ? ` (Seat ${u.seat})` : ''}:`);
        u.items.forEach(item => {
          lines.push(`    - ${pad(item.name, 42)} ${padL(`${item.price.toLocaleString('hu-HU')} Ft`, 10)}`);
        });
        lines.push(`    ${''.padEnd(44, '─')}`);
        lines.push(`    TOTAL: ${u.total.toLocaleString('hu-HU')} Ft`);
        lines.push('');
      });
      lines.push(`GRAND TOTAL: ${grandTotal.toLocaleString('hu-HU')} Ft`);
    } else {
      lines.push('  (no orders)');
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `menu-order-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert('Export failed'); }
}

// ── Clock Mode Functions ──────────────────────────────────────────────────────

async function loadClockMode() {
  try {
    const res = await fetch('/api/clock-mode');
    const data = await res.json();
    clockModeEnabled = !!data.enabled;
    renderClockMode();
  } catch (e) {}
}

let clockFadeTimer = null;

function renderClockMode() {
  const overlay = document.getElementById('clock-mode-overlay');
  const btn = document.getElementById('btn-toggle-clockmode');
  const headerClock = document.getElementById('header-clock');

  if (overlay) {
    if (clockModeEnabled) {
      if (clockFadeTimer) { clearTimeout(clockFadeTimer); clockFadeTimer = null; }
      overlay.classList.remove('fading-out');
      overlay.classList.remove('hidden');
    } else {
      if (!overlay.classList.contains('hidden') && !overlay.classList.contains('fading-out')) {
        overlay.classList.add('fading-out');
        if (clockFadeTimer) clearTimeout(clockFadeTimer);
        clockFadeTimer = setTimeout(() => {
          overlay.classList.add('hidden');
          overlay.classList.remove('fading-out');
          clockFadeTimer = null;
        }, 380);
      }
    }
  }

  if (headerClock) {
    headerClock.classList.toggle('hidden', clockModeEnabled);
  }

  if (btn) {
    if (clockModeEnabled) {
      btn.textContent = t('admin.btn_disable_clock_mode', '■ Disable Clock Mode');
      btn.className = 'btn btn-danger btn-sm';
    } else {
      btn.textContent = t('admin.btn_enable_clock_mode', '▶ Enable Clock Mode');
      btn.className = 'btn btn-secondary btn-sm';
    }
  }

  const welcomeUserEl = document.getElementById('clock-welcome-user');
  if (welcomeUserEl && me) {
    welcomeUserEl.textContent = me.name || 'Guest';
  }

  renderClockModeAnnouncement();
}

function renderClockModeAnnouncement() {
  const annBox = document.getElementById('clock-mode-announcement');
  const annTextEl = document.getElementById('clock-ann-text');
  if (!annBox || !annTextEl) return;

  if (currentAnnouncement && currentAnnouncement.text) {
    annTextEl.textContent = currentAnnouncement.text;
    annBox.classList.remove('hidden');
  } else {
    annBox.classList.add('hidden');
  }
}

async function toggleClockMode() {
  try {
    const nextState = !clockModeEnabled;
    const res = await fetch('/api/clock-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextState }),
    });
    const data = await res.json();
    if (data.ok) {
      clockModeEnabled = data.enabled;
      renderClockMode();
    }
  } catch (e) {
    alert('Failed to toggle Clock Mode');
  }
}

// ── i18n Internationalization Helpers ─────────────────────────────────────────

async function loadLanguage() {
  try {
    const res = await fetch('/lang.json');
    if (res.ok) {
      langData = await res.json();
      applyI18n();
    }
  } catch (e) {}
}

function t(path, fallback = '') {
  if (!langData) return fallback;
  const parts = path.split('.');
  let cur = langData;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) {
      cur = cur[p];
    } else {
      return fallback;
    }
  }
  return typeof cur === 'string' ? cur : fallback;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val) el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = t(key);
    if (val) el.title = val;
  });
}
