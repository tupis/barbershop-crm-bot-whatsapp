import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingService } from '../booking/booking.service';
import { RedisService } from '../redis/redis.service';

/** How long the bot steps aside after an attendant replies, in minutes. */
const DEFAULT_PAUSE_MINUTES = 10;

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

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

  @Post('whatsapp')
  async handleWebhook(@Body() payload: any) {
    this.logger.log(`Received webhook from Evolution API: ${payload.event}`);

    if (payload.event !== 'messages.upsert') {
      return { status: 'success' };
    }

    const data = payload.data;
    const instance = payload.instance;
    const phone = data?.key?.remoteJid?.split('@')[0];
    const messageId = data?.key?.id;

    if (!phone) return { status: 'success' };

    // Outgoing message. Evolution marks the bot's own sends the same way an
    // attendant's are marked, so the recorded id is what separates them.
    if (data?.key?.fromMe) {
      const isOurs = await this.redisService
        .wasSentByBot(instance, messageId)
        .catch(() => false);

      if (isOurs) return { status: 'success' };

      // A real person is handling this conversation — get out of the way.
      await this.redisService
        .pauseAutomation(instance, phone, this.pauseSeconds)
        .catch(() => undefined);

      this.logger.log(
        `Atendente respondeu ${phone}: automacao pausada por ${this.pauseSeconds / 60} min`,
      );

      return { status: 'success', automation: 'paused' };
    }

    // Incoming message from the customer.
    const paused = await this.redisService
      .isAutomationPaused(instance, phone)
      .catch(() => false);

    if (paused) {
      // Staying silent is the whole point: the attendant is mid-conversation.
      this.logger.log(`Mensagem de ${phone} ignorada: atendimento humano ativo`);
      return { status: 'success', automation: 'paused' };
    }

    const text =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text ||
      data.message?.buttonsResponseMessage?.selectedDisplayText ||
      data.message?.listResponseMessage?.title ||
      '';

    const selectedRowId =
      data.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
      data.message?.buttonsResponseMessage?.selectedButtonId;

    await this.bookingService.handleIncomingMessage(
      instance,
      phone,
      text,
      selectedRowId,
    );

    return { status: 'success' };
  }
}
