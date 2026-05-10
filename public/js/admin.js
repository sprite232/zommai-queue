// ── Admin Dashboard Logic ─────────────────────────────────────────────────────
const socket = io();
let allQueues    = [];
let activeQueue  = null;   // full queue object
let pendingImgUrl = null;
let currentFilter = 'all';
let unreadCounts  = {};

// ── Login ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const pass  = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    if (!res.ok) { errEl.style.display = 'block'; return; }
    startAdmin();
  } catch { errEl.style.display = 'block'; }
}

function startAdmin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appLayout').classList.add('show');
  socket.emit('admin_join');
  loadQueues();
}

document.getElementById('loginPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// ── Load Queues ───────────────────────────────────────────────────────────────
async function loadQueues() {
  allQueues = await fetch('/api/queues').then(r => r.json());
  renderQueueList();
  updateStats();
}

function renderQueueList() {
  const list     = document.getElementById('queueList');
  const filtered = currentFilter === 'all'
    ? allQueues
    : allQueues.filter(q => q.status === currentFilter);

  document.getElementById('queueCountBadge').textContent = filtered.length;

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-queue"><div class="icon">📋</div>ไม่มีคิว</div>';
    return;
  }

  list.innerHTML = '';
  filtered.forEach(q => {
    const div   = document.createElement('div');
    const unread = unreadCounts[q.id] || 0;
    div.className = 'queue-row' + (activeQueue?.id === q.id ? ' active' : '');
    div.innerHTML = `
      <div class="q-row-num">#${q.queueNumber}</div>
      <div class="q-row-info">
        <div class="queue-row-name">${q.name}</div>
        <div class="queue-row-type">${q.problemType}</div>
        <div class="queue-row-meta">
          <span class="q-badge ${q.status}">${statusLabel(q.status)}</span>
          <span class="queue-row-time">${relativeTime(q.createdAt)}</span>
          <span class="q-unread-dot ${unread > 0 ? 'show' : ''}"></span>
        </div>
      </div>`;
    div.onclick = () => openQueueDetail(q);
    list.appendChild(div);
  });
}

function updateStats() {
  document.getElementById('statWaiting').textContent  = allQueues.filter(q => q.status === 'waiting').length;
  document.getElementById('statProgress').textContent = allQueues.filter(q => q.status === 'in_progress').length;
  document.getElementById('statDone').textContent     = allQueues.filter(q => q.status === 'done').length;
}

function filterQueues(status, btn) {
  currentFilter = status;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderQueueList();
}

function statusLabel(s) {
  return { waiting: '⏳ รอ', in_progress: '🔧 กำลังซ่อม', done: '✅ เสร็จ', cancelled: '❌ ยกเลิก' }[s] || s;
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'เมื่อกี้';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  return `${Math.floor(h / 24)} วันที่แล้ว`;
}

