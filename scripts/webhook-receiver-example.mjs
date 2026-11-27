#!/usr/bin/env node
// Runnable example: verify APS webhook signatures over the exact raw body.
//
// When a signing secret is configured APS sends the legacy
// `X-APS-Signature: sha256=<hex>` over the body only and the recommended
// `X-APS-Signature-V2: t=<ms>,v2=<hex>` over the timestamp and body. This
// example requires V2, enforces a freshness window, verifies before parsing,
// compares digests with crypto.timingSafeEqual, and dedupes on authenticated
// body ids. `Idempotency-Key` is not signed.
//
// This is an example receiver, not a production queue: replace onVerified with
// your durable work. Run with --help for the CLI.

import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;
export const MIN_SECRET_LENGTH = 16;
export const MAX_SECRET_LENGTH = 256;

const SIGNATURE_PREFIX = 'sha256=';
const HEX_SIGNATURE = /^[0-9a-f]{64}$/i;
const SIGNATURE_V2 = /^t=([0-9]{1,15}),v2=([0-9a-fA-F]{64})$/;

const USAGE = `Usage: node scripts/webhook-receiver-example.mjs --secret <secret> [options]

Verify APS webhook signatures over the exact raw request body.

Options:
  --secret <secret>        Signing secret from Config (or set APS_WEBHOOK_SECRET)
  --host <host>            Bind address (default ${DEFAULT_HOST})
  --port <port>            Port, 0 for an ephemeral port (default ${DEFAULT_PORT})
  --tolerance-ms <ms>      V2 freshness window (default ${DEFAULT_TOLERANCE_MS})
  --help, -h               Show this help

Point the APS webhook at the printed loopback URL, or send a signed request with
the same secret. For a remote receiver, terminate HTTPS in front and keep this
process on loopback.`;

export function secretError(secret) {
  if (typeof secret !== 'string' || secret === '') {
    return 'a signing secret is required';
  }
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    return `the signing secret must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters`;
  }
  return null;
}

function bodyBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  return null;
}

/** Verify the legacy body-only signature. It does not prove freshness. */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (
    typeof signatureHeader !== 'string' ||
    !signatureHeader.startsWith(SIGNATURE_PREFIX)
  ) {
    return false;
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!HEX_SIGNATURE.test(providedHex)) return false;

  const body = bodyBytes(rawBody);
  if (body === null) return false;

  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = Buffer.from(providedHex, 'hex');
  return provided.length === expected.length && timingSafeEqual(expected, provided);
}

/**
 * Verify the timestamped V2 signature and its freshness window.
 * `now` is milliseconds; `toleranceMs` must be non-negative.
 */
