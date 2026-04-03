import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST'),
      port: this.configService.get<number>('REDIS_PORT'),
      username: this.configService.get<string>('REDIS_USER'),
      password: this.configService.get<string>('REDIS_PASSWORD'),
    });
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
}
