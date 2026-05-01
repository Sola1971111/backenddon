// backend/routes/campaigns.js
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ==== Multer config for campaign cover images ====
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_').slice(0, 80);
    const stamp = 'campaign_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    cb(null, `${stamp}_${safe}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPG, PNG, WEBP, or GIF images allowed'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

const toBool = (v) => v === true || v === 'true' || v === '1' || v === 1;

const rowToCampaign = (r) => ({
  id: r.id,
  title: r.title,
  story: r.story,
  creator: r.creator,
  category: r.category,
  imageUrl: r.image_filename ? `/api/campaigns/${r.id}/image` : null,
  gradient: r.gradient,
  goal: Number(r.goal),
  raised: Number(r.raised),
  daysLeft: r.days_left,
  urgent: r.urgent,
  createdAt: Number(r.created_at)
});

// GET /api/campaigns — public
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(result.rows.map(rowToCampaign));
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id — public
router.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rowToCampaign(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/campaigns/:id/image — public, serves campaign cover
router.get('/:id/image', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT image_filename FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].image_filename) {
      return res.status(404).json({ error: 'Not found' });
    }
    const file = path.join(uploadDir, result.rows[0].image_filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File missing' });
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns — admin (multipart, optional `image`)
router.post('/', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.title || !b.story || !b.creator || !b.goal) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'title, story, creator, goal required' });
    }
    const id = 'c_' + crypto.randomBytes(6).toString('hex');

    await db.query(
      `INSERT INTO campaigns
       (id, title, story, creator, category, image_filename, gradient, goal, raised, days_left, urgent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11)`,
      [
        id, b.title, b.story, b.creator,
        b.category || 'Community',
        req.file ? req.file.filename : null,
        b.gradient || 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
        Number(b.goal),
        Number(b.daysLeft || 30),
        toBool(b.urgent),
        Date.now()
      ]
    );

    const result = await db.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    res.status(201).json(rowToCampaign(result.rows[0]));
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    next(err);
  }
});

// PATCH /api/campaigns/:id — admin
router.patch('/:id', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const existingRes = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (existingRes.rows.length === 0) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Not found' });
    }
    const existing = existingRes.rows[0];

    let imageFilename = existing.image_filename;
    if (req.file) {
      if (existing.image_filename) {
        const old = path.join(uploadDir, existing.image_filename);
        if (fs.existsSync(old)) try { fs.unlinkSync(old); } catch {}
      }
      imageFilename = req.file.filename;
    }

    await db.query(
      `UPDATE campaigns
       SET title = $1, story = $2, creator = $3, category = $4,
           image_filename = $5, gradient = $6, goal = $7, days_left = $8, urgent = $9
       WHERE id = $10`,
      [
        b.title ?? existing.title,
        b.story ?? existing.story,
        b.creator ?? existing.creator,
        b.category ?? existing.category,
        imageFilename,
        b.gradient ?? existing.gradient,
        b.goal != null ? Number(b.goal) : existing.goal,
        b.daysLeft != null ? Number(b.daysLeft) : existing.days_left,
        b.urgent != null ? toBool(b.urgent) : existing.urgent,
        req.params.id
      ]
    );

    const result = await db.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    res.json(rowToCampaign(result.rows[0]));
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    next(err);
  }
});

// DELETE /api/campaigns/:id — admin
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const existingRes = await db.query(
      'SELECT image_filename FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (existingRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // Delete cover image file
    const imageFilename = existingRes.rows[0].image_filename;
    if (imageFilename) {
      const file = path.join(uploadDir, imageFilename);
      if (fs.existsSync(file)) try { fs.unlinkSync(file); } catch {}
    }

    // Delete receipt files for related donations
    const donationsRes = await db.query(
      'SELECT receipt_filename FROM donations WHERE campaign_id = $1',
      [req.params.id]
    );
    for (const d of donationsRes.rows) {
      if (d.receipt_filename) {
        const file = path.join(uploadDir, d.receipt_filename);
        if (fs.existsSync(file)) try { fs.unlinkSync(file); } catch {}
      }
    }

    // Foreign key cascade handles related donation rows
    await db.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
