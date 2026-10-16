import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { db, finalizeCampaignIfIdle, getSetting, setSetting } from './db.js';
import { cleanMessage, createId, eligibility, hashSecret, isLoopbackAddress, isOptOutMessage, normalizePhone, renderMessage, safeEqual } from './core.js';
import { importRecords, parseCsv, suggestedMapping } from './import.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');
const nowIso = () => new Date().toISOString();
const pairingWindowMs = 5 * 60 * 1000;
let activePairCode = null;
let activePairCodeExpires = 0;
let lastJobClaimAt = 0;

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use(session({
  name: 'atlas.sid',
  secret: process.env.ATLAS_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 12 * 60 * 60 * 1000 }
}));

const loginAttempts = new Map();
const pairAttempts = new Map();

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function replyError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireAdmin(req, res, next) {
  if (req.session?.adminId === 1) return next();
  return replyError(res, 401, 'Sign in to continue.');
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket.remoteAddress || req.ip || '');
}

function newPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, digest };
}

function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(actual, expected);
}

function phoneSuppressed(phone) {
  return Boolean(db.prepare('SELECT phone FROM suppressions WHERE phone = ? AND released_at IS NULL').get(phone));
}

function getContactById(id) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return null;
  return { ...contact, is_suppressed: phoneSuppressed(contact.phone) };
}

function getContactsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const safeIds = [...new Set(ids.map(String))].slice(0, 2000);
  const placeholders = safeIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM contacts WHERE id IN (${placeholders})`).all(...safeIds)
    .map((contact) => ({ ...contact, is_suppressed: phoneSuppressed(contact.phone) }));
}

function importData(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('Choose a CSV file first.');
  if (Buffer.byteLength(csvText, 'utf8') > 7_000_000) throw new Error('CSV files must be smaller than 7 MB.');
  const parsed = parseCsv(csvText);
  if (parsed.headers.length < 2) throw new Error('The CSV needs a header row and at least one data column.');
  return parsed;
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count;
  const consented = db.prepare(`SELECT COUNT(*) AS count FROM contacts
    WHERE consent_status = 'consented' AND consent_source <> '' AND consent_evidence <> '' AND consent_at IS NOT NULL`).get().count;
  const suppressed = db.prepare('SELECT COUNT(*) AS count FROM suppressions WHERE released_at IS NULL').get().count;
  const validPhones = db.prepare(`SELECT COUNT(*) AS count FROM contacts c
    WHERE c.consent_status = 'consented' AND c.consent_source <> '' AND c.consent_evidence <> '' AND c.consent_at IS NOT NULL
    AND c.phone GLOB '+[1-9]*' AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.phone = c.phone AND s.released_at IS NULL)`).get().count;
  return { total, consented, missing_consent: Math.max(0, total - consented - suppressed), suppressed, eligible: validPhones };
}

function mapContact(contact) {
  return {
    ...contact,
    first_name: String(contact.name || '').trim().split(/\s+/)[0] || '',
    is_suppressed: phoneSuppressed(contact.phone),
    eligibility: eligibility(contact, phoneSuppressed(contact.phone))
  };
}

function checkDailyLimit(count) {
  const limit = Math.min(100, Math.max(1, Number(getSetting('daily_send_limit', '100')) || 100));
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const used = db.prepare(`SELECT COUNT(*) AS count FROM campaign_recipients cr
    JOIN campaigns c ON c.id = cr.campaign_id
    WHERE cr.created_at >= ? AND cr.status IN ('queued', 'sending', 'sent', 'failed', 'unknown')
      AND c.status IN ('sending', 'completed', 'partial')`).get(since).count;
  if (used + count > limit) return { ok: false, limit, used, remaining: Math.max(0, limit - used) };
  return { ok: true, limit, used, remaining: limit - used };
}

function expireStaleJobs() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const campaignIds = db.prepare(`SELECT DISTINCT campaign_id FROM campaign_recipients
    WHERE status = 'sending' AND started_at < ?`).all(cutoff).map((row) => row.campaign_id);
  if (!campaignIds.length) return;
  const transaction = db.transaction(() => {
    db.prepare(`UPDATE campaign_recipients SET status = 'unknown', error = 'Delivery status unknown; check the phone and carrier before any manual follow-up.'
      WHERE status = 'sending' AND started_at < ?`).run(cutoff);
    for (const id of campaignIds) {
      const remaining = db.prepare(`SELECT COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status IN ('queued', 'sending')`).get(id).count;
      if (remaining === 0) finalizeCampaignIfIdle(id);
    }
  });
  transaction();
}

function recipientPayload(ids, template) {
  const businessName = getSetting('business_name', 'Atlas Property Buyers');
  const contacts = getContactsByIds(ids);
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const selected = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 2000)
    .map((id) => byId.get(id)).filter(Boolean);
  const eligibleContacts = [];
  const blocked = [];
  for (const contact of selected) {
    const decision = eligibility(contact, contact.is_suppressed);
    const message = renderMessage(template, contact, businessName);
    if (message.length > 480) decision.reasons.push('Personalized message exceeds 480 characters');
    if (!decision.eligible || decision.reasons.length) blocked.push({ id: contact.id, name: contact.name, phone: contact.phone, reasons: decision.reasons });
    else eligibleContacts.push({ contact, message });
  }
  return { selected, eligibleContacts, blocked };
}

const publicApi = express.Router();
publicApi.get('/setup/status', (_req, res) => res.json({ needs_setup: !db.prepare('SELECT id FROM admins WHERE id = 1').get() }));
publicApi.post('/setup/admin', asyncRoute((req, res) => {
  if (!isLoopbackRequest(req)) return replyError(res, 403, 'Create the first password from the computer running Atlas SMS.');
  if (db.prepare('SELECT id FROM admins WHERE id = 1').get()) return replyError(res, 409, 'The first password is already set.');
  const password = String(req.body?.password ?? '');
  if (password.length < 12) return replyError(res, 400, 'Use a password with at least 12 characters.');
  const { salt, digest } = newPasswordHash(password);
  db.prepare('INSERT INTO admins (id, password_salt, password_hash, created_at) VALUES (1, ?, ?, ?)').run(salt, digest, nowIso());
  req.session.adminId = 1;
  return res.json({ ok: true });
}));
publicApi.post('/login', asyncRoute((req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const bucket = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (bucket.until > Date.now() && bucket.count >= 10) return replyError(res, 429, 'Too many attempts. Wait 10 minutes and try again.');
  const admin = db.prepare('SELECT * FROM admins WHERE id = 1').get();
  const valid = admin && verifyPassword(String(req.body?.password ?? ''), admin.password_salt, admin.password_hash);
  if (!valid) {
    const failed = bucket.until < Date.now() ? { count: 0, until: Date.now() + 10 * 60 * 1000 } : bucket;
    failed.count += 1;
    loginAttempts.set(ip, failed);
    return replyError(res, 401, 'That password did not match.');
  }
  loginAttempts.delete(ip);
  req.session.adminId = 1;
  return res.json({ ok: true });
}));
publicApi.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
publicApi.get('/me', (req, res) => res.json({ signed_in: req.session?.adminId === 1 }));
app.use('/api', publicApi);

const bridgeApi = express.Router();
function requireBridge(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return replyError(res, 401, 'Pair this phone with Atlas SMS first.');
  const device = db.prepare('SELECT * FROM bridge_devices WHERE token_hash = ? AND active = 1').get(hashSecret(token));
  if (!device) return replyError(res, 401, 'This phone is no longer paired.');
  req.bridgeDevice = device;
  next();
}

bridgeApi.post('/pair', (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const attempts = pairAttempts.get(ip) || { count: 0, until: 0 };
  if (attempts.until > Date.now() && attempts.count >= 8) return replyError(res, 429, 'Too many pairing attempts. Ask Atlas SMS for a new code.');
  const code = String(req.body?.code ?? '').replace(/\D/g, '').slice(0, 6);
  if (!activePairCode || Date.now() > activePairCodeExpires || !safeEqual(code, activePairCode)) {
    const failed = attempts.until < Date.now() ? { count: 0, until: Date.now() + 10 * 60 * 1000 } : attempts;
    failed.count += 1;
    pairAttempts.set(ip, failed);
    return replyError(res, 401, 'The pairing code is invalid or expired.');
  }
  const name = String(req.body?.name ?? 'Android phone').trim().slice(0, 64) || 'Android phone';
  const phoneNumber = normalizePhone(req.body?.phone_number ?? '') || '';
  const token = crypto.randomBytes(32).toString('base64url');
  const id = createId();
  const now = nowIso();
  db.prepare('UPDATE bridge_devices SET active = 0 WHERE active = 1').run();
  db.prepare(`INSERT INTO bridge_devices (id, name, token_hash, phone_number, last_seen, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)`).run(id, name, hashSecret(token), phoneNumber, now);
  activePairCode = null;
  activePairCodeExpires = 0;
  pairAttempts.delete(ip);
  return res.json({ ok: true, device_id: id, token, message: 'Paired. Keep this token private; it is stored only on this phone and as a hash on the computer.' });
});

bridgeApi.use(requireBridge);
bridgeApi.post('/heartbeat', (req, res) => {
  const phoneNumber = normalizePhone(req.body?.phone_number ?? '') || req.bridgeDevice.phone_number;
  db.prepare('UPDATE bridge_devices SET last_seen = ?, phone_number = ? WHERE id = ?').run(nowIso(), phoneNumber, req.bridgeDevice.id);
  return res.json({ ok: true, server_time: nowIso() });
});
bridgeApi.get('/jobs/next', (req, res) => {
  expireStaleJobs();
  const now = Date.now();
  if (now - lastJobClaimAt < 2500) return res.json({ job: null, wait_ms: 2500 - (now - lastJobClaimAt) });
  const claim = db.transaction(() => {
    const row = db.prepare(`SELECT cr.*, c.name AS campaign_name
      FROM campaign_recipients cr JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.status = 'queued' AND c.status = 'sending'
      ORDER BY cr.created_at ASC LIMIT 1`).get();
    if (!row) return null;
    const contact = getContactById(row.contact_id);
    const decision = eligibility(contact, contact?.is_suppressed);
    if (!decision.eligible) {
      db.prepare(`UPDATE campaign_recipients SET status = 'blocked', error = ? WHERE id = ?`).run(decision.reasons.join(', '), row.id);
      finalizeCampaignIfIdle(row.campaign_id);
      return null;
    }
    const started = nowIso();
    const updated = db.prepare(`UPDATE campaign_recipients SET status = 'sending', started_at = ?
      WHERE id = ? AND status = 'queued'`).run(started, row.id);
    if (!updated.changes) return null;
    return { id: row.id, phone: row.phone, message: row.rendered_message, campaign_name: row.campaign_name };
  });
  const job = claim();
  if (job) lastJobClaimAt = Date.now();
  db.prepare('UPDATE bridge_devices SET last_seen = ? WHERE id = ?').run(nowIso(), req.bridgeDevice.id);
  return res.json({ job });
});
bridgeApi.post('/jobs/:id/result', (req, res) => {
  const recipient = db.prepare('SELECT * FROM campaign_recipients WHERE id = ?').get(req.params.id);
  if (!recipient) return replyError(res, 404, 'Message job not found.');
  if (recipient.status === 'sent' || recipient.status === 'failed') return res.json({ ok: true, status: recipient.status });
  if (recipient.status !== 'sending' && recipient.status !== 'unknown') return replyError(res, 409, 'This message is no longer in progress.');
  const status = req.body?.success === true ? 'sent' : 'failed';
  const error = status === 'failed' ? String(req.body?.error ?? 'The Android SIM could not send this message.').slice(0, 240) : '';
  const sentAt = nowIso();
  db.prepare(`UPDATE campaign_recipients SET status = ?, error = ?, sent_at = ? WHERE id = ?`).run(status, error, sentAt, recipient.id);
  db.prepare(`INSERT INTO messages (id, phone, direction, body, contact_id, campaign_id, recipient_id, status, received_at)
    VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`).run(createId(), recipient.phone, recipient.rendered_message, recipient.contact_id, recipient.campaign_id, recipient.id, status, sentAt);
  finalizeCampaignIfIdle(recipient.campaign_id);
  return res.json({ ok: true, status });
});
bridgeApi.post('/inbound', (req, res) => {
  const phone = normalizePhone(req.body?.phone ?? '');
  const body = cleanMessage(req.body?.body ?? '').slice(0, 1600);
  if (!phone || !body) return replyError(res, 400, 'A valid sender phone and message body are required.');
  const now = nowIso();
  const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  // Do not pull unrelated personal SMS from the paired phone into the CRM.
  if (!contact) return res.json({ ok: true, ignored: true });
  db.prepare(`INSERT INTO messages (id, phone, direction, body, contact_id, status, received_at)
    VALUES (?, ?, 'inbound', ?, ?, 'received', ?)`).run(createId(), phone, body, contact.id, now);
  if (isOptOutMessage(body)) {
    const affectedCampaigns = db.prepare(`SELECT DISTINCT campaign_id FROM campaign_recipients WHERE phone = ? AND status = 'queued'`).all(phone).map((row) => row.campaign_id);
    db.prepare(`INSERT INTO suppressions (phone, reason, source, created_at)
      VALUES (?, ?, 'Inbound SMS', ?) ON CONFLICT(phone) DO UPDATE SET
      reason = excluded.reason, source = excluded.source, created_at = excluded.created_at, released_at = NULL, release_evidence = ''`)
      .run(phone, `Opt-out reply: ${body.slice(0, 80)}`, now);
    db.prepare(`UPDATE contacts SET consent_status = 'revoked', updated_at = ? WHERE phone = ?`).run(now, phone);
    db.prepare(`UPDATE campaign_recipients SET status = 'cancelled', error = 'Suppressed after opt-out reply'
      WHERE phone = ? AND status = 'queued'`).run(phone);
    for (const campaignId of affectedCampaigns) finalizeCampaignIfIdle(campaignId);
    // No further message is sent. The suppression takes effect before the webhook responds.
    return res.json({ ok: true, opted_out: true });
  }
  return res.json({ ok: true, opted_out: false });
});
bridgeApi.delete('/device', (req, res) => {
  db.prepare('UPDATE bridge_devices SET active = 0 WHERE id = ?').run(req.bridgeDevice.id);
  return res.json({ ok: true });
});
app.use('/api/bridge', bridgeApi);

const adminApi = express.Router();
adminApi.use(requireAdmin);
adminApi.get('/dashboard', (_req, res) => {
  expireStaleJobs();
  const campaigns = db.prepare(`SELECT COUNT(*) AS count FROM campaigns WHERE status IN ('sending', 'queued')`).get().count;
  const sentToday = db.prepare(`SELECT COUNT(*) AS count FROM campaign_recipients WHERE status = 'sent' AND sent_at >= ?`)
    .get(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).count;
  const device = db.prepare('SELECT id, name, phone_number, last_seen, active FROM bridge_devices WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  return res.json({ ...getStats(), active_campaigns: campaigns, sent_last_24_hours: sentToday, bridge: device ? { ...device, connected: Boolean(device.last_seen && Date.now() - Date.parse(device.last_seen) < 45_000) } : null });
});

adminApi.get('/leads', (req, res) => {
  const query = String(req.query.q ?? '').trim().slice(0, 120);
  const view = String(req.query.view ?? 'all');
  const page = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit ?? '50', 10) || 50));
  const clauses = [];
  const params = [];
  if (query) {
    clauses.push('(name LIKE ? OR phone LIKE ? OR property_address LIKE ? OR city LIKE ? OR state LIKE ? OR zip LIKE ?)');
    const q = `%${query}%`;
    params.push(q, q, q, q, q, q);
  }
  if (view === 'consented') clauses.push(`consent_status = 'consented' AND consent_source <> '' AND consent_evidence <> '' AND consent_at IS NOT NULL`);
  if (view === 'missing') clauses.push(`consent_status <> 'consented' OR consent_source = '' OR consent_evidence = '' OR consent_at IS NULL`);
  if (view === 'suppressed') clauses.push(`EXISTS (SELECT 1 FROM suppressions s WHERE s.phone = contacts.phone AND s.released_at IS NULL)`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM contacts ${where}`).get(...params).count;
  const rows = db.prepare(`SELECT * FROM contacts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit).map(mapContact);
  return res.json({ rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), stats: getStats() });
});

adminApi.get('/leads/eligible-ids', (req, res) => {
  const query = String(req.query.q ?? '').trim().slice(0, 120);
  const clauses = [`consent_status = 'consented'`, `consent_source <> ''`, `consent_evidence <> ''`, `consent_at IS NOT NULL`];
  const params = [];
  if (query) {
    clauses.push('(name LIKE ? OR phone LIKE ? OR property_address LIKE ? OR city LIKE ? OR state LIKE ? OR zip LIKE ?)');
    const q = `%${query}%`;
    params.push(q, q, q, q, q, q);
  }
  const rows = db.prepare(`SELECT * FROM contacts WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 2000`).all(...params);
  const ids = rows.filter((contact) => eligibility({ ...contact, is_suppressed: phoneSuppressed(contact.phone) }, phoneSuppressed(contact.phone)).eligible).map((contact) => contact.id);
  return res.json({ ids, capped: rows.length === 2000 });
});

adminApi.get('/leads/:id', (req, res) => {
  const contact = getContactById(req.params.id);
  return contact ? res.json(mapContact(contact)) : replyError(res, 404, 'Lead not found.');
});

adminApi.patch('/leads/:id/consent', (req, res) => {
  const contact = getContactById(req.params.id);
  if (!contact) return replyError(res, 404, 'Lead not found.');
  const source = String(req.body?.consent_source ?? '').trim().slice(0, 180);
  const evidence = String(req.body?.consent_evidence ?? '').trim().slice(0, 500);
  const dateInput = String(req.body?.consent_at ?? '').trim();
  const parsedDate = dateInput ? new Date(dateInput) : null;
  if (!source || !evidence || !parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() > Date.now()) {
    return replyError(res, 400, 'Consent source, dated record, and evidence are required.');
  }
  const now = nowIso();
  db.prepare(`UPDATE contacts SET consent_status = 'consented', consent_source = ?, consent_evidence = ?, consent_at = ?, updated_at = ? WHERE id = ?`)
    .run(source, evidence, parsedDate.toISOString(), now, contact.id);
  return res.json(mapContact(getContactById(contact.id)));
});

adminApi.post('/import/preview', (req, res) => {
  try {
    const { headers, records } = importData(req.body?.csv_text);
    return res.json({ headers, suggested_mapping: suggestedMapping(headers), row_count: records.length, preview: records.slice(0, 6).map((row) => row.values) });
  } catch (error) {
    return replyError(res, 400, error.message || 'Could not read this CSV.');
  }
});

adminApi.post('/import', (req, res) => {
  try {
    const { records } = importData(req.body?.csv_text);
    const mapping = req.body?.mapping || {};
    if (!mapping.phone) return replyError(res, 400, 'Map a phone number column before importing.');
    const result = importRecords(records, mapping);
    return res.json({ ...result, stats: getStats(), message: `${result.imported} lead rows imported or updated.` });
  } catch (error) {
    return replyError(res, 400, error.message || 'Could not import this CSV.');
  }
});

adminApi.post('/campaigns/preview', (req, res) => {
  const template = cleanMessage(req.body?.message ?? '');
  if (!template) return replyError(res, 400, 'Write a message to preview.');
  const { eligibleContacts, blocked } = recipientPayload(req.body?.contact_ids, template);
  const messages = eligibleContacts.slice(0, 5).map(({ contact, message }) => ({ id: contact.id, name: contact.name, phone: contact.phone, message }));
  return res.json({ eligible_count: eligibleContacts.length, blocked_count: blocked.length, blocked, messages, daily_limit: checkDailyLimit(eligibleContacts.length) });
});

adminApi.get('/campaigns', (_req, res) => {
  expireStaleJobs();
  const campaigns = db.prepare(`SELECT c.*, COUNT(cr.id) AS recipient_count,
      SUM(CASE WHEN cr.status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN cr.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN cr.status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
      SUM(CASE WHEN cr.status = 'queued' THEN 1 ELSE 0 END) AS queued_count
    FROM campaigns c LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100`).all();
  return res.json({ campaigns });
});

adminApi.post('/campaigns', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 100);
  const template = cleanMessage(req.body?.message ?? '');
  const ids = req.body?.contact_ids;
  if (!name || !template) return replyError(res, 400, 'Campaign name and message are required.');
  if (template.length > 480) return replyError(res, 400, 'Keep the template under 480 characters.');
  const { eligibleContacts, blocked } = recipientPayload(ids, template);
  if (!eligibleContacts.length) return replyError(res, 400, 'No selected leads have complete consent records and valid, unsuppressed numbers.');
  const id = createId();
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO campaigns (id, name, message_template, status, created_at) VALUES (?, ?, ?, 'draft', ?)`)
      .run(id, name, template, now);
    const insert = db.prepare(`INSERT INTO campaign_recipients (id, campaign_id, contact_id, phone, rendered_message, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)`);
    for (const recipient of eligibleContacts) insert.run(createId(), id, recipient.contact.id, recipient.contact.phone, recipient.message, now);
  });
  transaction();
  return res.status(201).json({ id, name, status: 'draft', eligible_count: eligibleContacts.length, blocked_count: blocked.length, blocked, daily_limit: checkDailyLimit(eligibleContacts.length) });
});

