// Guard for scripts/webhook-receiver-example.mjs: the example must verify the
// exact raw bytes, reject every malformed signature before parsing, and model
// the response contract operators copy. The test runs in-process on an
// ephemeral port so it needs no child process, fixed port, or dependency.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  parseArgs,
  startReceiver,
  verifyWebhookSignature,
} from './webhook-receiver-example.mjs';

const SECRET = '0123456789abcdef';
const OTHER_SECRET = 'fedcba9876543210';
const BODY = JSON.stringify({
  version: 1,
  event: 'budget.test',
  alert: { id: 'alert-1' },
  text: 'hi',
});

function sign(body = BODY, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function headers(signature) {
  const value = { 'content-type': 'application/json' };
  if (typeof signature === 'string') value['x-aps-signature'] = signature;
  return value;
}

function post(url, body = BODY, signature = sign()) {
  return fetch(url, { method: 'POST', headers: headers(signature), body });
}

async function start(t, overrides = {}) {
  const verified = [];
  const logs = [];
  const receiver = await startReceiver({
    secret: SECRET,
    port: 0,
    onVerified: (body) => verified.push(body),
    log: {
      log: (line) => logs.push(String(line)),
      warn: (line) => logs.push(String(line)),
    },
    ...overrides,
  });
  t.after(() => receiver.close());
  return { receiver, verified, logs };
}

test('verifyWebhookSignature accepts only sha256 over the exact bytes', () => {
  assert.equal(verifyWebhookSignature(BODY, sign(), SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.from(BODY), sign(), SECRET), true);
  assert.equal(
    verifyWebhookSignature(BODY, `sha256=${sign().slice(7).toUpperCase()}`, SECRET),
    true,
  );

  assert.equal(verifyWebhookSignature(`${BODY} `, sign(), SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, sign(BODY, OTHER_SECRET), SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, undefined, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, '', SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, `sha1=${sign().slice(7)}`, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, 'sha256=', SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, `sha256=${'a'.repeat(63)}`, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, `sha256=${'a'.repeat(65)}`, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, `sha256=${'g'.repeat(64)}`, SECRET), false);
  assert.equal(verifyWebhookSignature(BODY, `${sign()} `, SECRET), false);
});

test('parseArgs validates CLI input and env fallback', () => {
  assert.deepEqual(parseArgs([], { APS_WEBHOOK_SECRET: SECRET }), {
    secret: SECRET,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    help: false,
  });
  assert.deepEqual(
    parseArgs(['--secret', SECRET, '--host', '0.0.0.0', '--port', '0'], {}),
    { secret: SECRET, host: '0.0.0.0', port: 0, help: false },
  );
  assert.equal(
    parseArgs(['--secret', 'explicit-secret-1234'], { APS_WEBHOOK_SECRET: SECRET }).secret,
    'explicit-secret-1234',
  );
  assert.equal(parseArgs(['--help'], {}).help, true);

  assert.throws(() => parseArgs([], {}), /signing secret is required/);
  assert.throws(
    () => parseArgs(['--secret', 'a'.repeat(MIN_SECRET_LENGTH - 1)], {}),
    /16-256/,
  );
  assert.throws(
    () => parseArgs(['--secret', 'a'.repeat(MAX_SECRET_LENGTH + 1)], {}),
    /16-256/,
  );
  assert.throws(
    () => parseArgs(['--port', 'abc'], { APS_WEBHOOK_SECRET: SECRET }),
    /--port/,
  );
  assert.throws(
    () => parseArgs(['--port', '65536'], { APS_WEBHOOK_SECRET: SECRET }),
    /--port/,
  );
  assert.throws(() => parseArgs(['--secret'], {}), /missing value/);
  assert.throws(
    () => parseArgs(['--unknown'], { APS_WEBHOOK_SECRET: SECRET }),
    /unknown option/,
  );
});

test('receiver verifies before parsing and calls onVerified once', async (t) => {
  const { receiver, verified, logs } = await start(t);
  const response = await post(receiver.url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(verified, [JSON.parse(BODY)]);

  const text = logs.join('\n');
  assert.match(text, /accepted budget\.test alert-1/);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes(sign().slice(7)));
  assert.ok(!text.includes('"text":"hi"'));
});

test('receiver accepts uppercase hex signatures', async (t) => {
  const { receiver, verified } = await start(t);
  const response = await post(
    receiver.url,
    BODY,
    `sha256=${sign().slice(7).toUpperCase()}`,
  );
  assert.equal(response.status, 200);
  assert.equal(verified.length, 1);
});

test('receiver rejects invalid signatures before calling the handler', async (t) => {
  const { receiver, verified } = await start(t);
  const cases = [
    null,
    '',
    `sha1=${sign().slice(7)}`,
    'sha256=',
    `sha256=${'a'.repeat(63)}`,
    `sha256=${'a'.repeat(65)}`,
    `sha256=${'g'.repeat(64)}`,
  ];

  for (const signature of cases) {
    const response = await post(receiver.url, BODY, signature);
    assert.equal(response.status, 401, `signature ${String(signature)}`);
    await response.text();
  }

  const tampered = await post(receiver.url, `${BODY} `, sign());
  assert.equal(tampered.status, 401);
  await tampered.text();

  const wrongSecret = await post(receiver.url, BODY, sign(BODY, OTHER_SECRET));
  assert.equal(wrongSecret.status, 401);
  await wrongSecret.text();

  assert.deepEqual(verified, []);
});

test('receiver rejects a validly signed non-JSON body', async (t) => {
  const { receiver, verified } = await start(t);
  const body = '{not json';
  const response = await post(receiver.url, body, sign(body));
  assert.equal(response.status, 400);
  await response.text();
  assert.deepEqual(verified, []);
});

test('receiver rejects non-POST methods', async (t) => {
  const { receiver, verified } = await start(t);
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(receiver.url, { method });
    assert.equal(response.status, 405);
    await response.text();
  }
  assert.deepEqual(verified, []);
});

