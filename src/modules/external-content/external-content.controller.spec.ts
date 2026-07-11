import { ExternalContentController } from './external-content.controller';
import type { ExternalContentService } from './external-content.service';
import type { ResolvedExternalContent } from './external-content.types';

describe('ExternalContentController', () => {
  it('delegates to the service and returns its result', async () => {
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

    const out = await controller.resolve({
      emailBody: 'see https://evil.com/x',
      interactionId: 'test-1',
    });

    expect(out).toBe(result);
    expect(resolveExternalContent).toHaveBeenCalledWith(
      'see https://evil.com/x',
      'test-1',
      undefined,
    );
  });

  it('forwards the tenantId to the service when provided', async () => {
    const resolveExternalContent = jest.fn().mockResolvedValue([]);
    const service = {
      resolveExternalContent,
    } as unknown as ExternalContentService;
    const controller = new ExternalContentController(service);

    await controller.resolve({
      emailBody: 'see https://evil.com/x',
      interactionId: 'test-1',
      tenantId: 'b3f8a1d2-4c5e-4f6a-9b7c-8d9e0f1a2b3c',
    });

    expect(resolveExternalContent).toHaveBeenCalledWith(
      'see https://evil.com/x',
      'test-1',
      'b3f8a1d2-4c5e-4f6a-9b7c-8d9e0f1a2b3c',
    );
  });
});
