import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { BotLogger } from '../common/logging/bot-logger';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;
  private readonly log = new BotLogger(RedisService.name);

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST'),
      port: this.configService.get<number>('REDIS_PORT'),
      username: this.configService.get<string>('REDIS_USER'),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      // Without a cap, commands queue silently while Redis is unreachable and
      // the webhook hangs; Evolution then times out and re-delivers. Failing
      // fast keeps the request short and the failure visible in the logs.
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
    });

    // Connection health is what explains "the bot did odd things at 3am".
    this.client.on('ready', () => this.log.info('redis.ready'));
    this.client.on('reconnecting', (ms: number) =>
      this.log.warn('redis.reconnecting', { inMs: ms }),
    );
    this.client.on('end', () => this.log.warn('redis.connection_closed'));
    this.client.on('error', (err) => this.log.error('redis.error', err));
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  // ---------------------------------------------------------------------
  // Human handover
  //
  // Evolution reports messages the bot itself sends with fromMe = true, the
  // same as a message typed by a real attendant. The bot therefore records the
  // id of everything it sends, so the webhook can tell the two apart and only
  // step aside for an actual person.
  // ---------------------------------------------------------------------

  /** Remembers a message id the bot just sent. */
  async markBotMessage(instance: string, messageId: string): Promise<void> {
    if (!messageId) return;
    // Only needs to outlive the webhook round-trip; minutes are generous.
    await this.set(`bot:sent:${instance}:${messageId}`, '1', 300);
  }

  /**
   * Idempotency for incoming webhooks: true only the first time a message id
   * is seen. Evolution re-delivers on timeouts/errors and WhatsApp itself
   * re-emits messages after decryption retries; without this every copy got
   * its own reply.
   */
  async claimMessage(
    instance: string,
    messageId: string,
    ttlSeconds = 86400,
  ): Promise<boolean> {
    const result = await this.client.set(
      `bot:seen:${instance}:${messageId}`,
      new Date().toISOString(),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  /**
   * Remembers that the welcome menu went out. While it is set the bot does not
   * greet the same customer again from scratch — a safety net for when the
   * conversation state is lost or the customer keeps chatting after booking.
   */
  async markWelcomeSent(
    companyId: string,
    phone: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.set(
      `bot:welcome:${companyId}:${phone}`,
      new Date().toISOString(),
      ttlSeconds,
    );
  }

  /** ISO time of the last welcome still inside the cooldown, or null. */
  async lastWelcomeAt(
    companyId: string,
    phone: string,
  ): Promise<string | null> {
    return this.get(`bot:welcome:${companyId}:${phone}`);
  }

  async clearWelcome(companyId: string, phone: string): Promise<void> {
    await this.del(`bot:welcome:${companyId}:${phone}`);
  }

  /**
   * Counts messages sent to one number in the current hour window. Used as a
   * circuit breaker: whatever the bug, a customer cannot be flooded.
   */
  async countOutbound(instance: string, number: string): Promise<number> {
    const key = `bot:outbound:${instance}:${number}`;
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, 3600);
    return count;
  }

  async wasSentByBot(instance: string, messageId: string): Promise<boolean> {
    if (!messageId) return false;
    return (await this.get(`bot:sent:${instance}:${messageId}`)) !== null;
  }

  /** Silences the bot for one conversation after an attendant replies. */
  async pauseAutomation(
    instance: string,
    phone: string,
    seconds: number,
  ): Promise<void> {
    await this.set(
      `bot:paused:${instance}:${phone}`,
      new Date().toISOString(),
      seconds,
    );
  }

  async isAutomationPaused(instance: string, phone: string): Promise<boolean> {
    return (await this.get(`bot:paused:${instance}:${phone}`)) !== null;
  }

  /** Seconds left on the pause, or 0 when the bot is free to answer. */
  async pauseTimeLeft(instance: string, phone: string): Promise<number> {
    const ttl = await this.client.ttl(`bot:paused:${instance}:${phone}`);
    return ttl > 0 ? ttl : 0;
  }

  async resumeAutomation(instance: string, phone: string): Promise<void> {
    await this.del(`bot:paused:${instance}:${phone}`);
  }

  async getUserState(branchId: string, phone: string): Promise<any | null> {
    const data = await this.get(`bot:state:${branchId}:${phone}`);
    return data ? JSON.parse(data) : null;
  }

  async setUserState(
    branchId: string,
    phone: string,
    state: any,
  ): Promise<void> {
    await this.set(
      `bot:state:${branchId}:${phone}`,
      JSON.stringify(state),
      3600,
    );
  }

  async clearUserState(branchId: string, phone: string): Promise<void> {
    await this.del(`bot:state:${branchId}:${phone}`);
  }

  async appendHistory(
    branchId: string,
    phone: string,
    message: { role: 'user' | 'bot'; content: string },
  ): Promise<void> {
    const key = `bot:history:${branchId}:${phone}`;
    const historyJson = await this.get(key);
    const history = historyJson ? JSON.parse(historyJson) : [];
    history.push({ ...message, timestamp: new Date().toISOString() });

    const trimmedHistory = history.slice(-20);
    await this.set(key, JSON.stringify(trimmedHistory), 86400);
  }

  async getHistory(branchId: string, phone: string): Promise<any[]> {
    const data = await this.get(`bot:history:${branchId}:${phone}`);
    return data ? JSON.parse(data) : [];
  }

  async pauseBot(
    branchId: string,
    phone: string,
    ttlSeconds: number = 1800,
  ): Promise<void> {
    await this.set(`bot:paused:${branchId}:${phone}`, 'true', ttlSeconds);
  }

  async isBotPaused(branchId: string, phone: string): Promise<boolean> {
    const data = await this.get(`bot:paused:${branchId}:${phone}`);
    return data === 'true';
  }

  async resumeBot(branchId: string, phone: string): Promise<void> {
    await this.del(`bot:paused:${branchId}:${phone}`);
  }

  async getBotPausedTtl(branchId: string, phone: string): Promise<number> {
    const ttl = await this.client.ttl(`bot:paused:${branchId}:${phone}`);
    return ttl > 0 ? ttl : 0;
  }
}
