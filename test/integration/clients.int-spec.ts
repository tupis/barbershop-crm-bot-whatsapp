jest.mock('ioredis', () => require('ioredis-mock'));

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiService } from '../../src/api/api.service';
import { RedisService } from '../../src/redis/redis.service';
import { WhatsappService } from '../../src/whatsapp/whatsapp.service';
import { FakeServices, startFakeServices } from '../support/fake-services';

/**
 * The bot's three outbound clients, unmocked: ApiService and WhatsappService
 * make real HTTP calls to a local fake server, RedisService talks to an
 * in-memory Redis with real TTL semantics.
 */
describe('Outbound clients (integration)', () => {
  let fake: FakeServices;
  let redis: RedisService;

  const config = (values: Record<string, string>) => new ConfigService(values);

  beforeAll(async () => {
    fake = await startFakeServices();
    redis = new RedisService(config({}));
    redis.onModuleInit();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    redis.onModuleDestroy();
    await fake.close();
    jest.restoreAllMocks();
  });
  beforeEach(async () => {
    fake.reset();
    await (redis as any).client.flushall();
  });

  describe('ApiService', () => {
    const api = () => new ApiService(config({ BACKEND_API_URL: fake.url }));

    it('resolves the tenant API once and caches it', async () => {
      const client = api();
      await client.getBranches('loja');
      await client.getServices('loja', 'br-1');
      const resolves = fake.requests.filter((r) =>
        r.path.startsWith('/api/v1/resolve'),
      );
      expect(resolves).toHaveLength(1);
      expect(
        fake.requests
          .filter((r) => !r.path.startsWith('/api'))
          .every((r) => r.tenant === 'loja'),
      ).toBe(true);
    });

    it('hides inactive branches and unavailable slots', async () => {
      fake.world.branches.push({
        id: 'br-2',
        name: 'Fechada',
        isActive: false,
      });
      fake.world.slots = { 'b-1': { '2030-01-01': ['09:00'] } };
      const client = api();
      expect((await client.getBranches('loja')).map((b: any) => b.id)).toEqual([
        'br-1',
      ]);
      expect(
        await client.getAvailableSlots('loja', 'b-1', '2030-01-01'),
      ).toEqual(['09:00']);
    });

    it('creates the user once and reuses it by phone', async () => {
      const client = api();
      const first = await client.findOrCreateUser(
        'loja',
        '11999990000',
        'Cliente WhatsApp',
      );
      const again = await client.findOrCreateUser(
        'loja',
        '11999990000',
        'Outro',
      );
      expect(again.id).toBe(first.id);
    });

    it('degrades gracefully when the backend answers errors', async () => {
      const client = api();
      expect(await client.validateCoupon('loja', 'X', 'b', [])).toEqual({
        valid: false,
        reason: 'Nao foi possivel validar o cupom agora.',
      });
    });

    it('propagates a refused booking so the conversation can recover', async () => {
      fake.world.failAppointments = true;
      await expect(api().createAppointment('loja', {})).rejects.toThrow('409');
    });

    it('falls back to BACKEND_API_URL when the resolver is unreachable', async () => {
      const client = new ApiService(
        config({ BACKEND_API_URL: 'http://127.0.0.1:1' }),
      );
      expect(await client.getBranches('loja')).toEqual([]);
      expect(await client.getServices('loja', 'b')).toEqual([]);
      expect(await client.getBarbers('loja', 'b')).toEqual([]);
      expect(await client.getCompanyBySlug('loja', 'loja')).toBeNull();
      expect(await client.getAvailableSlots('loja', 'b', 'd')).toEqual([]);
      expect(await client.findOrCreateUser('loja', '1', 'x')).toBeNull();
      expect(await client.updateCustomer('loja', 'c', {})).toBeNull();
    });
  });

  describe('WhatsappService', () => {
    it('remembers the ids of what it sent so its echo is not taken for an attendant', async () => {
      const whatsapp = new WhatsappService(
        config({ EVOLUTION_API_URL: fake.url, EVOLUTION_API_KEY: 'k' }),
        redis,
      );
      await whatsapp.sendText('loja', '5511900000000', 'oi');
      await whatsapp.sendList('loja', '5511900000000', 'T', 'D', 'B', []);
      await whatsapp.sendButtons('loja', '5511900000000', 'T', 'D', []);

      expect(fake.sent.map((s) => s.text)).toEqual(['oi', 'T', 'T']);
      for (const id of ['msg-1', 'msg-2', 'msg-3']) {
        await expect(redis.wasSentByBot('loja', id)).resolves.toBe(true);
      }
      await expect(redis.wasSentByBot('loja', 'msg-4')).resolves.toBe(false);
    });

    it('logs and swallows Evolution failures', async () => {
      const whatsapp = new WhatsappService(
        config({ EVOLUTION_API_URL: 'http://127.0.0.1:1' }),
        redis,
      );
      await expect(
        whatsapp.sendText('loja', '1', 'x'),
      ).resolves.toBeUndefined();
      await expect(
        whatsapp.sendList('loja', '1', 't', 'd', 'b', []),
      ).resolves.toBeUndefined();
      await expect(
        whatsapp.sendButtons('loja', '1', 't', 'd', []),
      ).resolves.toBeUndefined();
    });
  });

  describe('RedisService', () => {
    it('pauses automation with a TTL and resumes on demand', async () => {
      await redis.pauseAutomation('loja', '55119', 120);
      await expect(redis.isAutomationPaused('loja', '55119')).resolves.toBe(
        true,
      );
      const left = await redis.pauseTimeLeft('loja', '55119');
      expect(left).toBeGreaterThan(100);
      expect(left).toBeLessThanOrEqual(120);

      await redis.resumeAutomation('loja', '55119');
      await expect(redis.isAutomationPaused('loja', '55119')).resolves.toBe(
        false,
      );
      await expect(redis.pauseTimeLeft('loja', '55119')).resolves.toBe(0);
    });

    it('keeps the conversation state as JSON', async () => {
      await expect(redis.getUserState('co', '1')).resolves.toBeNull();
      await redis.setUserState('co', '1', { step: 'X', list: [1] });
      await expect(redis.getUserState('co', '1')).resolves.toEqual({
        step: 'X',
        list: [1],
      });
      await redis.clearUserState('co', '1');
      await expect(redis.getUserState('co', '1')).resolves.toBeNull();
    });

    it('keeps only the last 20 history entries', async () => {
      for (let i = 0; i < 25; i++) {
        await redis.appendHistory('co', '1', {
          role: 'user',
          content: `m${i}`,
        });
      }
      const history = await redis.getHistory('co', '1');
      expect(history).toHaveLength(20);
      expect(history[0].content).toBe('m5');
      await expect(redis.getHistory('co', 'outro')).resolves.toEqual([]);
    });

    it('handles the attendant pause requested by the customer', async () => {
      await redis.pauseBot('co', '1');
      await expect(redis.isBotPaused('co', '1')).resolves.toBe(true);
      expect(await redis.getBotPausedTtl('co', '1')).toBeGreaterThan(1700);
      await redis.resumeBot('co', '1');
      await expect(redis.isBotPaused('co', '1')).resolves.toBe(false);
      await expect(redis.getBotPausedTtl('co', '1')).resolves.toBe(0);
    });

    it('ignores empty message ids', async () => {
      await redis.markBotMessage('loja', '');
      await expect(redis.wasSentByBot('loja', '')).resolves.toBe(false);
    });
  });
});
