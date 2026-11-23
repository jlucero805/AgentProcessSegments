import { createHash } from 'node:crypto';
import { isLoopbackSmtpHost, type EmailSettings } from '../domain/budget.js';

export const EMAIL_CHANNEL = 'email';

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
  alertId: string;
  deliveryId: string;
}

/**
 * A classified email failure. `reason` is a short code safe to log; it never
 * contains the SMTP response, recipients, host, or credentials.
 */
export class EmailSendError extends Error {
  constructor(
    readonly reason: string,
    readonly permanent: boolean,
  ) {
    super(reason);
    this.name = 'EmailSendError';
  }
}

export type EmailSendLike = (
  email: EmailSettings,
  message: EmailMessage,
  signal: AbortSignal,
) => Promise<void>;

/**
 * The stable identity of one email destination. Including the password means a
 * credential rotation skips already-queued mail, matching the webhook secret.
 */
export function emailDestinationHash(email: EmailSettings): string {
  const recipients = [...email.to]
    .map((value) => value.trim().toLowerCase())
    .sort()
    .join(',');
  return createHash('sha256')
    .update(
      [
        'email',
        email.host?.trim() ?? '',
        String(email.port),
        email.secure ? 'secure' : 'starttls',
        email.from?.trim() ?? '',
        recipients,
        email.username ?? '',
        email.password ?? '',
      ].join('\n'),
    )
    .digest('hex');
}

interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  tls: { rejectUnauthorized: boolean };
}

interface SendInfo {
  accepted?: unknown[];
  rejected?: unknown[];
}

export interface EmailTransport {
  sendMail(message: Record<string, unknown>): Promise<SendInfo>;
  close(): void;
}

export type TransportFactory = (options: SmtpTransportOptions) => Promise<EmailTransport>;

/** nodemailer is loaded only on the first real send, never in tests. */
async function nodemailerTransport(options: SmtpTransportOptions): Promise<EmailTransport> {
  const module = (await import('nodemailer')) as unknown as {
    createTransport?: (options: SmtpTransportOptions) => EmailTransport;
    default?: { createTransport?: (options: SmtpTransportOptions) => EmailTransport };
  };
  const create = module.createTransport ?? module.default?.createTransport;
  if (!create) throw new EmailSendError('smtp transport unavailable', false);
  return create(options);
}

const PERMANENT_CODES = new Set([
  'EAUTH',
  'ELOGIN',
  'EENVELOPE',
  'EMESSAGE',
  'EPROTOCOL',
  'EACCES',
]);

/** Map a sender failure to a safe reason and a retry decision. */
export function emailErrorReason(error: unknown): { reason: string; permanent: boolean } {
  if (error instanceof EmailSendError) {
    return { reason: error.reason, permanent: error.permanent };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return { reason: 'timeout', permanent: false };
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') {
      const reason = code.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
      return {
        reason: reason === '' ? 'smtp error' : reason,
        permanent: PERMANENT_CODES.has(code.toUpperCase()),
      };
    }
    return {
      reason: error.name === 'Error' ? 'smtp error' : error.name.toLowerCase().slice(0, 40),
      permanent: false,
    };
  }
  return { reason: 'smtp error', permanent: false };
}

function abortError(): Error {
  const error = new Error('email send aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Build the injected email sender. One transport per send keeps a settings
 * change from reusing stale credentials; it is always closed, including on
 * abort or failure.
 */
export function createEmailSender(options: {
  timeoutMs: number;
  createTransport?: TransportFactory;
}): EmailSendLike {
  const factory = options.createTransport ?? nodemailerTransport;
  const timeoutMs = options.timeoutMs;

  return async (email, message, signal) => {
    if (email.host === null || email.from === null || email.to.length === 0) {
      throw new EmailSendError('email is not configured', true);
    }
    const host = email.host.trim();
    const transportOptions: SmtpTransportOptions = {
      host,
      port: email.port,
      secure: email.secure,
      requireTLS: !email.secure && !isLoopbackSmtpHost(host),
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      tls: { rejectUnauthorized: true },
    };
    if (email.username !== null && email.password !== null) {
      transportOptions.auth = { user: email.username, pass: email.password };
    }

    if (signal.aborted) throw abortError();
    const transport = await factory(transportOptions);
    const onAbort = () => {
      try {
        transport.close();
      } catch {
        // Closing twice is harmless; the send already failed.
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal.aborted) throw abortError();
      const info = await transport.sendMail({
        from: email.from,
        to: email.to,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
        headers: {
          'X-APS-Alert-Id': message.alertId,
          'X-APS-Delivery-Id': message.deliveryId,
        },
      });
      const rejected = info.rejected ?? [];
      const accepted = info.accepted ?? [];
      if (rejected.length > 0) throw new EmailSendError('recipient rejected', true);
      if (accepted.length === 0 && email.to.length > 0) {
        throw new EmailSendError('recipient rejected', true);
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof EmailSendError) throw error;
      const classified = emailErrorReason(error);
      throw new EmailSendError(classified.reason, classified.permanent);
    } finally {
      signal.removeEventListener('abort', onAbort);
      onAbort();
    }
  };
}
