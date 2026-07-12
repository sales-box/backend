import { Module } from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { EmailNotifyModule } from '../email-notify/email-notify.module';
import { AllowlistController } from './allowlist.controller';
import { TenantAllowlistGuard } from './tenant-allowlist.guard';

@Module({
  imports: [EmailNotifyModule],
  providers: [AllowlistService, TenantAllowlistGuard],
  exports: [AllowlistService, TenantAllowlistGuard],
  controllers: [AllowlistController],
})
export class AllowlistModule {}
