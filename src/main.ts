import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConsoleLogger, LogLevel, ValidationPipe } from '@nestjs/common';
import { BotLogger } from './common/logging/bot-logger';

/**
 * LOG_FORMAT=json -> one JSON object per line (for Loki/Datadog/CloudWatch).
 * LOG_LEVEL=debug -> also logs skipped Evolution events (very verbose).
 */
function buildLogger(): ConsoleLogger {
  const levels: LogLevel[] = ['fatal', 'error', 'warn', 'log'];
  if (process.env.LOG_LEVEL === 'debug') levels.push('debug', 'verbose');

  return new ConsoleLogger({
    json: process.env.LOG_FORMAT === 'json',
    timestamp: true,
    logLevels: levels,
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: buildLogger() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const log = new BotLogger('Bootstrap');

  // A crash + `restart: always` loop is invisible without these.
  process.on('unhandledRejection', (reason) =>
    log.error('process.unhandled_rejection', reason),
  );
  process.on('uncaughtException', (err) =>
    log.error('process.uncaught_exception', err),
  );
  process.on('SIGTERM', () => log.warn('process.sigterm'));

  await app.listen(process.env.PORT ?? 3000);

  log.info('bot.started', {
    url: await app.getUrl(),
    pid: process.pid,
    node: process.version,
    attendantPauseMinutes:
      process.env.ATTENDANT_PAUSE_MINUTES ?? '10 (default)',
    welcomeCooldownMinutes:
      process.env.WELCOME_COOLDOWN_MINUTES ?? '60 (default)',
    maxMessageAgeSeconds:
      process.env.WEBHOOK_MAX_MESSAGE_AGE_SECONDS ?? '600 (default)',
    maxOutboundPerPhonePerHour:
      process.env.MAX_OUTBOUND_PER_PHONE_PER_HOUR ?? '40 (default)',
  });
}
bootstrap();