export function verifyWebhookSignatureV2(
  rawBody,
  signatureHeader,
  secret,
  { now = Date.now(), toleranceMs = DEFAULT_TOLERANCE_MS } = {},
) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof signatureHeader !== 'string') return false;

  const match = SIGNATURE_V2.exec(signatureHeader);
  if (match === null) return false;
  const timestampText = match[1];
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(toleranceMs) ||
    toleranceMs < 0 ||
    Math.abs(now - timestamp) > toleranceMs
  ) {
    return false;
  }

  const body = bodyBytes(rawBody);
  if (body === null) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestampText}.`)
    .update(body)
    .digest();
  const provided = Buffer.from(match[2], 'hex');
  return provided.length === expected.length && timingSafeEqual(expected, provided);
}

function nextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  return value;
}

export function parseArgs(argv, env = {}) {
  const options = {
    secret: typeof env.APS_WEBHOOK_SECRET === 'string' ? env.APS_WEBHOOK_SECRET : '',
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    toleranceMs: DEFAULT_TOLERANCE_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--secret') {
      options.secret = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--host') {
      const host = nextValue(argv, index, arg);
      if (host === '') throw new Error('--host must not be empty');
      options.host = host;
      index += 1;
      continue;
    }
    if (arg === '--port') {
      const raw = nextValue(argv, index, arg);
      if (!/^\d+$/.test(raw)) throw new Error('--port must be an integer from 0 to 65535');
      const port = Number(raw);
      if (port > 65535) throw new Error('--port must be an integer from 0 to 65535');
      options.port = port;
      index += 1;
      continue;
    }
    if (arg === '--tolerance-ms') {
      const raw = nextValue(argv, index, arg);
      if (!/^\d+$/.test(raw)) {
        throw new Error('--tolerance-ms must be a positive integer');
      }
      const toleranceMs = Number(raw);
      if (!Number.isSafeInteger(toleranceMs) || toleranceMs <= 0) {
        throw new Error('--tolerance-ms must be a positive integer');
      }
      options.toleranceMs = toleranceMs;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  if (options.help) return options;
  const problem = secretError(options.secret);
  if (problem !== null) throw new Error(problem);
  return options;
}

function stringField(value, key) {
  if (value === null || typeof value !== 'object') return null;
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function idField(value, key) {
  const field = stringField(value, key);
  return field === null || field === '' ? null : field;
}

function eventSummary(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'event';
  const event = stringField(body, 'event') ?? 'event';
  const id =
    idField(body.alert, 'id') ??
    idField(body.turn, 'turnId') ??
    idField(body.master, 'cellId') ??
    idField(body.summary, 'cellId') ??
    idField(body.override, 'overrideId');
  return id === null ? event : `${event} ${id}`;
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export async function startReceiver(options = {}) {
  const {
    secret,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    toleranceMs = DEFAULT_TOLERANCE_MS,
    now = Date.now,
    onVerified,
    log = console,
  } = options;

  const problem = secretError(secret);
  if (problem !== null) throw new Error(problem);
  if (typeof host !== 'string' || host === '') throw new Error('host must not be empty');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port must be an integer from 0 to 65535');
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error('maxBodyBytes must be a positive integer');
  }
  if (!Number.isInteger(toleranceMs) || toleranceMs <= 0) {
    throw new Error('toleranceMs must be a positive integer');
  }
  if (typeof now !== 'function') throw new Error('now must be a function');
  if (onVerified !== undefined && typeof onVerified !== 'function') {
    throw new Error('onVerified must be a function');
  }

  const logger = log ?? console;
  const handleVerified =
    onVerified ??
    ((_body) => {
      // Replace this with durable work (enqueue, store) and dedupe on the
      // authenticated body ids before acknowledging. The
      // Idempotency-Key header is not signed, so do not trust it as identity.
    });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        req.resume();
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        logger.warn?.('webhook receiver: rejected non-POST request');
        return;
      }

      const chunks = [];
      let size = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBodyBytes) {
          tooLarge = true;
          break;
        }
        chunks.push(buffer);
      }

      if (tooLarge) {
        req.resume();
        sendJson(res, 413, { ok: false, error: 'payload too large' });
        logger.warn?.('webhook receiver: rejected oversized request');
        return;
      }

      const rawBody = Buffer.concat(chunks, size);
      const signature = req.headers['x-aps-signature-v2'];
      if (typeof signature !== 'string') {
        sendJson(res, 401, { ok: false, error: 'invalid signature' });
        logger.warn?.('webhook receiver: rejected missing v2 signature');
        return;
      }
      if (
        !verifyWebhookSignatureV2(rawBody, signature, secret, {
          now: now(),
          toleranceMs,
        })
      ) {
        sendJson(res, 401, { ok: false, error: 'invalid signature' });
        logger.warn?.('webhook receiver: rejected invalid or stale signature');
        return;
      }

      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' });
        logger.warn?.('webhook receiver: rejected invalid JSON');
        return;
      }

      try {
        await handleVerified(body);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'handler failed' });
        logger.warn?.(
          `webhook receiver: handler failed (${error instanceof Error ? error.name : 'unknown'})`,
        );
        return;
      }

      sendJson(res, 200, { ok: true });
      logger.log(`accepted ${eventSummary(body)}`);
    } catch {
      // The client went away or the request stream failed. There is no useful
      // response and nothing safe to log.
      if (!res.writableEnded && !res.destroyed) {
        sendJson(res, 400, { ok: false, error: 'unreadable request' });
      }
    }
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('error', (error) => {
    logger.warn?.(`webhook receiver: server error (${error.code ?? error.name})`);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(
        new Error(
          `could not listen on ${host}:${port} (${error.code ?? error.name ?? 'listen failed'})`,
        ),
      );
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port });
  });

  const address = server.address();
  const actualPort =
    address !== null && typeof address === 'object' ? address.port : port;
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  let closing = null;
  const close = () => {
    if (closing !== null) return closing;
    closing = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
    return closing;
  };

  return { url: `http://${displayHost}:${actualPort}`, close };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    console.error(`webhook receiver: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let receiver;
  try {
    receiver = await startReceiver({
      secret: options.secret,
      host: options.host,
      port: options.port,
      toleranceMs: options.toleranceMs,
    });
  } catch (error) {
    console.error(`webhook receiver: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  console.log(`webhook receiver listening on ${receiver.url}`);
  await new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await receiver.close();
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`webhook receiver: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}
