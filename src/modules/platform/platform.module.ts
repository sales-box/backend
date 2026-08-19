import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformGuard } from './platform.guard';

/**
 * The platform-operator console — the only module that acts across tenants.
 * Imports AuthModule solely for the shared JwtModule (one JWT engine for the
 * whole app). PrismaService comes from the global PrismaModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformGuard],
  exports: [PlatformGuard, PlatformAuthService],
})
export class PlatformModule {}
