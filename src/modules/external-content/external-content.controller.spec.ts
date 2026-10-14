import { ExternalContentController } from './external-content.controller';
import type { ExternalContentService } from './external-content.service';
import type { ResolvedExternalContent } from './external-content.types';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

const reqFor = (tenantId: string | null): AuthenticatedRequest =>
  ({
    user: { sub: 'acc-1', tenantId, isAdmin: true, email: 'admin@acme.com' },
  }) as unknown as AuthenticatedRequest;

describe('ExternalContentController', () => {
  it('resolves using the tenantId from the JWT claim, not the body', async () => {
    const result: ResolvedExternalContent[] = [
      {
        sourceType: 'unknown_link',
        originalRef: 'https://evil.com/x',
        domain: 'evil.com',
        fetched: false,
        summary: undefined,
        skipped: true,
        reason: 'unrecognized_domain',
      },
    ];
    const resolveExternalContent = jest.fn().mockResolvedValue(result);
    const service = {
      resolveExternalContent,
    } as unknown as ExternalContentService;
    const controller = new ExternalContentController(service);

    const out = await controller.resolve(
      { emailBody: 'see https://evil.com/x', interactionId: 'test-1' },
      reqFor('tenant-a'),
    );

    expect(out).toBe(result);
    expect(resolveExternalContent).toHaveBeenCalledWith(
      'see https://evil.com/x',
      'test-1',
      'tenant-a',
    );
  });

  it('passes undefined for a legacy admin token with no tenant', async () => {
    const resolveExternalContent = jest.fn().mockResolvedValue([]);
    const service = {
      resolveExternalContent,
    } as unknown as ExternalContentService;
    const controller = new ExternalContentController(service);

    await controller.resolve(
      { emailBody: 'x', interactionId: 't' },
      reqFor(null),
    );

    expect(resolveExternalContent).toHaveBeenCalledWith('x', 't', undefined);
  });
});