adminApi.post('/campaigns/:id/start', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return replyError(res, 404, 'Campaign not found.');
  if (campaign.status !== 'draft') return replyError(res, 409, 'This campaign has already been reviewed.');
  const recipients = db.prepare(`SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued'`).all(campaign.id);
  if (!recipients.length) return replyError(res, 400, 'There are no eligible recipients in this campaign.');
  const dryRun = req.body?.dry_run === true;
  if (dryRun) {
    const now = nowIso();
    db.prepare(`UPDATE campaign_recipients SET status = 'dry_run', error = 'Preview only; no SMS was sent.' WHERE campaign_id = ? AND status = 'queued'`).run(campaign.id);
    db.prepare(`UPDATE campaigns SET status = 'dry_run', started_at = ?, finished_at = ?, dry_run = 1 WHERE id = ?`).run(now, now, campaign.id);
    return res.json({ ok: true, status: 'dry_run', sent: 0, recipient_count: recipients.length });
  }
  if (String(req.body?.confirmation ?? '') !== `SEND ${recipients.length}`) return replyError(res, 400, `Type SEND ${recipients.length} to confirm this campaign.`);
  const device = db.prepare('SELECT * FROM bridge_devices WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  if (!device || !device.last_seen || Date.now() - Date.parse(device.last_seen) > 45_000) return replyError(res, 409, 'Connect the Atlas Android bridge before live sending.');
  const cap = checkDailyLimit(recipients.length);
  if (!cap.ok) return replyError(res, 429, `Daily send limit reached. ${cap.remaining} messages remain in the current 24-hour window.`);
  const now = nowIso();
  const transaction = db.transaction(() => {
    for (const recipient of recipients) {
      const contact = getContactById(recipient.contact_id);
      if (!eligibility(contact, contact?.is_suppressed).eligible) {
        db.prepare(`UPDATE campaign_recipients SET status = 'blocked', error = 'Consent or suppression status changed before send.' WHERE id = ?`).run(recipient.id);
      }
    }
    const remaining = db.prepare(`SELECT COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status = 'queued'`).get(campaign.id).count;
    if (!remaining) throw new Error('All recipients became ineligible before sending.');
    db.prepare(`UPDATE campaigns SET status = 'sending', started_at = ?, dry_run = 0 WHERE id = ?`).run(now, campaign.id);
  });
  try {
    transaction();
  } catch (error) {
    return replyError(res, 409, error.message);
  }
  return res.json({ ok: true, status: 'sending', recipient_count: recipients.length });
});

