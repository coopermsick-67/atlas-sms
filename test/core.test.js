import test from 'node:test';
import assert from 'node:assert/strict';
import { consentIsDocumented, eligibility, escapeLike, isLoopbackAddress, isOptOutMessage, isPrivateNetworkAddress, normalizePhone, parseConsent, renderMessage, smsSegmentCount, validateCsvHeaders } from '../server/core.js';

test('normalizes common US phone formats and rejects invalid numbers', () => {
  assert.equal(normalizePhone('(513) 555-0100'), '+15135550100');
  assert.equal(normalizePhone('1-513-555-0100'), '+15135550100');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('513-555-0100 ext 123'), null);
  assert.equal(normalizePhone('Call 513-555-0100'), null);
  assert.equal(normalizePhone('++15135550100'), null);
  assert.equal(normalizePhone('+0 513 555 0100'), null);
  assert.equal(normalizePhone('5135550100123'), null);
  assert.equal(normalizePhone('513555010'), null);
});

test('consent must include status, source, evidence, and a date', () => {
  assert.equal(parseConsent('YES'), 'consented');
  assert.equal(parseConsent('no'), 'revoked');
  assert.equal(parseConsent('maybe'), 'unknown');
  assert.equal(consentIsDocumented({ consent_status: 'consented', consent_source: 'website', consent_evidence: 'record 42', consent_at: '2026-01-01' }), true);
  assert.equal(consentIsDocumented({ consent_status: 'consented', consent_source: 'website', consent_evidence: '', consent_at: '2026-01-01' }), false);
  assert.equal(consentIsDocumented({ consent_status: 'consented', consent_source: 'website', consent_evidence: 'record 43', consent_at: new Date(Date.now() + 60_000).toISOString() }), false);
});

test('eligibility blocks missing consent and suppression', () => {
  const contact = { phone: '+15135550100', consent_status: 'consented', consent_source: 'website', consent_evidence: 'record 1', consent_at: '2026-01-01' };
  assert.equal(eligibility(contact).eligible, true);
  assert.deepEqual(eligibility({ ...contact, consent_status: 'unknown' }).reasons, ['SMS consent not recorded']);
  assert.deepEqual(eligibility(contact, true).reasons, ['Suppressed']);
});

test('renders sender identity, contact values, and opt-out instruction', () => {
  const rendered = renderMessage('Hi {{first_name}}, are you open to discuss {{property_address}}?', { name: 'Jordan Smith', property_address: '123 Main St' }, 'Atlas Buyers');
  assert.match(rendered, /^Atlas Buyers:/);
  assert.match(rendered, /Hi Jordan/);
  assert.match(rendered, /123 Main St/);
  assert.match(rendered, /Reply STOP to opt out\.$/);
});

test('detects STOP and common plain-language opt-out replies', () => {
  for (const body of ['STOP', 'unsubscribe', 'Please remove me', "don't text me again", 'do not contact me']) assert.equal(isOptOutMessage(body), true, body);
  assert.equal(isOptOutMessage('Yes, call me tomorrow'), false);
});

test('classifies only loopback and private addresses as local', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.20.30.40', '172.20.0.1', '192.168.1.20', 'fc00::1', 'fd12:3456::1', 'fe80::1']) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '192.167.1.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
  }
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.2'), false);
});

test('CSV headers reject blanks and duplicate names after normalization', () => {
  assert.deepEqual(validateCsvHeaders([' Phone ', 'Owner_Name']), ['Phone', 'Owner_Name']);
  assert.throws(() => validateCsvHeaders(['Name', ' name ']), /Duplicate CSV column/);
  assert.throws(() => validateCsvHeaders(['Name', '']), /cannot be blank/);
  assert.throws(() => validateCsvHeaders(Array.from({ length: 101 }, (_, index) => `col${index}`)), /at most 100 columns/);
});

test('search terms escape SQL LIKE wildcards literally', () => {
  assert.equal(escapeLike('100%_ready\\'), '100\\%\\_ready\\\\');
});

test('estimates carrier SMS segments for GSM and Unicode messages', () => {
  assert.equal(smsSegmentCount('a'.repeat(160)), 1);
  assert.equal(smsSegmentCount('a'.repeat(161)), 2);
  assert.equal(smsSegmentCount('['), 1);
  assert.equal(smsSegmentCount('中'.repeat(403)), 7);
  assert.equal(smsSegmentCount('😀'.repeat(36)), 2);
});
