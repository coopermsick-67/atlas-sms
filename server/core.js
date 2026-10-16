import crypto from 'node:crypto';
import net from 'node:net';

const CONSENTED_VALUES = new Set(['yes', 'true', '1', 'consented', 'opted in', 'opt-in']);
const OPT_OUT_VALUES = new Set(['no', 'false', '0', 'revoked', 'opted out', 'opt-out', 'do not contact']);
const GSM_BASIC = new Set(Array.from(`@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà`));
const GSM_EXTENSION = new Set(Array.from('\f^{}\\[~]|€'));

export function normalizePhone(value, defaultCountryCode = '1') {
  if (value == null) return null;
  let input = String(value).trim();
  if (!input) return null;
  if (/(?:\bext(?:ension)?\.?|\bx|#)\s*\d+\s*$/i.test(input)) return null;
  if (!/^\+?[0-9\s().-]+$/.test(input)) return null;
  const hasPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');
  if (!digits || digits.startsWith('0')) return null;
  if (!hasPlus && defaultCountryCode === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
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
  const consentAt = Date.parse(contact?.consent_at ?? '');
  return contact?.consent_status === 'consented'
    && Boolean(String(contact.consent_source ?? '').trim())
    && Boolean(String(contact.consent_evidence ?? '').trim())
    && Number.isFinite(consentAt)
    && consentAt <= Date.now();
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

export function smsSegmentCount(value) {
  const message = String(value ?? '');
  let septets = 0;
  let isGsm = true;
  for (const character of message) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENSION.has(character)) septets += 2;
    else { isGsm = false; break; }
  }
  if (isGsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  return message.length <= 70 ? 1 : Math.ceil(message.length / 67);
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
  const normalized = String(address).trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  if (net.isIPv4(mapped)) return Number(mapped.split('.')[0]) === 127;
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
}

export function isPrivateNetworkAddress(address = '') {
  const normalized = String(address).trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  if (isLoopbackAddress(normalized)) return true;
  if (net.isIPv4(mapped)) {
    const [first, second] = mapped.split('.').map(Number);
    return first === 10
      || first === 192 && second === 168
      || first === 172 && second >= 16 && second <= 31
      || first === 169 && second === 254;
  }
  return /^f[cd][0-9a-f]{2}:/i.test(normalized) || /^fe[89ab][0-9a-f]:/i.test(normalized);
}

export function validateCsvHeaders(headers) {
  if (!Array.isArray(headers) || headers.length === 0) throw new Error('The CSV needs a header row.');
  if (headers.length > 100) throw new Error('A CSV can contain at most 100 columns.');
  const normalized = headers.map((value) => String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '));
  if (normalized.some((header) => !header)) throw new Error('CSV column names cannot be blank.');
  const seen = new Set();
  for (const header of normalized) {
    if (seen.has(header)) throw new Error(`Duplicate CSV column name: ${header}.`);
    seen.add(header);
  }
  return headers.map((value) => String(value ?? '').trim());
}

export function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, '\\$&');
}

export function cleanMessage(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}
