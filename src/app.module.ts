import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { RedisModule } from './redis/redis.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    RedisModule,
    WhatsappModule,
    ApiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
