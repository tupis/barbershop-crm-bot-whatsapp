import {
  Body,
  Controller,
  Post,
  Logger,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { WhatsappService } from './whatsapp.service';
import { SendCodeDto } from './dto/send-code.dto';
import { SendReminderDto } from './dto/send-reminder.dto';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';

@Controller('whatsapp')
export class WhatsappApiController {
  private readonly logger = new Logger(WhatsappApiController.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly redisService: RedisService,
  ) {}

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
    const number = this.whatsappService.normalizeNumber(dto.phone);

    // A reminder landing in the middle of a human conversation is exactly the
    // interruption the pause exists to prevent. Refusing with 409 tells the
    // backend to try again later instead of dropping it.
    const paused = await this.redisService
      .isAutomationPaused(dto.instance, number)
      .catch(() => false);

    if (paused) {
      const secondsLeft = await this.redisService
        .pauseTimeLeft(dto.instance, number)
        .catch(() => 0);

      this.logger.log(
        `Lembrete adiado para ${dto.instance}: atendimento humano ativo (${secondsLeft}s restantes)`,
      );

      throw new HttpException(
        { status: 'paused', reason: 'attendant-active', secondsLeft },
        HttpStatus.CONFLICT,
      );
    }

    this.logger.log(
      `Enviando lembrete (${dto.leadTimeLabel}) na instancia ${dto.instance}`,
    );

    await this.whatsappService.sendText(
      dto.instance,
      number,
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
