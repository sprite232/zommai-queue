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
const uploadArea     = document.getElementById('uploadArea');
const imgInput       = document.getElementById('imgInput');
const uploadPreviews = document.getElementById('uploadPreviews');
let selectedFiles    = [];
const MAX_FILES      = 5;
const MAX_FILE_SIZE  = 10 * 1024 * 1024; // 10MB

uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault(); uploadArea.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
imgInput.addEventListener('change', () => addFiles([...imgInput.files]));

function addFiles(files) {
  files.forEach(f => {
    if (selectedFiles.length >= MAX_FILES) {
      showFormError(`แนบรูปได้สูงสุด ${MAX_FILES} รูปเท่านั้น`); return;
    }
    if (!f.type.startsWith('image/')) {
      showFormError('รองรับเฉพาะไฟล์รูปภาพ (JPG, PNG, GIF, WEBP) เท่านั้น'); return;
    }
    if (f.size > MAX_FILE_SIZE) {
      showFormError(`ไฟล์ "${f.name}" ใหญ่เกิน 10MB`); return;
    }
    selectedFiles.push(f);
    const wrap = document.createElement('div');
    wrap.className = 'preview-wrap';
    const idx = selectedFiles.length - 1;
    const reader = new FileReader();
    reader.onload = ev => {
      wrap.innerHTML = `
        <img src="${ev.target.result}" class="upload-preview-img" alt="preview"/>
        <button class="remove-img" data-idx="${idx}" title="ลบรูป" type="button">×</button>`;
    };
    reader.readAsDataURL(f);
    uploadPreviews.appendChild(wrap);
  });
  imgInput.value = '';
}

uploadPreviews.addEventListener('click', e => {
  if (e.target.classList.contains('remove-img')) {
    const i = +e.target.dataset.idx;
    selectedFiles.splice(i, 1);
    e.target.closest('.preview-wrap').remove();
    uploadPreviews.querySelectorAll('.remove-img').forEach((btn, ni) => btn.dataset.idx = ni);
  }
});

// ── Validation Helpers ────────────────────────────────────────────────────────
function validatePhone(phone) {
  const cleaned = phone.replace(/[\s\-]/g, '');
  // Must start with 0 or +66, followed by 8-10 digits
  if (!/^(\+66|0)[0-9]{8,10}$/.test(cleaned)) return false;
  if (cleaned.length < 9 || cleaned.length > 15) return false;
  return true;
}

function validateName(name) {
  if (name.length < 2 || name.length > 100) return false;
  if (!/[a-zA-Zก-๙]/.test(name)) return false;   // must have at least one letter
  if (/[<>\"'&]/.test(name)) return false;          // no HTML special chars
  return true;
}

function validateDate(date) {
  if (!date) return true; // optional
  const selected = new Date(date);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return !isNaN(selected.getTime()) && selected >= today;
}

// Filter phone input — only allow digits, +, -, spaces
function filterPhoneInput(el) {
  const cursor = el.selectionStart;
  const raw  = el.value;
  const clean = raw.replace(/[^\d\+\-\s]/g, '');
  if (raw !== clean) {
    el.value = clean;
    el.setSelectionRange(cursor - (raw.length - clean.length), cursor - (raw.length - clean.length));
  }
  if (clean.length > 15) el.value = clean.slice(0, 15);
}

// Character counter
function updateCounter(el, max, counterId) {
  const counter = document.getElementById(counterId);
  if (!counter) return;
  const len = el.value.length;
  counter.textContent = `${len} / ${max}`;
  counter.style.color = len > max * 0.9 ? '#ef4444' : '#94a3b8';
}

// ── Inline field error helpers ────────────────────────────────────────────────
function setFieldError(fieldId, msg) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.classList.add('input-error');
  let err = field.parentNode.querySelector('.field-err');
  if (!err) {
    err = document.createElement('div');
    err.className = 'field-err';
    field.parentNode.appendChild(err);
  }
  err.textContent = msg;
}

function clearFieldError(fieldId) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.classList.remove('input-error');
  const err = field.parentNode.querySelector('.field-err');
  if (err) err.remove();
}

