import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { ClassifierModule } from './classifier/classifier.module';

@Module({
  imports: [ClassifierModule],
  controllers: [AiController],
})
export class AiModule {}
