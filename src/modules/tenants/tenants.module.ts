import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { TenantCleanupService } from './tenant-cleanup.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService, TenantCleanupService],
})
export class TenantsModule {}
