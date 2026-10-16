import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-sms-api-test-'));
let serverProcess;
let serverPort;

before(async () => {
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  serverPort = portProbe.address().port;
  await new Promise((resolveClose, rejectClose) => portProbe.close((error) => error ? rejectClose(error) : resolveClose()));

  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, ATLAS_DATA_DIR: dataDir, NODE_ENV: 'production', PORT: String(serverPort) },
    stdio: 'ignore'
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`API test server exited with code ${serverProcess.exitCode}.`);
    try {
      await fetch(`http://127.0.0.1:${serverPort}/api/setup/status`);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw new Error('API test server did not start within 10 seconds.');
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await Promise.race([
      once(serverProcess, 'exit'),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))
    ]);
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test('unknown API routes return a JSON 404 instead of the web application', async () => {
  const url = `http://127.0.0.1:${serverPort}/api/route-that-does-not-exist`;
  const anonymousResponse = await fetch(url);
  assert.equal(anonymousResponse.status, 401);
  assert.match(anonymousResponse.headers.get('content-type') || '', /application\/json/);

  const setupResponse = await fetch(`http://127.0.0.1:${serverPort}/api/setup/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'temporary-test-password' })
  });
  assert.equal(setupResponse.status, 200);
  const cookie = setupResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'admin setup should establish a local session');

  const response = await fetch(url, { headers: { Cookie: cookie } });

  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await response.json(), { error: 'API route not found.' });
});
