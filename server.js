// Fix for ISPs that don't support DNS SRV records (needed for mongodb+srv://)
const dns = require('dns');
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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6
});

const PORT         = process.env.PORT || 3000;
const MONGODB_URI  = process.env.MONGODB_URI || 'mongodb://localhost:27017/zommai';

// ── MongoDB Schemas ───────────────────────────────────────────────────────────

const queueSchema = new mongoose.Schema({
  queueNumber:  { type: Number, required: true, unique: true },
  name:         { type: String, required: true },
  phone:        { type: String, required: true },
  problemType:  { type: String, default: 'ไม่ระบุ' },
  date:         { type: String, default: null },
  description:  { type: String, default: '' },
  status:       { type: String, enum: ['waiting','in_progress','done','cancelled'], default: 'waiting' },
  images:       [{ type: String }]
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  queueId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Queue', required: true },
  text:       { type: String, default: '' },
  imageUrl:   { type: String, default: null },
  sender:     { type: String, enum: ['customer','admin'], required: true },
  senderName: { type: String, default: '' },
  read:       { type: Boolean, default: false }
}, { timestamps: true });

const Queue   = mongoose.model('Queue',   queueSchema);
const Message = mongoose.model('Message', messageSchema);

// ── Counter helper (auto-increment queueNumber) ────────────────────────────
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', counterSchema);

async function nextQueueNumber() {
  const doc = await Counter.findByIdAndUpdate(
    'queueNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
}

// ── Multer Upload ─────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    /image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only images allowed'));
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ──────────────────────────────────────────────────────────────────

// Create queue
app.post('/api/queue', async (req, res) => {
  try {
    const { name, phone, problemType, date, description } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'กรุณากรอกชื่อและเบอร์โทรศัพท์' });

    const queueNumber = await nextQueueNumber();
    const queue = await Queue.create({ queueNumber, name, phone, problemType, date, description });

    io.to('admin_room').emit('new_queue', queueToJSON(queue));
    res.json({ success: true, queue: queueToJSON(queue) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get queue by MongoDB ID
app.get('/api/queue/:id', async (req, res) => {
  try {
    const queue = await Queue.findById(req.params.id);
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิวนี้' });
    res.json(queueToJSON(queue));
  } catch {
    res.status(404).json({ error: 'ไม่พบคิวนี้' });
  }
});

// Get all queues (admin) — newest first
app.get('/api/queues', async (_req, res) => {
  try {
    const queues = await Queue.find().sort({ createdAt: -1 });
    res.json(queues.map(queueToJSON));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update queue status
app.patch('/api/queue/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['waiting','in_progress','done','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const queue = await Queue.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!queue) return res.status(404).json({ error: 'ไม่พบคิวนี้' });

    const q = queueToJSON(queue);
    io.to(`queue_${queue._id}`).emit('queue_updated', q);
    io.to('admin_room').emit('queue_updated', q);
    res.json({ success: true, queue: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload image (standalone)
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

// Attach image to queue
app.post('/api/queue/:id/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = `/uploads/${req.file.filename}`;
    await Queue.findByIdAndUpdate(req.params.id, { $push: { images: url } });
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages for a queue
app.get('/api/messages/:queueId', async (req, res) => {
  try {
    const msgs = await Message.find({ queueId: req.params.queueId }).sort({ createdAt: 1 });
    res.json(msgs.map(msgToJSON));
  } catch {
    res.json([]);
  }
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || 'admin1234';
  if (password === adminPass) res.json({ success: true });
  else res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
});

// Health check for Railway
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));

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
    images:      q.images,
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
  console.log(`[WS] +${socket.id}`);

  socket.on('join_queue', (queueId) => {
    socket.join(`queue_${queueId}`);
    socket.emit('admin_status', { online: adminOnline });
  });

  socket.on('admin_join', () => {
    socket.join('admin_room');
    adminOnline = true;
    io.emit('admin_status', { online: true });
    console.log('[WS] Admin online');
  });

  socket.on('send_message', async (data) => {
    try {
      const msg = await Message.create({
        queueId:    data.queueId,
        text:       data.text   || '',
        imageUrl:   data.imageUrl || null,
        sender:     data.sender,
        senderName: data.senderName || (data.sender === 'admin' ? 'ช่างซ่อมมั้ย' : 'ลูกค้า')
      });
      const json = msgToJSON(msg);
      // Emit to customer room and admin room
      io.to(`queue_${data.queueId}`).emit('new_message', json);
      io.to('admin_room').emit('new_message', json);
    } catch (err) {
      console.error('[WS] send_message error:', err.message);
    }
  });

  socket.on('mark_read', async ({ queueId, reader }) => {
    try {
      // Mark messages from the other side as read
      const senderToMark = reader === 'admin' ? 'customer' : 'admin';
      await Message.updateMany({ queueId, sender: senderToMark, read: false }, { read: true });
      io.to(`queue_${queueId}`).emit('messages_read', { queueId });
      io.to('admin_room').emit('messages_read', { queueId });
    } catch (err) {
      console.error('[WS] mark_read error:', err.message);
    }
  });

  socket.on('typing', (data) => {
    if (data.sender === 'admin') io.to(`queue_${data.queueId}`).emit('typing', data);
    else io.to('admin_room').emit('typing', data);
  });

  socket.on('disconnect', () => {
    if ([...socket.rooms].includes('admin_room')) {
      adminOnline = false;
      io.emit('admin_status', { online: false });
      console.log('[WS] Admin offline');
    }
  });
});

// ── Connect DB → Start Server ─────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log(`✅ MongoDB connected: ${MONGODB_URI.split('@').pop() || 'localhost'}`);
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
