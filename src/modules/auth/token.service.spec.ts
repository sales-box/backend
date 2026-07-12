import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const SECRET = 'test-jwt-secret-32-characters-long';
  const config = {
    getOrThrow: (key: string) => {
      if (key === 'JWT_SECRET') return SECRET;
      throw new Error(`missing ${key}`);
    },
  } as unknown as ConfigService;

  const service = new TokenService(config);

  it('issues a JWT that verifies with the secret and carries the SE claims', () => {
    const token = service.issueSeToken({ email: 'se@acme.com' });

    const payload = jwt.verify(token, SECRET) as {
      email: string;
      role: string;
    };
    expect(payload.email).toBe('se@acme.com');
    expect(payload.role).toBe('se');
  });

  it('produces a token that fails verification under a different secret', () => {
    const token = service.issueSeToken({ email: 'se@acme.com' });
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });
});
