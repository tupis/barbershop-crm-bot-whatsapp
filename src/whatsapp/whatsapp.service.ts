import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RedisService } from '../redis/redis.service';
import { BotLogger, maskPhone, preview } from '../common/logging/bot-logger';

/** Hard ceiling of messages to one number per hour, whatever the cause. */
const DEFAULT_MAX_OUTBOUND_PER_HOUR = 40;

@Injectable()
export class WhatsappService {
  private readonly log = new BotLogger(WhatsappService.name);
  private readonly apiUrl: string;
  private readonly globalApiKey: string;

  constructor(
    private configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.apiUrl = this.configService.get<string>('EVOLUTION_API_URL') || '';
    this.globalApiKey =
      this.configService.get<string>('EVOLUTION_API_KEY') || '';
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      apikey: this.globalApiKey,
    };
  }

  /**
   * Evolution echoes the bot's own messages back through the webhook with
   * fromMe = true. Recording the id is what lets the webhook tell a bot
   * message apart from one an attendant typed.
   */
  private async rememberSentMessage(instance: string, response: any) {
    const messageId = response?.data?.key?.id;
    if (messageId) {
      await this.redisService.markBotMessage(instance, messageId).catch((err) =>
        // If this fails the echo looks like an attendant reply and the bot
        // pauses itself — worth knowing about.
        this.log.error('redis.mark_bot_message_failed', err, {
          sentMessageId: messageId,
        }),
      );
    }
  }

  /** Strips formatting and prefixes the BR country code when missing. */
  normalizeNumber(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return digits.startsWith('55') ? digits : `55${digits}`;
  }

  private get maxOutboundPerHour(): number {
    const configured = Number(
      this.configService.get<string>('MAX_OUTBOUND_PER_PHONE_PER_HOUR'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_OUTBOUND_PER_HOUR;
  }

  /**
   * Circuit breaker. If anything upstream loops (duplicate webhooks, lost
   * state, a bug in the flow), the customer gets at most N messages an hour
   * and the logs say loudly that it happened.
   */
  private async allowOutbound(
    instance: string,
    number: string,
    kind: string,
  ): Promise<boolean> {
    try {
      const count = await this.redisService.countOutbound(instance, number);
      const limit = this.maxOutboundPerHour;
      if (count > limit) {
        this.log.warn('whatsapp.send_blocked_rate_limit', {
          kind,
          to: maskPhone(number),
          countThisHour: count,
          limit,
        });
        return false;
      }
      if (count === Math.ceil(limit * 0.75)) {
        this.log.warn('whatsapp.send_rate_high', {
          to: maskPhone(number),
          countThisHour: count,
          limit,
        });
      }
      return true;
    } catch (err) {
      // Counting is a safety net; not being able to count must not stop
      // legitimate replies.
      this.log.error('whatsapp.rate_counter_failed', err);
      return true;
    }
  }

  private async post(
    kind: 'text' | 'list' | 'buttons',
    instance: string,
    number: string,
    path: string,
    body: Record<string, unknown>,
    summary: string,
  ): Promise<void> {
    if (!(await this.allowOutbound(instance, number, kind))) return;

    const startedAt = Date.now();
    try {
      const response = await axios.post(
        `${this.apiUrl}/message/${path}/${instance}`,
        body,
        { headers: this.headers, timeout: 15000 },
      );
      await this.rememberSentMessage(instance, response);
      this.log.info('whatsapp.sent', {
        kind,
        to: maskPhone(number),
        sentMessageId: response?.data?.key?.id,
        httpStatus: response?.status,
        durationMs: Date.now() - startedAt,
        preview: preview(summary, 50),
      });
    } catch (error) {
      this.log.error('whatsapp.send_failed', error, {
        kind,
        to: maskPhone(number),
        durationMs: Date.now() - startedAt,
        preview: preview(summary, 50),
      });
    }
  }

  async sendText(instance: string, number: string, text: string) {
    await this.post(
      'text',
      instance,
      number,
      'sendText',
      { number, text, linkPreview: false },
      text,
    );
  }

  async sendList(
    instance: string,
    number: string,
    title: string,
    description: string,
    buttonText: string,
    sections: any[],
  ) {
    await this.post(
      'list',
      instance,
      number,
      'sendList',
      {
        number,
        title,
        description,
        buttonText,
        footerText: 'Barbearia CRM',
        sections,
      },
      `${title} — ${description}`,
    );
  }

  async sendButtons(
    instance: string,
    number: string,
    title: string,
    description: string,
    buttons: any[],
  ) {
    await this.post(
      'buttons',
      instance,
      number,
      'sendButtons',
      {
        number,
        title,
        description,
        footer: 'Barbearia CRM',
        buttons,
      },
      `${title} — ${description}`,
    );
  }
}
