// backend/routes/paystack.js
// Handles Paystack payment initialization + webhook confirmation.

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { db, pool } = require('../db/init');

const router = express.Router();

const PAYSTACK_API = 'https://api.paystack.co';

// =====================================================
// INITIALIZE PAYMENT (public — donor frontend calls this)
// =====================================================
// Body: { campaignId, donorName, email, amount, message?, anonymous? }
// Returns: { authorizationUrl, reference, donationId }
router.post('/initialize', async (req, res, next) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: 'Paystack not configured' });
    }

    const b = req.body || {};
    if (!b.campaignId || !b.donorName || !b.email || !b.amount) {
      return res.status(400).json({ error: 'campaignId, donorName, email, amount required' });
    }

    // Verify campaign exists
    const campRes = await db.query('SELECT id FROM campaigns WHERE id = $1', [b.campaignId]);
    if (campRes.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Verify site is actually in Paystack mode (so frontend can't bypass admin toggle)
    const methodRes = await db.query("SELECT value FROM settings WHERE key = 'payment_method'");
    const currentMethod = methodRes.rows[0]?.value || 'manual';
    if (currentMethod !== 'paystack') {
      return res.status(400).json({ error: 'Paystack payment is currently disabled' });
    }

    const amountKobo = Math.max(100, Math.floor(Number(b.amount) * 100)); // Paystack uses kobo (smallest unit)
    if (!Number.isFinite(amountKobo) || amountKobo < 100) {
      return res.status(400).json({ error: 'Amount must be at least ₦1' });
    }

    // Create a donation row up-front in `pending` status, so we have a stable id
    // to attach the Paystack reference to. Webhook will update it to `approved`.
    const donationId = 'd_' + crypto.randomBytes(6).toString('hex');
    const reference = 'KND_' + crypto.randomBytes(8).toString('hex'); // our unique reference

    await db.query(
      `INSERT INTO donations
       (id, campaign_id, donor_name, email, amount, message, anonymous,
        status, payment_method, paystack_reference, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'paystack', $8, $9)`,
      [
        donationId, b.campaignId, b.donorName.trim(), b.email.trim(),
        Math.floor(Number(b.amount)),
        (b.message || '').trim(),
        b.anonymous === true || b.anonymous === 'true',
        reference, Date.now()
      ]
    );

    // Call Paystack to initialize the transaction
    const callbackUrl = `${req.protocol}://${req.get('host')}`;
    // ^^^ this gets the backend's own URL, but we want frontend's URL for callback.
    // FRONTEND_ORIGIN env var is comma-separated list; use the first entry.
    const frontendOrigin = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
      .split(',')[0].trim();

    const paystackRes = await axios.post(
      `${PAYSTACK_API}/transaction/initialize`,
      {
        email: b.email.trim(),
        amount: amountKobo,
        reference,
        callback_url: `${frontendOrigin}/?paystack_ref=${reference}`,
        metadata: {
          donation_id: donationId,
          campaign_id: b.campaignId,
          donor_name: b.donorName.trim(),
          custom_fields: [
            { display_name: 'Campaign', variable_name: 'campaign_id', value: b.campaignId },
            { display_name: 'Donor', variable_name: 'donor_name', value: b.donorName.trim() }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (!paystackRes.data?.status) {
      // Roll back the pending donation we created
      await db.query('DELETE FROM donations WHERE id = $1', [donationId]);
      return res.status(502).json({ error: 'Paystack initialization failed' });
    }

    res.json({
      authorizationUrl: paystackRes.data.data.authorization_url,
      reference,
      donationId
    });
  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    next(err);
  }
});

// =====================================================
// VERIFY (frontend calls this after redirect back from Paystack)
// Useful for showing a definitive "approved" or "pending" message to the donor.
// Note: source of truth is still the webhook — this is just for UX.
// =====================================================
router.get('/verify/:reference', async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, status, amount, campaign_id FROM donations WHERE paystack_reference = $1',
      [req.params.reference]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reference not found' });
    }
    const d = result.rows[0];
    res.json({
      donationId: d.id,
      status: d.status,
      amount: Number(d.amount),
      campaignId: d.campaign_id
    });
  } catch (err) {
    next(err);
  }
});

// =====================================================
// WEBHOOK (Paystack calls this server-to-server)
// THIS IS THE SOURCE OF TRUTH for marking donations approved.
// =====================================================
//
// IMPORTANT: this route uses raw body parsing (set up in server.js)
// because we need the exact original bytes to verify the HMAC signature.
//
router.post('/webhook', async (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      console.error('Webhook received but PAYSTACK_SECRET_KEY not set');
      return res.status(500).send('Not configured');
    }

    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      console.warn('Webhook missing signature header');
      return res.status(401).send('Missing signature');
    }

    // req.body is a Buffer here because we use express.raw() for this route
    const rawBody = req.body;
    const expectedSig = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSig) {
      console.warn('Webhook signature mismatch — possibly forged request');
      return res.status(401).send('Invalid signature');
    }

    // Parse the verified body
    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('Paystack webhook event:', event.event);

    // We only care about successful charges
    if (event.event !== 'charge.success') {
      return res.status(200).send('Event ignored');
    }

    const reference = event.data?.reference;
    const amountKobo = event.data?.amount;
    if (!reference || !amountKobo) {
      console.warn('Webhook missing reference or amount');
      return res.status(400).send('Bad payload');
    }
    const amountNaira = Math.floor(amountKobo / 100);

    // Use a transaction so amount-update + status-update happen atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row to prevent race conditions if Paystack retries the webhook
      const dRes = await client.query(
        'SELECT * FROM donations WHERE paystack_reference = $1 FOR UPDATE',
        [reference]
      );

      if (dRes.rows.length === 0) {
        await client.query('ROLLBACK');
        console.warn(`Webhook reference not found in DB: ${reference}`);
        // Still return 200 so Paystack doesn't keep retrying
        return res.status(200).send('Reference not found');
      }

      const d = dRes.rows[0];

      // Idempotency check — if already approved, do nothing (Paystack may retry)
      if (d.status === 'approved') {
        await client.query('COMMIT');
        console.log(`Webhook duplicate ignored for ${reference}`);
        return res.status(200).send('Already approved');
      }

      // Sanity-check amount matches what we recorded
      if (Number(d.amount) !== amountNaira) {
        await client.query('ROLLBACK');
        console.error(`Amount mismatch: db=${d.amount}, paystack=${amountNaira}`);
        return res.status(400).send('Amount mismatch');
      }

      // Mark approved + bump campaign raised total
      await client.query(
        'UPDATE donations SET status = $1, approved_at = $2 WHERE id = $3',
        ['approved', Date.now(), d.id]
      );
      await client.query(
        'UPDATE campaigns SET raised = raised + $1 WHERE id = $2',
        [d.amount, d.campaign_id]
      );

      await client.query('COMMIT');
      console.log(`✓ Donation ${d.id} approved via Paystack (ref ${reference})`);
      return res.status(200).send('OK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    // Return 500 so Paystack retries
    return res.status(500).send('Server error');
  }
});

module.exports = router;