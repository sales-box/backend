import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { crmAdapterProvider } from './crm-adapter.provider';
import { CRM_QUEUE } from './crm.constants';
import { CrmProcessor } from './crm.processor';
import { CrmService } from './crm.service';

@Module({
  imports: [
    // Register the crm-sync queue
    BullModule.registerQueue({ name: CRM_QUEUE }),
    // (pending/completed/failed) in Bull Board.
    BullBoardModule.forFeature({ name: CRM_QUEUE, adapter: BullMQAdapter }),
  ],
  providers: [CrmService, CrmProcessor, crmAdapterProvider],
  exports: [CrmService],
})
export class CrmModule {}