adminApi.post('/campaigns/:id/cancel', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return replyError(res, 404, 'Campaign not found.');
  const now = nowIso();
  db.prepare(`UPDATE campaign_recipients SET status = 'cancelled', error = 'Cancelled by user'
    WHERE campaign_id = ? AND status = 'queued'`).run(campaign.id);
  db.prepare(`UPDATE campaigns SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('draft', 'sending')`).run(now, campaign.id);
  return res.json({ ok: true });
});

adminApi.get('/conversations', (_req, res) => {
  const conversations = db.prepare(`SELECT m.phone, MAX(m.received_at) AS last_at, COUNT(*) AS message_count,
      (SELECT body FROM messages m2 WHERE m2.phone = m.phone ORDER BY m2.received_at DESC LIMIT 1) AS last_body,
      (SELECT direction FROM messages m2 WHERE m2.phone = m.phone ORDER BY m2.received_at DESC LIMIT 1) AS last_direction,
      COALESCE(c.name, '') AS name, COALESCE(c.property_address, '') AS property_address,
      EXISTS (SELECT 1 FROM suppressions s WHERE s.phone = m.phone AND s.released_at IS NULL) AS is_suppressed
    FROM messages m LEFT JOIN contacts c ON c.phone = m.phone
    GROUP BY m.phone ORDER BY last_at DESC LIMIT 200`).all();
  return res.json({ conversations });
});
adminApi.get('/conversations/:phone', (req, res) => {
  const phone = normalizePhone(decodeURIComponent(req.params.phone));
  if (!phone) return replyError(res, 400, 'Invalid phone number.');
  const messages = db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY received_at ASC LIMIT 500').all(phone);
  return res.json({ messages });
});

