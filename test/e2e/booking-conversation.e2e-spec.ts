jest.mock('ioredis', () => require('ioredis-mock'));

import { format, addDays } from 'date-fns';
import { createBotApp, BotContext, INSTANCE } from '../support/bot-app';
import { optionNumber } from '../support/fake-services';

/**
 * A customer books a haircut over WhatsApp, message by message, through the
 * real webhook, state machine, Redis state and HTTP clients.
 */
describe('WhatsApp booking conversation (e2e)', () => {
  let ctx: BotContext;
  const phone = '5511987654321';
  const date = format(addDays(new Date(), 2), 'yyyy-MM-dd');

  beforeAll(async () => (ctx = await createBotApp()));
  afterAll(async () => {
    await ctx.app.close();
    await ctx.fake.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    ctx.fake.world.slots = { 'b-1': { [date]: ['09:00', '10:00', '11:00'] } };
  });

  const last = () => ctx.fake.lastTextTo(phone);
  const pick = async (label: string) =>
    ctx.say(phone, optionNumber(last(), label));

  /** Walks the menus up to the summary screen. */
  async function reachSummary() {
    await ctx.say(phone, 'oi');
    expect(last()).toContain('Bem-vindo(a) à Barbearia Teste');
    await pick('Centro');
    expect(last()).toContain('Escolha o Profissional');
    await pick('Joao');
    expect(last()).toContain('Escolha o Serviço');
    await pick('Corte');
    expect(last()).toContain('Selecionados atualmente:* Corte');
    await pick('Avançar');
    expect(last()).toContain('Escolha a Data');
    await ctx.say(
      phone,
      optionNumber(last(), format(addDays(new Date(), 2), 'dd/MM')),
    );
    expect(last()).toContain(`Horários disponíveis para o dia ${date}`);
    await pick('10:00');
  }

  it('books for a first-time customer, collecting name and e-mail', async () => {
    await reachSummary();
    expect(last()).toContain('primeiro agendamento');

    await ctx.say(phone, 'Maria Silva');
    expect(last()).toContain('Obrigado, Maria Silva');

    await ctx.say(phone, 'email-invalido');
    expect(last()).toContain('E-mail inválido');

    await ctx.say(phone, 'maria@exemplo.com');
    expect(last()).toContain('RESUMO DO AGENDAMENTO');
    expect(last()).toContain('📌 *Serviços:* Corte');
    expect(last()).toContain('R$ 50,00');
    expect(ctx.fake.world.customerUpdates).toEqual([
      {
        id: 'user-1',
        body: {
          name: 'Maria Silva',
          email: 'maria@exemplo.com',
          phone: '11987654321',
        },
      },
    ]);

    await pick('Confirmar');
    expect(last()).toContain('Agendamento Confirmado');
    expect(ctx.fake.world.appointments).toEqual([
      expect.objectContaining({
        clientId: 'user-1',
        barberId: 'b-1',
        branchId: 'br-1',
        services: ['sv-corte'],
        date,
        time: '10:00',
      }),
    ]);

    // The conversation starts over afterwards.
    await ctx.say(phone, 'oi de novo');
    expect(last()).toContain('Bem-vindo(a)');
  });

  it('goes straight to the summary for a returning customer and lets them skip e-mail', async () => {
    ctx.fake.world.users.push({
      id: 'user-9',
      phone: '11987654321',
      name: 'Carlos',
    });
    await reachSummary();
    expect(last()).toContain('RESUMO DO AGENDAMENTO');
    expect(ctx.fake.world.customerUpdates).toEqual([]);
  });

  it('re-offers times when the slot was taken in the meantime', async () => {
    ctx.fake.world.users.push({
      id: 'user-9',
      phone: '11987654321',
      name: 'Carlos',
    });
    await reachSummary();

    ctx.fake.world.slots['b-1'][date] = ['11:00'];
    await pick('Confirmar');

    const texts = ctx.fake.textsTo(phone);
    expect(texts.at(-2)).toContain('não está mais disponível');
    expect(last()).toContain('Escolha o Horário');
    expect(ctx.fake.world.appointments).toEqual([]);
  });

  it('tells the customer when the backend refuses the booking', async () => {
    ctx.fake.world.users.push({
      id: 'user-9',
      phone: '11987654321',
      name: 'Carlos',
    });
    ctx.fake.world.failAppointments = true;
    await reachSummary();
    await pick('Confirmar');
    expect(ctx.fake.textsTo(phone).at(-2)).toContain(
      'Não foi possível finalizar',
    );
    expect(last()).toContain('Escolha o Horário');
  });

  it('applies a coupon validated by the backend to the summary and the booking', async () => {
    ctx.fake.world.users.push({
      id: 'user-9',
      phone: '11987654321',
      name: 'Carlos',
    });
    ctx.fake.world.coupons = {
      PROMO: {
        valid: true,
        coupon: {
          code: 'PROMO',
          discountType: 'PERCENTAGE',
          discountValue: 20,
        },
      },
      VELHO: { valid: false, reason: 'Cupom expirado.' },
    };
    await reachSummary();
    expect(last()).toContain('💰 *Total:* R$ 50,00');

    await pick('Tenho um cupom');
    expect(last()).toContain('Digite o código do cupom');

    await ctx.say(phone, 'velho');
    expect(last()).toContain('Cupom expirado.');

    await ctx.say(phone, 'promo');
    expect(last()).toContain('Subtotal:* R$ 50,00');
    expect(last()).toContain('Cupom PROMO:* -R$ 10,00');
    expect(last()).toContain('Total:* R$ 40,00');
    expect(
      ctx.fake.requests.some((r) => r.path === '/cliente/coupons/validate'),
    ).toBe(true);

    await pick('Confirmar');
    expect(ctx.fake.world.appointments[0].couponCode).toBe('PROMO');
  });

  it('caps a fixed coupon at the subtotal', async () => {
    ctx.fake.world.users.push({
      id: 'user-9',
      phone: '11987654321',
      name: 'Carlos',
    });
    ctx.fake.world.coupons = {
      TUDO: {
        valid: true,
        coupon: { code: 'TUDO', discountType: 'FIXED', discountValue: 99999 },
      },
    };
    await reachSummary();
    await pick('Tenho um cupom');
    await ctx.say(phone, 'tudo');
    expect(last()).toContain('Cupom TUDO:* -R$ 50,00');
    expect(last()).toContain('Total:* R$ 0,00');
  });

  it('keeps going without discount when the coupon cannot be checked', async () => {
    ctx.fake.world.users.push({
      id: 'user-9',
      phone: '11987654321',
      name: 'Carlos',
    });
    await reachSummary();
    await pick('Tenho um cupom');
    await ctx.say(phone, 'PROMO');
    expect(last()).toContain('Nao foi possivel validar o cupom agora');
    await ctx.say(phone, 'pular');
    expect(last()).toContain('RESUMO DO AGENDAMENTO');
    expect(last()).not.toContain('Cupom');
  });

  it('navigates back step by step and can be reset', async () => {
    await ctx.say(phone, 'oi');
    await pick('Centro');
    await pick('Joao');
    await ctx.say(phone, 'voltar');
    expect(last()).toContain('Escolha o Profissional');
    await ctx.say(phone, 'voltar');
    expect(last()).toContain('selecione a unidade');
    await ctx.say(phone, 'voltar');
    expect(last()).toContain('Agendamento cancelado');

    await ctx.say(phone, 'oi');
    await pick('Reiniciar atendimento');
    expect(last()).toContain('Agendamento cancelado');
  });

  it('re-prompts when the answer is not one of the options', async () => {
    await ctx.say(phone, 'oi');
    await ctx.say(phone, 'quero cortar o cabelo');
    expect(last()).toContain('Por favor, selecione uma unidade');
    await ctx.say(phone, '99');
    expect(last()).toContain('Por favor, selecione uma unidade');
  });

  it('hands over to a human and comes back on #bot', async () => {
    await ctx.say(phone, 'oi');
    await pick('Falar com atendente');
    expect(last()).toContain('Atendimento humano solicitado');

    const before = ctx.fake.textsTo(phone).length;
    await ctx.say(phone, 'alguém aí?');
    expect(ctx.fake.textsTo(phone)).toHaveLength(before);

    await ctx.say(phone, '#bot');
    expect(last()).toContain('Atendimento do robô reativado');

    await ctx.say(phone, '#bot');
    expect(last()).toContain('já está ativo');
  });

  it('ignores messages for a tenant whose company cannot be found', async () => {
    ctx.fake.world.company = null;
    await ctx.say(phone, 'oi');
    expect(ctx.fake.textsTo(phone)).toEqual([]);
  });

  it('routes every backend call with the tenant header', async () => {
    await ctx.say(phone, 'oi');
    const backend = ctx.fake.requests.filter((r) =>
      r.path.startsWith('/branches'),
    );
    expect(backend.every((r) => r.tenant === INSTANCE)).toBe(true);
  });
});
