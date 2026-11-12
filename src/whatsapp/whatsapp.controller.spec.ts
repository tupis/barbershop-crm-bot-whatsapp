import { WhatsappController } from './whatsapp.controller';

/**
 * Evolution reports the bot's own outgoing messages with fromMe = true, the
 * same flag a human attendant's message carries. Getting this wrong makes the
 * bot silence itself after every single reply it sends.
 */
function build({ botMessageIds = [] as string[], paused = false } = {}) {
  const store = {
    paused: new Map<string, number>(),
    pausedCalls: [] as { phone: string; seconds: number }[],
  };

  const seen = new Set<string>();
  const redis: any = {
    claimMessage: async (_i: string, id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    wasSentByBot: async (_i: string, id: string) => botMessageIds.includes(id),
    pauseAutomation: async (_i: string, phone: string, seconds: number) => {
      store.paused.set(phone, seconds);
      store.pausedCalls.push({ phone, seconds });
    },
    isAutomationPaused: async (_i: string, phone: string) =>
      paused || store.paused.has(phone),
    pauseTimeLeft: async () => 600,
  };

  const handled: any[] = [];
  const booking: any = {
    handleIncomingMessage: async (
      instance: string,
      phone: string,
      text: string,
      rowId?: string,
    ) => {
      handled.push({ instance, phone, text, rowId });
    },
  };

  const config: any = { get: () => undefined };

  return {
    controller: new WhatsappController(booking, redis, config),
    handled,
    store,
  };
}

const upsert = (over: any = {}) => ({
  event: 'messages.upsert',
  instance: 'barbearialino',
  data: {
    key: {
      remoteJid: '5511988887777@s.whatsapp.net',
      fromMe: false,
      id: 'MSG1',
      ...(over.key ?? {}),
    },
    message: { conversation: 'oi', ...(over.message ?? {}) },
  },
});

describe('WhatsappController — handover ao atendente', () => {
  it('nao se auto-pausa quando a mensagem saiu do proprio bot', async () => {
    const { controller, store } = build({ botMessageIds: ['MSG_BOT'] });

    await controller.handleWebhook(
      upsert({ key: { fromMe: true, id: 'MSG_BOT' } }),
    );

    expect(store.pausedCalls).toHaveLength(0);
  });

  it('pausa quando um atendente responde', async () => {
    const { controller, store } = build({ botMessageIds: ['MSG_BOT'] });

    const res: any = await controller.handleWebhook(
      upsert({ key: { fromMe: true, id: 'MSG_HUMANO' } }),
    );

    expect(res.automation).toBe('paused');
    expect(store.pausedCalls).toEqual([
      { phone: '5511988887777', seconds: 600 },
    ]);
  });

  it('ignora a mensagem do cliente enquanto a pausa estiver ativa', async () => {
    const { controller, handled } = build({ paused: true });

    const res: any = await controller.handleWebhook(upsert());

    expect(res.automation).toBe('paused');
    expect(handled).toHaveLength(0);
  });

  it('volta a responder quando nao ha pausa', async () => {
    const { controller, handled } = build();

    await controller.handleWebhook(upsert());

    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      instance: 'barbearialino',
      phone: '5511988887777',
      text: 'oi',
    });
  });

  it('respeita ATTENDANT_PAUSE_MINUTES', async () => {
    const { controller, store } = build();
    (controller as any).configService = {
      get: (k: string) => (k === 'ATTENDANT_PAUSE_MINUTES' ? '3' : undefined),
    };

    await controller.handleWebhook(
      upsert({ key: { fromMe: true, id: 'OUTRO' } }),
    );

    expect(store.pausedCalls[0].seconds).toBe(180);
  });

  it('ignora eventos que nao sao mensagens', async () => {
    const { controller, handled } = build();

    await controller.handleWebhook({ event: 'connection.update', data: {} });

    expect(handled).toHaveLength(0);
  });

  it('nao quebra quando o payload vem sem remetente', async () => {
    const { controller, handled } = build();

    await expect(
      controller.handleWebhook({
        event: 'messages.upsert',
        instance: 'x',
        data: { key: {} },
      }),
    ).resolves.toBeDefined();
    expect(handled).toHaveLength(0);
  });

  it('extrai a resposta de um botao de lista', async () => {
    const { controller, handled } = build();

    await controller.handleWebhook(
      upsert({
        message: {
          conversation: undefined,
          listResponseMessage: {
            title: 'Corte',
            singleSelectReply: { selectedRowId: 'srv_1' },
          },
        },
      }),
    );

    expect(handled[0]).toMatchObject({ text: 'Corte', rowId: 'srv_1' });
  });

  describe('protecao contra disparos repetidos', () => {
    it('responde uma unica vez ao mesmo id entregue de novo', async () => {
      const { controller, handled } = build();

      await controller.handleWebhook(upsert());
      const again: any = await controller.handleWebhook(upsert());

      expect(handled).toHaveLength(1);
      expect(again.status).toBe('success');
    });

    it.each([
      ['grupo', { key: { remoteJid: '120363000000@g.us' } }],
      ['status', { key: { remoteJid: 'status@broadcast' } }],
      ['newsletter', { key: { remoteJid: '1203@newsletter' } }],
      ['lid sem numero real', { key: { remoteJid: '123456789@lid' } }],
    ])('ignora mensagem de %s', async (_label, over) => {
      const { controller, handled } = build();
      await controller.handleWebhook(upsert(over));
      expect(handled).toHaveLength(0);
    });

    it('usa o numero real quando o remetente vem como @lid', async () => {
      const { controller, handled } = build();
      await controller.handleWebhook(
        upsert({
          key: {
            remoteJid: '123456789@lid',
            remoteJidAlt: '5511977776666@s.whatsapp.net',
          },
        }),
      );
      expect(handled[0]).toMatchObject({ phone: '5511977776666' });
    });

    it.each([
      ['reacao', { reactionMessage: { text: '👍' } }],
      ['protocolo (apagar/editar)', { protocolMessage: { type: 0 } }],
      ['figurinha', { stickerMessage: {} }],
    ])('ignora %s', async (_label, message) => {
      const { controller, handled } = build();
      const payload: any = upsert();
      payload.data.message = message;
      await controller.handleWebhook(payload);
      expect(handled).toHaveLength(0);
    });

    it('ignora avisos do sistema (chamada perdida, aguardando mensagem)', async () => {
      const { controller, handled } = build();
      const payload: any = upsert();
      payload.data.messageStubType = 2;
      payload.data.message = undefined;
      await controller.handleWebhook(payload);
      expect(handled).toHaveLength(0);
    });

    it('nao responde mensagem antiga reentregue (reconexao/backlog)', async () => {
      const { controller, handled } = build();
      const payload: any = upsert();
      payload.data.messageTimestamp = Math.floor(Date.now() / 1000) - 3 * 3600;
      await controller.handleWebhook(payload);
      expect(handled).toHaveLength(0);
    });

    it('responde mensagem recente', async () => {
      const { controller, handled } = build();
      const payload: any = upsert();
      payload.data.messageTimestamp = String(Math.floor(Date.now() / 1000) - 5);
      await controller.handleWebhook(payload);
      expect(handled).toHaveLength(1);
    });

    it('devolve 2xx mesmo quando o fluxo quebra, para a Evolution nao reenviar', async () => {
      const { controller } = build();
      (controller as any).bookingService = {
        handleIncomingMessage: async () => {
          throw new Error('backend fora');
        },
      };
      const res: any = await controller.handleWebhook(upsert());
      expect(res.status).toBe('error');
    });
  });
});
