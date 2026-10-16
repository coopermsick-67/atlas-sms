import { parse } from 'csv-parse/sync';
import { db, finalizeCampaignIfIdle } from './db.js';
import { createId, normalizePhone, parseConsent, validateCsvHeaders } from './core.js';

const ALIASES = {
  name: ['name', 'full name', 'owner name', 'seller name', 'contact name', 'first name'],
  phone: ['phone', 'phone number', 'mobile', 'mobile phone', 'cell', 'cell phone', 'telephone'],
  property_address: ['property address', 'address', 'street address', 'site address', 'address 1'],
  city: ['city', 'property city'],
  state: ['state', 'property state'],
  zip: ['zip', 'zipcode', 'zip code', 'postal code'],
  notes: ['notes', 'lead notes', 'reason', 'distress reason'],
  consent_status: ['sms consent', 'consent status', 'consent', 'text consent', 'sms opt in'],
  consent_source: ['consent source', 'opt in source', 'sms consent source'],
  consent_evidence: ['consent proof', 'consent evidence', 'proof', 'consent record', 'consent url'],
  consent_at: ['consent date', 'opt in date', 'consent timestamp', 'consented at']
};

export function parseCsv(csvText) {
  const rows = parse(String(csvText ?? ''), {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    max_record_size: 100_000
  });
  if (!rows.length) return { headers: [], records: [] };
  const headers = validateCsvHeaders(rows[0]);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].length > headers.length && rows[index].slice(headers.length).some((value) => String(value ?? '').trim())) {
      throw new Error(`CSV row ${index + 1} has more values than the header row.`);
    }
  }
  const records = rows.slice(1).map((cells, index) => ({
    row_number: index + 2,
    values: Object.fromEntries(headers.map((header, i) => [header, String(cells[i] ?? '').trim()]))
  }));
  return { headers, records };
}

export function suggestedMapping(headers) {
  const normalized = new Map(headers.map((header) => [header.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(), header]));
  return Object.fromEntries(Object.entries(ALIASES).map(([field, aliases]) => {
    const match = aliases.map((alias) => normalized.get(alias)).find(Boolean) || '';
    return [field, match];
  }));
}

function read(record, mapping, field) {
  const header = mapping?.[field];
  return header ? String(record.values[header] ?? '').trim() : '';
}

function parseDate(value) {
  const date = String(value ?? '').trim();
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function importRecords(records, mapping) {
  const now = new Date().toISOString();
  const insertOrUpdate = db.prepare(`
    INSERT INTO contacts (
      id, name, phone, property_address, city, state, zip, notes,
      consent_status, consent_source, consent_evidence, consent_at, created_at, updated_at
    ) VALUES (
      @id, @name, @phone, @property_address, @city, @state, @zip, @notes,
      @consent_status, @consent_source, @consent_evidence, @consent_at, @created_at, @updated_at
    ) ON CONFLICT(phone) DO UPDATE SET
      name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END,
      property_address = CASE WHEN excluded.property_address <> '' THEN excluded.property_address ELSE contacts.property_address END,
      city = CASE WHEN excluded.city <> '' THEN excluded.city ELSE contacts.city END,
      state = CASE WHEN excluded.state <> '' THEN excluded.state ELSE contacts.state END,
      zip = CASE WHEN excluded.zip <> '' THEN excluded.zip ELSE contacts.zip END,
      notes = CASE WHEN excluded.notes <> '' THEN excluded.notes ELSE contacts.notes END,
      consent_status = CASE WHEN excluded.consent_status = 'consented' THEN 'consented' ELSE contacts.consent_status END,
      consent_source = CASE WHEN excluded.consent_status = 'consented' THEN excluded.consent_source ELSE contacts.consent_source END,
      consent_evidence = CASE WHEN excluded.consent_status = 'consented' THEN excluded.consent_evidence ELSE contacts.consent_evidence END,
      consent_at = CASE WHEN excluded.consent_status = 'consented' THEN excluded.consent_at ELSE contacts.consent_at END,
      updated_at = excluded.updated_at
  `);
  const getExisting = db.prepare('SELECT id FROM contacts WHERE phone = ?');
  const addSuppression = db.prepare(`INSERT INTO suppressions (phone, reason, source, created_at)
    VALUES (?, ?, 'CSV import', ?) ON CONFLICT(phone) DO UPDATE SET
      reason = excluded.reason, source = excluded.source, created_at = excluded.created_at,
      released_at = NULL, release_evidence = ''`);
  const updateRevoked = db.prepare(`UPDATE contacts SET consent_status = 'revoked', updated_at = ? WHERE phone = ?`);
  const inserted = new Set();
  const updated = new Set();
  const skipped = [];
  const tx = db.transaction(() => {
    for (const record of records) {
      const rawPhone = read(record, mapping, 'phone');
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        skipped.push({ row: record.row_number, reason: 'No valid phone number' });
        continue;
      }
      const existing = getExisting.get(phone);
      const consent = parseConsent(read(record, mapping, 'consent_status'));
      const source = read(record, mapping, 'consent_source');
      const evidence = read(record, mapping, 'consent_evidence');
      const consentAt = parseDate(read(record, mapping, 'consent_at'));
      const documented = consent === 'consented' && source && evidence && consentAt && Date.parse(consentAt) <= Date.now();
      const status = documented ? 'consented' : 'unknown';
      const values = {
        id: existing?.id || createId(),
        name: read(record, mapping, 'name'),
        phone,
        property_address: read(record, mapping, 'property_address'),
        city: read(record, mapping, 'city'),
        state: read(record, mapping, 'state'),
        zip: read(record, mapping, 'zip'),
        notes: read(record, mapping, 'notes'),
        consent_status: status,
        consent_source: documented ? source : '',
        consent_evidence: documented ? evidence : '',
        consent_at: documented ? consentAt : null,
        created_at: now,
        updated_at: now
      };
      insertOrUpdate.run(values);
      if (consent === 'revoked') {
        addSuppression.run(phone, 'Opt-out imported from source file', now);
        updateRevoked.run(now, phone);
        const campaignIds = db.prepare(`SELECT DISTINCT campaign_id FROM campaign_recipients WHERE phone = ? AND status = 'queued'`).all(phone).map((row) => row.campaign_id);
        db.prepare(`UPDATE campaign_recipients SET status = 'cancelled', error = 'Suppressed during CSV import'
          WHERE phone = ? AND status = 'queued'`).run(phone);
        for (const campaignId of campaignIds) finalizeCampaignIfIdle(campaignId);
      }
      (existing ? updated : inserted).add(phone);
    }
  });
  tx();
  return { inserted: inserted.size, updated: updated.size, skipped, imported: inserted.size + updated.size };
}
