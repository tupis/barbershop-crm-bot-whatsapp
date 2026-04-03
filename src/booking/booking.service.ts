import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ApiService } from '../api/api.service';
import { format, addDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export enum BookingState {
  IDLE = 'IDLE',
  SELECTING_UNIT = 'SELECTING_UNIT',
  SELECTING_SERVICES = 'SELECTING_SERVICES',
  SELECTING_BARBER = 'SELECTING_BARBER',
  SELECTING_DATE = 'SELECTING_DATE',
  SELECTING_TIME = 'SELECTING_TIME',
  CONFIRMING = 'CONFIRMING',
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

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
    const company = await this.apiService.getCompanyBySlug(instance);

    if (!company) {
      this.logger.error(`Company not found for instance: ${instance}`);
      return;
    }

    const companyId = company.id || company.uuid;

    if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'sair') {
      await this.redisService.clearUserState(companyId, phone);
      await this.whatsappService.sendText(
        instance,
        phone,
        'Agendamento cancelado. Digite algo para recomeçar.',
      );
      return;
    }

    let state = await this.redisService.getUserState(companyId, phone);

    if (!state) {
      state = { step: BookingState.IDLE, selectedServices: [] };
    }

    if (!selectedRowId && state.availableOptions && /^\d+$/.test(text)) {
      const index = parseInt(text, 10) - 1;
      if (index >= 0 && index < state.availableOptions.length) {
        selectedRowId = state.availableOptions[index];
      }
    }

    await this.redisService.appendHistory(companyId, phone, {
      role: 'user',
      content: text,
    });

    switch (state.step) {
      case BookingState.IDLE:
        await this.sendUnitSelection(instance, phone, company, state);
        state.step = BookingState.SELECTING_UNIT;
        break;

      case BookingState.SELECTING_UNIT:
        if (selectedRowId) {
          state.selectedBranchId = selectedRowId.replace('unit_', '');
          await this.sendServiceSelection(
            instance,
            phone,
            state.selectedBranchId,
            state,
          );
          state.step = BookingState.SELECTING_SERVICES;
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

      case BookingState.SELECTING_SERVICES:
        if (selectedRowId) {
          const serviceId = selectedRowId.replace('service_', '');
          state.selectedServices = [serviceId];
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            state.selectedServices,
            state,
          );
          state.step = BookingState.SELECTING_BARBER;
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

      case BookingState.SELECTING_BARBER:
        if (selectedRowId) {
          state.selectedBarberId = selectedRowId.replace('barber_', '');
          await this.sendDateSelection(instance, phone, state);
          state.step = BookingState.SELECTING_DATE;
        } else {
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            state.selectedServices,
            state,
            'Por favor, selecione um profissional digitando o número:',
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
          await this.sendConfirmation(instance, phone, state);
          state.step = BookingState.CONFIRMING;
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

      case BookingState.CONFIRMING:
        if (
          text.toLowerCase().includes('sim') ||
          text.toLowerCase() === 'confirmar' ||
          selectedRowId === 'btn_confirm' ||
          text.toLowerCase() === '1'
        ) {
          await this.createAppointment(instance, phone, state);
          await this.redisService.clearUserState(companyId, phone);
        } else if (
          text.toLowerCase().includes('não') ||
          text.toLowerCase() === 'cancelar' ||
          selectedRowId === 'btn_cancel' ||
          text.toLowerCase() === '2'
        ) {
          await this.redisService.clearUserState(companyId, phone);
          await this.whatsappService.sendText(
            instance,
            phone,
            'Agendamento cancelado. Digite algo para recomeçar.',
          );
        } else {
          await this.sendConfirmation(instance, phone, state);
        }
        break;
    }

    if (state) {
      await this.redisService.setUserState(companyId, phone, state);
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
    let menuText = `*${title}*\n\n${text}\n\n`;
    options.forEach((opt, i) => {
      menuText += `${i + 1}. ${opt.label}\n`;
    });
    menuText += `\n_Digite o número da opção desejada_`;

    state.availableOptions = options.map((opt) => opt.rowId);

    await this.whatsappService.sendText(instance, phone, menuText);
  }

  private async sendUnitSelection(
    instance: string,
    phone: string,
    company: any,
    state: any,
    customText?: string,
  ) {
    const branches = await this.apiService.getBranches();

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
    const services = await this.apiService.getServices(branchId);

    const options = services.map((s: any) => ({
      label: `${s.name} - R$ ${s.price}`,
      rowId: `service_${s.id}`,
    }));

    await this.sendMenu(
      instance,
      phone,
      'Escolha o Serviço',
      customText || `Ótimo! Agora escolha o serviço que deseja agendar:`,
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
    const barbers = await this.apiService.getBarbers(branchId);

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
    const options: { label: string; rowId: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(new Date(), i);
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
    const slots = await this.apiService.getAvailableSlots(barberId, date);

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
    const services = await this.apiService.getServices(state.selectedBranchId);
    const selectedServices = services.filter((s: any) =>
      state.selectedServices.includes(s.id),
    );

    const barbers = await this.apiService.getBarbers(state.selectedBranchId);
    const barber = barbers.find((b: any) => b.id === state.selectedBarberId);

    const total = selectedServices.reduce(
      (sum: number, s: any) => sum + s.price,
      0,
    );

    const summary =
      `📌 *Serviços:* ${selectedServices.map((s: any) => s.name).join(', ')}\n` +
      `👤 *Profissional:* ${barber?.name}\n` +
      `📅 *Data:* ${state.selectedDate}\n` +
      `🕒 *Horário:* ${state.selectedTime}\n` +
      `💰 *Total:* R$ ${total}\n\n` +
      `Podemos confirmar?`;

    const options = [
      { label: '✅ Confirmar', rowId: 'btn_confirm' },
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

  private async createAppointment(instance: string, phone: string, state: any) {
    try {
      this.logger.log(`Creating appointment via API for ${phone}`);
      const phoneWithoutDDD = phone.replace('55', '');

      const user = await this.apiService.findOrCreateUser(
        phoneWithoutDDD,
        'Cliente WhatsApp',
      );
      if (!user) {
        throw new Error('Could not find or create user in backend');
      }

      await this.apiService.createAppointment({
        clientId: user.id || user.uuid,
        barberId: state.selectedBarberId,
        branchId: state.selectedBranchId,
        services: state.selectedServices,
        date: state.selectedDate,
        time: state.selectedTime,
      });

      await this.whatsappService.sendText(
        instance,
        phone,
        '✅ *Agendamento Confirmado!*\n\nSeu horário foi reservado com sucesso. Te esperamos lá!',
      );
    } catch (error) {
      this.logger.error(`Error creating appointment: ${error.message}`);
      await this.whatsappService.sendText(
        instance,
        phone,
        '❌ Ocorreu um erro ao finalizar seu agendamento. Por favor, tente novamente ou entre em contato com a barbearia.',
      );
    }
  }
}
