// backend/routes/donations.js
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, pool } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ==== Multer config: store receipts on disk ====
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_').slice(0, 80);
    const stamp = Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    cb(null, `${stamp}_${safe}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;
  if (allowed.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPG, PNG, WEBP, GIF, or PDF files are allowed'));
};

const maxMb = Number(process.env.MAX_UPLOAD_MB || 5);
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxMb * 1024 * 1024 }
});

const rowToDonation = (r) => ({
  id: r.id,
  campaignId: r.campaign_id,
  donorName: r.donor_name,
  email: r.email,
  amount: Number(r.amount),
  message: r.message,
  anonymous: r.anonymous,
  status: r.status,
  paymentMethod: r.payment_method || 'manual',
  paystackReference: r.paystack_reference || null,
  receiptUrl: r.receipt_filename ? `/api/donations/${r.id}/receipt` : null,
  createdAt: Number(r.created_at),
  approvedAt: r.approved_at ? Number(r.approved_at) : null,
  rejectedAt: r.rejected_at ? Number(r.rejected_at) : null
});

// POST /api/donations — public, multipart with `receipt` file
router.post('/', upload.single('receipt'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.campaignId || !b.donorName || !b.email || !b.amount) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'campaignId, donorName, email, amount required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Receipt file required' });
    }

    const campRes = await db.query('SELECT id FROM campaigns WHERE id = $1', [b.campaignId]);
    if (campRes.rows.length === 0) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const id = 'd_' + crypto.randomBytes(6).toString('hex');
    await db.query(
      `INSERT INTO donations
       (id, campaign_id, donor_name, email, amount, message, anonymous, receipt_filename, status, payment_method, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'manual', $9)`,
      [
        id, b.campaignId, b.donorName.trim(), b.email.trim(),
        Math.max(1, Math.floor(Number(b.amount))),
        (b.message || '').trim(),
        b.anonymous === 'true' || b.anonymous === '1',
        req.file.filename, Date.now()
      ]
    );

    const result = await db.query('SELECT * FROM donations WHERE id = $1', [id]);
    res.status(201).json(rowToDonation(result.rows[0]));
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    next(err);
  }
});

// GET /api/donations — admin (filter by ?status=...)
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const status = req.query.status;
    let result;
    if (!status || status === 'all') {
      result = await db.query('SELECT * FROM donations ORDER BY created_at DESC');
    } else {
      result = await db.query(
        'SELECT * FROM donations WHERE status = $1 ORDER BY created_at DESC',
        [status]
      );
    }
    res.json(result.rows.map(rowToDonation));
  } catch (err) {
    next(err);
  }
});

// GET /api/donations/:id/receipt — admin
router.get('/:id/receipt', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT receipt_filename FROM donations WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].receipt_filename) {
      return res.status(404).json({ error: 'Not found' });
    }
    const file = path.join(uploadDir, result.rows[0].receipt_filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing' });
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

// POST /api/donations/:id/approve — admin (transactional)
router.post('/:id/approve', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dRes = await client.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (dRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const d = dRes.rows[0];
    if (d.status === 'approved') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already approved' });
    }

    await client.query(
      'UPDATE donations SET status = $1, approved_at = $2 WHERE id = $3',
      ['approved', Date.now(), d.id]
    );
    await client.query(
      'UPDATE campaigns SET raised = raised + $1 WHERE id = $2',
      [d.amount, d.campaign_id]
    );

    await client.query('COMMIT');

    const fresh = await db.query('SELECT * FROM donations WHERE id = $1', [d.id]);
    res.json(rowToDonation(fresh.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/donations/:id/reject — admin
router.post('/:id/reject', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dRes = await client.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (dRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const d = dRes.rows[0];

    // If it was approved before, deduct from raised
    if (d.status === 'approved') {
      await client.query(
        'UPDATE campaigns SET raised = GREATEST(0, raised - $1) WHERE id = $2',
        [d.amount, d.campaign_id]
      );
    }

    await client.query(
      'UPDATE donations SET status = $1, rejected_at = $2 WHERE id = $3',
      ['rejected', Date.now(), d.id]
    );

    await client.query('COMMIT');

    const fresh = await db.query('SELECT * FROM donations WHERE id = $1', [d.id]);
    res.json(rowToDonation(fresh.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/donations/:id — admin
router.delete('/:id', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dRes = await client.query('SELECT * FROM donations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (dRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    const d = dRes.rows[0];

    // If approved, deduct from raised before deleting
    if (d.status === 'approved') {
      await client.query(
        'UPDATE campaigns SET raised = GREATEST(0, raised - $1) WHERE id = $2',
        [d.amount, d.campaign_id]
      );
    }

    // Delete receipt file
    if (d.receipt_filename) {
      const file = path.join(uploadDir, d.receipt_filename);
      if (fs.existsSync(file)) try { fs.unlinkSync(file); } catch {}
    }

    await client.query('DELETE FROM donations WHERE id = $1', [d.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
