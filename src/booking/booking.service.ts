import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ApiService } from '../api/api.service';
import { format, addDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { phoneWithoutDDD } from '../utils/phone-without-ddd';
import { BotLogger, preview } from '../common/logging/bot-logger';

/**
 * After the welcome menu goes out, the bot does not greet the same customer
 * from scratch again for this long (unless they ask with a restart keyword).
 */
const DEFAULT_WELCOME_COOLDOWN_MINUTES = 60;

/** Words that always (re)start the booking flow, cooldown or not. */
const START_KEYWORDS = [
  'menu',
  'agendar',
  'agendamento',
  'novo agendamento',
  'inicio',
  'início',
  'comecar',
  'começar',
];

/** Steps whose free text is personal data and stays out of the logs. */
const PRIVATE_STEPS = new Set(['ASKING_NAME', 'ASKING_EMAIL']);

export enum BookingState {
  IDLE = 'IDLE',
  SELECTING_UNIT = 'SELECTING_UNIT',
  SELECTING_SERVICES = 'SELECTING_SERVICES',
  CHOSING_BARBER_MODE = 'CHOSING_BARBER_MODE',
  SELECTING_BARBER_FOR_SERVICE = 'SELECTING_BARBER_FOR_SERVICE',
  SELECTING_BARBER = 'SELECTING_BARBER',
  SELECTING_DATE = 'SELECTING_DATE',
  SELECTING_TIME = 'SELECTING_TIME',
  ASKING_NAME = 'ASKING_NAME',
  ASKING_EMAIL = 'ASKING_EMAIL',
  ASKING_COUPON = 'ASKING_COUPON',
  CONFIRMING = 'CONFIRMING',
}

@Injectable()
export class BookingService {
  private readonly log = new BotLogger(BookingService.name);

  private get welcomeCooldownSeconds(): number {
    const configured = Number(process.env.WELCOME_COOLDOWN_MINUTES);
    const minutes =
      Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_WELCOME_COOLDOWN_MINUTES;
    return Math.round(minutes * 60);
  }

  /** Customer explicitly ended the conversation: next message starts fresh. */
  private async resetConversation(companyId: string, phone: string) {
    await this.redisService.clearUserState(companyId, phone);
    await this.redisService
      .clearWelcome(companyId, phone)
      .catch((err) => this.log.error('redis.clear_welcome_failed', err));
  }

  /**
   * Decides whether an idle customer gets the welcome menu. Returns false
   * (and logs why) when the message is not a reason to greet them.
   */
  private async shouldGreet(
    companyId: string,
    phone: string,
    text: string,
    selectedRowId?: string,
  ): Promise<boolean> {
    const clean = text.trim().toLowerCase();

    // Audio, image without caption, sticker... — almost always meant for a
    // person, never a reason to fire the menu.
    if (!clean && !selectedRowId) {
      this.log.info('booking.welcome_skipped', { reason: 'empty_text' });
      return false;
    }

    if (START_KEYWORDS.includes(clean)) return true;

    const lastWelcome = await this.redisService
      .lastWelcomeAt(companyId, phone)
      .catch((err) => {
        this.log.error('redis.last_welcome_failed', err);
        return null;
      });

    if (lastWelcome) {
      this.log.warn('booking.welcome_suppressed', {
        reason: 'cooldown',
        lastWelcomeAt: lastWelcome,
        cooldownMinutes: this.welcomeCooldownSeconds / 60,
      });
      return false;
    }
    return true;
  }

  constructor(
    private apiService: ApiService,
    private redisService: RedisService,
    private whatsappService: WhatsappService,
  ) {}

  async handleIncomingMessage(
    instance: string,
    phone: string,
    text: string,
    selectedRowId?: string,
  ) {
    const company = await this.apiService.getCompanyBySlug(instance, instance);

    if (!company) {
      this.log.error('booking.company_not_found', undefined, { instance });
      return;
    }

    const companyId = company.id || company.uuid;

    let state = await this.redisService.getUserState(companyId, phone);
    const hadState = Boolean(state);

    if (!state) {
      state = { step: BookingState.IDLE, selectedServices: [] };
    }

    const stepBefore = state.step;
    this.log.info('booking.message', {
      companyId,
      step: stepBefore,
      hadState,
      selectedRowId,
      textPreview: PRIVATE_STEPS.has(stepBefore)
        ? '[redacted]'
        : preview(text, 30),
    });

    if (!selectedRowId && state.availableOptions && /^\d+$/.test(text)) {
      const index = parseInt(text, 10) - 1;
      if (index >= 0 && index < state.availableOptions.length) {
        selectedRowId = state.availableOptions[index];
      }
    }

    const cleanText = text.trim().toLowerCase();

    const attendantCommands = [
      'atendente',
      'falar com atendente',
      'chamar atendente',
      'suporte',
      'humano',
      'falar com humano',
      '#atendente',
      '!atendente',
      '/atendente',
    ];

    const resumeCommands = [
      'bot',
      '#bot',
      '!bot',
      '/bot',
      'voltar bot',
      'ativar bot',
      'zerar timer',
      'cancelar atendente',
      'reiniciar bot',
      'chamar bot',
    ];

    const isAttendantRequest =
      selectedRowId === 'flow_attendant' ||
      attendantCommands.includes(cleanText);

    const isResumeBotRequest =
      selectedRowId === 'flow_resume_bot' || resumeCommands.includes(cleanText);

    const isPaused = await this.redisService.isBotPaused(companyId, phone);

    if (isPaused) {
      if (isResumeBotRequest) {
        await this.redisService.resumeBot(companyId, phone);
        await this.resetConversation(companyId, phone);
        this.log.info('booking.bot_resumed_by_customer');
        await this.whatsappService.sendText(
          instance,
          phone,
          '🤖 *Atendimento do robô reativado!*\nComo posso te ajudar?',
        );
        return;
      } else {
        return;
      }
    }

    if (isAttendantRequest) {
      const pauseMinutes = parseInt(
        process.env.BOT_PAUSE_DURATION_MINUTES || '30',
        10,
      );
      const pauseSeconds = pauseMinutes * 60;
      await this.redisService.pauseBot(companyId, phone, pauseSeconds);
      await this.redisService.clearUserState(companyId, phone);
      this.log.info('booking.attendant_requested', { pauseMinutes });
      await this.whatsappService.sendText(
        instance,
        phone,
        `👤 *Atendimento humano solicitado!*\n\nUm de nossos atendentes falará com você em breve.\nO bot permanecerá pausado por ${pauseMinutes} minutos.\n\n💡 *Para reativar o robô a qualquer momento, digite:* *#bot* ou *zerar timer*.`,
      );
      return;
    }

    if (isResumeBotRequest && cleanText !== 'bot') {
      await this.whatsappService.sendText(
        instance,
        phone,
        '🤖 *O atendimento do robô já está ativo!*\nComo posso te ajudar?',
      );
      return;
    }

    const isReset =
      selectedRowId === 'flow_reset' ||
      text.toLowerCase() === 'reset' ||
      text.toLowerCase() === 'sair' ||
      text.toLowerCase() === 'reiniciar';

    if (isReset) {
      await this.resetConversation(companyId, phone);
      this.log.info('booking.reset_by_customer');
      await this.whatsappService.sendText(
        instance,
        phone,
        'Agendamento cancelado. Digite algo para recomeçar.',
      );
      return;
    }

    const isBack =
      selectedRowId === 'flow_back' || text.toLowerCase() === 'voltar';

    if (isBack && state.step !== BookingState.IDLE) {
      switch (state.step) {
        case BookingState.SELECTING_UNIT:
          await this.resetConversation(companyId, phone);
          await this.whatsappService.sendText(
            instance,
            phone,
            'Agendamento cancelado. Digite algo para recomeçar.',
          );
          return;

        case BookingState.SELECTING_BARBER:
          state.selectedBranchId = undefined;
          await this.sendUnitSelection(instance, phone, company, state);
          state.step = BookingState.SELECTING_UNIT;
          break;

        case BookingState.SELECTING_SERVICES:
          state.selectedBarberId = undefined;
          state.serviceBarberIds = {};
          state.selectedServices = [];
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            [],
            state,
          );
          state.step = BookingState.SELECTING_BARBER;
          break;

        case BookingState.SELECTING_DATE:
          state.selectedDate = undefined;
          await this.sendServiceSelection(
            instance,
            phone,
            state.selectedBranchId,
            state,
          );
          state.step = BookingState.SELECTING_SERVICES;
          break;

        case BookingState.SELECTING_TIME:
          state.selectedTime = undefined;
          await this.sendDateSelection(instance, phone, state);
          state.step = BookingState.SELECTING_DATE;
          break;

        case BookingState.ASKING_NAME:
          state.selectedTime = undefined;
          state.tempName = undefined;
          await this.sendTimeSelection(
            instance,
            phone,
            state.selectedBarberId,
            state.selectedDate,
            state,
          );
          state.step = BookingState.SELECTING_TIME;
          break;

        case BookingState.ASKING_EMAIL:
          state.tempName = undefined;
          await this.whatsappService.sendText(
            instance,
            phone,
            'Por favor, digite o seu nome completo:',
          );
          state.step = BookingState.ASKING_NAME;
          break;

        case BookingState.ASKING_COUPON:
          await this.sendConfirmation(instance, phone, state);
          state.step = BookingState.CONFIRMING;
          break;

        case BookingState.CONFIRMING:
          if (state.tempName) {
            state.tempEmail = undefined;
            await this.whatsappService.sendText(
              instance,
              phone,
              'Por favor, digite o seu e-mail (ou digite *pular* para continuar sem e-mail):',
            );
            state.step = BookingState.ASKING_EMAIL;
          } else {
            state.selectedTime = undefined;
            await this.sendTimeSelection(
              instance,
              phone,
              state.selectedBarberId,
              state.selectedDate,
              state,
            );
            state.step = BookingState.SELECTING_TIME;
          }
          break;
      }
      if (state) {
        await this.redisService.setUserState(companyId, phone, state);
      }
      return;
    }

    await this.redisService.appendHistory(companyId, phone, {
      role: 'user',
      content: text,
    });

    switch (state.step) {
      case BookingState.IDLE:
        if (!(await this.shouldGreet(companyId, phone, text, selectedRowId))) {
          return;
        }
        await this.sendUnitSelection(instance, phone, company, state);
        state.step = BookingState.SELECTING_UNIT;
        await this.redisService
          .markWelcomeSent(companyId, phone, this.welcomeCooldownSeconds)
          .catch((err) => this.log.error('redis.mark_welcome_failed', err));
        this.log.info('booking.welcome_sent', { hadState });
        break;

      case BookingState.SELECTING_UNIT:
        if (selectedRowId) {
          state.selectedBranchId = selectedRowId.replace('unit_', '');
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            [],
            state,
          );
          state.step = BookingState.SELECTING_BARBER;
        } else {
          await this.sendUnitSelection(
            instance,
            phone,
            company,
            state,
            'Por favor, selecione uma unidade digitando o número:',
          );
        }
        break;

      case BookingState.SELECTING_BARBER:
        if (selectedRowId && selectedRowId.startsWith('barber_')) {
          state.selectedBarberId = selectedRowId.replace('barber_', '');
          state.selectedServices = [];
          state.serviceBarberIds = {};
          await this.sendServiceSelection(
            instance,
            phone,
            state.selectedBranchId,
            state,
          );
          state.step = BookingState.SELECTING_SERVICES;
        } else {
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            [],
            state,
            'Por favor, selecione um profissional digitando o número:',
          );
        }
        break;

      case BookingState.SELECTING_SERVICES:
        if (selectedRowId) {
          if (selectedRowId === 'confirm_services') {
            if (state.selectedServices && state.selectedServices.length > 0) {
              state.serviceBarberIds = {};
              state.selectedServices.forEach((sid: string) => {
                state.serviceBarberIds[sid] = state.selectedBarberId;
              });
              await this.sendDateSelection(instance, phone, state);
              state.step = BookingState.SELECTING_DATE;
            } else {
              await this.sendServiceSelection(
                instance,
                phone,
                state.selectedBranchId,
                state,
                'Por favor, selecione pelo menos um serviço:',
              );
            }
          } else if (selectedRowId.startsWith('service_')) {
            const serviceId = selectedRowId.replace('service_', '');
            if (!state.selectedServices) {
              state.selectedServices = [];
            }
            const idx = state.selectedServices.indexOf(serviceId);
            if (idx > -1) {
              state.selectedServices.splice(idx, 1);
            } else {
              state.selectedServices.push(serviceId);
            }
            await this.sendServiceSelection(
              instance,
              phone,
              state.selectedBranchId,
              state,
            );
          }
        } else {
          await this.sendServiceSelection(
            instance,
            phone,
            state.selectedBranchId,
            state,
            'Por favor, selecione um serviço digitando o número:',
          );
        }
        break;

      case BookingState.SELECTING_DATE:
        if (selectedRowId) {
          state.selectedDate = selectedRowId.replace('date_', '');
          await this.sendTimeSelection(
            instance,
            phone,
            state.selectedBarberId,
            state.selectedDate,
            state,
          );
          state.step = BookingState.SELECTING_TIME;
        } else {
          await this.sendDateSelection(instance, phone, state);
        }
        break;

      case BookingState.SELECTING_TIME:
        if (selectedRowId) {
          state.selectedTime = selectedRowId.replace('time_', '');

          const formattedPhone = phoneWithoutDDD(phone);
          const user = await this.apiService.findOrCreateUser(
            instance,
            formattedPhone,
            'Cliente WhatsApp',
          );
          if (user) {
            state.customerId = user.id || user.uuid;
            if (user.name === 'Cliente WhatsApp') {
              await this.whatsappService.sendText(
                instance,
                phone,
                'Percebi que é seu primeiro agendamento conosco! Para começarmos, digite o seu nome completo:',
              );
              state.step = BookingState.ASKING_NAME;
            } else {
              await this.sendConfirmation(instance, phone, state);
              state.step = BookingState.CONFIRMING;
            }
          } else {
            await this.sendConfirmation(instance, phone, state);
            state.step = BookingState.CONFIRMING;
          }
        } else {
          await this.sendTimeSelection(
            instance,
            phone,
            state.selectedBarberId,
            state.selectedDate,
            state,
          );
        }
        break;

      case BookingState.ASKING_NAME:
        state.tempName = text.trim();
        await this.whatsappService.sendText(
          instance,
          phone,
          `Obrigado, ${state.tempName}! Agora, por favor, digite o seu e-mail (ou digite *pular* para continuar sem e-mail):`,
        );
        state.step = BookingState.ASKING_EMAIL;
        break;

      case BookingState.ASKING_EMAIL:
        const rawEmail = text.trim();
        const lowerEmail = rawEmail.toLowerCase();
        const skipKeywords = [
          'pular',
          'pula',
          'não',
          'nao',
          '0',
          'sem email',
          'sem e-mail',
          'ignorar',
          'skip',
        ];

        if (skipKeywords.includes(lowerEmail)) {
          state.tempEmail = undefined;
          const formattedPhone = phoneWithoutDDD(phone);
          await this.apiService.updateCustomer(instance, state.customerId, {
            name: state.tempName,
            phone: formattedPhone,
          });
          await this.sendConfirmation(instance, phone, state);
          state.step = BookingState.CONFIRMING;
        } else if (!rawEmail.includes('@') || !rawEmail.includes('.')) {
          await this.whatsappService.sendText(
            instance,
            phone,
            'E-mail inválido. Por favor, digite um e-mail válido (ex: seuemail@email.com) ou digite *pular* para continuar sem e-mail:',
          );
        } else {
          state.tempEmail = rawEmail;
          const formattedPhone = phoneWithoutDDD(phone);
          await this.apiService.updateCustomer(instance, state.customerId, {
            name: state.tempName,
            email: state.tempEmail,
            phone: formattedPhone,
          });
          await this.sendConfirmation(instance, phone, state);
          state.step = BookingState.CONFIRMING;
        }
        break;

      case BookingState.ASKING_COUPON: {
        const typed = text.trim();

        if (!typed || typed.toLowerCase() === 'pular') {
          // Clearing lets someone drop a coupon they had already applied.
          state.couponCode = undefined;
          state.couponDiscount = 0;
          await this.sendConfirmation(instance, phone, state);
          state.step = BookingState.CONFIRMING;
          break;
        }

        const code = typed.toUpperCase();
        const result = await this.apiService.validateCoupon(
          instance,
          code,
          state.selectedBranchId,
          state.selectedServices ?? [],
        );

        if (!result.valid) {
          await this.whatsappService.sendText(
            instance,
            phone,
            `❌ ${result.reason || 'Cupom inválido.'}\n\nDigite outro código ou *pular* para seguir sem desconto:`,
          );
          break;
        }

        // Work out the discount here so the summary and the backend agree.
        const services = await this.apiService.getServices(
          instance,
          state.selectedBranchId,
        );
        const selected = services.filter((sv: any) =>
          (state.selectedServices ?? []).includes(sv.id),
        );
        const subtotal = selected.reduce(
          (sum: number, sv: any) => sum + sv.price,
          0,
        );

        const coupon = result.coupon ?? {};
        const discount =
          coupon.discountType === 'PERCENTAGE'
            ? Math.round((subtotal * Number(coupon.discountValue ?? 0)) / 100)
            : Number(coupon.discountValue ?? 0);

        state.couponCode = code;
        state.couponDiscount = Math.max(0, Math.min(discount, subtotal));

        await this.whatsappService.sendText(
          instance,
          phone,
          `✅ Cupom *${code}* aplicado!`,
        );
        await this.sendConfirmation(instance, phone, state);
        state.step = BookingState.CONFIRMING;
        break;
      }

      case BookingState.CONFIRMING:
        if (
          selectedRowId === 'btn_coupon' ||
          text.toLowerCase() === 'cupom' ||
          text.toLowerCase() === '2'
        ) {
          await this.whatsappService.sendText(
            instance,
            phone,
            '🎟️ Digite o código do cupom (ou *pular* para continuar sem desconto):',
          );
          state.step = BookingState.ASKING_COUPON;
          break;
        }

        if (
          text.toLowerCase().includes('sim') ||
          text.toLowerCase() === 'confirmar' ||
          selectedRowId === 'btn_confirm' ||
          text.toLowerCase() === '1'
        ) {
          const uniqueBarberIds = [
            ...new Set([
              state.selectedBarberId,
              ...(state.serviceBarberIds
                ? Object.values(state.serviceBarberIds)
                : []),
            ]),
          ].filter(Boolean) as string[];

          let isStillAvailable = true;
          for (const bId of uniqueBarberIds) {
            const slots = await this.apiService.getAvailableSlots(
              instance,
              bId,
              state.selectedDate,
            );
            if (!slots.includes(state.selectedTime)) {
              isStillAvailable = false;
              break;
            }
          }

          if (!isStillAvailable) {
            await this.whatsappService.sendText(
              instance,
              phone,
              `⚠️ *Ops! O horário ${state.selectedTime} no dia ${state.selectedDate} não está mais disponível.* (Já foi reservado por outro cliente).\n\nPor favor, escolha outro horário disponível abaixo:`,
            );
            state.selectedTime = undefined;
            await this.sendTimeSelection(
              instance,
              phone,
              state.selectedBarberId,
              state.selectedDate,
              state,
            );
            state.step = BookingState.SELECTING_TIME;
            await this.redisService.setUserState(companyId, phone, state);
            return;
          }

          const success = await this.createAppointment(instance, phone, state);
          if (success) {
            // Welcome cooldown is kept on purpose: a "valeu!" right after
            // booking must not open the menu again.
            await this.redisService.clearUserState(companyId, phone);
            this.log.info('booking.completed');
          } else {
            state.selectedTime = undefined;
            await this.sendTimeSelection(
              instance,
              phone,
              state.selectedBarberId,
              state.selectedDate,
              state,
            );
            state.step = BookingState.SELECTING_TIME;
            await this.redisService.setUserState(companyId, phone, state);
          }
          return;
        } else if (
          text.toLowerCase().includes('não') ||
          text.toLowerCase() === 'cancelar' ||
          selectedRowId === 'btn_cancel' ||
          text.toLowerCase() === '2'
        ) {
          await this.resetConversation(companyId, phone);
          this.log.info('booking.cancelled_by_customer');
          await this.whatsappService.sendText(
            instance,
            phone,
            'Agendamento cancelado. Digite algo para recomeçar.',
          );
          return;
        } else {
          await this.sendConfirmation(instance, phone, state);
        }
        break;
    }

    if (state) {
      await this.redisService.setUserState(companyId, phone, state);
      if (state.step !== stepBefore) {
        this.log.info('booking.step_changed', {
          from: stepBefore,
          to: state.step,
        });
      }
    }
  }

  private async sendMenu(
    instance: string,
    phone: string,
    title: string,
    text: string,
    options: { label: string; rowId: string }[],
    state: any,
  ) {
    const menuOptions = [...options];
    menuOptions.push({
      label: '↩️ Voltar para o passo anterior',
      rowId: 'flow_back',
    });
    menuOptions.push({
      label: '👤 Falar com atendente',
      rowId: 'flow_attendant',
    });
    menuOptions.push({
      label: '🔄 Reiniciar atendimento',
      rowId: 'flow_reset',
    });

    let menuText = `*${title}*\n\n${text}\n\n`;
    menuOptions.forEach((opt, i) => {
      menuText += `${i + 1}. ${opt.label}\n`;
    });
    menuText += `\n_Digite o número da opção desejada_`;

    state.availableOptions = menuOptions.map((opt) => opt.rowId);

    await this.whatsappService.sendText(instance, phone, menuText);
  }

  private async sendUnitSelection(
    instance: string,
    phone: string,
    company: any,
    state: any,
    customText?: string,
  ) {
    const branches = await this.apiService.getBranches(instance);

    const options = branches.map((b: any) => ({
      label: b.name,
      rowId: `unit_${b.id}`,
    }));

    await this.sendMenu(
      instance,
      phone,
      company.name,
      customText ||
        `Olá! Bem-vindo(a) à ${company.name}. Para começar, selecione a unidade que deseja ser atendido:`,
      options,
      state,
    );
  }

  private async sendServiceSelection(
    instance: string,
    phone: string,
    branchId: string,
    state: any,
    customText?: string,
  ) {
    const services = await this.apiService.getServices(instance, branchId);

    let filteredServices = services;
    if (state.selectedBarberId) {
      const barbers = await this.apiService.getBarbers(instance, branchId);
      const selectedBarber = barbers.find(
        (b: any) => b.id === state.selectedBarberId,
      );
      if (selectedBarber && selectedBarber.serviceIds) {
        filteredServices = services.filter((s: any) =>
          selectedBarber.serviceIds.includes(s.id),
        );
      }
    }

    const options = filteredServices.map((s: any) => {
      const isSelected = state.selectedServices?.includes(s.id);
      return {
        label: `${s.name} - R$ ${s.price / 100}${isSelected ? ' [Selecionado ✅]' : ''}`,
        rowId: `service_${s.id}`,
      };
    });

    if (state.selectedServices && state.selectedServices.length > 0) {
      options.push({
        label: '➡️ Avançar / Continuar',
        rowId: 'confirm_services',
      });
    }

    let descriptionText =
      customText ||
      `Ótimo! Agora escolha o serviço que deseja agendar (você pode selecionar vários):`;
    if (state.selectedServices && state.selectedServices.length > 0) {
      const selectedNames = filteredServices
        .filter((s: any) => state.selectedServices.includes(s.id))
        .map((s: any) => s.name)
        .join(', ');
      descriptionText = `*Selecionados atualmente:* ${selectedNames}\n\nDeseja adicionar mais algum serviço ou avançar?`;
    }

    await this.sendMenu(
      instance,
      phone,
      'Escolha o Serviço',
      descriptionText,
      options,
      state,
    );
  }

  private async sendBarberSelection(
    instance: string,
    phone: string,
    branchId: string,
    serviceIds: string[],
    state: any,
    customText?: string,
  ) {
    const barbers = await this.apiService.getBarbers(instance, branchId);

    const compatibleBarbers = barbers.filter((b: any) =>
      serviceIds.every((sid) => b.serviceIds?.includes(sid)),
    );

    const options = compatibleBarbers.map((b: any) => ({
      label: b.name,
      rowId: `barber_${b.id}`,
    }));

    await this.sendMenu(
      instance,
      phone,
      'Escolha o Profissional',
      customText || 'Ótimo! Agora escolha quem vai te atender:',
      options,
      state,
    );
  }

  private async sendDateSelection(instance: string, phone: string, state: any) {
    const company = await this.apiService.getCompanyBySlug(instance, instance);
    const barbers = await this.apiService.getBarbers(
      instance,
      state.selectedBranchId,
    );
    const branches = await this.apiService.getBranches(instance);
    const selectedBranch = branches.find(
      (b: any) => b.id === state.selectedBranchId,
    );

    const uniqueBarberIds = [
      ...new Set([
        state.selectedBarberId,
        ...(state.serviceBarberIds
          ? Object.values(state.serviceBarberIds)
          : []),
      ]),
    ].filter(Boolean) as string[];

    const activeBarbers = uniqueBarberIds
      .map((id) => barbers.find((b: any) => b.id === id))
      .filter(Boolean);

    const daysOfWeekMap = [
      'DOMINGO',
      'SEGUNDA',
      'TERCA',
      'QUARTA',
      'QUINTA',
      'SEXTA',
      'SABADO',
    ];

    const options: { label: string; rowId: string }[] = [];
    const maxDaysToScan = 30;
    const targetCount = 7;

    const candidates: Date[] = [];
    for (let i = 0; i < maxDaysToScan; i++) {
      candidates.push(addDays(new Date(), i));
    }

    const workingDays = candidates.filter((date) => {
      const dayOfWeekName = daysOfWeekMap[date.getDay()];

      // 1. Check if the branch/barbershop is active on this day
      let isBranchActive = true;
      if (selectedBranch && selectedBranch.workingHours) {
        const branchWh = selectedBranch.workingHours.find(
          (h: any) => h.dayOfWeek === dayOfWeekName,
        );
        if (branchWh) {
          isBranchActive = branchWh.isActive;
        } else {
          // Fall back to company working hours if not specified in branch
          const companyWh = company?.workingHours?.find(
            (h: any) => h.dayOfWeek === dayOfWeekName,
          );
          isBranchActive = companyWh
            ? companyWh.isActive
            : dayOfWeekName !== 'DOMINGO';
        }
      } else {
        const companyWh = company?.workingHours?.find(
          (h: any) => h.dayOfWeek === dayOfWeekName,
        );
        isBranchActive = companyWh
          ? companyWh.isActive
          : dayOfWeekName !== 'DOMINGO';
      }

      // If the branch is closed, this day is not available regardless of the barber
      if (!isBranchActive) {
        return false;
      }

      // 2. Check if all active barbers are active on this day
      if (activeBarbers.length > 0) {
        return activeBarbers.every((barber: any) => {
          const barberWh = barber.workingHours?.find(
            (h: any) => h.dayOfWeek === dayOfWeekName,
          );
          if (barberWh) {
            return barberWh.isActive;
          }
          // If no specific working hours settings for the barber on this day, fallback to true since branch is active
          return true;
        });
      }

      return true;
    });

    const workingDaysToCheck = workingDays.slice(0, 20);

    const slotChecks = await Promise.all(
      workingDaysToCheck.map(async (date) => {
        const formatted = format(date, 'yyyy-MM-dd');
        const hasSlotsResults = await Promise.all(
          uniqueBarberIds.map(async (barberId) => {
            const slots = await this.apiService.getAvailableSlots(
              instance,
              barberId,
              formatted,
            );
            return slots.length > 0;
          }),
        );
        const isAvailable = hasSlotsResults.every(Boolean);
        return { date, isAvailable };
      }),
    );

    const availableDays = slotChecks
      .filter((c) => c.isAvailable)
      .map((c) => c.date)
      .slice(0, targetCount);

    const finalDays =
      availableDays.length > 0
        ? availableDays
        : workingDays.slice(0, targetCount);

    for (const date of finalDays) {
      const formatted = format(date, 'yyyy-MM-dd');
      const label = format(date, 'EEEE, dd/MM', { locale: ptBR });
      options.push({
        label,
        rowId: `date_${formatted}`,
      });
    }

    await this.sendMenu(
      instance,
      phone,
      'Escolha a Data',
      'Para quando você deseja agendar?',
      options,
      state,
    );
  }

  private async sendTimeSelection(
    instance: string,
    phone: string,
    barberId: string,
    date: string,
    state: any,
  ) {
    const slots = await this.apiService.getAvailableSlots(
      instance,
      barberId,
      date,
    );

    const options = slots.map((s: string) => ({
      label: s,
      rowId: `time_${s}`,
    }));

    await this.sendMenu(
      instance,
      phone,
      'Escolha o Horário',
      `Horários disponíveis para o dia ${date}:`,
      options,
      state,
    );
  }

  private async sendConfirmation(instance: string, phone: string, state: any) {
    const services = await this.apiService.getServices(
      instance,
      state.selectedBranchId,
    );
    const selectedServices = services.filter((s: any) =>
      state.selectedServices.includes(s.id),
    );

    const barbers = await this.apiService.getBarbers(
      instance,
      state.selectedBranchId,
    );
    const barber = barbers.find((b: any) => b.id === state.selectedBarberId);

    const total = selectedServices.reduce(
      (sum: number, s: any) => sum + s.price,
      0,
    );

    let professionalLine = '';
    const uniqueBarberIds = [
      ...new Set(Object.values(state.serviceBarberIds || {})),
    ];
    if (uniqueBarberIds.length > 1) {
      professionalLine = `👤 *Profissionais:* \n`;
      selectedServices.forEach((s: any) => {
        const bid = state.serviceBarberIds[s.id];
        const b = barbers.find((x: any) => x.id === bid);
        professionalLine += `  - ${s.name}: ${b?.name || 'Não selecionado'}\n`;
      });
    } else {
      professionalLine = `👤 *Profissional:* ${barber?.name}\n`;
    }

    const money = (cents: number) =>
      `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

    // The discount was worked out when the code was accepted.
    const discount = state.couponDiscount ?? 0;
    const finalTotal = Math.max(0, total - discount);

    let priceLines = `💰 *Total:* ${money(total)}\n`;
    if (state.couponCode && discount > 0) {
      priceLines =
        `💰 *Subtotal:* ${money(total)}\n` +
        `🎟️ *Cupom ${state.couponCode}:* -${money(discount)}\n` +
        `💵 *Total:* ${money(finalTotal)}\n`;
    }

    const summary =
      `📌 *Serviços:* ${selectedServices.map((s: any) => s.name).join(', ')}\n` +
      professionalLine +
      `📅 *Data:* ${state.selectedDate}\n` +
      `🕒 *Horário:* ${state.selectedTime}\n` +
      priceLines +
      `\nPodemos confirmar?`;

    const options = [
      { label: '✅ Confirmar', rowId: 'btn_confirm' },
      {
        label: state.couponCode ? '🎟️ Trocar cupom' : '🎟️ Tenho um cupom',
        rowId: 'btn_coupon',
      },
      { label: '❌ Cancelar', rowId: 'btn_cancel' },
    ];

    await this.sendMenu(
      instance,
      phone,
      'RESUMO DO AGENDAMENTO',
      summary,
      options,
      state,
    );
  }

  private async createAppointment(
    instance: string,
    phone: string,
    state: any,
  ): Promise<boolean> {
    try {
      this.log.info('booking.creating_appointment');
      const phoneWithoutDDD = phone.replace('55', '9');

      let customerId = state.customerId;
      if (!customerId) {
        const user = await this.apiService.findOrCreateUser(
          instance,
          phoneWithoutDDD,
          'Cliente WhatsApp',
        );
        if (!user) {
          throw new Error('Could not find or create user in backend');
        }
        customerId = user.id || user.uuid;
      }

      await this.apiService.createAppointment(instance, {
        clientId: customerId,
        barberId: state.selectedBarberId,
        branchId: state.selectedBranchId,
        services: state.selectedServices,
        date: state.selectedDate,
        time: state.selectedTime,
        serviceBarberIds: state.serviceBarberIds,
        couponCode: state.couponCode,
      });

      await this.whatsappService.sendText(
        instance,
        phone,
        '✅ *Agendamento Confirmado!*\n\nSeu horário foi reservado com sucesso. Te esperamos lá!\n\n_Para um novo agendamento, digite *menu*._',
      );
      return true;
    } catch (error) {
      this.log.error('booking.create_appointment_failed', error);
      await this.whatsappService.sendText(
        instance,
        phone,
        '❌ Não foi possível finalizar o agendamento pois o horário selecionado não está mais disponível ou ocorreu um erro. Por favor, selecione outro horário.',
      );
      return false;
    }
  }

  private async sendBarberModeSelection(
    instance: string,
    phone: string,
    state: any,
  ) {
    const options = [
      {
        label: '👤 Um único profissional para todos os serviços',
        rowId: 'barber_mode_single',
      },
      {
        label: '👥 Um profissional diferente para cada serviço',
        rowId: 'barber_mode_multi',
      },
    ];

    await this.sendMenu(
      instance,
      phone,
      'Seleção de Profissionais',
      'Como deseja selecionar os profissionais para os seus serviços?',
      options,
      state,
    );
  }

  private async sendNextServiceBarberSelection(
    instance: string,
    phone: string,
    state: any,
  ) {
    const services = await this.apiService.getServices(
      instance,
      state.selectedBranchId,
    );
    const serviceId = state.selectedServices[state.currentServiceBarberIndex];
    const service = services.find((s: any) => s.id === serviceId);

    const barbers = await this.apiService.getBarbers(
      instance,
      state.selectedBranchId,
    );
    const compatibleBarbers = barbers.filter((b: any) =>
      b.serviceIds?.includes(serviceId),
    );

    const options = compatibleBarbers.map((b: any) => ({
      label: b.name,
      rowId: `barber_${b.id}`,
    }));

    await this.sendMenu(
      instance,
      phone,
      `Profissional para ${service?.name}`,
      `Por favor, selecione quem vai te atender para o serviço *${service?.name}*:`,
      options,
      state,
    );
  }
}
