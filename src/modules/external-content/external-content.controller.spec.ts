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
    );
  });
});