// ── Open Queue Detail ─────────────────────────────────────────────────────────
async function openQueueDetail(queue) {
  activeQueue = queue;
  unreadCounts[queue.id] = 0;

  document.getElementById('chatPlaceholder').style.display = 'none';
  const wrap = document.getElementById('activeChatWrap');
  wrap.style.display = 'flex';

  // Header
  document.getElementById('aChatName').textContent = `${queue.name} — คิว #${queue.queueNumber}`;
  document.getElementById('aChatInfo').textContent = `📞 ${queue.phone} · ${queue.problemType}`;
  document.getElementById('statusSelector').value  = queue.status;

  // ── Tab: Info ──────────────────────────────────────────
  document.getElementById('iName').textContent    = queue.name;
  document.getElementById('iPhone').textContent   = queue.phone;
  document.getElementById('iPhone').href          = `tel:${queue.phone}`;
  document.getElementById('iType').textContent    = queue.problemType;
  document.getElementById('iDate').textContent    = queue.date || '—';
  document.getElementById('iCreated').textContent = new Date(queue.createdAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  document.getElementById('iDesc').textContent    = queue.description || '—';

  // Images
  const imgWrap = document.getElementById('iImagesWrap');
  const imgCont = document.getElementById('iImages');
  imgCont.innerHTML = '';
  if (queue.images && queue.images.length > 0) {
    imgWrap.style.display = 'block';
    queue.images.forEach(url => {
      const img = document.createElement('img');
      img.src = url; img.className = 'img-thumb'; img.alt = 'รูปลูกค้า';
      img.onclick = () => openLightbox(url);
      imgCont.appendChild(img);
    });
  } else {
    imgWrap.style.display = 'none';
  }

  // ── Tab: Work Log ──────────────────────────────────────
  renderWorkLogs(queue.workLogs || []);

  // ── Tab: Chat ──────────────────────────────────────────
  const msgArea = document.getElementById('adminMessages');
  msgArea.innerHTML = '';
  const msgs = await fetch(`/api/messages/${queue.id}`).then(r => r.json());
  msgs.forEach(m => renderAdminMsg(m));
  scrollAdminBottom();

  socket.emit('mark_read', { queueId: queue.id, reader: 'admin' });
  renderQueueList();
  updateBadge();
  hideChatBadge();

  // Show info tab by default
  switchDetailTab('info');
}

// ── Detail Tabs ───────────────────────────────────────────────────────────────
function switchDetailTab(tab) {
  ['info','log','chat'].forEach(t => {
    document.getElementById(`panel${t.charAt(0).toUpperCase()+t.slice(1)}`).style.display = 'none';
    document.getElementById(`tab${t.charAt(0).toUpperCase()+t.slice(1)}`).classList.remove('active');
  });
  const panelId = `panel${tab.charAt(0).toUpperCase()+tab.slice(1)}`;
  const panel = document.getElementById(panelId);
  panel.style.display = 'flex';
  document.getElementById(`tab${tab.charAt(0).toUpperCase()+tab.slice(1)}`).classList.add('active');

  if (tab === 'chat') {
    hideChatBadge();
    scrollAdminBottom();
  }
}

// ── Change Status ─────────────────────────────────────────────────────────────
async function changeStatus(status) {
  if (!activeQueue) return;
  await fetch(`/api/queue/${activeQueue.id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  const q = allQueues.find(q => q.id === activeQueue.id);
  if (q) q.status = status;
  activeQueue.status = status;
  renderQueueList(); updateStats();
  showToast(`อัปเดตสถานะเป็น "${statusLabel(status)}"`, 'success');
}

// ── Work Log ──────────────────────────────────────────────────────────────────
function renderWorkLogs(logs) {
  const list  = document.getElementById('workLogList');
  const empty = document.getElementById('emptyLog');
  list.innerHTML = '';
  if (!logs.length) {
    list.appendChild(empty);
    return;
  }
  logs.forEach(log => appendWorkLog(log));
}

function appendWorkLog(log) {
  const list  = document.getElementById('workLogList');
  const empty = document.getElementById('emptyLog');
  if (empty.parentNode) empty.remove();

  const item = document.createElement('div');
  item.className = 'work-log-item';
  item.innerHTML = `
    <div class="wl-icon">🔧</div>
    <div class="wl-body">
      <div class="wl-text">${escHtml(log.text)}</div>
      <div class="wl-meta">${log.author || 'ช่างซ่อมมั้ย'} · ${new Date(log.timestamp).toLocaleString('th-TH',{dateStyle:'short',timeStyle:'short'})}</div>
    </div>`;
  list.appendChild(item);
}

async function addWorkLog() {
  const text = document.getElementById('logTextarea').value.trim();
  if (!text || !activeQueue) return;

  const res = await fetch(`/api/queue/${activeQueue.id}/log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('logTextarea').value = '';
    document.getElementById('logTextarea').style.height = 'auto';
  }
}

function logEnter(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addWorkLog(); }
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function adminSend() {
  const text = document.getElementById('adminTextarea').value.trim();
  if (!text && !pendingImgUrl) return;

  const msgData = {
    queueId: activeQueue.id, text, imageUrl: pendingImgUrl,
    sender: 'admin', senderName: 'ช่างซ่อมมั้ย',
    createdAt: new Date().toISOString()
  };
  renderAdminMsg(msgData);
  scrollAdminBottom();
  socket.emit('send_message', msgData);
  document.getElementById('adminTextarea').value = '';
  document.getElementById('adminTextarea').style.height = 'auto';
  clearAdminImg();
}

function adminEnter(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adminSend(); }
  if (activeQueue) socket.emit('typing', { queueId: activeQueue.id, sender: 'admin' });
}

function adminResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

async function adminPreviewImg(input) {
  const file = input.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('image', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json(); if (!data.url) return;
  pendingImgUrl = data.url;
  document.getElementById('adminImgPreview').classList.add('show');
  document.getElementById('adminImgThumb').src = data.url;
  document.getElementById('adminImgName').textContent = file.name;
  input.value = '';
}

function clearAdminImg() {
  pendingImgUrl = null;
  document.getElementById('adminImgPreview').classList.remove('show');
  document.getElementById('adminImgThumb').src = '';
}

function renderAdminMsg(msg) {
  const isAdmin = msg.sender === 'admin';
  const wrap = document.createElement('div');
  wrap.className = `msg ${isAdmin ? 'from-admin' : 'from-customer'}`;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = isAdmin ? '🔧' : '👤';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (msg.imageUrl) {
    const img = document.createElement('img');
    img.src = msg.imageUrl; img.className = 'msg-image'; img.alt = 'รูป';
    img.onclick = () => openLightbox(msg.imageUrl);
    bubble.appendChild(img);
  }
  if (msg.text) {
    const t = document.createElement('div'); t.textContent = msg.text;
    bubble.appendChild(t);
  }
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = new Date(msg.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const inner = document.createElement('div');
  inner.style.cssText = 'display:flex;flex-direction:column';
  inner.appendChild(bubble); inner.appendChild(time);
  wrap.appendChild(avatar); wrap.appendChild(inner);
  document.getElementById('adminMessages').appendChild(wrap);
}

function scrollAdminBottom() {
  const el = document.getElementById('adminMessages');
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on('new_queue', queue => {
  allQueues.unshift(queue);
  renderQueueList(); updateStats();
  showToast(`📋 คิวใหม่ #${queue.queueNumber} — ${queue.name}`, 'warning');
  updateNewBadge();
});

socket.on('new_message', msg => {
  if (msg.sender === 'admin') return;
  if (msg.queueId === activeQueue?.id) {
    renderAdminMsg(msg); scrollAdminBottom();
    socket.emit('mark_read', { queueId: msg.queueId, reader: 'admin' });
    // If not on chat tab, show badge
    if (!document.getElementById('tabChat').classList.contains('active')) {
      document.getElementById('tabChatBadge').style.display = 'inline';
    }
  } else {
    unreadCounts[msg.queueId] = (unreadCounts[msg.queueId] || 0) + 1;
    renderQueueList();
    const q = allQueues.find(q => q.id === msg.queueId);
    if (q) showToast(`💬 ข้อความใหม่จาก ${q.name}`);
    updateBadge();
  }
});

socket.on('queue_updated', queue => {
  const idx = allQueues.findIndex(q => q.id === queue.id);
  if (idx !== -1) allQueues[idx] = { ...allQueues[idx], ...queue };
  if (activeQueue?.id === queue.id) {
    document.getElementById('statusSelector').value = queue.status;
    activeQueue.status = queue.status;
  }
  renderQueueList(); updateStats();
});

socket.on('work_log', ({ queueId, log }) => {
  if (activeQueue?.id === queueId) appendWorkLog(log);
});

// ── Badges ────────────────────────────────────────────────────────────────────
function updateBadge() {
  const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
  const el = document.getElementById('badgeMsg');
  if (el) { el.textContent = total; el.classList.toggle('show', total > 0); }
}

function updateNewBadge() {
  const el = document.getElementById('badgeNew');
  if (!el) return;
  const count = allQueues.filter(q => q.status === 'waiting').length;
  el.textContent = count; el.classList.toggle('show', count > 0);
}

function hideChatBadge() {
  document.getElementById('tabChatBadge').style.display = 'none';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
  if (Notification.permission === 'granted') {
    new Notification('ซ่อมมั้ย Admin', { body: msg });
  }
}
if ('Notification' in window) Notification.requestPermission();

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
