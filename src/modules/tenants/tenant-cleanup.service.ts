import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@/database/prisma.service';

@Injectable()
export class TenantCleanupService {
  private readonly logger = new Logger(TenantCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron() {
    this.logger.log('Running daily cleanup for abandoned tenants...');

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    try {
      const result = await this.prisma.tenant.updateMany({
        where: {
          status: 'pending',
          createdAt: {
            lt: sevenDaysAgo,
          },
        },
        data: {
          status: 'abandoned',
        },
      });

      this.logger.log(`Cleanup complete. Abandoned ${result.count} tenants.`);
    } catch (error) {
      this.logger.error('Failed to run tenant cleanup job', error);
    }
  }
}
