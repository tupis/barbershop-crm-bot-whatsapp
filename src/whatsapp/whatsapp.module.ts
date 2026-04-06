import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { BookingService } from '../booking/booking.service';
// import { Branch } from '../database/entities/branch.entity';
// import { Service } from '../database/entities/service.entity';
import { ServiceCategory } from '../database/entities/service-category.entity';
import { Barber } from '../database/entities/barber.entity';
import { Appointment } from '../database/entities/appointment.entity';
import { User } from '../database/entities/user.entity';

import { Company } from '../database/entities/company.entity';
import { WhatsappApiController } from './whatsapp-api.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Branch,
      // Service,
      // ServiceCategory,
      // Barber,
      // Appointment,
      // User,
      // Company,
    ]),
  ],
  providers: [WhatsappService, BookingService],
  controllers: [WhatsappController, WhatsappApiController],
  exports: [WhatsappService],
})
export class WhatsappModule {}
