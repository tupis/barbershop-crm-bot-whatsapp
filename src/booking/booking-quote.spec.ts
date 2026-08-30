import { BookingService } from './booking.service';

/**
 * The bot must not do pricing maths of its own: everything it shows has to
 * come from /cliente/quote, or the WhatsApp total will drift from the site's.
 */
function build({ quote = null as any, statement = null as any } = {}) {
  const sent: string[] = [];
  const menus: { title: string; text: string; options: any[] }[] = [];

  // sendMenu renders the whole menu as one text message.
  const whatsapp: any = {
    sendText: async (_i: string, _p: string, text: string) => {
      sent.push(text);
      menus.push({ title: '', text, options: text.split('\n') });
    },
    sendList: async () => undefined,
    sendButtons: async () => undefined,
  };

  const api: any = {
    quote: async () => quote,
    getMyMembership: async () => statement,
    getServices: async () => [
      { id: 'sv-1', name: 'Corte', price: 5000 },
      { id: 'sv-2', name: 'Barba', price: 3500 },
    ],
    getBarbers: async () => [{ id: 'b-1', name: 'Joao', serviceIds: ['sv-1', 'sv-2'] }],
    getBranches: async () => [{ id: 'br-1', name: 'Centro', isActive: true }],
    getCompanyBySlug: async () => ({ name: 'Barbearia' }),
  };

  const redis: any = {
    getUserState: async () => null,
    setUserState: async () => undefined,
    clearUserState: async () => undefined,
    appendHistory: async () => undefined,
  };

  const service = new BookingService(api, redis, whatsapp);
  return { service, sent, menus };
}

const state = () => ({
  customerId: 'cli-1',
  selectedBranchId: 'br-1',
  selectedBarberId: 'b-1',
  selectedServices: ['sv-1', 'sv-2'],
  selectedDate: '2026-09-10',
  selectedTime: '10:00',
  serviceBarberIds: {},
});

const quoteWith = (over: any = {}) => ({
  membership: { planName: 'Clube do Corte', cycleEnd: '2026-09-30' },
  lines: [],
  totals: {
    listCents: 8500,
    membershipDiscountCents: 5000,
    couponDiscountCents: 0,
    chargedCents: 3500,
  },
  coupon: null,
  messages: ['Corte incluso no Clube do Corte — resta 1 neste ciclo.'],
  ...over,
});

describe('resumo do agendamento', () => {
  it('mostra o abatimento do plano e repete as frases do backend', async () => {
    const { service, menus } = build({ quote: quoteWith() });

    await (service as any).sendConfirmation('inst', '5511', state());

    const text = menus[0].text;
    expect(text).toContain('Subtotal:* R$ 85,00');
    expect(text).toContain('Clube do Corte:* -R$ 50,00');
    expect(text).toContain('Total:* R$ 35,00');
    expect(text).toContain('resta 1 neste ciclo');
  });

  it('separa a linha do cupom da linha do plano', async () => {
    const { service, menus } = build({
      quote: quoteWith({
        totals: {
          listCents: 8500,
          membershipDiscountCents: 5000,
          couponDiscountCents: 350,
          chargedCents: 3150,
        },
      }),
    });

    const st = { ...state(), couponCode: 'DEZ' };
    await (service as any).sendConfirmation('inst', '5511', st);

    const text = menus[0].text;
    expect(text).toContain('Clube do Corte:* -R$ 50,00');
    expect(text).toContain('Cupom DEZ:* -R$ 3,50');
    expect(text).toContain('Total:* R$ 31,50');
  });

  it('sem desconto mostra apenas o total', async () => {
    const { service, menus } = build({
      quote: quoteWith({
        membership: null,
        totals: {
          listCents: 8500,
          membershipDiscountCents: 0,
          couponDiscountCents: 0,
          chargedCents: 8500,
        },
        messages: [],
      }),
    });

    const text = (await (service as any).sendConfirmation('inst', '5511', state()),
      menus[0].text);
    expect(text).toContain('Total:* R$ 85,00');
    expect(text).not.toContain('Subtotal');
  });

  it('cai para a soma do catalogo se o backend nao responder', async () => {
    // Never leave the customer without a number, but say it is provisional.
    const { service, menus } = build({ quote: null });

    await (service as any).sendConfirmation('inst', '5511', state());

    expect(menus[0].text).toContain('R$ 85,00');
    expect(menus[0].text).toContain('valor final sai na confirmacao');
  });
});

describe('saldo do plano na escolha do servico', () => {
  const statement = {
    membership: { planName: 'Clube do Corte' },
    balances: [
      { serviceId: 'sv-1', serviceName: 'Corte', remaining: 2, quotaPerCycle: 2 },
      { serviceId: 'sv-2', serviceName: 'Barba', remaining: 0, quotaPerCycle: 1 },
    ],
  };

  it('anuncia o plano e o que ainda cabe', async () => {
    const { service, menus } = build({ statement });

    await (service as any).sendServiceSelection('inst', '5511', 'br-1', {
      customerId: 'cli-1',
    });

    expect(menus[0].text).toContain('Clube do Corte');
    expect(menus[0].text).toContain('2x Corte');
    // Beard quota is spent, so it is not advertised as available.
    expect(menus[0].text).not.toContain('0x Barba');
  });

  it('marca na lista quantos usos restam por servico', async () => {
    const { service, menus } = build({ statement });

    await (service as any).sendServiceSelection('inst', '5511', 'br-1', {
      customerId: 'cli-1',
    });

    const labels: string[] = menus[0].options;
    expect(labels.some((l: string) => l.includes('2 no plano'))).toBe(true);
    // Exhausted service shows no tag: it is simply full price now.
    expect(labels.some((l: string) => l.includes('Barba') && l.includes('plano'))).toBe(false);
  });

  it('cliente sem assinatura ve a lista normal', async () => {
    const { service, menus } = build({ statement: null });

    await (service as any).sendServiceSelection('inst', '5511', 'br-1', {
      customerId: 'cli-1',
    });

    expect(menus[0].text).not.toContain('⭐');
    const labels: string[] = menus[0].options;
    expect(labels.some((l: string) => l.includes('no plano'))).toBe(false);
  });
});
