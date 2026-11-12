/**
 * Turns an Evolution `messages.upsert` payload into something the booking
 * flow may answer — or says why it must not.
 *
 * Evolution forwards far more than chat messages through `messages.upsert`:
 * delivery of messages that piled up while the instance was offline,
 * decryption-retry stubs (the same id arrives twice), reactions, edits,
 * deletions, missed-call notices, status updates, group traffic. Each of those
 * used to reach the booking flow as an empty text and, for an idle customer,
 * produced the "choose a unit" welcome menu.
 */

export type IgnoreReason =
  | 'not_upsert'
  | 'no_key'
  | 'no_message_id'
  | 'group'
  | 'broadcast'
  | 'newsletter'
  | 'unresolved_lid'
  | 'unsupported_jid'
  | 'stub'
  | 'no_content'
  | 'unsupported_type'
  | 'stale';

export interface ParsedMessage {
  instance: string;
  messageId: string;
  phone: string;
  fromMe: boolean;
  remoteJid: string;
  messageType: string;
  text: string;
  selectedRowId?: string;
  /** Seconds since the message was sent, when Evolution tells us. */
  ageSeconds?: number;
  messageTimestamp?: number;
}

export type ParseResult =
  | { ok: true; message: ParsedMessage }
  | { ok: false; reason: IgnoreReason; details: Record<string, unknown> };

/** Content the bot actually reacts to. Everything else is ignored. */
const ANSWERABLE_TYPES = new Set([
  'conversation',
  'extendedTextMessage',
  'buttonsResponseMessage',
  'listResponseMessage',
  'templateButtonReplyMessage',
  'interactiveResponseMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'documentWithCaptionMessage',
]);

/** Wrappers whose payload lives one level deeper. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'documentWithCaptionMessage',
];

/** Keys that are metadata, not the content type. */
const META_KEYS = new Set([
  'messageContextInfo',
  'senderKeyDistributionMessage',
  'deviceSentMessage',
]);

export const DEFAULT_MAX_MESSAGE_AGE_SECONDS = 600;

function toNumber(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  // protobuf Long ({ low, high, unsigned })
  if (typeof value === 'object' && typeof value.low === 'number') {
    return value.low + (value.high ?? 0) * 2 ** 32;
  }
  return undefined;
}

function unwrap(message: any): any {
  let current = message;
  for (let i = 0; i < 3 && current; i++) {
    const wrapper = WRAPPERS.find((w) => current[w]?.message);
    if (!wrapper) break;
    current = { ...current, ...current[wrapper].message };
    delete current[wrapper];
  }
  return current;
}

function contentType(message: any): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  return Object.keys(message).find(
    (k) => !META_KEYS.has(k) && message[k] !== undefined && message[k] !== null,
  );
}

/**
 * Customer number for a 1:1 chat. Newer WhatsApp accounts show up as `@lid`
 * (an opaque id, not a phone); Evolution then carries the real number in
 * `remoteJidAlt` / `senderPn`. Answering the lid digits would go nowhere.
 */
function resolvePhone(key: any): { phone: string } | { reason: IgnoreReason } {
  const jid: string = key.remoteJid ?? '';
  if (!jid) return { reason: 'no_key' };
  if (jid.endsWith('@g.us')) return { reason: 'group' };
  if (jid.endsWith('@broadcast')) return { reason: 'broadcast' };
  if (jid.endsWith('@newsletter')) return { reason: 'newsletter' };

  if (jid.endsWith('@lid')) {
    const alt: string | undefined = [key.remoteJidAlt, key.senderPn].find(
      (v) => typeof v === 'string' && v.endsWith('@s.whatsapp.net'),
    );
    if (!alt) return { reason: 'unresolved_lid' };
    return { phone: alt.split('@')[0] };
  }

  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@c.us')) {
    return { reason: 'unsupported_jid' };
  }
  return { phone: jid.split('@')[0].split(':')[0] };
}

export function parseIncoming(
  payload: any,
  options: { now?: number; maxAgeSeconds?: number } = {},
): ParseResult {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_MESSAGE_AGE_SECONDS;

  if (payload?.event !== 'messages.upsert') {
    return {
      ok: false,
      reason: 'not_upsert',
      details: { event: payload?.event },
    };
  }

  const data = payload.data ?? {};
  const key = data.key;
  if (!key) return { ok: false, reason: 'no_key', details: {} };

  const fromMe = Boolean(key.fromMe);
  const remoteJid: string = key.remoteJid ?? '';
  const messageId: string | undefined = key.id;
  const timestamp = toNumber(data.messageTimestamp);
  const ageSeconds =
    timestamp !== undefined
      ? Math.round(
          now / 1000 - (timestamp > 1e12 ? timestamp / 1000 : timestamp),
        )
      : undefined;

  const base = { remoteJid, fromMe, messageType: data.messageType, ageSeconds };

  const resolved = resolvePhone(key);
  if ('reason' in resolved) {
    return { ok: false, reason: resolved.reason, details: base };
  }

  if (!messageId) {
    return { ok: false, reason: 'no_message_id', details: base };
  }

  // System notices (missed call, "waiting for this message", e2e change...).
  if (data.messageStubType !== undefined && data.messageStubType !== null) {
    return {
      ok: false,
      reason: 'stub',
      details: { ...base, stubType: data.messageStubType },
    };
  }

  const message = unwrap(data.message);
  const type = contentType(message) ?? data.messageType;

  // Outgoing messages only need id + phone (handover detection); their
  // content does not matter.
  if (!fromMe) {
    if (!type) return { ok: false, reason: 'no_content', details: base };
    if (!ANSWERABLE_TYPES.has(type)) {
      return {
        ok: false,
        reason: 'unsupported_type',
        details: { ...base, messageType: type },
      };
    }
    // Messages that waited somewhere (instance offline, webhook retried for
    // hours, reconnection backlog) are not answered: replying at 3am to an
    // "oi" from yesterday afternoon is exactly the behaviour to avoid.
    if (ageSeconds !== undefined && ageSeconds > maxAge) {
      return {
        ok: false,
        reason: 'stale',
        details: { ...base, messageType: type, maxAgeSeconds: maxAge },
      };
    }
  }

  const text: string =
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.buttonsResponseMessage?.selectedDisplayText ||
    message?.listResponseMessage?.title ||
    message?.templateButtonReplyMessage?.selectedDisplayText ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    '';

  const selectedRowId: string | undefined =
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.templateButtonReplyMessage?.selectedId ||
    undefined;

  return {
    ok: true,
    message: {
      instance: payload.instance,
      messageId,
      phone: resolved.phone,
      fromMe,
      remoteJid,
      messageType: type ?? 'unknown',
      text,
      selectedRowId,
      ageSeconds,
      messageTimestamp: timestamp,
    },
  };
}