test('receiver rejects bodies over maxBodyBytes', async (t) => {
  const { receiver, verified } = await start(t, { maxBodyBytes: 32 });
  const body = 'x'.repeat(64);
  const response = await post(receiver.url, body, sign(body));
  assert.equal(response.status, 413);
  await response.text();
  assert.deepEqual(verified, []);
});

test('receiver returns 500 when the verified handler fails', async (t) => {
  const logs = [];
  const receiver = await startReceiver({
    secret: SECRET,
    port: 0,
    onVerified: () => {
      throw new Error('boom');
    },
    log: {
      log: (line) => logs.push(String(line)),
      warn: (line) => logs.push(String(line)),
    },
  });
  t.after(() => receiver.close());

  const response = await post(receiver.url);
  assert.equal(response.status, 500);
  await response.text();
  const text = logs.join('\n');
  assert.match(text, /handler failed \(Error\)/);
  assert.ok(!text.includes('boom'));
});

test('startReceiver rejects invalid secrets before listening', async () => {
  await assert.rejects(() => startReceiver({ secret: 'short', port: 0 }), /16-256/);
  await assert.rejects(
    () => startReceiver({ secret: 'a'.repeat(MAX_SECRET_LENGTH + 1), port: 0 }),
    /16-256/,
  );
});

test('close stops a keep-alive client promptly', async () => {
  const receiver = await startReceiver({
    secret: SECRET,
    port: 0,
    onVerified: () => {},
    log: { log: () => {}, warn: () => {} },
  });
  const agent = new http.Agent({ keepAlive: true });

  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(
        receiver.url,
        {
          method: 'POST',
          agent,
          headers: {
            'content-type': 'application/json',
            'x-aps-signature': sign(),
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(BODY);
    });
    assert.equal(status, 200);

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('close timed out')), 2000);
    });
    try {
      await Promise.race([receiver.close(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    agent.destroy();
    await receiver.close();
  }
});

test('operator docs keep the receiver contract visible', () => {
  const doc = readFileSync(
    new URL('../docs/08-user-workflows.md', import.meta.url),
    'utf8',
  );
  assert.match(doc, /### Verify webhook signatures/);
  assert.match(doc, /scripts\/webhook-receiver-example\.mjs/);
  assert.match(doc, /timingSafeEqual/);
  assert.match(doc, /not\*\*\s+covered by the HMAC/i);
  assert.match(doc, /#verify-webhook-signatures/);

  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Verify webhook signatures/);
});
