import { Body, Controller, Post, Logger, UseGuards } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { SendCodeDto } from './dto/send-code.dto';
import { SendReminderDto } from './dto/send-reminder.dto';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';

@Controller('whatsapp')
export class WhatsappApiController {
  private readonly logger = new Logger(WhatsappApiController.name);

  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('send-code')
  async sendCode(@Body() dto: SendCodeDto) {
    this.logger.log(
      `Sending verification code to ${dto.phone} on instance ${dto.instance}`,
    );

    const message = `Seu código de verificação para o CRM da Barbearia é: *${dto.code}*.\n\nEste código expira em 10 minutos.`;

    await this.whatsappService.sendText(
      dto.instance,
      this.whatsappService.normalizeNumber(dto.phone),
      message,
    );

    return { status: 'success', message: 'Verification code sent' };
  }

  @Post('send-reminder')
  @UseGuards(BotApiKeyGuard)
  async sendReminder(@Body() dto: SendReminderDto) {
    this.logger.log(
      `Enviando lembrete (${dto.leadTimeLabel}) na instancia ${dto.instance}`,
    );

    await this.whatsappService.sendText(
      dto.instance,
      this.whatsappService.normalizeNumber(dto.phone),
      this.buildReminderMessage(dto),
    );

    return { status: 'success', message: 'Reminder sent' };
  }

  /** dd/MM from a YYYY-MM-DD string, without dragging in a date library. */
  private formatDate(date: string): string {
    const [year, month, day] = date.split('-');
    return day && month ? `${day}/${month}/${year}` : date;
  }

  private buildReminderMessage(dto: SendReminderDto): string {
    const lines = [
      `Ola, ${dto.clientName}! 👋`,
      '',
      `Passando para lembrar do seu horario na *${dto.companyName}*.`,
      '',
      `🗓️ ${this.formatDate(dto.date)} as ${dto.startTime}`,
    ];

    if (dto.services?.length) {
      lines.push(`✂️ ${dto.services.join(', ')}`);
    }
    if (dto.barberName) {
      lines.push(`💈 ${dto.barberName}`);
    }

    lines.push(`📍 ${dto.branchName}`);
    if (dto.branchAddress) {
      lines.push(`   ${dto.branchAddress}`);
    }

    lines.push('', `Faltam ${dto.leadTimeLabel}. Ate breve!`);

    return lines.join('\n');
  }
}
