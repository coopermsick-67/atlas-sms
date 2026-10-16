import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'atlas-sms-import-test-'));
process.env.ATLAS_DATA_DIR = dataDir;

const [{ db }, { importRecords, parseCsv }] = await Promise.all([
  import('../server/db.js'),
  import('../server/import.js')
]);

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('CSV parsing keeps quoted commas and maps normalized headers', () => {
  const parsed = parseCsv('Owner_Name,Phone,Address\n"Jordan, Smith",5135550100,"12 Main St, Apt 4"');
  assert.deepEqual(parsed.headers, ['Owner_Name', 'Phone', 'Address']);
  assert.equal(parsed.records[0].values.Owner_Name, 'Jordan, Smith');
  assert.equal(parsed.records[0].values.Address, '12 Main St, Apt 4');
});

test('duplicate phones in one CSV are counted once as one imported lead', () => {
  const { records } = parseCsv('Name,Phone\nJordan Smith,5135550100\nJordan S, (513) 555-0100');
  const result = importRecords(records, { name: 'Name', phone: 'Phone' });

  assert.deepEqual({ inserted: result.inserted, updated: result.updated, imported: result.imported }, {
    inserted: 1,
    updated: 0,
    imported: 1
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 1);
  assert.equal(db.prepare('SELECT name FROM contacts WHERE phone = ?').get('+15135550100').name, 'Jordan S');
});

test('a later CSV refresh counts an existing lead once as updated', () => {
  const { records } = parseCsv('Name,Phone\nJordan Smith,5135550100\nJordan S, (513) 555-0100');
  const result = importRecords(records, { name: 'Name', phone: 'Phone' });

  assert.deepEqual({ inserted: result.inserted, updated: result.updated, imported: result.imported }, {
    inserted: 0,
    updated: 1,
    imported: 1
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 1);
});
