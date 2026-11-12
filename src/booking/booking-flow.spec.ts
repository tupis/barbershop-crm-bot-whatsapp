import { Logger } from '@nestjs/common';
import { addDays, format } from 'date-fns';
import { BookingService, BookingState } from './booking.service';

/**
 * The conversation state machine in isolation: Redis is a Map, the backend
 * and WhatsApp are plain fakes. Each test seeds a step and sends one message.
 */
function build(api: Record<string, any> = {}) {
  const sent: string[] = [];
  const store = new Map<string, any>();
  const paused = new Set<string>();
  const welcomed = new Map<string, string>();

  const whatsapp: any = {
    sendText: jest.fn(async (_i: string, _p: string, text: string) => {
      sent.push(text);
    }),
  };
  const apiService: any = {
    getCompanyBySlug: jest.fn(async () => ({ id: 'co', name: 'Barbearia' })),
    getBranches: jest.fn(async () => [
      { id: 'br', name: 'Centro', workingHours: [] },
    ]),
    getServices: jest.fn(async () => [
      { id: 's1', name: 'Corte', price: 5000 },
      { id: 's2', name: 'Barba', price: 3000 },
    ]),
    getBarbers: jest.fn(async () => [
      { id: 'b1', name: 'Joao', serviceIds: ['s1'] },
      { id: 'b2', name: 'Pedro', serviceIds: ['s1', 's2'] },
    ]),
    getAvailableSlots: jest.fn(async () => ['09:00', '10:00']),
    findOrCreateUser: jest.fn(async () => null),
    updateCustomer: jest.fn(async () => ({})),
    createAppointment: jest.fn(async () => ({ id: 'a' })),
    ...api,
  };
  const redis: any = {
    getUserState: jest.fn(
      async (_c: string, p: string) => store.get(p) ?? null,
    ),
    setUserState: jest.fn(async (_c: string, p: string, s: any) =>
      store.set(p, JSON.parse(JSON.stringify(s))),
    ),
    clearUserState: jest.fn(async (_c: string, p: string) => store.delete(p)),
    appendHistory: jest.fn(async () => undefined),
    isBotPaused: jest.fn(async (_c: string, p: string) => paused.has(p)),
    pauseBot: jest.fn(async (_c: string, p: string) => paused.add(p)),
    resumeBot: jest.fn(async (_c: string, p: string) => paused.delete(p)),
    markWelcomeSent: jest.fn(async (_c: string, p: string) =>
      welcomed.set(p, new Date().toISOString()),
    ),
    lastWelcomeAt: jest.fn(
      async (_c: string, p: string) => welcomed.get(p) ?? null,
    ),
    clearWelcome: jest.fn(async (_c: string, p: string) => welcomed.delete(p)),
  };

  const service = new BookingService(apiService, redis, whatsapp);
  const phone = '5511999990000';

  return {
    service,
    api: apiService,
    redis,
    sent,
    last: () => sent.at(-1) ?? '',
    state: () => store.get(phone),
    seed: (state: any) => store.set(phone, state),
    welcomed,
    say: (text: string, rowId?: string) =>
      service.handleIncomingMessage('loja', phone, text, rowId),
  };
}

const base = {
  selectedBranchId: 'br',
  selectedBarberId: 'b1',
  selectedServices: ['s1'],
  serviceBarberIds: { s1: 'b1' },
  selectedDate: '2030-01-10',
  selectedTime: '10:00',
};