function showFormError(msg) {
  const errBox = document.getElementById('bookingError');
  errBox.textContent = msg;
  errBox.style.display = 'block';
  errBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Live validation on blur ───────────────────────────────────────────────────
document.getElementById('bName').addEventListener('blur', function() {
  const val = this.value.trim();
  if (val && !validateName(val)) setFieldError('bName', 'ชื่อต้องมี 2-100 ตัวอักษร และต้องมีตัวอักษรภาษาไทยหรืออังกฤษ');
  else clearFieldError('bName');
});

document.getElementById('bPhone').addEventListener('input', function() {
  filterPhoneInput(this);
  clearFieldError('bPhone');
});

document.getElementById('bPhone').addEventListener('blur', function() {
  const val = this.value.trim();
  if (val && !validatePhone(val)) setFieldError('bPhone', 'เบอร์ไม่ถูกต้อง ตัวอย่าง: 081-234-5678 หรือ 0812345678');
  else clearFieldError('bPhone');
});

document.getElementById('bDate').addEventListener('change', function() {
  if (this.value && !validateDate(this.value)) {
    setFieldError('bDate', 'วันที่ต้องเป็นวันนี้หรือวันในอนาคต');
    this.value = '';
  } else clearFieldError('bDate');
});

document.getElementById('bDesc').addEventListener('input', function() {
  updateCounter(this, 2000, 'descCounter');
  if (this.value.length > 2000) this.value = this.value.slice(0, 2000);
});

// ── Booking Form Submit ───────────────────────────────────────────────────────
const form      = document.getElementById('bookingForm');
const errBox    = document.getElementById('bookingError');
const submitBtn = document.getElementById('submitBooking');
let isSubmitting = false;

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (isSubmitting) return;
  errBox.style.display = 'none';
  ['bName','bPhone','bType','bDate'].forEach(clearFieldError);

  const name  = document.getElementById('bName').value.trim();
  const phone = document.getElementById('bPhone').value.trim();
  const type  = document.getElementById('bType').value;
  const date  = document.getElementById('bDate').value;
  const desc  = document.getElementById('bDesc').value.trim();

  let hasError = false;

  if (!validateName(name)) {
    setFieldError('bName', 'ชื่อต้องมี 2-100 ตัวอักษร และต้องมีตัวอักษรภาษาไทยหรืออังกฤษ');
    hasError = true;
  }
  if (!validatePhone(phone)) {
    setFieldError('bPhone', 'เบอร์ไม่ถูกต้อง ตัวอย่าง: 081-234-5678 หรือ 0812345678');
    hasError = true;
  }
  if (!type) {
    setFieldError('bType', 'กรุณาเลือกประเภทปัญหา');
    hasError = true;
  }
  if (date && !validateDate(date)) {
    setFieldError('bDate', 'วันที่ต้องเป็นวันนี้หรืออนาคต');
    hasError = true;
  }
  if (desc.length > 2000) {
    showFormError('รายละเอียดต้องไม่เกิน 2,000 ตัวอักษร');
    hasError = true;
  }
  if (hasError) return;

  isSubmitting = true;
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ กำลังบันทึก...';

  try {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, problemType: type, date, description: desc })
    });
    const data = await res.json();
    if (!res.ok) {
      showFormError(data.error || 'เกิดข้อผิดพลาด');
      return;
    }

    const queueId = data.queue.id;

    // Upload images
    for (const file of selectedFiles) {
      const fd = new FormData();
      fd.append('image', file);
      const upRes = await fetch(`/api/queue/${queueId}/image`, { method: 'POST', body: fd });
      if (!upRes.ok) {
        const upErr = await upRes.json();
        showFormError(upErr.error || 'อัปโหลดรูปไม่สำเร็จ');
      }
    }

    localStorage.setItem('myQueueId', queueId);
    localStorage.setItem('myQueueName', name);

    document.getElementById('modalQueueId').textContent = data.queue.queueNumber;
    document.getElementById('successModal').classList.add('active');
    form.reset();
    selectedFiles = [];
    uploadPreviews.innerHTML = '';
    document.getElementById('descCounter') && (document.getElementById('descCounter').textContent = '0 / 2000');

  } catch (err) {
    showFormError('ไม่สามารถเชื่อมต่อ server ได้ กรุณาลองใหม่');
  } finally {
    isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.textContent = '📋 จองคิวเลย';
  }
});

// Modal
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
