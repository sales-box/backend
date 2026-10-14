import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule provides JwtAuthGuard (admin JWT → tenant identity).
  imports: [PrismaModule, AuthModule],
  providers: [AnalyticsService],
  controllers: [AnalyticsController],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
