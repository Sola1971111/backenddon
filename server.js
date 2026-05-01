// backend/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { init } = require('./db/init');

const app = express();

// CORS — accepts comma-separated origins so you can list both
// https://yourdomain.com and https://www.yourdomain.com
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin} is not in FRONTEND_ORIGIN allowlist`));
  },
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/donations', require('./routes/donations'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/chat', require('./routes/chat'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 404
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler (catches multer + general errors)
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB || 5}MB)` });
  }
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await init();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🌱 Kindred backend listening on port ${PORT}`);
      console.log(`   Admin user: ${process.env.ADMIN_USERNAME}`);
      console.log(`   Allowed origins: ${allowedOrigins.join(', ')}\n`);
    });
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
})();
