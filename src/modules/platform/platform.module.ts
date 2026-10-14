import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AllowlistModule } from '../allowlist/allowlist.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformGuard } from './platform.guard';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformTenantsService } from './platform-tenants.service';
import { PlatformMembersService } from './platform-members.service';
import { GoogleGrantRevoker } from './google-grant-revoker';

/**
 * The platform-operator console — the only module that acts across tenants.
 * Imports AuthModule for the shared JwtModule (one JWT engine for the whole app)
 * and AllowlistModule to reuse the terminal offboard path. PrismaService comes
 * from the global PrismaModule.
 */
@Module({
  imports: [AuthModule, AllowlistModule],
  controllers: [PlatformAuthController, PlatformTenantsController],
  providers: [
    PlatformAuthService,
    PlatformGuard,
    PlatformTenantsService,
    PlatformMembersService,
    GoogleGrantRevoker,
  ],
  exports: [PlatformGuard, PlatformAuthService],
})
export class PlatformModule {}
