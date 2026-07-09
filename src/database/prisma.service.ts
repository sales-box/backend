import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginationExtension } from './pagination/pagination.extension';

/**
 * Prisma client bound to the Nest lifecycle: connects on module init and
 * disconnects on shutdown (shutdown hooks are enabled via graceful-shutdown).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  public readonly extended = this.$extends(paginationExtension);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
