jest.mock('ioredis', () => require('ioredis-mock'));

import {
  createBotApp,
  BotContext,
  API_KEY,
  INSTANCE,
} from '../support/bot-app';

/** Messages the backend asks the bot to deliver, and the attendant handover. */
describe('Notifications and handover (e2e)', () => {
  let ctx: BotContext;
  const phone = '5511912345678';

  beforeAll(async () => (ctx = await createBotApp()));
  afterAll(async () => {
    await ctx.app.close();
    await ctx.fake.close();
  });
  beforeEach(() => ctx.reset());

  const reminder = {
    instance: INSTANCE,
    phone: '(11) 91234-5678',
    clientName: 'Ana',
    companyName: 'Barbearia Teste',
    branchName: 'Centro',
    branchAddress: 'Rua A, 10',
    barberName: 'Joao',
    services: ['Corte', 'Barba'],
    date: '2030-03-04',
    startTime: '14:30',
    leadTimeLabel: '1 hora',
  };

  describe('POST /whatsapp/send-code', () => {
    it('delivers the verification code to the normalised number', async () => {
      await ctx
        .http()
        .post('/whatsapp/send-code')
        .send({ instance: INSTANCE, phone: '11 91234-5678', code: '4321' })
        .expect(201);
      expect(ctx.fake.sent).toEqual([
        expect.objectContaining({
          instance: INSTANCE,
          number: phone,
          text: expect.stringContaining('*4321*'),
        }),
      ]);
    });

    it('validates the payload', async () => {
      await ctx
        .http()
        .post('/whatsapp/send-code')
        .send({ phone: '1' })
        .expect(400);
    });
  });

  describe('POST /whatsapp/send-reminder', () => {
    it('requires the shared API key', async () => {
      await ctx
        .http()
        .post('/whatsapp/send-reminder')
        .send(reminder)
        .expect(401);
      await ctx
        .http()
        .post('/whatsapp/send-reminder')
        .set('x-bot-api-key', 'errada')
        .send(reminder)
        .expect(401);
    });

    it('writes the reminder message itself from structured data', async () => {
      await ctx
        .http()
        .post('/whatsapp/send-reminder')
        .set('x-bot-api-key', API_KEY)
        .send(reminder)
        .expect(201);

      const text = ctx.fake.lastTextTo(phone);
      expect(text).toContain('Ola, Ana!');
      expect(text).toContain('🗓️ 04/03/2030 as 14:30');
      expect(text).toContain('✂️ Corte, Barba');
      expect(text).toContain('💈 Joao');
      expect(text).toContain('📍 Centro\n   Rua A, 10');
      expect(text).toContain('Faltam 1 hora.');
    });

    it('rejects extra or oversized fields', async () => {
      await ctx
        .http()
        .post('/whatsapp/send-reminder')
        .set('x-bot-api-key', API_KEY)
        .send({ ...reminder, clientName: 'x'.repeat(200) })
        .expect(400);
    });

    it('answers 409 while an attendant is talking to the customer', async () => {
      // An attendant replies from the shop's phone: Evolution reports fromMe.
      await ctx
        .http()
        .post('/webhook/whatsapp')
        .send({
          event: 'messages.upsert',
          instance: INSTANCE,
          data: {
            key: {
              remoteJid: `${phone}@s.whatsapp.net`,
              id: 'human-1',
              fromMe: true,
            },
            message: {},
          },
        })
        .expect(201)
        .expect((r) => expect(r.body.automation).toBe('paused'));

      const res = await ctx
        .http()
        .post('/whatsapp/send-reminder')
        .set('x-bot-api-key', API_KEY)
        .send(reminder)
        .expect(409);
      expect(res.body).toMatchObject({
        reason: 'attendant-active',
        secondsLeft: expect.any(Number),
      });
      expect(res.body.secondsLeft).toBeGreaterThan(0);
      expect(ctx.fake.sent).toEqual([]);

      // And the customer's own messages are left for the attendant too.
      await ctx.say(phone, 'oi');
      expect(ctx.fake.sent).toEqual([]);
    });
  });

  it("does not pause itself on the echo of the bot's own message", async () => {
    await ctx.say(phone, 'oi');
    const ownId = 'msg-1'; // first id issued by the fake Evolution API
    await ctx
      .http()
      .post('/webhook/whatsapp')
      .send({
        event: 'messages.upsert',
        instance: INSTANCE,
        data: {
          key: {
            remoteJid: `${phone}@s.whatsapp.net`,
            id: ownId,
            fromMe: true,
          },
          message: {},
        },
      })
      .expect(201)
      .expect((r) => expect(r.body).toEqual({ status: 'success' }));

    await expect(ctx.redis.isAutomationPaused(INSTANCE, phone)).resolves.toBe(
      false,
    );
  });

  it('acknowledges unrelated webhook events', async () => {
    await ctx
      .http()
      .post('/webhook/whatsapp')
      .send({ event: 'connection.update', instance: INSTANCE })
      .expect(201)
      .expect({ status: 'success' });
  });
});
