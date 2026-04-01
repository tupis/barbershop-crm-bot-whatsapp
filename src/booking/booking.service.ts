import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Branch } from '../database/entities/branch.entity';
import { Service } from '../database/entities/service.entity';
import { ServiceCategory } from '../database/entities/service-category.entity';
import { Barber } from '../database/entities/barber.entity';
import { Appointment } from '../database/entities/appointment.entity';
import { User } from '../database/entities/user.entity';
import { Company } from '../database/entities/company.entity';
import { RedisService } from '../redis/redis.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AppointmentStatus, UserRole } from '../common/enums';
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
    @InjectRepository(Branch) private branchRepo: Repository<Branch>,
    @InjectRepository(Service) private serviceRepo: Repository<Service>,
    @InjectRepository(ServiceCategory)
    private categoryRepo: Repository<ServiceCategory>,
    @InjectRepository(Barber) private barberRepo: Repository<Barber>,
    @InjectRepository(Appointment)
    private appointmentRepo: Repository<Appointment>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Company) private companyRepo: Repository<Company>,
    private redisService: RedisService,
    private whatsappService: WhatsappService,
  ) {}

  async handleIncomingMessage(
    instance: string,
    phone: string,
    text: string,
    selectedRowId?: string,
  ) {
    // 1. Identify company by instance (slug)
    const company = await this.companyRepo.findOne({
      where: { slug: instance },
    });

    if (!company) {
      this.logger.error(`Company not found for instance: ${instance}`);
      return;
    }

    // 2. Clear state on "reset" or "sair"
    if (text.toLowerCase() === 'reset' || text.toLowerCase() === 'sair') {
      await this.redisService.clearUserState(company.uuid, phone);
      await this.whatsappService.sendText(
        instance,
        phone,
        'Agendamento cancelado. Digite algo para recomeçar.',
      );
      return;
    }

    // 3. Get or init state
    let state = await this.redisService.getUserState(company.uuid, phone);

    if (!state) {
      state = { step: BookingState.IDLE, selectedServices: [] };
    }

    // 4. Record history
    await this.redisService.appendHistory(company.uuid, phone, {
      role: 'user',
      content: text,
    });

    // 5. Process state
    switch (state.step) {
      case BookingState.IDLE:
        await this.sendUnitSelection(instance, phone, company);
        state.step = BookingState.SELECTING_UNIT;
        break;

      case BookingState.SELECTING_UNIT:
        if (selectedRowId) {
          state.selectedBranchId = selectedRowId.replace('unit_', '');
          const branch = await this.branchRepo.findOne({
            where: { uuid: state.selectedBranchId },
          });
          if (branch) {
            await this.sendServiceSelection(instance, phone, branch);
            state.step = BookingState.SELECTING_SERVICES;
          } else {
            await this.sendUnitSelection(instance, phone, company);
            state.step = BookingState.SELECTING_UNIT;
          }
        } else {
          await this.sendUnitSelection(
            instance,
            phone,
            company,
            'Por favor, selecione uma unidade da lista:',
          );
        }
        break;

      case BookingState.SELECTING_SERVICES:
        if (selectedRowId) {
          const serviceId = selectedRowId.replace('service_', '');
          state.selectedServices = [serviceId]; // Multi-service can be added later
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            state.selectedServices,
          );
          state.step = BookingState.SELECTING_BARBER;
        } else {
          const branch = await this.branchRepo.findOne({
            where: { uuid: state.selectedBranchId },
          });
          if (branch) {
            await this.sendServiceSelection(
              instance,
              phone,
              branch,
              'Por favor, selecione um serviço da lista:',
            );
          } else {
            await this.sendUnitSelection(instance, phone, company);
            state.step = BookingState.SELECTING_UNIT;
          }
        }
        break;

      case BookingState.SELECTING_BARBER:
        if (selectedRowId) {
          state.selectedBarberId = selectedRowId.replace('barber_', '');
          await this.sendDateSelection(instance, phone);
          state.step = BookingState.SELECTING_DATE;
        } else {
          await this.sendBarberSelection(
            instance,
            phone,
            state.selectedBranchId,
            state.selectedServices,
            'Por favor, selecione um profissional da lista:',
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
          );
          state.step = BookingState.SELECTING_TIME;
        } else {
          await this.sendDateSelection(instance, phone);
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
          );
        }
        break;

      case BookingState.CONFIRMING:
        if (
          text.toLowerCase().includes('sim') ||
          text.toLowerCase() === 'confirmar' ||
          selectedRowId === 'btn_confirm'
        ) {
          const branch = await this.branchRepo.findOne({
            where: { uuid: state.selectedBranchId },
          });
          if (branch) {
            await this.createAppointment(instance, phone, branch, state);
          }
          await this.redisService.clearUserState(company.uuid, phone);
        } else if (
          text.toLowerCase().includes('não') ||
          text.toLowerCase() === 'cancelar' ||
          selectedRowId === 'btn_cancel'
        ) {
          await this.redisService.clearUserState(company.uuid, phone);
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

    // 6. Save state
    if (state) {
      await this.redisService.setUserState(company.uuid, phone, state);
    }
  }

  private async sendUnitSelection(
    instance: string,
    phone: string,
    company: Company,
    customText?: string,
  ) {
    const branches = await this.branchRepo.find({
      where: { companyId: company.uuid, isActive: true },
    });

    const sections = [
      {
        title: 'Unidades Disponíveis',
        rows: branches.map((b) => ({
          title: b.name,
          description: b.address || 'Selecione esta unidade',
          rowId: `unit_${b.uuid}`,
        })),
      },
    ];

    await this.whatsappService.sendList(
      instance,
      phone,
      company.name,
      customText ||
        `Ol� Bem-vindo � ${company.name}. Para come�ar, selecione a unidade que deseja ser atendido:`,
      'Ver Unidades',
      sections,
    );
  }

  private async sendServiceSelection(
    instance: string,
    phone: string,
    branch: Branch,
    customText?: string,
  ) {
    const services = await this.serviceRepo.find({
      where: { branchId: branch.uuid, isActive: true },
    });

    const sections = [
      {
        title: 'Serviços Disponíveis',
        rows: services.map((s) => ({
          title: s.name,
          description: `R$ ${s.price} - ${s.duration} min`,
          rowId: `service_${s.uuid}`,
        })),
      },
    ];

    await this.whatsappService.sendList(
      instance,
      phone,
      branch.name,
      customText ||
        `Ótimo! Agora escolha o serviço que deseja agendar na unidade ${branch.name}:`,
      'Ver Serviços',
      sections,
    );
  }

  private async sendBarberSelection(
    instance: string,
    phone: string,
    branchId: string,
    serviceIds: string[],
    customText?: string,
  ) {
    // Find barbers that can do all selected services
    const barbers = await this.barberRepo.find({
      where: { branchId, isActive: true },
    });
    const compatibleBarbers = barbers.filter((b) =>
      serviceIds.every((sid) => b.serviceIds?.includes(sid)),
    );

    const sections = [
      {
        title: 'Profissionais',
        rows: compatibleBarbers.map((b) => ({
          title: b.name,
          description: 'Disponível hoje',
          rowId: `barber_${b.uuid}`,
        })),
      },
    ];

    await this.whatsappService.sendList(
      instance,
      phone,
      'Escolha o Profissional',
      customText || 'Ótimo! Agora escolha quem vai te atender:',
      'Ver Profissionais',
      sections,
    );
  }

  private async sendDateSelection(instance: string, phone: string) {
    const rows: { title: string; rowId: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(new Date(), i);
      const formatted = format(date, 'yyyy-MM-dd');
      const label = format(date, 'EEEE, dd/MM', { locale: ptBR });
      rows.push({
        title: label,
        rowId: `date_${formatted}`,
      });
    }

    const sections = [{ title: 'Próximos Dias', rows }];
    await this.whatsappService.sendList(
      instance,
      phone,
      'Escolha a Data',
      'Para quando você deseja agendar?',
      'Ver Datas',
      sections,
    );
  }

  private async sendTimeSelection(
    instance: string,
    phone: string,
    barberId: string,
    date: string,
  ) {
    // Simple availability check: 9am to 7pm every 30 mins
    // In a real app, logic from AppointmentsService.getAvailableSlots would be used here
    const slots: { title: string; rowId: string }[] = [];
    for (let h = 9; h < 19; h++) {
      for (let m = 0; m < 60; m += 30) {
        const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        slots.push({ title: time, rowId: `time_${time}` });
      }
    }

    const sections = [{ title: 'Horários Disponíveis', rows: slots }];
    await this.whatsappService.sendList(
      instance,
      phone,
      'Escolha o Horário',
      `Horários para o dia ${date}:`,
      'Ver Horários',
      sections,
    );
  }

  private async sendConfirmation(instance: string, phone: string, state: any) {
    const services = await this.serviceRepo.find({
      where: { uuid: In(state.selectedServices) },
    });
    const barber = await this.barberRepo.findOne({
      where: { uuid: state.selectedBarberId },
    });
    const total = services.reduce((sum, s) => sum + s.price, 0);

    const summary =
      `*RESUMO DO AGENDAMENTO*\n\n` +
      `📌 *Serviços:* ${services.map((s) => s.name).join(', ')}\n` +
      `👤 *Profissional:* ${barber?.name}\n` +
      `📅 *Data:* ${state.selectedDate}\n` +
      `🕒 *Horário:* ${state.selectedTime}\n` +
      `💰 *Total:* R$ ${total}\n\n` +
      `Podemos confirmar?`;

    const buttons = [
      {
        buttonId: 'btn_confirm',
        buttonText: { displayText: '✅ Confirmar' },
        type: 1,
      },
      {
        buttonId: 'btn_cancel',
        buttonText: { displayText: '❌ Cancelar' },
        type: 1,
      },
    ];

    await this.whatsappService.sendButtons(
      instance,
      phone,
      'Confirmar Agendamento',
      summary,
      buttons,
    );
  }

  private async createAppointment(
    instance: string,
    phone: string,
    branch: Branch,
    state: any,
  ) {
    try {
      this.logger.log(
        `Creating appointment for ${phone} in branch ${branch.name}`,
      );

      // Find or create user
      let user = await this.userRepo.findOne({ where: { phone } });
      if (!user) {
        user = this.userRepo.create({
          name: `Cliente WhatsApp`,
          phone,
          email: `${phone}@whatsapp.temp`,
          role: UserRole.CLIENTE,
        });
        await this.userRepo.save(user);
      }

      const services = await this.serviceRepo.find({
        where: { uuid: In(state.selectedServices) },
      });
      const totalDuration = services.reduce((sum, s) => sum + s.duration, 0);
      const totalPrice = services.reduce((sum, s) => sum + s.price, 0);

      // Calculate end time
      const [h, m] = state.selectedTime.split(':').map(Number);
      const endMinutes = h * 60 + m + totalDuration;
      const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

      const appointment = this.appointmentRepo.create({
        clientId: user.uuid,
        barberId: state.selectedBarberId,
        branchId: branch.uuid,
        companyId: branch.companyId,
        serviceIds: state.selectedServices,
        date: state.selectedDate,
        startTime: state.selectedTime,
        endTime,
        status: AppointmentStatus.CONFIRMADO,
        totalPrice,
        totalDuration,
      });

      await this.appointmentRepo.save(appointment);
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
