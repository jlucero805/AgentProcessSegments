// Guard for scripts/webhook-receiver-example.mjs: the example must verify the
// exact raw bytes, enforce the V2 timestamp freshness window, reject every
// malformed signature before parsing, and model the response contract operators
// copy. The test runs in-process on an ephemeral port so it needs no child
// process, fixed port, or dependency.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TOLERANCE_MS,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  parseArgs,
  startReceiver,
  verifyWebhookSignatureV2,
} from './webhook-receiver-example.mjs';

const SECRET = '0123456789abcdef';
const OTHER_SECRET = 'fedcba9876543210';
const FIXED_NOW = 1_700_000_000_000;
const BODY = JSON.stringify({
  version: 1,
  event: 'budget.test',
  alert: { id: 'alert-1' },
  text: 'hi',
});

function legacySign(body = BODY, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function v2Hex(body = BODY, timestamp = FIXED_NOW, secret = SECRET) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
}

function signV2(body = BODY, timestamp = FIXED_NOW, secret = SECRET) {
  return `t=${timestamp},v2=${v2Hex(body, timestamp, secret)}`;
}

function uppercaseV2(signature) {
  return signature.replace(/v2=([0-9a-f]+)/, (_match, hex) => `v2=${hex.toUpperCase()}`);
}

function headers({ v2, legacy } = {}) {
  const value = { 'content-type': 'application/json' };
  if (typeof v2 === 'string') value['x-aps-signature-v2'] = v2;
  if (typeof legacy === 'string') value['x-aps-signature'] = legacy;
  return value;
}

function post(url, body = BODY, options = {}) {
  const v2 = Object.prototype.hasOwnProperty.call(options, 'v2')
    ? options.v2
    : signV2(body);
  return fetch(url, {
    method: 'POST',
    headers: headers({ v2, legacy: options.legacy }),
    body,
  });
}

