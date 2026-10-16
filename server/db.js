import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = path.resolve(process.env.ATLAS_DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new Database(path.join(dataDir, 'atlas.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL UNIQUE,
  property_address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  zip TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  consent_status TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'consented', 'revoked')),
  consent_source TEXT NOT NULL DEFAULT '',
  consent_evidence TEXT NOT NULL DEFAULT '',
  consent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppressions (
  phone TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  phone TEXT NOT NULL,
  rendered_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  sent_at TEXT,
  UNIQUE(campaign_id, phone)
);
CREATE TABLE IF NOT EXISTS bridge_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  phone_number TEXT NOT NULL DEFAULT '',
  last_seen TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body TEXT NOT NULL,
  contact_id TEXT,
  campaign_id TEXT,
  recipient_id TEXT,
  status TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipients_status ON campaign_recipients(status, created_at);
`);

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('business_name', 'Atlas Property Buyers');
insertSetting.run('daily_send_limit', '100');

export function getSetting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

export function withTransaction(fn) {
  return db.transaction(fn)();
}

export function finalizeCampaignIfIdle(campaignId) {
  const campaign = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign || ['draft', 'dry_run', 'cancelled'].includes(campaign.status)) return;
  const remaining = db.prepare(`SELECT COUNT(*) AS count FROM campaign_recipients
    WHERE campaign_id = ? AND status IN ('queued', 'sending')`).get(campaignId).count;
  if (remaining > 0) return;
  const groups = db.prepare(`SELECT status, COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? GROUP BY status`).all(campaignId);
  const counts = Object.fromEntries(groups.map((row) => [row.status, row.count]));
  const total = groups.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return;
  const sent = counts.sent || 0;
  const failed = (counts.failed || 0) + (counts.blocked || 0) + (counts.unknown || 0);
  const cancelled = counts.cancelled || 0;
  const status = sent === 0 && cancelled === total ? 'cancelled' : sent + failed + cancelled === total && (failed > 0 || cancelled > 0) ? 'partial' : 'completed';
  db.prepare('UPDATE campaigns SET status = ?, finished_at = ? WHERE id = ? AND status <> \'cancelled\'')
    .run(status, new Date().toISOString(), campaignId);
}
