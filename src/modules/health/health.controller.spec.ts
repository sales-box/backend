import { HealthController } from './health.controller';
import type { PrismaService } from '../../database/prisma.service';

function build(dbOk: boolean, redisOk: boolean) {
  const prisma = {
    $queryRaw: () =>
      dbOk ? Promise.resolve([{ ok: 1 }]) : Promise.reject(new Error('no db')),
  } as unknown as PrismaService;
  const redis = {
    ping: () =>
      redisOk ? Promise.resolve('PONG') : Promise.reject(new Error('no redis')),
  };
  return new HealthController(prisma, redis as never);
}

describe('HealthController', () => {
  it('reports ok only when every dependency answers', async () => {
    await expect(build(true, true).check()).resolves.toEqual({
      status: 'ok',
      dependencies: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  // The whole point of the change: the old controller returned a hardcoded
  // { status: 'ok' } and would have passed all three of these while the
  // process could not serve a single request.
  it('does not claim ok when the database is unreachable', async () => {
    const result = await build(false, true).check();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.database).toEqual({
      status: 'down',
      error: 'no db',
    });
    expect(result.dependencies.redis.status).toBe('up');
  });

  it('does not claim ok when Redis is unreachable', async () => {
    const result = await build(true, false).check();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.redis).toEqual({
      status: 'down',
      error: 'no redis',
    });
    expect(result.dependencies.database.status).toBe('up');
  });

  it('reports both dependencies when neither answers', async () => {
    const result = await build(false, false).check();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.database.status).toBe('down');
    expect(result.dependencies.redis.status).toBe('down');
  });
});
