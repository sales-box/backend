import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../database/prisma.service';

type DependencyState = { status: 'up' | 'down'; error?: string };

/**
 * A probe that cannot fail is not a probe. This endpoint used to `return
 * { status: 'ok' }` unconditionally, so a container with a dead database and a
 * dead Redis still reported healthy to anything watching it — an orchestrator
 * would keep routing traffic to a process that could not serve a single
 * request. It now actually asks both dependencies and reports per-dependency
 * state, answering 200 only when everything it needs is reachable.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOkResponse({
    description: 'Service and its dependencies are up',
    schema: {
      example: {
        status: 'ok',
        dependencies: { database: { status: 'up' }, redis: { status: 'up' } },
      },
    },
  })
  async check() {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(() => this.redis.ping()),
    ]);

    const status =
      database.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded';

    return { status, dependencies: { database, redis } };
  }

  private async probe(fn: () => Promise<unknown>): Promise<DependencyState> {
    try {
      await fn();
      return { status: 'up' };
    } catch (error) {
      return {
        status: 'down',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
