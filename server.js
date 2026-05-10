// Fix for ISPs that don't support DNS SRV records (needed for mongodb+srv://)
const dns   = require('dns');
const https = require('https');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const mongoose   = require('mongoose');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6 // 5MB max socket message
});

const PORT        = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/zommai';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'admin1234';

// ── Security Headers ───────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // allow inline scripts for simplicity
  crossOriginEmbedderPolicy: false
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'คำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่' }
});

const queueCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // max 5 queues per IP per hour
  message: { error: 'จองคิวบ่อยเกินไป กรุณารอ 1 ชั่วโมงแล้วลองใหม่' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'อัปโหลดบ่อยเกินไป กรุณารอสักครู่' }
});

// Admin login brute-force protection (in-memory)
const loginAttempts = new Map(); // ip → { count, lockedUntil }

const adminLoginLimiter = (req, res, next) => {
  const ip   = req.ip;
  const now  = Date.now();
  const data = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (data.lockedUntil > now) {
    const mins = Math.ceil((data.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `ล็อกชั่วคราว กรุณารออีก ${mins} นาที` });
  }
  req._loginIp = ip;
  next();
};

function recordLoginFailure(ip) {
  const data = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  data.count += 1;
  if (data.count >= 5) {
    data.lockedUntil = Date.now() + 15 * 60 * 1000; // lock 15 min
    data.count = 0;
  }
  loginAttempts.set(ip, data);
}
function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

app.use(generalLimiter);

// ── MongoDB Schemas ───────────────────────────────────────────────────────────
const queueSchema = new mongoose.Schema({
  queueNumber:  { type: Number, required: true, unique: true },
  name:         { type: String, required: true, maxlength: 100, trim: true },
  phone:        { type: String, required: true, maxlength: 20 },
  problemType:  { type: String, default: 'ไม่ระบุ', maxlength: 100 },
  date:         { type: String, default: null },
  description:  { type: String, default: '', maxlength: 2000, trim: true },
  status:       { type: String, enum: ['waiting','in_progress','done','cancelled'], default: 'waiting' },
  images:       [{ type: String }],
  workLogs:     [{
    text:      { type: String, required: true, maxlength: 1000 },
    author:    { type: String, default: 'ช่างซ่อมมั้ย', maxlength: 100 },
    timestamp: { type: Date, default: Date.now }
  }],
  price:  { type: Number, default: null, min: 0 },
  review: {
    stars:     { type: Number, min: 1, max: 5, default: null },
    comment:   { type: String, default: '', maxlength: 500, trim: true },
    createdAt: { type: Date }
  }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  queueId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Queue', required: true },
  text:       { type: String, default: '', maxlength: 2000, trim: true },
  imageUrl:   { type: String, default: null },
  sender:     { type: String, enum: ['customer','admin'], required: true },
  senderName: { type: String, default: '', maxlength: 100 },
  read:       { type: Boolean, default: false }
}, { timestamps: true });

const Queue   = mongoose.model('Queue',   queueSchema);
const Message = mongoose.model('Message', messageSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);

async function nextQueueNumber() {
  const doc = await Counter.findByIdAndUpdate(
    'queueNumber', { $inc: { seq: 1 } }, { new: true, upsert: true }
  );
  return doc.seq;
}

