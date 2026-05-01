// backend/db/init.js
// Postgres database setup, schema creation, and seed data.

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Configure it in .env or your deploy platform.');
  process.exit(1);
}

// Render Postgres requires SSL. The connection string from Render may or may not
// include sslmode=require, so we explicitly enable it here.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

// Tiny helper so route files can do `db.query(...)` without managing the pool.
const db = {
  query: (text, params) => pool.query(text, params),
  pool
};

async function initSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      story TEXT NOT NULL,
      creator TEXT NOT NULL,
      category TEXT NOT NULL,
      image_filename TEXT,
      gradient TEXT DEFAULT 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
      goal BIGINT NOT NULL,
      raised BIGINT NOT NULL DEFAULT 0,
      days_left INTEGER NOT NULL DEFAULT 30,
      urgent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      donor_name TEXT NOT NULL,
      email TEXT NOT NULL,
      amount BIGINT NOT NULL,
      message TEXT,
      anonymous BOOLEAN NOT NULL DEFAULT FALSE,
      receipt_filename TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      approved_at BIGINT,
      rejected_at BIGINT,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      visitor_name TEXT,
      visitor_email TEXT,
      last_message_at BIGINT NOT NULL,
      unread_admin INTEGER NOT NULL DEFAULT 0,
      unread_visitor INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);`);
}

async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.error('⚠️  ADMIN_USERNAME or ADMIN_PASSWORD missing in environment');
    return;
  }
  const existing = await db.query('SELECT id FROM admins WHERE username = $1', [username]);
  if (existing.rows.length > 0) return;

  const hash = bcrypt.hashSync(password, 10);
  await db.query(
    'INSERT INTO admins (username, password_hash, created_at) VALUES ($1, $2, $3)',
    [username, hash, Date.now()]
  );
  console.log(`✓ Admin "${username}" created`);
}

async function seedBankSettings() {
  const existing = await db.query("SELECT value FROM settings WHERE key = 'bank'");
  if (existing.rows.length > 0) return;

  const bank = {
    bankName: 'GTBank',
    accountName: 'Kindred Foundation',
    accountNumber: '0123456789',
    routingCode: '',
    reference: 'Use your full name + campaign title as reference',
    notes: 'Please upload your transfer receipt below after sending payment. Your donation will reflect on the campaign once approved by our team (usually within 24 hours).'
  };

  await db.query(
    "INSERT INTO settings (key, value) VALUES ('bank', $1)",
    [JSON.stringify(bank)]
  );
  console.log('✓ Default bank settings seeded');
}

async function seedCampaigns() {
  const result = await db.query('SELECT COUNT(*)::int AS n FROM campaigns');
  if (result.rows[0].n > 0) return;

  const samples = [
    {
      id: 'c1', title: 'Help Amaru get the surgery he needs',
      category: 'Medical',
      gradient: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
      goal: 5000000, days_left: 5, urgent: true,
      story: 'Amaru is 7 years old and was born with a heart condition that requires urgent corrective surgery. His family has exhausted their savings on initial treatments. Every donation brings him closer to the procedure that will let him run, play, and grow up like any other child.',
      creator: 'Maria Quispe'
    },
    {
      id: 'c2', title: 'Coral nursery for the Mesoamerican reef',
      category: 'Environment',
      gradient: 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)',
      goal: 15000000, days_left: 28, urgent: false,
      story: 'We are building underwater coral nurseries to restore 5 hectares of dying reef in Belize. Funds cover dive equipment, coral fragments, monitoring stations, and training for 12 local marine biologists.',
      creator: 'Reef Restoration Collective'
    },
    {
      id: 'c3', title: 'A graphic novel about queer joy in 1920s Harlem',
      category: 'Creative',
      gradient: 'linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%)',
      goal: 2000000, days_left: 45, urgent: false,
      story: 'A 240-page illustrated novel celebrating Black queer life during the Harlem Renaissance. Three years in the making. Funds cover printing, distribution, and paying our team of artists fairly.',
      creator: 'Jordan Reyes'
    },
    {
      id: 'c4', title: 'A library on wheels for rural Kenya',
      category: 'Education',
      gradient: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
      goal: 3000000, days_left: 14, urgent: false,
      story: 'A converted truck carrying 3,000 books to 24 villages in Kenya weekly. We need funds for the vehicle conversion, initial book stock, and a salary for our librarian-driver for the first year.',
      creator: 'Wanjiru Kamau'
    }
  ];

  const now = Date.now();
  for (const c of samples) {
    await db.query(
      `INSERT INTO campaigns (id, title, story, creator, category, gradient, goal, raised, days_left, urgent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)`,
      [c.id, c.title, c.story, c.creator, c.category, c.gradient, c.goal, c.days_left, c.urgent, now]
    );
  }
  console.log(`✓ Seeded ${samples.length} sample campaigns`);
}

async function init() {
  try {
    await pool.query('SELECT 1');
    console.log('✓ Connected to Postgres');
  } catch (err) {
    console.error('❌ Postgres connection failed:', err.message);
    throw err;
  }

  await initSchema();
  await seedAdmin();
  await seedBankSettings();
  await seedCampaigns();
}

module.exports = { db, pool, init };
