import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from '@nestjs/common';

/**
 * Structured runtime logging for the bot.
 *
 * Every line is `<event> {json}` so it can be grepped by event name
 * (`grep webhook.ignored`) or by field (`grep '"traceId":"3EB0..."'`).
 * The webhook opens a context per incoming message, so every log written
 * while handling it — booking step, backend calls, outgoing sends — carries
 * the same traceId, instance and (masked) phone.
 */

export interface LogContext {
  traceId?: string;
  instance?: string;
  phone?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Keeps the country/area code and the last 4 digits: enough to find a
 * customer's complaint in the logs without writing full numbers to disk.
 * LOG_FULL_PHONES=true turns masking off (use only while investigating).
 */
export function maskPhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  if (process.env.LOG_FULL_PHONES === 'true') return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length <= 6) return '*'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 8)}${digits.slice(-4)}`;
}

/** First chars of a message, single line — enough to recognise it. */
export function preview(text?: string | null, max = 40): string | undefined {
  if (text === undefined || text === null) return undefined;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type Fields = Record<string, unknown>;

export class BotLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  private format(event: string, fields: Fields = {}): string {
    const ctx = currentLogContext();
    const payload: Fields = {
      traceId: ctx.traceId,
      instance: ctx.instance,
      phone: maskPhone(ctx.phone),
      ...fields,
    };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
    return `${event} ${safeStringify(payload)}`;
  }

  info(event: string, fields?: Fields) {
    this.logger.log(this.format(event, fields));
  }

  warn(event: string, fields?: Fields) {
    this.logger.warn(this.format(event, fields));
  }

  debug(event: string, fields?: Fields) {
    this.logger.debug(this.format(event, fields));
  }

  error(event: string, error?: unknown, fields?: Fields) {
    this.logger.error(
      this.format(event, { ...fields, ...describeError(error) }),
      error instanceof Error ? error.stack : undefined,
    );
  }
}

/** Pulls what matters out of axios/ioredis/plain errors. */
export function describeError(error: unknown): Fields {
  if (!error) return {};
  const e: any = error;
  const out: Fields = { error: e.message ?? String(e) };
  if (e.code) out.errorCode = e.code;
  if (e.config?.url) out.url = e.config.url;
  if (e.config?.method) out.method = String(e.config.method).toUpperCase();
  if (e.response?.status) out.status = e.response.status;
  if (e.response?.data !== undefined) {
    out.responseBody = preview(safeStringify(e.response.data), 300);
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
