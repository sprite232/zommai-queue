// ── Customer Chat Logic ───────────────────────────────────────────────────────
const socket = io();
let currentQueueId = null;
let currentQueueNum = null;
let myName = '';
let pendingImageUrl = null;
let typingTimeout = null;

// ── Entry Screen ──────────────────────────────────────────────────────────────
function switchTab(tab) {
  const isQueueId = tab === 'queueId';
  document.getElementById('tabQueueId').classList.toggle('active', isQueueId);
  document.getElementById('tabNewChat').classList.toggle('active', !isQueueId);
  document.getElementById('formQueueId').style.display = isQueueId ? 'block' : 'none';
  document.getElementById('formNewChat').style.display = isQueueId ? 'none' : 'block';
}

// Auto-fill from localStorage
window.addEventListener('DOMContentLoaded', () => {
  const savedId = localStorage.getItem('myQueueId');
  const savedName = localStorage.getItem('myQueueName');
  if (savedId) {
    // Fetch queue to get queue number
    fetch(`/api/queue/${savedId}`)
      .then(r => r.json())
      .then(q => {
        if (q && q.queueNumber) {
          document.getElementById('inputQueueId').value = q.queueNumber;
          if (savedName) document.getElementById('inputQueueName').value = savedName;
        }
      }).catch(() => {});
  }
  if (savedName) document.getElementById('inputGuestName').value = savedName;
});

async function enterByQueueId() {
  const numStr = document.getElementById('inputQueueId').value.trim();
  const name   = document.getElementById('inputQueueName').value.trim();
  const errEl  = document.getElementById('errQueueId');
  errEl.style.display = 'none';

  if (!numStr || !name) { showErr(errEl, 'กรุณากรอก Queue ID และชื่อ'); return; }
  const num = parseInt(numStr, 10);

  try {
    const queues = await fetch('/api/queues').then(r => r.json());
    const queue = queues.find(q => q.queueNumber === num);
    if (!queue) { showErr(errEl, `ไม่พบคิว #${num} กรุณาตรวจสอบอีกครั้ง`); return; }

    myName = name;
    localStorage.setItem('myQueueId', queue.id);
    localStorage.setItem('myQueueName', name);
    enterChat(queue);
  } catch (e) {
    showErr(errEl, 'เชื่อมต่อ server ไม่ได้ กรุณาลองใหม่');
  }
}

async function startNewChat() {
  const name  = document.getElementById('inputGuestName').value.trim();
  const phone = document.getElementById('inputGuestPhone').value.trim();
  const msg   = document.getElementById('inputGuestMsg').value.trim();
  const errEl = document.getElementById('errNewChat');
  errEl.style.display = 'none';

  if (!name || !phone) { showErr(errEl, 'กรุณากรอกชื่อและเบอร์โทร'); return; }

  try {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, problemType: 'สอบถามทั่วไป', description: msg })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    myName = name;
    localStorage.setItem('myQueueId', data.queue.id);
    localStorage.setItem('myQueueName', name);
    enterChat(data.queue);

    // Send initial message
    if (msg) {
      setTimeout(() => {
        socket.emit('send_message', {
          queueId: data.queue.id, text: msg,
          sender: 'customer', senderName: name
        });
      }, 600);
    }
  } catch (e) {
    showErr(errEl, e.message || 'เกิดข้อผิดพลาด');
  }
}

function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }

// ── Enter Chat ────────────────────────────────────────────────────────────────
async function enterChat(queue) {
  currentQueueId  = queue.id;
  currentQueueNum = queue.queueNumber;

  // Update UI
  document.getElementById('entryScreen').style.display = 'none';
  document.getElementById('chatScreen').style.display  = 'flex';
  document.getElementById('headerQNum').textContent    = queue.queueNumber;
  document.getElementById('qBarName').textContent      = queue.name;
  document.getElementById('qBarType').textContent      = queue.problemType;
  updateStatusBadge(queue.status);

  // Join socket room
  socket.emit('join_queue', queue.id);

  // Load messages
  const msgs = await fetch(`/api/messages/${queue.id}`).then(r => r.json());
  msgs.forEach(m => renderMsg(m));
  scrollBottom();
}

function goBack() {
  document.getElementById('entryScreen').style.display = 'flex';
  document.getElementById('chatScreen').style.display  = 'none';
  document.getElementById('chatMessages').querySelectorAll('.msg,.day-sep').forEach(el => el.remove());
}

