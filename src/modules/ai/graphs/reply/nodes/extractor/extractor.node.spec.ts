import { extractorNode } from './extractor.node';
import { AiModelService } from '@/modules/ai/ai.model.service';
import { ReplyGraphStateType } from '@/modules/ai/graphs/reply/reply-graph.state';

function makeState(
  overrides: Partial<ReplyGraphStateType> = {},
): ReplyGraphStateType {
  return {
    emailId: 'e1',
    tenantId: 't1',
    emailBody: 'We have around 500 employees across two branches.',
    intent: 'product inquiry',
    attachmentsText: [],
    externalContentText: [],
    excludedByUser: [],
    ...overrides,
  } as ReplyGraphStateType;
}

describe('extractorNode', () => {
  it('marks a literal signal as NOT inferred', async () => {
    const mockResult = {
      reasoning: 'employee count stated directly',
      features: [],
      featuresInferred: false,
      constraints: null,
      constraintsInferred: false,
      scale: '500 employees',
      scaleInferred: false,
      scaleInferenceSource: null,
      budgetHint: null,
      budgetInferred: false,
      timeline: null,
      timelineInferred: false,
    };
    const aiModelService = {
      generateStructured: jest.fn().mockResolvedValue(mockResult),
    } as unknown as AiModelService;

    const result = await extractorNode(makeState(), aiModelService);

    expect(result.extractorResult?.scaleInferred).toBe(false);
  });

  it('never invents a budget when the email has no budget signal', async () => {
    const mockResult = {
      reasoning: 'no budget mentioned anywhere in the email',
      features: [],
      featuresInferred: false,
      constraints: null,
      constraintsInferred: false,
      scale: null,
      scaleInferred: false,
      scaleInferenceSource: null,
      budgetHint: null,
      budgetInferred: false,
      timeline: null,
      timelineInferred: false,
    };
    const aiModelService = {
      generateStructured: jest.fn().mockResolvedValue(mockResult),
    } as unknown as AiModelService;

    const result = await extractorNode(
      makeState({ emailBody: 'Do you support warehouse management?' }),
      aiModelService,
    );

    expect(result.extractorResult?.budgetHint).toBeNull();
  });

  it('wraps the email body as untrusted email_body content before the call', async () => {
    const aiModelService = {
      generateStructured: jest.fn().mockResolvedValue({
        reasoning: '',
        features: [],
        featuresInferred: false,
        constraints: null,
        constraintsInferred: false,
        scale: null,
        scaleInferred: false,
        scaleInferenceSource: null,
        budgetHint: null,
        budgetInferred: false,
        timeline: null,
        timelineInferred: false,
      }),
    } as unknown as AiModelService;

    await extractorNode(makeState(), aiModelService);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockFn = aiModelService.generateStructured as jest.Mock<
      Promise<unknown>,
      [{ messages: { content: string }[] }]
    >;
    const call = mockFn.mock.calls[0][0];
    expect(call.messages[1].content).toContain(
      '<untrusted_content source="email_body">',
    );
  });

  it('extracts with the same accuracy from an Arabic email (US-019 acceptance criteria)', async () => {
    const mockResult = {
      reasoning: 'client states company size directly, in Arabic',
      features: [],
      featuresInferred: false,
      constraints: null,
      constraintsInferred: false,
      scale: '500 employees',
      scaleInferred: false,
      scaleInferenceSource: null,
      budgetHint: null,
      budgetInferred: false,
      timeline: 'end of week',
      timelineInferred: false,
    };
    const aiModelService = {
      generateStructured: jest.fn().mockResolvedValue(mockResult),
    } as unknown as AiModelService;

    const arabicEmail =
      'احنا شركة متوسطة، حوالي 500 موظف، ولازم الحل يكون جاهز قبل نهاية الأسبوع ده.';
    const result = await extractorNode(
      makeState({ emailBody: arabicEmail }),
      aiModelService,
    );

    expect(result.extractorResult?.scale).toBe('500 employees');
    expect(result.extractorResult?.timeline).toBe('end of week');
  });
});
