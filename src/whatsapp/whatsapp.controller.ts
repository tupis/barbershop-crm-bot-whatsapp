import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { BookingService } from '../booking/booking.service';
import { RedisService } from '../redis/redis.service';
import {
  BotLogger,
  maskPhone,
  preview,
  runWithLogContext,
} from '../common/logging/bot-logger';
import {
  DEFAULT_MAX_MESSAGE_AGE_SECONDS,
  parseIncoming,
} from './incoming-message';

/** How long the bot steps aside after an attendant replies, in minutes. */
const DEFAULT_PAUSE_MINUTES = 10;

@Controller('webhook')
export class WhatsappController {
  private readonly log = new BotLogger(WhatsappController.name);

  constructor(
    private bookingService: BookingService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  private get pauseSeconds(): number {
    const configured = Number(
      this.configService.get<string>('ATTENDANT_PAUSE_MINUTES'),
    );
    const minutes =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_PAUSE_MINUTES;
    return Math.round(minutes * 60);
  }

  private get maxMessageAgeSeconds(): number {
    const configured = Number(
      this.configService.get<string>('WEBHOOK_MAX_MESSAGE_AGE_SECONDS'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_MESSAGE_AGE_SECONDS;
  }

  /**
   * Always answers 2xx. A non-2xx makes Evolution re-deliver the same event,
   * and a re-delivery used to mean a second welcome menu for the customer.
   */
  @Post('whatsapp')
  @HttpCode(201)
  async handleWebhook(@Body() payload: any) {
    const messageId: string | undefined = payload?.data?.key?.id;
    const traceId = messageId ?? randomUUID();

    return runWithLogContext(
      { traceId, instance: payload?.instance },
      async () => {
        const startedAt = Date.now();
        try {
          const result = await this.process(payload);
          this.log.info('webhook.done', {
            outcome: result.outcome,
            durationMs: Date.now() - startedAt,
          });
          return { status: 'success', ...result.extra };
        } catch (error) {
          this.log.error('webhook.failed', error, {
            event: payload?.event,
            durationMs: Date.now() - startedAt,
          });
          return { status: 'error' };
        }
      },
    );
  }

  private async process(
    payload: any,
  ): Promise<{ outcome: string; extra?: Record<string, unknown> }> {
    const event = payload?.event;

    // Only chat traffic is interesting; the rest is logged at debug level so
    // it can be switched on when investigating connection problems.
    if (event !== 'messages.upsert') {
      if (event === 'connection.update') {
        this.log.warn('webhook.connection_update', {
          state: payload?.data?.state,
          statusReason: payload?.data?.statusReason,
        });
      } else {
        this.log.debug('webhook.event_skipped', { event });
      }
      return { outcome: 'not_upsert' };
    }

    const parsed = parseIncoming(payload, {
      maxAgeSeconds: this.maxMessageAgeSeconds,
    });

    if (!parsed.ok) {
      this.log.info('webhook.ignored', {
        reason: parsed.reason,
        remoteJid: maskJid(payload?.data?.key?.remoteJid),
        fromMe: parsed.details.fromMe,
        messageType: parsed.details.messageType ?? payload?.data?.messageType,
        ageSeconds: parsed.details.ageSeconds,
        stubType: parsed.details.stubType,
      });
      return { outcome: `ignored:${parsed.reason}` };
    }

    const msg = parsed.message;

    return runWithLogContext({ phone: msg.phone }, async () => {
      this.log.info('webhook.received', {
        fromMe: msg.fromMe,
        messageType: msg.messageType,
        ageSeconds: msg.ageSeconds,
        textPreview: preview(msg.text, 30),
        selectedRowId: msg.selectedRowId,
        evolutionSource: payload?.data?.source,
        evolutionStatus: payload?.data?.status,
      });

      // Outgoing message. Evolution marks the bot's own sends the same way an
      // attendant's are marked, so the recorded id is what separates them.
      if (msg.fromMe) {
        const isOurs = await this.redisService
          .wasSentByBot(msg.instance, msg.messageId)
          .catch((err) => {
            this.log.error('redis.was_sent_by_bot_failed', err);
            return false;
          });

        if (isOurs) return { outcome: 'own_message' };

        // A real person is handling this conversation — get out of the way.
        await this.redisService
          .pauseAutomation(msg.instance, msg.phone, this.pauseSeconds)
          .catch((err) => this.log.error('redis.pause_failed', err));

        this.log.info('handover.attendant_replied', {
          pauseMinutes: this.pauseSeconds / 60,
        });

        return {
          outcome: 'attendant_reply',
          extra: { automation: 'paused' },
        };
      }

      // Same message delivered twice (webhook retry, decryption retry,
      // reconnection backlog): answer only the first copy. If Redis is down
      // we stay silent — without state the flow would restart anyway.
      let firstTime: boolean;
      try {
        firstTime = await this.redisService.claimMessage(
          msg.instance,
          msg.messageId,
        );
      } catch (err) {
        this.log.error('webhook.dedupe_unavailable', err);
        return { outcome: 'dedupe_unavailable' };
      }

      if (!firstTime) {
        this.log.warn('webhook.duplicate', { messageId: msg.messageId });
        return { outcome: 'duplicate' };
      }

      // Incoming message from the customer.
      const paused = await this.redisService
        .isAutomationPaused(msg.instance, msg.phone)
        .catch((err) => {
          this.log.error('redis.is_paused_failed', err);
          return false;
        });

      if (paused) {
        // Staying silent is the whole point: the attendant is mid-conversation.
        this.log.info('handover.message_ignored_paused');
        return { outcome: 'paused', extra: { automation: 'paused' } };
      }

      await this.bookingService.handleIncomingMessage(
        msg.instance,
        msg.phone,
        msg.text,
        msg.selectedRowId,
      );

      return { outcome: 'handled' };
    });
  }
}

function maskJid(jid?: string): string | undefined {
  if (!jid) return undefined;
  const [user, server] = jid.split('@');
  return `${maskPhone(user)}@${server ?? ''}`;
}
