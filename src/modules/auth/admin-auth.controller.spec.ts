import { AdminAuthController } from './admin-auth.controller';
import type { AdminAuthService } from './admin-auth.service';

describe('AdminAuthController', () => {
  it('login delegates to adminLoginWithPassword and returns the token', async () => {
    const adminLoginWithPassword = jest
      .fn()
      .mockResolvedValue({ token: 'jwt' });
    const controller = new AdminAuthController({
      adminLoginWithPassword,
    } as unknown as AdminAuthService);

    const res = await controller.login({
      email: 'admin@acme.com',
      password: 'secret-password',
    });

    expect(res).toEqual({ token: 'jwt' });
    expect(adminLoginWithPassword).toHaveBeenCalledWith(
      'admin@acme.com',
      'secret-password',
    );
  });

  it('set-password delegates to setAdminPassword with the tenant', async () => {
    const setAdminPassword = jest.fn().mockResolvedValue({ linked: true });
    const controller = new AdminAuthController({
      setAdminPassword,
    } as unknown as AdminAuthService);

    const res = await controller.setPassword({
      email: 'admin@acme.com',
      password: 'secret-password',
      tenantId: 'tenant-a',
    });

    expect(res).toEqual({ linked: true });
    expect(setAdminPassword).toHaveBeenCalledWith(
      'admin@acme.com',
      'secret-password',
      'tenant-a',
    );
  });
});
