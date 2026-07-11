import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { crmAdapterProvider } from './crm-adapter.provider';
import { CRM_QUEUE } from './crm.constants';
import { CrmProcessor } from './crm.processor';
import { CrmService } from './crm.service';
import { CrmController } from './crm.controller';
import { CrmAdapterFactory } from './crm-adapter.factory';
import { AuthModule } from '../auth/auth.module';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: CRM_QUEUE }),
    BullBoardModule.forFeature({ name: CRM_QUEUE, adapter: BullMQAdapter }),
    AuthModule,
    forwardRef(() => ClientsModule),
  ],
  controllers: [CrmController],
  providers: [CrmService, CrmProcessor, crmAdapterProvider, CrmAdapterFactory],
  exports: [CrmService, CrmAdapterFactory],
})
export class CrmModule {}
