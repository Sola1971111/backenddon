// backend/routes/settings.js
const express = require('express');
const { db } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/settings/bank — public
router.get('/bank', async (req, res, next) => {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'bank'");
    if (result.rows.length === 0) return res.json({});
    try { res.json(JSON.parse(result.rows[0].value)); }
    catch { res.json({}); }
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/bank — admin only
router.put('/bank', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const required = ['bankName', 'accountName', 'accountNumber'];
    for (const f of required) {
      if (!b[f]) return res.status(400).json({ error: `${f} is required` });
    }
    const value = JSON.stringify({
      bankName: b.bankName,
      accountName: b.accountName,
      accountNumber: b.accountNumber,
      routingCode: b.routingCode || '',
      reference: b.reference || '',
      notes: b.notes || ''
    });

    await db.query(`
      INSERT INTO settings (key, value) VALUES ('bank', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [value]);

    res.json(JSON.parse(value));
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/stats — admin only
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const totalApprovedQ = await db.query(
      "SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM donations WHERE status = 'approved'"
    );
    const pendingQ = await db.query("SELECT COUNT(*)::int AS n FROM donations WHERE status = 'pending'");
    const approvedQ = await db.query("SELECT COUNT(*)::int AS n FROM donations WHERE status = 'approved'");
    const rejectedQ = await db.query("SELECT COUNT(*)::int AS n FROM donations WHERE status = 'rejected'");
    const campaignQ = await db.query("SELECT COUNT(*)::int AS n FROM campaigns");
    const unreadQ = await db.query("SELECT COALESCE(SUM(unread_admin), 0)::int AS n FROM chat_threads");
    const activeQ = await db.query("SELECT COUNT(*)::int AS n FROM chat_threads");

    res.json({
      // BIGINT comes back as a string from pg by default; convert to number
      totalApproved: Number(totalApprovedQ.rows[0].s),
      pendingCount: pendingQ.rows[0].n,
      approvedCount: approvedQ.rows[0].n,
      rejectedCount: rejectedQ.rows[0].n,
      campaignCount: campaignQ.rows[0].n,
      unreadChats: unreadQ.rows[0].n,
      activeChats: activeQ.rows[0].n
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
