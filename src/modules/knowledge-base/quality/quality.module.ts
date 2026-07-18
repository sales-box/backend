import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullBoardModule } from '@bull-board/nestjs';
import { QUALITY_QUEUE } from './quality.constants';
import { QualityProcessor } from './quality.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUALITY_QUEUE }),
    BullBoardModule.forFeature({ name: QUALITY_QUEUE, adapter: BullMQAdapter }),
  ],
  providers: [QualityProcessor],
})
export class QualityModule {}
