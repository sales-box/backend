import { Controller, Get } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { AiController } from './ai.controller';
import { KnowledgeBaseController } from '../knowledge-base/knowledge-base.controller';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// A plain route with NO @Throttle note. It proves the GLOBAL 100/min still
// applies everywhere else — tightening upload/ai must not drop this to 5 or 10.
@Controller('normal')
class NormalController {
  @Get()
  ping(): string {
    return 'ok';
  }
}

describe('route rate limiting', () => {
  let app: NestFastifyApplication;
  let server: FastifyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Same global limit as production (100/min), but the default in-memory
        // storage so this test needs no Redis.
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 100 }] }),
      ],
      controllers: [AiController, KnowledgeBaseController, NormalController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        // The upload handler is never reached before the throttle blocks it, so a
        // stub service is enough to let the controller be constructed.
        { provide: KnowledgeBaseService, useValue: { ingest: jest.fn() } },
      ],
    })
      // This suite tests THROTTLING only — bypass the KB auth guard so requests
      // reach the throttle layer instead of 401-ing on a missing token.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    // So the upload handler returns a clean 400 (not a crash) when it finds no
    // multipart body — we only care that the throttle blocks the 6th request.
    await app.register(fastifyMultipart);
    await app.init();
    server = app.getHttpAdapter().getInstance();
    await server.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Fire one request at the running app and return the response. */
  const hit = (method: 'GET' | 'POST', url: string) =>
    server.inject({ method, url });

  it('upload route: 5 pass, the 6th is blocked with 429 + retry-after', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await hit('POST', '/knowledge-base/upload');
      expect(res.statusCode).not.toBe(429); // within the 5/min limit
    }
    const sixth = await hit('POST', '/knowledge-base/upload');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('AI route: 10 pass, the 11th is blocked with 429 + retry-after', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await hit('POST', '/ai/process');
      expect(res.statusCode).not.toBe(429);
    }
    const eleventh = await hit('POST', '/ai/process');
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers['retry-after']).toBeDefined();
  });

  it('normal route stays at the global 100/min (not reduced to 5 or 10)', async () => {
    for (let i = 1; i <= 11; i++) {
      const res = await hit('GET', '/normal');
      expect(res.statusCode).toBe(200);
    }
  });
});
