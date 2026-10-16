import test from 'node:test';
import assert from 'node:assert/strict';
import { consentIsDocumented, eligibility, isOptOutMessage, normalizePhone, parseConsent, renderMessage } from '../server/core.js';

test('normalizes common US phone formats and rejects invalid numbers', () => {
  assert.equal(normalizePhone('(513) 555-0100'), '+15135550100');
  assert.equal(normalizePhone('1-513-555-0100'), '+15135550100');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('123'), null);
});

test('consent must include status, source, evidence, and a date', () => {
  assert.equal(parseConsent('YES'), 'consented');
  assert.equal(parseConsent('no'), 'revoked');
  assert.equal(parseConsent('maybe'), 'unknown');
  assert.equal(consentIsDocumented({ consent_status: 'consented', consent_source: 'website', consent_evidence: 'record 42', consent_at: '2026-01-01' }), true);
  assert.equal(consentIsDocumented({ consent_status: 'consented', consent_source: 'website', consent_evidence: '', consent_at: '2026-01-01' }), false);
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
