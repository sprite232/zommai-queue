// ── Admin Dashboard Logic ─────────────────────────────────────────────────────
const socket = io();
let allQueues = [];
let activeQueueId = null;
let pendingImgUrl = null;
let currentFilter = 'all';
let unreadCounts = {}; // queueId → count

// ── Login ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (!res.ok) { errEl.style.display = 'block'; return; }
    startAdmin();
  } catch {
    errEl.style.display = 'block';
  }
}

function startAdmin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appLayout').classList.add('show');
  socket.emit('admin_join');
  loadQueues();
}

// ── Load Queues ───────────────────────────────────────────────────────────────
async function loadQueues() {
  allQueues = await fetch('/api/queues').then(r => r.json());
  renderQueueList();
  updateStats();
}

function renderQueueList() {
  const list = document.getElementById('queueList');
  const filtered = currentFilter === 'all' ? allQueues : allQueues.filter(q => q.status === currentFilter);

  document.getElementById('queueCountBadge').textContent = filtered.length;

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-queue"><div class="icon">📋</div>ไม่มีคิว</div>';
    return;
  }

  list.innerHTML = '';
  filtered.forEach(q => {
    const div = document.createElement('div');
    div.className = 'queue-row' + (q.id === activeQueueId ? ' active' : '');
    div.dataset.id = q.id;
    const unread = unreadCounts[q.id] || 0;

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
    div.onclick = () => openChat(q);
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

// ── Open Chat ─────────────────────────────────────────────────────────────────
async function openChat(queue) {
  activeQueueId = queue.id;
  unreadCounts[queue.id] = 0;

  document.getElementById('chatPlaceholder').style.display = 'none';
  const wrap = document.getElementById('activeChatWrap');
  wrap.style.display = 'flex'; wrap.style.flexDirection = 'column';

  document.getElementById('aChatName').textContent = `${queue.name} — คิว #${queue.queueNumber}`;
  document.getElementById('aChatInfo').textContent = `${queue.problemType} · ${queue.phone}`;
  document.getElementById('statusSelector').value = queue.status;

  // Clear + load messages
  const msgArea = document.getElementById('adminMessages');
  msgArea.innerHTML = '';
  const msgs = await fetch(`/api/messages/${queue.id}`).then(r => r.json());
  msgs.forEach(m => renderAdminMsg(m));
  scrollAdminBottom();

  // Mark read
  socket.emit('mark_read', { queueId: queue.id, reader: 'admin' });
  renderQueueList();
  updateBadge();
}

// ── Change Status ─────────────────────────────────────────────────────────────
async function changeStatus(status) {
  if (!activeQueueId) return;
  await fetch(`/api/queue/${activeQueueId}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  const q = allQueues.find(q => q.id === activeQueueId);
  if (q) q.status = status;
  renderQueueList(); updateStats();
  showToast(`อัปเดตสถานะเป็น "${statusLabel(status)}"`, 'success');
}

// ── Send Message ──────────────────────────────────────────────────────────────
function adminSend() {
  const text = document.getElementById('adminTextarea').value.trim();
  if (!text && !pendingImgUrl) return;

  const msgData = {
    queueId: activeQueueId, text,
    imageUrl: pendingImgUrl,
    sender: 'admin', senderName: 'ช่างซ่อมมั้ย',
    createdAt: new Date().toISOString()
  };

  // Render immediately
  renderAdminMsg(msgData);
  scrollAdminBottom();

  socket.emit('send_message', msgData);
  document.getElementById('adminTextarea').value = '';
  document.getElementById('adminTextarea').style.height = 'auto';
  clearAdminImg();
}

function adminEnter(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adminSend(); }
  if (activeQueueId) socket.emit('typing', { queueId: activeQueueId, sender: 'admin' });
}

function adminResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

// ── Image ─────────────────────────────────────────────────────────────────────
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

// ── Render Message ────────────────────────────────────────────────────────────
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
  el.scrollTop = el.scrollHeight;
}

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on('new_queue', queue => {
  allQueues.unshift(queue);
  renderQueueList(); updateStats();
  showToast(`📋 คิวใหม่ #${queue.queueNumber} — ${queue.name}`, 'warning');
  updateNewBadge();
});

socket.on('new_message', msg => {
  if (msg.sender === 'admin') return; // admin's own messages rendered immediately
  if (msg.queueId === activeQueueId) {
    renderAdminMsg(msg); scrollAdminBottom();
    socket.emit('mark_read', { queueId: msg.queueId, reader: 'admin' });
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
  if (idx !== -1) allQueues[idx] = queue;
  if (queue.id === activeQueueId) document.getElementById('statusSelector').value = queue.status;
  renderQueueList(); updateStats();
});

// ── Badges ────────────────────────────────────────────────────────────────────
function updateBadge() {
  const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
  const el = document.getElementById('badgeMsg');
  el.textContent = total;
  el.classList.toggle('show', total > 0);
}

function updateNewBadge() {
  const el = document.getElementById('badgeNew');
  const count = allQueues.filter(q => q.status === 'waiting').length;
  el.textContent = count;
  el.classList.toggle('show', count > 0);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);

  // Browser notification
  if (Notification.permission === 'granted') {
    new Notification('ซ่อมมั้ย Admin', { body: msg, icon: '/favicon.ico' });
  }
}

// Request notification permission
if ('Notification' in window) Notification.requestPermission();

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) { document.getElementById('lightboxImg').src = src; document.getElementById('lightbox').classList.add('open'); }
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }

// ── Sidebar view switch ───────────────────────────────────────────────────────
function setView(v) {
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  event.currentTarget.classList.add('active');
}

// Allow Enter on login
document.getElementById('loginPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
