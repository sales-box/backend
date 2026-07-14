import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { hash } from '@node-rs/argon2';
import request from 'supertest';
import { AdminAuthController } from './../src/modules/auth/admin-auth.controller';
import { AdminAuthService } from './../src/modules/auth/admin-auth.service';
import { JwtAuthGuard } from './../src/modules/auth/jwt-auth.guard';
import type { AuthenticatedRequest } from './../src/modules/auth/jwt-auth.guard';
import { PrismaService } from './../src/database/prisma.service';

const JWT_SECRET = 'e2e-admin-jwt-secret-0123456789abcdef';

// A guarded probe route that echoes the tenant read off the JWT.
@Controller('protected')
class ProbeController {
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: AuthenticatedRequest): { tenantId: string | null } {
    return { tenantId: req.user.tenantId };
  }
}

describe('Admin Auth (e2e)', () => {
  let app: NestFastifyApplication;
  const count = jest.fn();
  const findFirst = jest.fn();
  const update = jest.fn();
  const tenantFindUnique = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      controllers: [AdminAuthController, ProbeController],
      providers: [
        AdminAuthService,
        JwtAuthGuard,
        {
          provide: PrismaService,
          useValue: {
            connectedAccount: { count, findFirst, update },
            tenant: { findUnique: tenantFindUnique },
          },
        },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => JWT_SECRET },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('logs in with a correct password and returns a working JWT', async () => {
    const passwordHash = await hash('correct-horse');
    // count returns 1 → single match, no ambiguity
    count.mockResolvedValue(1);
    findFirst.mockResolvedValue({
      id: 'acc-1',
      email: 'admin@acme.com',
      tenantId: 'tenant-a',
      isAdmin: true,
      passwordHash,
    });

    const login = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: 'admin@acme.com', password: 'correct-horse' })
      .expect(200);

    const token = (login.body as { token: string }).token;
    expect(typeof token).toBe('string');

    // The token unlocks a guarded route and carries the tenant claim.
    const me = await request(app.getHttpServer())
      .get('/protected/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body).toEqual({ tenantId: 'tenant-a' });
  });

  it('rejects a wrong password with 401 (generic)', async () => {
    const passwordHash = await hash('correct-horse');
    // count returns 1 → single match, no ambiguity
    count.mockResolvedValue(1);
    findFirst.mockResolvedValue({
      id: 'acc-1',
      email: 'admin@acme.com',
      tenantId: 'tenant-a',
      isAdmin: true,
      passwordHash,
    });

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: 'admin@acme.com', password: 'nope' })
      .expect(401);
  });

  it('guards a protected route: no token → 401', async () => {
    await request(app.getHttpServer()).get('/protected/me').expect(401);
  });

  it('guards a protected route: garbage token → 401', async () => {
    await request(app.getHttpServer())
      .get('/protected/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
  });

  it('set-password links the hash onto the existing Google account', async () => {
    tenantFindUnique.mockResolvedValue({ id: 'tenant-a', status: 'active' });
    findFirst
      .mockResolvedValueOnce({ id: 'acc-1', passwordHash: null }) // by email
      .mockResolvedValueOnce(null); // no other admin
    update.mockResolvedValue({ id: 'acc-1' });

    const res = await request(app.getHttpServer())
      .post('/auth/admin/set-password')
      .send({
        email: 'admin@acme.com',
        password: 'a-strong-password',
        tenantId: 'tenant-a',
      })
      .expect(201);

    expect(res.body).toEqual({ linked: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
