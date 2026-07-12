import { forwardRef, Module } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { EmailNotifyModule } from '../email-notify/email-notify.module';
import { AllowlistController } from './allowlist.controller';
import { TenantAllowlistGuard } from './tenant-allowlist.guard';
import { AuthModule } from '../auth/auth.module';

@Module({
  // forwardRef: AuthModule imports AllowlistModule (for AllowlistService), and
  // AllowlistModule imports AuthModule back (for JwtAuthGuard on its controller).
  imports: [EmailNotifyModule, forwardRef(() => AuthModule)],
  providers: [AllowlistService, TenantAllowlistGuard],
  exports: [AllowlistService, TenantAllowlistGuard],
  controllers: [AllowlistController],
})
export class AllowlistModule {}