async function start(t, overrides = {}) {
  const verified = [];
  const logs = [];
  const receiver = await startReceiver({
    secret: SECRET,
    port: 0,
    now: () => FIXED_NOW,
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

test('verifyWebhookSignatureV2 verifies bytes and the freshness window', () => {
  const options = { now: FIXED_NOW };
  assert.equal(verifyWebhookSignatureV2(BODY, signV2(), SECRET, options), true);
  assert.equal(
    verifyWebhookSignatureV2(Buffer.from(BODY), signV2(), SECRET, options),
    true,
  );
  assert.equal(
    verifyWebhookSignatureV2(new Uint8Array(Buffer.from(BODY)), signV2(), SECRET, options),
    true,
  );
  assert.equal(verifyWebhookSignatureV2(BODY, uppercaseV2(signV2()), SECRET, options), true);

  assert.equal(verifyWebhookSignatureV2(`${BODY} `, signV2(), SECRET, options), false);
  assert.equal(
    verifyWebhookSignatureV2(BODY, signV2(BODY, FIXED_NOW, OTHER_SECRET), SECRET, options),
    false,
  );
  assert.equal(
    verifyWebhookSignatureV2(
      BODY,
      `t=${FIXED_NOW + 1},v2=${v2Hex()}`,
      SECRET,
      options,
    ),
    false,
  );

  assert.equal(
    verifyWebhookSignatureV2(
      BODY,
      signV2(BODY, FIXED_NOW - DEFAULT_TOLERANCE_MS),
      SECRET,
      options,
    ),
    true,
  );
  assert.equal(
    verifyWebhookSignatureV2(
      BODY,
      signV2(BODY, FIXED_NOW - DEFAULT_TOLERANCE_MS - 1),
      SECRET,
      options,
    ),
    false,
  );
  assert.equal(
    verifyWebhookSignatureV2(
      BODY,
      signV2(BODY, FIXED_NOW + DEFAULT_TOLERANCE_MS),
      SECRET,
      options,
    ),
    true,
  );
  assert.equal(
    verifyWebhookSignatureV2(
      BODY,
      signV2(BODY, FIXED_NOW + DEFAULT_TOLERANCE_MS + 1),
      SECRET,
      options,
    ),
    false,
  );
  assert.equal(
    verifyWebhookSignatureV2(BODY, signV2(BODY, FIXED_NOW - 10_000), SECRET, {
      now: FIXED_NOW,
      toleranceMs: 5_000,
    }),
    false,
  );
});

test('verifyWebhookSignatureV2 rejects malformed headers', () => {
  const hex = v2Hex();
  const options = { now: FIXED_NOW };
  const cases = [
    undefined,
    '',
    legacySign(),
    `t=${FIXED_NOW}`,
    `v2=${hex}`,
    `v2=${hex},t=${FIXED_NOW}`,
    ` t=${FIXED_NOW},v2=${hex}`,
    `t=${FIXED_NOW},v2=${hex},x=1`,
    `t=abc,v2=${hex}`,
    `t=${'1'.repeat(16)},v2=${hex}`,
    `t=${FIXED_NOW},v2=${hex.slice(1)}`,
    `t=${FIXED_NOW},v2=${hex}0`,
    `t=${FIXED_NOW},v2=${'g'.repeat(64)}`,
    `T=${FIXED_NOW},v2=${hex}`,
    `t=${FIXED_NOW},V2=${hex}`,
    `${signV2()} `,
  ];

  for (const signature of cases) {
    assert.equal(
      verifyWebhookSignatureV2(BODY, signature, SECRET, options),
      false,
      `signature ${String(signature)}`,
    );
  }
});

test('parseArgs validates CLI input and env fallback', () => {
  assert.deepEqual(parseArgs([], { APS_WEBHOOK_SECRET: SECRET }), {
    secret: SECRET,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    toleranceMs: DEFAULT_TOLERANCE_MS,
    help: false,
  });
  assert.deepEqual(
    parseArgs(
      [
        '--secret',
        SECRET,
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--tolerance-ms',
        '60000',
      ],
      {},
    ),
    {
      secret: SECRET,
      host: '0.0.0.0',
      port: 0,
      toleranceMs: 60_000,
      help: false,
    },
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
  assert.throws(
    () => parseArgs(['--tolerance-ms', 'abc'], { APS_WEBHOOK_SECRET: SECRET }),
    /--tolerance-ms/,
  );
  assert.throws(
    () => parseArgs(['--tolerance-ms', '0'], { APS_WEBHOOK_SECRET: SECRET }),
    /--tolerance-ms/,
  );
  assert.throws(() => parseArgs(['--secret'], {}), /missing value/);
  assert.throws(
    () => parseArgs(['--tolerance-ms'], {}),
    /missing value/,
  );
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
  assert.ok(!text.includes(v2Hex()));
  assert.ok(!text.includes('"text":"hi"'));
});

test('receiver accepts uppercase V2 hex signatures', async (t) => {
  const { receiver, verified } = await start(t);
  const response = await post(receiver.url, BODY, { v2: uppercaseV2(signV2()) });
  assert.equal(response.status, 200);
  assert.equal(verified.length, 1);
});

test('receiver rejects missing, stale, malformed, and tampered V2', async (t) => {
  const { receiver, verified } = await start(t);
  const cases = [
    { v2: null },
    { v2: '' },
    { v2: legacySign() },
    { v2: `t=${FIXED_NOW}` },
    { v2: `v2=${v2Hex()}` },
    { v2: `t=abc,v2=${v2Hex()}` },
    { v2: `t=${FIXED_NOW},v2=${v2Hex().slice(1)}` },
    { v2: signV2(BODY, FIXED_NOW - DEFAULT_TOLERANCE_MS - 1) },
    { v2: signV2(BODY, FIXED_NOW + DEFAULT_TOLERANCE_MS + 1) },
    { v2: signV2(BODY, FIXED_NOW, OTHER_SECRET) },
  ];

  for (const options of cases) {
    const response = await post(receiver.url, BODY, options);
    assert.equal(response.status, 401, `options ${JSON.stringify(options)}`);
    await response.text();
  }

  const tampered = await post(receiver.url, `${BODY} `, { v2: signV2() });
  assert.equal(tampered.status, 401);
  await tampered.text();

  const legacyOnly = await post(receiver.url, BODY, {
    v2: null,
    legacy: legacySign(),
  });
  assert.equal(legacyOnly.status, 401);
  await legacyOnly.text();

  assert.deepEqual(verified, []);
});

test('receiver rejects a validly signed non-JSON body', async (t) => {
  const { receiver, verified } = await start(t);
  const body = '{not json';
  const response = await post(receiver.url, body);
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
  const response = await post(receiver.url, body);
  assert.equal(response.status, 413);
  await response.text();
  assert.deepEqual(verified, []);
});

test('receiver returns 500 when the verified handler fails', async (t) => {
  const logs = [];
  const receiver = await startReceiver({
    secret: SECRET,
    port: 0,
    now: () => FIXED_NOW,
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

test('startReceiver rejects invalid options before listening', async () => {
  await assert.rejects(() => startReceiver({ secret: 'short', port: 0 }), /16-256/);
  await assert.rejects(
    () => startReceiver({ secret: 'a'.repeat(MAX_SECRET_LENGTH + 1), port: 0 }),
    /16-256/,
  );
  await assert.rejects(
    () => startReceiver({ secret: SECRET, port: 0, toleranceMs: 0 }),
    /toleranceMs/,
  );
  await assert.rejects(
    () => startReceiver({ secret: SECRET, port: 0, toleranceMs: 1.5 }),
    /toleranceMs/,
  );
  await assert.rejects(
    () => startReceiver({ secret: SECRET, port: 0, now: 1 }),
    /now/,
  );
});

test('close stops a keep-alive client promptly', async () => {
  const receiver = await startReceiver({
    secret: SECRET,
    port: 0,
    now: () => FIXED_NOW,
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
          headers: headers({ v2: signV2() }),
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

test('operator docs keep the V2 receiver contract visible', () => {
  const doc = readFileSync(
    new URL('../docs/08-user-workflows.md', import.meta.url),
    'utf8',
  );
  assert.match(doc, /### Verify webhook signatures/);
  assert.match(doc, /scripts\/webhook-receiver-example\.mjs/);
  assert.match(doc, /X-APS-Signature-V2: t=<ms>,v2=<64 hex>/);
  assert.match(doc, /5 minutes/);
  assert.match(doc, /retry/i);
  assert.match(doc, /replay/i);
  assert.match(doc, /timingSafeEqual/);
  assert.match(doc, /#verify-webhook-signatures/);
  assert.match(doc, /Upgrading from the legacy header/);
  assert.match(doc, /no longer sent/);
  assert.doesNotMatch(doc, /verifyWebhookSignature/);
  assert.doesNotMatch(doc, /two signature headers/);

  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Verify webhook signatures/);
  assert.match(readme, /X-APS-Signature-V2/);
  assert.match(readme, /no longer sent/);
});
