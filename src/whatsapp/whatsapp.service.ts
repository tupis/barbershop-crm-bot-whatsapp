import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly apiUrl: string;
  private readonly globalApiKey: string;

  constructor(private configService: ConfigService) {
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

  async sendText(instance: string, number: string, text: string) {
    try {
      const url = `${this.apiUrl}/message/sendText/${instance}`;
      await axios.post(
        url,
        {
          number,
          text,
          linkPreview: false,
        },
        { headers: this.headers },
      );
    } catch (error) {
      this.logger.error(`Error sending text: ${error.message}`);
    }
  }

  async sendList(
    instance: string,
    number: string,
    title: string,
    description: string,
    buttonText: string,
    sections: any[],
  ) {
    try {
      const url = `${this.apiUrl}/message/sendList/${instance}`;

      await axios.post(
        url,
        {
          number,
          title,
          description,
          buttonText,
          footerText: 'Barbearia CRM',
          sections,
        },
        { headers: this.headers },
      );
    } catch (error) {
      this.logger.error(`Error sending list: ${error.message}`);
    }
  }

  async sendButtons(
    instance: string,
    number: string,
    title: string,
    description: string,
    buttons: any[],
  ) {
    try {
      const url = `${this.apiUrl}/message/sendButtons/${instance}`;
      await axios.post(
        url,
        {
          number,
          title,
          description,
          footer: 'Barbearia CRM',
          buttons,
        },
        { headers: this.headers },
      );
    } catch (error) {
      this.logger.error(`Error sending buttons: ${error.message}`);
    }
  }
}