// ── Status ─────────────────────────────────────────────────────────────────────
function updateStatusBadge(status) {
  const badge = document.getElementById('qBarStatus');
  const map = {
    waiting:     ['รอ', 's-waiting'],
    in_progress: ['กำลังซ่อม', 's-progress'],
    done:        ['เสร็จแล้ว', 's-done'],
    cancelled:   ['ยกเลิก', 's-cancelled']
  };
  const [label, cls] = map[status] || ['รอ', 's-waiting'];
  badge.textContent = label;
  badge.className = 'q-status-badge ' + cls;
}

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on('admin_status', ({ online }) => {
  document.getElementById('adminDot').className = 'status-dot' + (online ? ' online' : '');
  document.getElementById('adminStatusText').textContent = online ? 'ออนไลน์ อยู่' : 'ออฟไลน์';
});

socket.on('new_message', msg => {
  if (msg.queueId !== currentQueueId) return;
  // Only render admin replies (customer messages are rendered optimistically)
  if (msg.sender === 'admin') {
    renderMsg(msg);
    scrollBottom();
    document.getElementById('emptyChat').style.display = 'none';
    document.getElementById('typingIndicator').style.display = 'none';
  }
});

socket.on('queue_updated', queue => {
  if (queue.id !== currentQueueId) return;
  updateStatusBadge(queue.status);
});

socket.on('typing', data => {
  if (data.queueId !== currentQueueId || data.sender !== 'admin') return;
  const ind = document.getElementById('typingIndicator');
  ind.style.display = 'flex';
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => ind.style.display = 'none', 2500);
});

// ── Send Message ──────────────────────────────────────────────────────────────
async function sendMessage() {
  const text = document.getElementById('chatTextarea').value.trim();
  if (!text && !pendingImageUrl) return;

  const msgData = {
    queueId: currentQueueId, text,
    imageUrl: pendingImageUrl,
    sender: 'customer', senderName: myName,
    createdAt: new Date().toISOString()
  };

  // Render immediately (optimistic)
  renderMsg(msgData);
  scrollBottom();
  document.getElementById('emptyChat').style.display = 'none';

  socket.emit('send_message', msgData);
  document.getElementById('chatTextarea').value = '';
  document.getElementById('chatTextarea').style.height = 'auto';
  clearImgPreview();
}

function handleEnter(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  // Typing indicator
  socket.emit('typing', { queueId: currentQueueId, sender: 'customer' });
}

// ── Image handling ────────────────────────────────────────────────────────────
async function previewImg(input) {
  const file = input.files[0];
  if (!file) return;

  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.url) return;

  pendingImageUrl = data.url;
  document.getElementById('imgPreviewBar').classList.add('show');
  document.getElementById('imgPreviewThumb').src = data.url;
  document.getElementById('imgPreviewName').textContent = file.name;
  input.value = '';
}

function clearImgPreview() {
  pendingImageUrl = null;
  document.getElementById('imgPreviewBar').classList.remove('show');
  document.getElementById('imgPreviewThumb').src = '';
}

// ── Render Message ────────────────────────────────────────────────────────────
function renderMsg(msg) {
  const isMe = msg.sender === 'customer';
  const wrap = document.createElement('div');
  wrap.className = `msg ${isMe ? 'from-me' : 'from-admin'}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = isMe ? '👤' : '🔧';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.imageUrl) {
    const img = document.createElement('img');
    img.src = msg.imageUrl; img.className = 'msg-image'; img.alt = 'รูปภาพ';
    img.onclick = () => openLightbox(msg.imageUrl);
    bubble.appendChild(img);
  }
  if (msg.text) {
    const t = document.createElement('div');
    t.textContent = msg.text;
    bubble.appendChild(t);
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.createdAt);

  const inner = document.createElement('div');
  inner.style.display = 'flex'; inner.style.flexDirection = 'column';
  inner.appendChild(bubble); inner.appendChild(time);

  wrap.appendChild(avatar); wrap.appendChild(inner);
  document.getElementById('typingIndicator').before(wrap);
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function scrollBottom() {
  const el = document.getElementById('chatMessages');
  el.scrollTop = el.scrollHeight;
}

function autoResize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }
