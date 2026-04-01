import { Controller, Post, Body, Logger } from '@nestjs/common';
import { BookingService } from '../booking/booking.service';

@Controller('webhook')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(private bookingService: BookingService) {}

  @Post('whatsapp')
  async handleWebhook(@Body() payload: any) {
    this.logger.log(`Received webhook from Evolution API: ${payload.event}`);

    // Evolution API sends 'messages.upsert' for new messages
    if (payload.event === 'messages.upsert') {
      const data = payload.data;
      const instance = payload.instance;
      const phone = data.key.remoteJid.split('@')[0];
      const isFromMe = data.key.fromMe;

      if (isFromMe) return; // Ignore messages sent by the bot

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
    }

    return { status: 'success' };
  }
}
