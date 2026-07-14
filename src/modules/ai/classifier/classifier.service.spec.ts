/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access */
import { ClassifierService } from './classifier.service';
import { LlmClientPort } from './llm-client.port';
import {
  CLASSIFIER_SCHEMA,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TEMPERATURE,
} from './classifier.prompts';

describe('ClassifierService', () => {
  const llmResult = {
    reasoning: 'pre-sale question',
    isUrgent: false,
    urgencyReason: null,
    intent: 'product inquiry',
    intentConfidence: 0.92,
  };

  function makeLlm(overrides: Partial<LlmClientPort> = {}): LlmClientPort {
    return {
      generateStructured: jest.fn().mockResolvedValue(llmResult),
      wrapUntrustedContent: jest.fn(
        (content: string, source: string) =>
          `<untrusted_content source="${source}">\n${content}\n</untrusted_content>`,
      ),
      ...overrides,
    };
  }

  it('wraps the email body as untrusted email_body content BEFORE the LLM call', async () => {
    const llm = makeLlm();
    const service = new ClassifierService(llm);

    await service.classify('Need pricing for 50 seats.');

    expect(llm.wrapUntrustedContent).toHaveBeenCalledWith(
      'Need pricing for 50 seats.',
      'email_body',
    );
    const params = (llm.generateStructured as jest.Mock).mock
      .calls[0][0] as import('./llm-client.port').GenerateStructuredParams;
    expect(params.userMessage).toContain(
      '<untrusted_content source="email_body">',
    );
    expect(params.userMessage).toContain('Need pricing for 50 seats.');
  });

  it('calls generateStructured with the classifier prompt, schema, and temperature 0', async () => {
    const llm = makeLlm();
    const service = new ClassifierService(llm);

    await service.classify('hello');

    const params = (llm.generateStructured as jest.Mock).mock
      .calls[0][0] as import('./llm-client.port').GenerateStructuredParams;
    expect(params.systemPrompt).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect(params.schema).toBe(CLASSIFIER_SCHEMA);
    expect(params.temperature).toBe(CLASSIFIER_TEMPERATURE);
  });

  it('returns the validated classification', async () => {
    const service = new ClassifierService(makeLlm());
    await expect(service.classify('hello')).resolves.toEqual(llmResult);
  });

  it('throws (→ job retry) when the LLM returns an out-of-enum intent', async () => {
    const llm = makeLlm({
      generateStructured: jest
        .fn()
        .mockResolvedValue({ ...llmResult, intent: 'other' }),
    });
    const service = new ClassifierService(llm);
    await expect(service.classify('hello')).rejects.toThrow(/invalid intent/);
  });
});
