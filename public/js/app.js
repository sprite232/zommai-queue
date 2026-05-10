// ── Landing Page Logic ────────────────────────────────────────────────────────

// Navbar scroll
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
});

// Nav toggle
document.getElementById('navToggle').addEventListener('click', () => {
  document.getElementById('navLinks').classList.toggle('open');
});
document.querySelectorAll('.nav-link').forEach(l => {
  l.addEventListener('click', () => document.getElementById('navLinks').classList.remove('open'));
});

// ── Image Upload ─────────────────────────────────────────────────────────────
const uploadArea   = document.getElementById('uploadArea');
const imgInput     = document.getElementById('imgInput');
const uploadPreviews = document.getElementById('uploadPreviews');
let selectedFiles  = [];

uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault(); uploadArea.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
imgInput.addEventListener('change', () => addFiles([...imgInput.files]));

function addFiles(files) {
  files.filter(f => f.type.startsWith('image/')).forEach(f => {
    if (selectedFiles.length >= 5) return;
    selectedFiles.push(f);
    const wrap = document.createElement('div');
    wrap.className = 'preview-wrap';
    const idx = selectedFiles.length - 1;
    const reader = new FileReader();
    reader.onload = e => {
      wrap.innerHTML = `
        <img src="${e.target.result}" class="upload-preview-img" alt="preview"/>
        <button class="remove-img" data-idx="${idx}" title="ลบรูป">×</button>`;
    };
    reader.readAsDataURL(f);
    uploadPreviews.appendChild(wrap);
  });
  uploadPreviews.addEventListener('click', e => {
    if (e.target.classList.contains('remove-img')) {
      const i = +e.target.dataset.idx;
      selectedFiles.splice(i, 1);
      e.target.closest('.preview-wrap').remove();
      // Re-index buttons
      uploadPreviews.querySelectorAll('.remove-img').forEach((btn, ni) => btn.dataset.idx = ni);
    }
  });
}

// ── Booking Form ──────────────────────────────────────────────────────────────
const form = document.getElementById('bookingForm');
const errBox = document.getElementById('bookingError');
const submitBtn = document.getElementById('submitBooking');

form.addEventListener('submit', async e => {
  e.preventDefault();
  errBox.style.display = 'none';

  const name  = document.getElementById('bName').value.trim();
  const phone = document.getElementById('bPhone').value.trim();
  const type  = document.getElementById('bType').value;
  const date  = document.getElementById('bDate').value;
  const desc  = document.getElementById('bDesc').value.trim();

  if (!name || !phone || !type) {
    errBox.textContent = 'กรุณากรอกชื่อ เบอร์โทร และประเภทปัญหา';
    errBox.style.display = 'block';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ กำลังบันทึก...';

  try {
    // 1. Create queue
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, problemType: type, date, description: desc })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

    const queueId = data.queue.id;

    // 2. Upload images if any
    for (const file of selectedFiles) {
      const fd = new FormData();
      fd.append('image', file);
      await fetch(`/api/queue/${queueId}/image`, { method: 'POST', body: fd });
    }

    // 3. Save queue ID to localStorage for chat
    localStorage.setItem('myQueueId', queueId);
    localStorage.setItem('myQueueName', name);

    // 4. Show success modal
    document.getElementById('modalQueueId').textContent = data.queue.queueNumber;
    document.getElementById('successModal').classList.add('active');

    form.reset(); selectedFiles = []; uploadPreviews.innerHTML = '';

  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '📋 จองคิวเลย';
  }
});

// Modal buttons
document.getElementById('modalClose').addEventListener('click', () => {
  document.getElementById('successModal').classList.remove('active');
});
document.getElementById('modalChat').addEventListener('click', () => {
  window.location.href = 'chat.html';
});
document.getElementById('successModal').addEventListener('click', e => {
  if (e.target === document.getElementById('successModal'))
    document.getElementById('successModal').classList.remove('active');
});

// Set min date to today
const dateInput = document.getElementById('bDate');
if (dateInput) dateInput.min = new Date().toISOString().split('T')[0];
