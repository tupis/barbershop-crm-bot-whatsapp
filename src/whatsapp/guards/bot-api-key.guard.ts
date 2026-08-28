import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared-secret check between the backend and this bot.
 *
 * If BOT_API_KEY is unset the guard lets the request through and warns, so an
 * existing deployment keeps working after an upgrade — set the variable on
 * both services to actually close the endpoint.
 */
@Injectable()
export class BotApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(BotApiKeyGuard.name);
  private warned = false;

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('BOT_API_KEY');

    if (!expected) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'BOT_API_KEY nao configurada: endpoint de lembretes esta aberto.',
        );
      }
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const provided = request.headers['x-bot-api-key'];

    if (provided !== expected) {
      throw new UnauthorizedException('Chave de API invalida');
    }

    return true;
  }
}