adminApi.get('/suppressions', (_req, res) => {
  const suppressions = db.prepare(`SELECT s.*, COALESCE(c.name, '') AS name FROM suppressions s
    LEFT JOIN contacts c ON c.phone = s.phone ORDER BY s.created_at DESC LIMIT 1000`).all();
  return res.json({ suppressions });
});
adminApi.post('/suppressions', (req, res) => {
  const phone = normalizePhone(req.body?.phone ?? '');
  const reason = String(req.body?.reason ?? '').trim().slice(0, 180);
  if (!phone || !reason) return replyError(res, 400, 'Enter a valid phone number and a reason.');
  const now = nowIso();
  const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  if (!contact) db.prepare(`INSERT INTO contacts (id, phone, consent_status, created_at, updated_at) VALUES (?, ?, 'revoked', ?, ?)`)
    .run(createId(), phone, now, now);
  else db.prepare(`UPDATE contacts SET consent_status = 'revoked', updated_at = ? WHERE phone = ?`).run(now, phone);
  db.prepare(`INSERT INTO suppressions (phone, reason, source, created_at) VALUES (?, ?, 'Manual suppression', ?)
    ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source, created_at = excluded.created_at, released_at = NULL, release_evidence = ''`)
    .run(phone, reason, now);
  const affectedCampaigns = db.prepare(`SELECT DISTINCT campaign_id FROM campaign_recipients WHERE phone = ? AND status = 'queued'`).all(phone).map((row) => row.campaign_id);
  db.prepare(`UPDATE campaign_recipients SET status = 'cancelled', error = 'Added to suppression list'
    WHERE phone = ? AND status = 'queued'`).run(phone);
  for (const campaignId of affectedCampaigns) finalizeCampaignIfIdle(campaignId);
  return res.status(201).json({ ok: true, phone });
});
adminApi.post('/suppressions/:phone/release', (req, res) => {
  const phone = normalizePhone(decodeURIComponent(req.params.phone));
  const evidence = String(req.body?.new_consent_evidence ?? '').trim().slice(0, 500);
  const source = String(req.body?.new_consent_source ?? '').trim().slice(0, 180);
  const date = new Date(String(req.body?.new_consent_at ?? ''));
  if (!phone || !source || !evidence || Number.isNaN(date.getTime())) return replyError(res, 400, 'Document new consent source, date, and evidence before releasing suppression.');
  const now = nowIso();
  const exists = db.prepare('SELECT phone FROM suppressions WHERE phone = ? AND released_at IS NULL').get(phone);
  if (!exists) return replyError(res, 404, 'This phone number is not suppressed.');
  db.prepare(`UPDATE suppressions SET released_at = ?, release_evidence = ? WHERE phone = ?`).run(now, `New consent (${source}, ${date.toISOString()}): ${evidence}`, phone);
  db.prepare(`UPDATE contacts SET consent_status = 'consented', consent_source = ?, consent_evidence = ?, consent_at = ?, updated_at = ? WHERE phone = ?`)
    .run(source, evidence, date.toISOString(), now, phone);
  return res.json({ ok: true });
});