// ── Telegram Bot Notify ───────────────────────────────────────────────────────
function sendTelegramNotify(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || token === 'your_bot_token' || chatId === 'your_chat_id') return;

  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
  const opts = {
    hostname: 'api.telegram.org',
    path:     `/bot${token}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(opts, r => {
    if (r.statusCode !== 200) console.warn('[Telegram] status', r.statusCode);
  });
  req.on('error', e => console.warn('[Telegram] error', e.message));
  req.write(body); req.end();
}

// ── Input Sanitization Helpers ────────────────────────────────────────────────

// Strip HTML tags completely
function stripHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

// Validate Thai/English phone number: 9-15 digits, may have +, -, spaces
function isValidPhone(phone) {
  const cleaned = phone.replace(/[\s\-]/g, '');
  return /^(\+66|0)[0-9]{8,10}$/.test(cleaned) && cleaned.length >= 9 && cleaned.length <= 15;
}

// Validate name: 2-100 chars, must contain at least some letters (Thai or English)
function isValidName(name) {
  if (!name || name.length < 2 || name.length > 100) return false;
  // Must contain at least one letter (Thai Unicode or ASCII letter)
  return /[a-zA-Zก-๙]/.test(name);
}

// ── Multer Upload ─────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg','image/jpg','image/png','image/gif','image/webp']);
const ALLOWED_EXT  = new Set(['.jpg','.jpeg','.png','.gif','.webp']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ (JPG, PNG, GIF, WEBP) เท่านั้น'));
    }
    cb(null, true);
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──────────────────────────────────────────────────────────────────

// Create queue — with strict validation
app.post('/api/queue', queueCreateLimiter, async (req, res) => {
  try {
    let { name, phone, problemType, date, description } = req.body;

    // Sanitize
    name        = stripHtml(name || '');
    phone       = (phone || '').trim().replace(/[^\d\+\-\s]/g, ''); // strip non-phone chars
    problemType = stripHtml(problemType || '');
    description = stripHtml(description || '');
    date        = (date || '').replace(/[^0-9\-]/g, ''); // only digits and dashes

    // Validate name
    if (!isValidName(name)) {
      return res.status(400).json({ error: 'ชื่อต้องมี 2-100 ตัวอักษร และต้องมีตัวอักษรอย่างน้อยหนึ่งตัว' });
    }

    // Validate phone
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง ต้องเป็นตัวเลข 9-15 หลัก เช่น 081-234-5678' });
    }

    // Validate problem type
    const allowedTypes = [
      'เครื่องช้า / ค้าง','เปลี่ยน SSD / RAM','ลง Windows',
      'ทำความสะอาด','จอมีปัญหา','แบตเตอรี่เสีย','แป้นพิมพ์เสีย',
      'สอบถามทั่วไป','อื่นๆ'
    ];
    if (!allowedTypes.includes(problemType)) {
      return res.status(400).json({ error: 'กรุณาเลือกประเภทปัญหาจากตัวเลือกที่มี' });
    }

    // Validate date (optional but must be today or future)
    if (date) {
      const selectedDate = new Date(date);
      const today = new Date(); today.setHours(0,0,0,0);
      if (isNaN(selectedDate.getTime()) || selectedDate < today) {
        return res.status(400).json({ error: 'วันที่ต้องเป็นวันนี้หรือวันในอนาคต' });
      }
    }

    // Description length
    if (description.length > 2000) {
      return res.status(400).json({ error: 'รายละเอียดต้องไม่เกิน 2,000 ตัวอักษร' });
    }

    const queueNumber = await nextQueueNumber();
    const queue = await Queue.create({ queueNumber, name, phone, problemType, date, description });

    io.to('admin_room').emit('new_queue', queueToJSON(queue));
    // Telegram notify
    sendTelegramNotify(
      `🔔 <b>คิวใหม่! #${queueNumber}</b>\n` +
      `👤 ${name}\n` +
      `📞 ${phone}\n` +
      `🔧 ${problemType}` +
      (description ? `\n📝 ${description.slice(0, 100)}` : '')
    );
    res.json({ success: true, queue: queueToJSON(queue) });
  } catch (err) {
    console.error('[queue create]', err.message);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' }); // don't expose internal error
  }
});

// Get queue by ID
app.get('/api/queue/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID ไม่ถูกต้อง' });
    const queue = await Queue.findById(req.params.id);
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิวนี้' });
    res.json(queueToJSON(queue));
  } catch {
    res.status(404).json({ error: 'ไม่พบคิวนี้' });
  }
});

// Get all queues (admin only — no public pagination leak)
app.get('/api/queues', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '50'));
    const queues = await Queue.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    res.json(queues.map(queueToJSON));
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// Update status
app.patch('/api/queue/:id/status', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID ไม่ถูกต้อง' });
    const { status } = req.body;
    const valid = ['waiting','in_progress','done','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

    const queue = await Queue.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิว' });

    const q = queueToJSON(queue);
    io.to(`queue_${queue._id}`).emit('queue_updated', q);
    io.to('admin_room').emit('queue_updated', q);
    res.json({ success: true, queue: q });
  } catch {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// Upload image
app.post('/api/upload', uploadLimiter, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });
  // Extra: verify file signature (magic bytes)
  const filePath = req.file.path;
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(4);
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  const hex = header.toString('hex');
  const isValidImage =
    hex.startsWith('ffd8ff') ||       // JPEG
    hex.startsWith('89504e47') ||      // PNG
    hex.startsWith('47494638') ||      // GIF
    hex.startsWith('52494646');        // WEBP (RIFF)
  if (!isValidImage) {
    fs.unlinkSync(filePath);
    return res.status(400).json({ error: 'ไฟล์ไม่ใช่รูปภาพจริง' });
  }
  res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

// Attach image to queue
app.post('/api/queue/:id/image', uploadLimiter, upload.single('image'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID ไม่ถูกต้อง' });
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const url = `/uploads/${req.file.filename}`;
    const queue = await Queue.findById(req.params.id);
    if (!queue) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'ไม่พบคิว' }); }
    if (queue.images.length >= 10) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'แนบรูปได้สูงสุด 10 รูปต่อคิว' });
    }
    await Queue.findByIdAndUpdate(req.params.id, { $push: { images: url } });
    res.json({ success: true, url });
  } catch {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// Get messages
app.get('/api/messages/:queueId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.queueId)) return res.json([]);
    const msgs = await Message.find({ queueId: req.params.queueId })
      .sort({ createdAt: 1 })
      .limit(500);
    res.json(msgs.map(msgToJSON));
  } catch {
    res.json([]);
  }
});

