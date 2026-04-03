import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Branch } from './database/entities/branch.entity';
import { Service } from './database/entities/service.entity';
import { ServiceCategory } from './database/entities/service-category.entity';
import { Barber } from './database/entities/barber.entity';
import { Appointment } from './database/entities/appointment.entity';
import { User } from './database/entities/user.entity';
import { Company } from './database/entities/company.entity';
import { RedisModule } from './redis/redis.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        entities: [
          Branch,
          Service,
          ServiceCategory,
          Barber,
          Appointment,
          User,
          Company,
        ],
        synchronize: false, // Never synchronize in production or shared DB
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([
      Branch,
      Service,
      ServiceCategory,
      Barber,
      Appointment,
      User,
      Company,
    ]),
    RedisModule,
    WhatsappModule,
    ApiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
