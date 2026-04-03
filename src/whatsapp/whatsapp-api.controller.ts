import { Body, Controller, Post, Logger } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { SendCodeDto } from './dto/send-code.dto';

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

    let number = dto.phone.replace(/\D/g, '');
    if (!number.startsWith('55')) {
      number = `55${number}`;
    }

    number = '5598991739443';

    await this.whatsappService.sendText(dto.instance, number, message);

    return { status: 'success', message: 'Verification code sent' };
  }
}