// Admin Statistics
app.get('/api/stats', async (req, res) => {
  try {
    const now = new Date();
    const tod = new Date(now); tod.setHours(0,0,0,0);
    const wk  = new Date(now); wk.setDate(now.getDate() - 6); wk.setHours(0,0,0,0);
    const mo  = new Date(now.getFullYear(), now.getMonth(), 1);

    const [all, todayQ, weekQ, monthQ] = await Promise.all([
      Queue.find(),
      Queue.find({ createdAt: { $gte: tod } }),
      Queue.find({ createdAt: { $gte: wk } }),
      Queue.find({ createdAt: { $gte: mo } })
    ]);

    const sumPrice = arr => arr.reduce((s, q) => s + (q.price || 0), 0);
    const doneOnly = arr => arr.filter(q => q.status === 'done');
    const reviews  = all.filter(q => q.review?.stars);
    const avgStars = reviews.length
      ? (reviews.reduce((s,q) => s + q.review.stars, 0) / reviews.length).toFixed(1)
      : null;

    res.json({
      today:   { count: todayQ.length,  revenue: sumPrice(doneOnly(todayQ)) },
      week:    { count: weekQ.length,   revenue: sumPrice(doneOnly(weekQ)) },
      month:   { count: monthQ.length,  revenue: sumPrice(doneOnly(monthQ)) },
      total:   { count: all.length,     revenue: sumPrice(doneOnly(all)) },
      status:  {
        waiting:     all.filter(q => q.status==='waiting').length,
        in_progress: all.filter(q => q.status==='in_progress').length,
        done:        all.filter(q => q.status==='done').length,
        cancelled:   all.filter(q => q.status==='cancelled').length
      },
      reviews: {
        count: reviews.length, avg: avgStars,
        latest: reviews.slice(-5).reverse().map(q => ({
          queueNumber: q.queueNumber, name: q.name,
          stars: q.review.stars, comment: q.review.comment, createdAt: q.review.createdAt
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// Set price (admin)
app.patch('/api/queue/:id/price', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID ไม่ถูกต้อง' });
    const price = parseFloat(req.body.price);
    if (isNaN(price) || price < 0 || price > 999999) return res.status(400).json({ error: 'ราคาไม่ถูกต้อง' });
    const queue = await Queue.findByIdAndUpdate(req.params.id, { price }, { new: true });
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิว' });
    const q = queueToJSON(queue);
    io.to('admin_room').emit('queue_updated', q);
    res.json({ success: true, price: queue.price });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// Submit review (customer — only if done, only once)
app.post('/api/queue/:id/review', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID ไม่ถูกต้อง' });
    const queue = await Queue.findById(req.params.id);
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิว' });
    if (queue.status !== 'done') return res.status(400).json({ error: 'รีวิวได้เฉพาะงานที่เสร็จแล้วเท่านั้น' });
    if (queue.review?.stars) return res.status(400).json({ error: 'รีวิวไปแล้ว' });
    const stars   = parseInt(req.body.stars);
    const comment = stripHtml(req.body.comment || '').slice(0, 500);
    if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'กรุณาให้คะแนน 1-5 ดาว' });
    queue.review = { stars, comment, createdAt: new Date() };
    await queue.save();
    io.to('admin_room').emit('new_review', {
      queueId: req.params.id, queueNumber: queue.queueNumber,
      name: queue.name, stars, comment
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});


// Add work log
app.post('/api/queue/:id/log', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'ID ไม่ถูกต้อง' });
    let { text } = req.body;
    text = stripHtml(text || '').slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });

    const queue = await Queue.findByIdAndUpdate(
      req.params.id,
      { $push: { workLogs: { text, timestamp: new Date() } } },
      { new: true }
    );
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิว' });
    const log = queue.workLogs[queue.workLogs.length - 1];
    const payload = { queueId: req.params.id, log: { text: log.text, author: log.author, timestamp: log.timestamp } };
    io.to(`queue_${req.params.id}`).emit('work_log', payload);
    io.to('admin_room').emit('work_log', payload);
    res.json({ success: true, log: payload.log });
  } catch {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// Admin login — with brute force protection
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  if (password === ADMIN_PASS) {
    recordLoginSuccess(req._loginIp || req.ip);
    res.json({ success: true });
  } else {
    recordLoginFailure(req._loginIp || req.ip);
    res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'ไม่พบหน้าที่ต้องการ' }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function queueToJSON(q) {
  return {
    id:          q._id.toString(),
    queueNumber: q.queueNumber,
    name:        q.name,
    phone:       q.phone,
    problemType: q.problemType,
    date:        q.date,
    description: q.description,
    status:      q.status,
    images:      q.images || [],
    workLogs:    (q.workLogs || []).map(l => ({ text: l.text, author: l.author, timestamp: l.timestamp })),
    price:       q.price ?? null,
    review:      q.review?.stars ? { stars: q.review.stars, comment: q.review.comment, createdAt: q.review.createdAt } : null,
    createdAt:   q.createdAt,
    updatedAt:   q.updatedAt
  };
}
function msgToJSON(m) {
  return {
    id:         m._id.toString(),
    queueId:    m.queueId.toString(),
    text:       m.text,
    imageUrl:   m.imageUrl,
    sender:     m.sender,
    senderName: m.senderName,
    read:       m.read,
    createdAt:  m.createdAt
  };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let adminOnline = false;

io.on('connection', (socket) => {
  socket.on('join_queue', (queueId) => {
    if (!queueId || typeof queueId !== 'string') return;
    socket.join(`queue_${queueId}`);
    socket.emit('admin_status', { online: adminOnline });
  });

  socket.on('admin_join', () => {
    socket.join('admin_room');
    adminOnline = true;
    io.emit('admin_status', { online: true });
  });

  socket.on('send_message', async (data) => {
    try {
      if (!data || !data.queueId || !mongoose.isValidObjectId(data.queueId)) return;
      if (!['customer','admin'].includes(data.sender)) return;

      // Sanitize text
      const text      = stripHtml(data.text || '').slice(0, 2000);
      const imageUrl  = typeof data.imageUrl === 'string' ? data.imageUrl : null;
      const senderName = stripHtml(data.senderName || '').slice(0, 100);

      if (!text && !imageUrl) return; // must have content

      const msg = await Message.create({
        queueId:    data.queueId,
        text, imageUrl, senderName,
        sender:     data.sender,
      });
      const json = msgToJSON(msg);
      io.to(`queue_${data.queueId}`).emit('new_message', json);
      io.to('admin_room').emit('new_message', json);
    } catch (err) {
      console.error('[WS] send_message error:', err.message);
    }
  });

  socket.on('mark_read', async ({ queueId, reader }) => {
    try {
      if (!queueId || !mongoose.isValidObjectId(queueId)) return;
      if (!['admin','customer'].includes(reader)) return;
      const senderToMark = reader === 'admin' ? 'customer' : 'admin';
      await Message.updateMany({ queueId, sender: senderToMark, read: false }, { read: true });
      io.to(`queue_${queueId}`).emit('messages_read', { queueId });
      io.to('admin_room').emit('messages_read', { queueId });
    } catch {}
  });

  socket.on('typing', (data) => {
    if (!data?.queueId) return;
    if (data.sender === 'admin')    io.to(`queue_${data.queueId}`).emit('typing', data);
    else                            io.to('admin_room').emit('typing', data);
  });

  socket.on('disconnect', () => {
    const rooms = [...socket.rooms];
    if (rooms.includes('admin_room')) {
      adminOnline = false;
      io.emit('admin_status', { online: false });
    }
  });
});

// ── Connect DB → Start ────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log(`✅ MongoDB connected`);
    server.listen(PORT, () => {
      console.log(`\n🔧 ซ่อมมั้ย running → http://localhost:${PORT}`);
      console.log(`📋 Admin  → http://localhost:${PORT}/admin.html`);
      console.log(`💬 Chat   → http://localhost:${PORT}/chat.html\n`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
