import crypto from 'node:crypto';

const CONSENTED_VALUES = new Set(['yes', 'true', '1', 'consented', 'opted in', 'opt-in']);
const OPT_OUT_VALUES = new Set(['no', 'false', '0', 'revoked', 'opted out', 'opt-out', 'do not contact']);

export function normalizePhone(value, defaultCountryCode = '1') {
  if (value == null) return null;
  let input = String(value).trim();
  if (!input) return null;
  const hasPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');
  if (!digits) return null;
  if (!hasPlus && digits.length === 10 && defaultCountryCode === '1') digits = `1${digits}`;
  if (!hasPlus && digits.length === 11 && digits.startsWith('1') && defaultCountryCode === '1') {
    return `+${digits}`;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function parseConsent(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (CONSENTED_VALUES.has(normalized)) return 'consented';
  if (OPT_OUT_VALUES.has(normalized)) return 'revoked';
  return 'unknown';
}

export function consentIsDocumented(contact) {
  return contact?.consent_status === 'consented'
    && Boolean(String(contact.consent_source ?? '').trim())
    && Boolean(String(contact.consent_evidence ?? '').trim())
    && Boolean(contact.consent_at)
    && !Number.isNaN(Date.parse(contact.consent_at));
}

export function eligibility(contact, suppressed = false) {
  const reasons = [];
  if (!contact?.phone || !/^\+[1-9]\d{7,14}$/.test(contact.phone)) reasons.push('Invalid phone number');
  if (suppressed || contact?.is_suppressed) reasons.push('Suppressed');
  if (contact?.consent_status !== 'consented') reasons.push('SMS consent not recorded');
  else if (!consentIsDocumented(contact)) reasons.push('Consent proof incomplete');
  return { eligible: reasons.length === 0, reasons };
}

export function renderMessage(template, contact, businessName) {
  const firstName = String(contact?.name ?? '').trim().split(/\s+/)[0] || 'there';
  let message = String(template ?? '')
    .replaceAll('{{first_name}}', firstName)
    .replaceAll('{{name}}', String(contact?.name ?? ''))
    .replaceAll('{{property_address}}', String(contact?.property_address ?? ''))
    .replaceAll('{{city}}', String(contact?.city ?? ''))
    .replaceAll('{{state}}', String(contact?.state ?? ''))
    .replaceAll('{{zip}}', String(contact?.zip ?? ''))
    .replaceAll('{{business_name}}', String(businessName ?? 'Atlas Property Buyers'))
    .trim();
  const brand = String(businessName ?? '').trim();
  if (brand && !message.toLowerCase().includes(brand.toLowerCase())) message = `${brand}: ${message}`;
  if (!/reply\s+stop|text\s+stop|opt\s*out|unsubscribe/i.test(message)) message = `${message} Reply STOP to opt out.`;
  return message.replace(/\s+/g, ' ').trim();
}

export function isOptOutMessage(body) {
  const normalized = String(body ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const exact = new Set([
    'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'opt out',
    'remove', 'remove me', 'do not text', 'dont text', "don't text", 'no more texts',
    'do not contact', 'dont contact me', "don't contact me"
  ]);
  return exact.has(normalized)
    || /\b(stop|unsubscribe|remove me|do not (text|contact)|dont (text|contact)|no more texts|opt out)\b/.test(normalized);
}

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createId() {
  return crypto.randomUUID();
}

export function isLoopbackAddress(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function cleanMessage(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}
