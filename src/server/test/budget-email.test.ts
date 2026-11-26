import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATIONS,
  type EmailSettings,
} from '../src/domain/budget.js';
import {
  EmailSendError,
  createEmailSender,
  emailDestinationHash,
  emailErrorReason,
  type EmailMessage,
  type EmailTransport,
  type TransportFactory,
} from '../src/usage/budget-email.js';

const EMAIL: EmailSettings = {
  enabled: true,
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  username: 'aps',
  password: 'super-secret',
  from: 'APS <alerts@example.test>',
  to: ['ops@example.test', 'OnCall@example.test'],
};

const MESSAGE: EmailMessage = {
  from: 'APS <alerts@example.test>',
  to: ['ops@example.test', 'OnCall@example.test'],
  subject: '[APS] Overall budget warning (80%)',
  text: 'Overall spend reached 80% of its $100.00 monthly budget.',
  messageId: '<budget-alert-1@aps.local>',
  alertId: 'alert-1',
  deliveryId: 'delivery-1',
};

function transport(
  sendMail: EmailTransport['sendMail'] = async () => ({
    accepted: ['ops@example.test'],
    rejected: [],
  }),
): { transport: EmailTransport; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const send = vi.fn(sendMail);
  return { transport: { sendMail: send, close }, close, send };
}

function factory(result: EmailTransport): {
  calls: Array<Parameters<TransportFactory>[0]>;
  createTransport: TransportFactory;
} {
  const calls: Array<Parameters<TransportFactory>[0]> = [];
  return {
    calls,
    createTransport: async (options) => {
      calls.push(options);
      return result;
    },
  };
}

