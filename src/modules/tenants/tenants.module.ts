import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { TenantCleanupService } from './tenant-cleanup.service';
import { AllowlistModule } from '../allowlist/allowlist.module';

@Module({
  imports: [AllowlistModule],
  controllers: [TenantsController],
  providers: [TenantsService, TenantCleanupService],
})
export class TenantsModule {}
