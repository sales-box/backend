import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCreatedResponse } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { DEMO_QUEUE } from './queue.constants';

@ApiTags('queue')
@Controller('queue/demo')
export class DemoController {
  constructor(@InjectQueue(DEMO_QUEUE) private readonly queue: Queue) {}

  // Enqueue a demo job — used to exercise the worker and Bull Board dashboard.
  @Post('enqueue')
  @ApiOperation({
    summary: 'Enqueue a demo job (dev tool for the queue dashboard)',
  })
  @ApiCreatedResponse({ description: 'Job enqueued; returns its id.' })
  async enqueue(): Promise<{ jobId: string | undefined }> {
    const job = await this.queue.add('demo-job', { at: Date.now() });
    return { jobId: job.id };
  }
}
