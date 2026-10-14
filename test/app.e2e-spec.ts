import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { HealthController } from './../src/modules/health/health.controller';
import { PrismaService } from './../src/database/prisma.service';

interface HealthBody {
  status: 'ok' | 'degraded';
  dependencies: {
    database: { status: 'up' | 'down'; error?: string };
    redis: { status: 'up' | 'down'; error?: string };
  };
}

// The health endpoint now asks its dependencies instead of returning a
// hardcoded literal, so the test has to be able to make them fail. Both are
// stubbed here: the point of these cases is the reporting contract, not
// Postgres or Redis themselves.
describe('Health (e2e)', () => {
  let app: NestFastifyApplication;
  let dbOk: boolean;
  let redisOk: boolean;

  beforeEach(async () => {
    dbOk = true;
    redisOk = true;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn(() =>
              dbOk
                ? Promise.resolve([{ '?column?': 1 }])
                : Promise.reject(new Error('connection refused')),
            ),
          },
        },
        {
          provide: 'REDIS_CLIENT',
          useValue: {
            ping: jest.fn(() =>
              redisOk
                ? Promise.resolve('PONG')
                : Promise.reject(new Error('redis is down')),
            ),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/health (GET) reports ok when both dependencies answer', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body as HealthBody).toEqual({
      status: 'ok',
      dependencies: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('/health (GET) reports the database down instead of claiming ok', async () => {
    dbOk = false;
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.dependencies.database.status).toBe('down');
    expect(body.dependencies.database.error).toContain('connection refused');
    expect(body.dependencies.redis.status).toBe('up');
  });

  it('/health (GET) reports Redis down instead of claiming ok', async () => {
    redisOk = false;
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.dependencies.redis.status).toBe('down');
    expect(body.dependencies.database.status).toBe('up');
  });

  it('/health (GET) reports both down when nothing is reachable', async () => {
    dbOk = false;
    redisOk = false;
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = res.body as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.dependencies.database.status).toBe('down');
    expect(body.dependencies.redis.status).toBe('down');
  });

  afterEach(async () => {
    await app.close();
  });
});