adminApi.get('/settings', (_req, res) => res.json({ business_name: getSetting('business_name', 'Atlas Property Buyers'), daily_send_limit: Number(getSetting('daily_send_limit', '100')) }));
adminApi.patch('/settings', (req, res) => {
  const businessName = String(req.body?.business_name ?? '').trim().slice(0, 100);
  const dailyLimit = Number(req.body?.daily_send_limit);
  if (!businessName) return replyError(res, 400, 'Business name is required.');
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) return replyError(res, 400, 'The daily send cap must be between 1 and 100.');
  setSetting('business_name', businessName);
  setSetting('daily_send_limit', String(dailyLimit));
  return res.json({ business_name: businessName, daily_send_limit: dailyLimit });
});

adminApi.get('/bridge/devices', (_req, res) => {
  const device = db.prepare('SELECT id, name, phone_number, last_seen, active, created_at FROM bridge_devices WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  return res.json({ device: device ? { ...device, connected: Boolean(device.last_seen && Date.now() - Date.parse(device.last_seen) < 45_000) } : null });
});
adminApi.post('/bridge/pair-code', (_req, res) => {
  const existing = db.prepare('SELECT id FROM bridge_devices WHERE active = 1').get();
  if (existing) return replyError(res, 409, 'Unpair the current phone before pairing another one.');
  activePairCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  activePairCodeExpires = Date.now() + pairingWindowMs;
  return res.json({ code: activePairCode, expires_in_seconds: 300, server_url: `http://${getPrimaryLanAddress()}:${port}` });
});
adminApi.delete('/bridge/devices/:id', (req, res) => {
  const result = db.prepare('UPDATE bridge_devices SET active = 0 WHERE id = ? AND active = 1').run(req.params.id);
  if (!result.changes) return replyError(res, 404, 'Paired phone not found.');
  return res.json({ ok: true });
});

app.use('/api', adminApi);

function getPrimaryLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  app.get('/', (_req, res) => res.status(200).send('Atlas SMS API is running. Start the Vite app with npm run dev.'));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  return replyError(res, 500, 'Something went wrong. Check the Atlas SMS server log.');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Atlas SMS API listening on port ${port}`);
  console.log(`Dashboard: http://127.0.0.1:${port}${process.env.NODE_ENV === 'production' ? '' : ' (run npm run dev for the Vite dashboard)'}`);
  console.log(`Android bridge address on this network: http://${getPrimaryLanAddress()}:${port}`);
});