describe('BookingService conversation', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  describe('"voltar" returns to the previous step', () => {
    it.each([
      [
        BookingState.SELECTING_SERVICES,
        BookingState.SELECTING_BARBER,
        'Escolha o Profissional',
      ],
      [
        BookingState.SELECTING_DATE,
        BookingState.SELECTING_SERVICES,
        'Escolha o Serviço',
      ],
      [
        BookingState.SELECTING_TIME,
        BookingState.SELECTING_DATE,
        'Escolha a Data',
      ],
      [
        BookingState.ASKING_NAME,
        BookingState.SELECTING_TIME,
        'Escolha o Horário',
      ],
      [BookingState.ASKING_EMAIL, BookingState.ASKING_NAME, 'nome completo'],
      [
        BookingState.ASKING_COUPON,
        BookingState.CONFIRMING,
        'RESUMO DO AGENDAMENTO',
      ],
    ])('from %s to %s', async (from, to, shown) => {
      const t = build();
      t.seed({ ...base, step: from });
      await t.say('voltar');
      expect(t.state().step).toBe(to);
      expect(t.last()).toContain(shown);
    });

    it('from the summary goes back to e-mail for a new customer, to times otherwise', async () => {
      const t = build();
      t.seed({ ...base, step: BookingState.CONFIRMING, tempName: 'Ana' });
      await t.say('voltar');
      expect(t.state().step).toBe(BookingState.ASKING_EMAIL);

      t.seed({ ...base, step: BookingState.CONFIRMING });
      await t.say('voltar');
      expect(t.state().step).toBe(BookingState.SELECTING_TIME);
    });
  });

  describe('service selection', () => {
    it('only lists what the chosen barber performs and toggles a choice off', async () => {
      const t = build();
      t.seed({
        ...base,
        step: BookingState.SELECTING_SERVICES,
        selectedServices: [],
      });
      await t.say('', 'service_s1');
      expect(t.last()).toContain('Corte - R$ 50 [Selecionado ✅]');
      expect(t.last()).not.toContain('Barba');

      await t.say('', 'service_s1');
      expect(t.state().selectedServices).toEqual([]);
    });

    it('requires at least one service to continue', async () => {
      const t = build();
      t.seed({
        ...base,
        step: BookingState.SELECTING_SERVICES,
        selectedServices: [],
      });
      await t.say('', 'confirm_services');
      expect(t.last()).toContain('selecione pelo menos um serviço');
      await t.say('qualquer coisa');
      expect(t.last()).toContain('selecione um serviço digitando o número');
    });
  });

  it('asks again for a barber when the answer is not a barber', async () => {
    const t = build();
    t.seed({ ...base, step: BookingState.SELECTING_BARBER });
    await t.say('talvez');
    expect(t.last()).toContain('selecione um profissional');
  });

  it('re-sends dates and times when the answer is free text', async () => {
    const t = build();
    t.seed({ ...base, step: BookingState.SELECTING_DATE });
    await t.say('amanhã?');
    expect(t.last()).toContain('Escolha a Data');

    t.seed({ ...base, step: BookingState.SELECTING_TIME });
    await t.say('cedo');
    expect(t.last()).toContain('Escolha o Horário');
  });

  it('goes to the summary when the backend cannot identify the customer', async () => {
    const t = build();
    t.seed({ ...base, step: BookingState.SELECTING_TIME });
    await t.say('', 'time_09:00');
    expect(t.state().step).toBe(BookingState.CONFIRMING);
  });

  it('lets the customer skip the e-mail', async () => {
    const t = build();
    t.seed({
      ...base,
      step: BookingState.ASKING_EMAIL,
      tempName: 'Ana',
      customerId: 'u1',
    });
    await t.say('pular');
    expect(t.api.updateCustomer).toHaveBeenCalledWith('loja', 'u1', {
      name: 'Ana',
      phone: '11999990000',
    });
    expect(t.state().step).toBe(BookingState.CONFIRMING);
  });

  describe('summary', () => {
    it('lists one professional per service when they differ', async () => {
      const t = build();
      t.seed({
        ...base,
        step: BookingState.CONFIRMING,
        selectedServices: ['s1', 's2'],
        serviceBarberIds: { s1: 'b1', s2: 'b2' },
      });
      await t.say('hmm');
      expect(t.last()).toContain('*Profissionais:*');
      expect(t.last()).toContain('- Corte: Joao');
      expect(t.last()).toContain('- Barba: Pedro');
    });

    it('cancels on "não"', async () => {
      const t = build();
      t.seed({ ...base, step: BookingState.CONFIRMING });
      await t.say('não');
      expect(t.last()).toContain('Agendamento cancelado');
      expect(t.state()).toBeUndefined();
    });

    it('creates the customer at confirmation time when it was not known yet', async () => {
      const t = build({
        findOrCreateUser: jest.fn(async () => ({ uuid: 'u-77' })),
      });
      t.seed({ ...base, step: BookingState.CONFIRMING });
      await t.say('sim');
      expect(t.api.createAppointment).toHaveBeenCalledWith(
        'loja',
        expect.objectContaining({ clientId: 'u-77', time: '10:00' }),
      );
      expect(t.last()).toContain('Agendamento Confirmado');
    });

    it('reports an error when the customer cannot be created', async () => {
      const t = build();
      t.seed({ ...base, step: BookingState.CONFIRMING });
      await t.say('confirmar');
      expect(t.sent.at(-2)).toContain('Não foi possível finalizar');
      expect(t.state().step).toBe(BookingState.SELECTING_TIME);
    });

    it('shows the coupon line and the discounted total', async () => {
      const t = build();
      t.seed({
        ...base,
        step: BookingState.CONFIRMING,
        couponCode: 'X',
        couponDiscount: 500,
      });
      await t.say('?');
      expect(t.last()).toContain('💰 *Subtotal:* R$ 50,00');
      expect(t.last()).toContain('🎟️ *Cupom X:* -R$ 5,00');
      expect(t.last()).toContain('💵 *Total:* R$ 45,00');
      expect(t.last()).toContain('Trocar cupom');
    });
  });

  describe('coupon step', () => {
    const coupon = (discountType: string, discountValue: number) => ({
      validateCoupon: jest.fn(async () => ({
        valid: true,
        coupon: { discountType, discountValue },
      })),
    });

    it.each([
      ['a percentage', coupon('PERCENTAGE', 10), 500],
      ['a fixed value', coupon('FIXED', 1200), 1200],
      ['a fixed value above the subtotal', coupon('FIXED', 9000), 5000],
    ])(
      'computes %s discount over the selected services',
      async (_l, api, expected) => {
        const t = build(api);
        t.seed({ ...base, step: BookingState.ASKING_COUPON });
        await t.say(' promo ');
        expect(api.validateCoupon).toHaveBeenCalledWith('loja', 'PROMO', 'br', [
          's1',
        ]);
        expect(t.state()).toMatchObject({
          couponCode: 'PROMO',
          couponDiscount: expected,
          step: BookingState.CONFIRMING,
        });
      },
    );

    it('explains a rejected code and stays on the coupon step', async () => {
      const t = build({
        validateCoupon: jest.fn(async () => ({ valid: false })),
      });
      t.seed({ ...base, step: BookingState.ASKING_COUPON });
      await t.say('xpto');
      expect(t.last()).toContain('❌ Cupom inválido.');
      expect(t.state().step).toBe(BookingState.ASKING_COUPON);
    });

    it('drops an applied coupon on "pular"', async () => {
      const t = build();
      t.seed({
        ...base,
        step: BookingState.ASKING_COUPON,
        couponCode: 'X',
        couponDiscount: 500,
      });
      await t.say('pular');
      expect(t.state()).toMatchObject({
        couponDiscount: 0,
        step: BookingState.CONFIRMING,
      });
      expect(t.state().couponCode).toBeUndefined();
    });
  });

  describe('date selection', () => {
    const weekdays = [
      'DOMINGO',
      'SEGUNDA',
      'TERCA',
      'QUARTA',
      'QUINTA',
      'SEXTA',
      'SABADO',
    ];

    it('skips days the branch or the barber does not work', async () => {
      const closedForBranch = weekdays[addDays(new Date(), 1).getDay()];
      const closedForBarber = weekdays[addDays(new Date(), 2).getDay()];
      const t = build({
        getBranches: jest.fn(async () => [
          {
            id: 'br',
            name: 'Centro',
            workingHours: [{ dayOfWeek: closedForBranch, isActive: false }],
          },
        ]),
        getBarbers: jest.fn(async () => [
          {
            id: 'b1',
            name: 'Joao',
            workingHours: [{ dayOfWeek: closedForBarber, isActive: false }],
          },
        ]),
      });
      t.seed({ ...base, step: BookingState.SELECTING_DATE });
      await t.say('?');

      const menu = t.last();
      const ddmm = (d: number) => format(addDays(new Date(), d), 'dd/MM');
      // Consecutive days, so the two closed weekdays are always different.
      expect(menu).not.toContain(ddmm(1));
      expect(menu).not.toContain(ddmm(2));
      expect(menu).toContain(ddmm(0));
    });

    it('falls back to company hours, and to "closed on Sunday" without any', async () => {
      const t = build({
        getCompanyBySlug: jest.fn(async () => ({
          id: 'co',
          name: 'Barbearia',
          workingHours: weekdays.map((d) => ({
            dayOfWeek: d,
            isActive: d === 'SEGUNDA',
          })),
        })),
        getBranches: jest.fn(async () => []),
      });
      t.seed({ ...base, step: BookingState.SELECTING_DATE });
      await t.say('?');
      const dates = t
        .last()
        .split('\n')
        .filter((l) => /^\d+\. .*\d{2}\/\d{2}/.test(l));
      expect(dates.length).toBeGreaterThan(0);
      expect(dates.every((l) => /segunda/i.test(l))).toBe(true);
    });

    it('offers working days even when no barber has free slots', async () => {
      const t = build({ getAvailableSlots: jest.fn(async () => []) });
      t.seed({ ...base, step: BookingState.SELECTING_DATE });
      await t.say('?');
      expect(t.last()).toContain('Escolha a Data');
      expect(
        t.state().availableOptions.filter((o: string) => o.startsWith('date_')),
      ).toHaveLength(7);
    });
  });

  it('stays silent while paused and only answers a resume command', async () => {
    const t = build();
    await t.say('atendente');
    expect(t.last()).toContain('Atendimento humano solicitado');
    await t.say('olá');
    expect(t.sent).toHaveLength(1);
    await t.say('zerar timer');
    expect(t.last()).toContain('reativado');
  });

  it('does nothing when the company is unknown', async () => {
    const t = build({ getCompanyBySlug: jest.fn(async () => null) });
    await t.say('oi');
    expect(t.sent).toEqual([]);
  });

  describe('welcome menu (incidente: menu de unidade repetido)', () => {
    it('greets an idle customer once and records the cooldown', async () => {
      const t = build();
      await t.say('oi');
      expect(t.last()).toContain('Bem-vindo(a)');
      expect(t.welcomed.size).toBe(1);
    });

    it('does not greet again while the cooldown is active, even if the state was lost', async () => {
      const t = build();
      await t.say('oi');
      t.redis.clearUserState('co', '5511999990000');
      t.sent.length = 0;

      await t.say('oi');
      await t.say('alguém aí?');

      expect(t.sent).toHaveLength(0);
    });

    it('restarts on an explicit keyword despite the cooldown', async () => {
      const t = build();
      await t.say('oi');
      await t.redis.clearUserState('co', '5511999990000');

      await t.say('menu');

      expect(t.last()).toContain('Bem-vindo(a)');
    });

    it('never opens the menu for a message without text (audio, sticker...)', async () => {
      const t = build();
      await t.say('');
      expect(t.sent).toHaveLength(0);
      expect(t.state()).toBeUndefined();
    });

    it('a reset clears the cooldown so the next message starts over', async () => {
      const t = build();
      await t.say('oi');
      await t.say('sair');
      await t.say('oi');
      expect(t.last()).toContain('Bem-vindo(a)');
    });
  });
});
