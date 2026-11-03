import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { RedisService } from '../../src/redis/redis.service';
import { FakeServices, startFakeServices } from './fake-services';

export const INSTANCE = 'barbearia-teste';
export const API_KEY = 'bot-test-key';

export interface BotContext {
  app: INestApplication;
  fake: FakeServices;
  redis: RedisService;
  http: () => ReturnType<typeof request>;
  /** Sends a customer message through the Evolution webhook. */
  say: (phone: string, text: string) => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * The whole bot (AppModule) over HTTP. Redis is ioredis-mock (see the
 * jest.mock in each suite) and every outbound call — tenant resolver,
 * backend, Evolution API — lands on the local fake server.
 */
export async function createBotApp(): Promise<BotContext> {
  const fake = await startFakeServices();

  // The repo's .env may hold real endpoints; explicit values win over it.
  process.env.BACKEND_API_URL = fake.url;
  process.env.EVOLUTION_API_URL = fake.url;
  process.env.EVOLUTION_API_KEY = 'evo-test';
  process.env.BOT_API_KEY = API_KEY;
  process.env.REDIS_HOST = '127.0.0.1';
  process.env.REDIS_PORT = '6379';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const redis = app.get(RedisService);
  const http = () => request(app.getHttpServer());

  return {
    app,
    fake,
    redis,
    http,
    say: async (phone, text) => {
      await http()
        .post('/webhook/whatsapp')
        .send({
          event: 'messages.upsert',
          instance: INSTANCE,
          data: {
            key: {
              remoteJid: `${phone}@s.whatsapp.net`,
              id: `in-${Math.random()}`,
              fromMe: false,
            },
            message: { conversation: text },
          },
        })
        .expect(201);
    },
    reset: async () => {
      fake.reset();
      await (redis as any).client.flushall();
    },
  };
}
