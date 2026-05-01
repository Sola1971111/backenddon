// backend/routes/chat.js
// Live chat support: visitors create a thread, admin replies via dashboard.

const express = require('express');
const crypto = require('crypto');
const { db } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const rowToThread = (r) => ({
  id: r.id,
  visitorName: r.visitor_name,
  visitorEmail: r.visitor_email,
  lastMessageAt: Number(r.last_message_at),
  unreadAdmin: r.unread_admin,
  unreadVisitor: r.unread_visitor,
  createdAt: Number(r.created_at)
});

const rowToMessage = (r) => ({
  id: r.id,
  threadId: r.thread_id,
  sender: r.sender,
  body: r.body,
  createdAt: Number(r.created_at)
});

// =====================================================
// VISITOR ENDPOINTS (no auth required)
// =====================================================

// POST /api/chat/threads — visitor starts a thread
router.post('/threads', async (req, res, next) => {
  try {
    const b = req.body || {};
    const id = 'th_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();

    await db.query(
      `INSERT INTO chat_threads
       (id, visitor_name, visitor_email, last_message_at, unread_admin, unread_visitor, created_at)
       VALUES ($1, $2, $3, $4, 0, 0, $5)`,
      [id, (b.visitorName || 'Guest').slice(0, 80), (b.visitorEmail || '').slice(0, 120), now, now]
    );

    const result = await db.query('SELECT * FROM chat_threads WHERE id = $1', [id]);
    res.status(201).json(rowToThread(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/threads/:id/messages — visitor sends a message
router.post('/threads/:id/messages', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.body || !b.body.trim()) return res.status(400).json({ error: 'Message body required' });

    const threadRes = await db.query('SELECT id FROM chat_threads WHERE id = $1', [req.params.id]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });

    const sender = b.sender === 'admin' ? 'admin' : 'visitor';
    const id = 'm_' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();

    await db.query(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.params.id, sender, b.body.trim().slice(0, 2000), now]
    );

    if (sender === 'visitor') {
      await db.query(
        'UPDATE chat_threads SET last_message_at = $1, unread_admin = unread_admin + 1, unread_visitor = 0 WHERE id = $2',
        [now, req.params.id]
      );
    } else {
      await db.query(
        'UPDATE chat_threads SET last_message_at = $1, unread_visitor = unread_visitor + 1, unread_admin = 0 WHERE id = $2',
        [now, req.params.id]
      );
    }

    const result = await db.query('SELECT * FROM chat_messages WHERE id = $1', [id]);
    res.status(201).json(rowToMessage(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/threads/:id/messages — visitor polls own thread
router.get('/threads/:id/messages', async (req, res, next) => {
  try {
    const threadRes = await db.query('SELECT * FROM chat_threads WHERE id = $1', [req.params.id]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });

    const messagesRes = await db.query(
      'SELECT * FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({
      thread: rowToThread(threadRes.rows[0]),
      messages: messagesRes.rows.map(rowToMessage)
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/threads/:id/read-visitor — clear visitor unread
router.post('/threads/:id/read-visitor', async (req, res, next) => {
  try {
    await db.query('UPDATE chat_threads SET unread_visitor = 0 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// =====================================================
// ADMIN ENDPOINTS (require auth)
// =====================================================

// GET /api/chat/admin/threads — list all threads
router.get('/admin/threads', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM chat_threads ORDER BY last_message_at DESC');
    res.json(result.rows.map(rowToThread));
  } catch (err) {
    next(err);
  }
});

// GET /api/chat/admin/threads/:id — get a thread + messages
router.get('/admin/threads/:id', requireAdmin, async (req, res, next) => {
  try {
    const threadRes = await db.query('SELECT * FROM chat_threads WHERE id = $1', [req.params.id]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const messagesRes = await db.query(
      'SELECT * FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({
      thread: rowToThread(threadRes.rows[0]),
      messages: messagesRes.rows.map(rowToMessage)
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/admin/threads/:id/messages — admin replies
router.post('/admin/threads/:id/messages', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.body || !b.body.trim()) return res.status(400).json({ error: 'Message body required' });

    const threadRes = await db.query('SELECT id FROM chat_threads WHERE id = $1', [req.params.id]);
    if (threadRes.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });

    const id = 'm_' + crypto.randomBytes(6).toString('hex');
    const now = Date.now();

    await db.query(
      `INSERT INTO chat_messages (id, thread_id, sender, body, created_at)
       VALUES ($1, $2, 'admin', $3, $4)`,
      [id, req.params.id, b.body.trim().slice(0, 2000), now]
    );

    await db.query(
      'UPDATE chat_threads SET last_message_at = $1, unread_visitor = unread_visitor + 1, unread_admin = 0 WHERE id = $2',
      [now, req.params.id]
    );

    const result = await db.query('SELECT * FROM chat_messages WHERE id = $1', [id]);
    res.status(201).json(rowToMessage(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/admin/threads/:id/read — clear admin unread
router.post('/admin/threads/:id/read', requireAdmin, async (req, res, next) => {
  try {
    await db.query('UPDATE chat_threads SET unread_admin = 0 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/chat/admin/threads/:id — delete a thread
router.delete('/admin/threads/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM chat_threads WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