describe('emailDestinationHash', () => {
  it('is stable across recipient order and case', () => {
    const a = emailDestinationHash(EMAIL);
    const b = emailDestinationHash({
      ...EMAIL,
      to: ['oncall@example.test', 'OPS@example.test'],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain('example.test');
  });

  it('changes when any routing or credential field changes', () => {
    const base = emailDestinationHash(EMAIL);
    const changes: Array<Partial<EmailSettings>> = [
      { host: 'smtp.other.test' },
      { port: 465 },
      { secure: true },
      { username: 'other' },
      { password: 'rotated' },
      { from: 'other@example.test' },
      { to: ['ops@example.test'] },
    ];
    for (const change of changes) {
      expect(emailDestinationHash({ ...EMAIL, ...change })).not.toBe(base);
    }
  });
});

describe('createEmailSender', () => {
  it('builds STARTTLS options for a remote host and authenticates', async () => {
    const fake = transport();
    const created = factory(fake.transport);
    const send = createEmailSender({ timeoutMs: 5_000, createTransport: created.createTransport });

    await send(EMAIL, MESSAGE, new AbortController().signal);

    expect(created.calls[0]).toEqual({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'aps', pass: 'super-secret' },
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
      tls: { rejectUnauthorized: true },
    });
    expect(fake.send).toHaveBeenCalledWith({
      from: EMAIL.from,
      to: EMAIL.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      messageId: MESSAGE.messageId,
      headers: {
        'X-APS-Alert-Id': 'alert-1',
        'X-APS-Delivery-Id': 'delivery-1',
      },
    });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('uses event headers instead of an alert id for event mail', async () => {
    const fake = transport();
    const created = factory(fake.transport);
    const send = createEmailSender({ timeoutMs: 5_000, createTransport: created.createTransport });

    await send(
      EMAIL,
      { ...MESSAGE, alertId: undefined, eventKind: 'turn.failed', eventId: 'turn:r1:1' },
      new AbortController().signal,
    );

    expect(fake.send).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          'X-APS-Delivery-Id': 'delivery-1',
          'X-APS-Event-Kind': 'turn.failed',
          'X-APS-Event-Id': 'turn:r1:1',
        },
      }),
    );
  });

  it('uses implicit TLS when secure is on and allows plaintext loopback', async () => {
    const secureFake = transport();
    const secure = factory(secureFake.transport);
    const secureSend = createEmailSender({
      timeoutMs: 1_000,
      createTransport: secure.createTransport,
    });
    await secureSend({ ...EMAIL, secure: true }, MESSAGE, new AbortController().signal);
    expect(secure.calls[0]).toMatchObject({ secure: true, requireTLS: false });
    expect(secure.calls[0]?.auth).toEqual({ user: 'aps', pass: 'super-secret' });

    const loopbackFake = transport();
    const loopback = factory(loopbackFake.transport);
    const loopbackSend = createEmailSender({
      timeoutMs: 1_000,
      createTransport: loopback.createTransport,
    });
    await loopbackSend(
      { ...EMAIL, host: 'localhost', username: null, password: null },
      MESSAGE,
      new AbortController().signal,
    );
    expect(loopback.calls[0]).toMatchObject({ requireTLS: false });
    expect(loopback.calls[0]?.auth).toBeUndefined();
  });

  it('treats partial or empty acceptances as a permanent failure', async () => {
    const partialFake = transport(async () => ({
      accepted: ['ops@example.test'],
      rejected: ['OnCall@example.test'],
    }));
    const partial = factory(partialFake.transport);
    const send = createEmailSender({ timeoutMs: 1_000, createTransport: partial.createTransport });
    await expect(send(EMAIL, MESSAGE, new AbortController().signal)).rejects.toMatchObject({
      reason: 'recipient rejected',
      permanent: true,
    });
    expect(partialFake.close).toHaveBeenCalledOnce();

    const emptyFake = transport(async () => ({ accepted: [], rejected: [] }));
    const empty = factory(emptyFake.transport);
    const emptySend = createEmailSender({
      timeoutMs: 1_000,
      createTransport: empty.createTransport,
    });
    await expect(emptySend(EMAIL, MESSAGE, new AbortController().signal)).rejects.toMatchObject({
      reason: 'recipient rejected',
      permanent: true,
    });
  });

  it('closes the transport when the signal aborts during a send', async () => {
    const fake = transport(() => new Promise(() => undefined));
    const created = factory(fake.transport);
    const send = createEmailSender({
      timeoutMs: 1_000,
      createTransport: created.createTransport,
    });
    const controller = new AbortController();
    void send(EMAIL, MESSAGE, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('refuses an already-aborted signal without opening a transport', async () => {
    const created = factory(transport().transport);
    const send = createEmailSender({ timeoutMs: 1_000, createTransport: created.createTransport });
    const controller = new AbortController();
    controller.abort();
    await expect(send(EMAIL, MESSAGE, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(created.calls).toHaveLength(0);
  });

  it('rejects unconfigured email without a transport', async () => {
    const created = factory(transport().transport);
    const send = createEmailSender({ timeoutMs: 1_000, createTransport: created.createTransport });
    await expect(
      send(
        { ...DEFAULT_NOTIFICATIONS.email, enabled: true },
        MESSAGE,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(EmailSendError);
    expect(created.calls).toHaveLength(0);
  });
});

describe('emailErrorReason', () => {
  it('maps auth and envelope codes to permanent failures', () => {
    expect(emailErrorReason(Object.assign(new Error('bad auth'), { code: 'EAUTH' }))).toEqual({
      reason: 'eauth',
      permanent: true,
    });
    expect(emailErrorReason(Object.assign(new Error('bad envelope'), { code: 'EENVELOPE' }))).toEqual(
      { reason: 'eenvelope', permanent: true },
    );
  });

  it('retries network codes, timeouts, and unknown errors', () => {
    expect(emailErrorReason(Object.assign(new Error('reset'), { code: 'ECONNECTION' }))).toEqual({
      reason: 'econnection',
      permanent: false,
    });
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(emailErrorReason(timeout)).toEqual({ reason: 'timeout', permanent: false });
    expect(emailErrorReason(new TypeError('boom'))).toEqual({
      reason: 'typeerror',
      permanent: false,
    });
    expect(emailErrorReason('nope')).toEqual({ reason: 'smtp error', permanent: false });
  });

  it('never echoes the raw error message', () => {
    const reason = emailErrorReason(new Error('rejected because ops@example.test is bad'));
    expect(reason.reason).toBe('smtp error');
    expect(JSON.stringify(reason)).not.toContain('ops@example.test');
  });
});
