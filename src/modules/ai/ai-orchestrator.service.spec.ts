import { Prisma } from '@prisma/client';
import { AiOrchestratorService } from './ai-orchestrator.service';

function makeDeps() {
  return {
    prisma: {
      generalAnalysis: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({
              ...BASE_CLASSIFICATION,
              ...data,
            }),
          ),
      },
      connectedAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'acc-uuid-1' }),
      },
    },
    gmailProvider: {
      fetchMessage: jest.fn(),
      getSalesboxLabelIds: jest.fn().mockResolvedValue(['Label_salesbox_123']),
    },
    classifierService: { classify: jest.fn() },
    clientsService: {
      captureInboundEmail: jest.fn().mockResolvedValue({}),
      getClientContext: jest.fn(),
    },
    replyService: {
      draftReply: jest.fn(),
      resumeWithFeedback: jest.fn(),
    },
    supervisorService: { supervise: jest.fn() },
    crmActionsAgent: {
      suggestActions: jest.fn(),
      resumeWithDecision: jest.fn(),
    },
  };
}

function makeOrchestrator(deps: ReturnType<typeof makeDeps>) {
  return new AiOrchestratorService(
    deps.prisma as never,
    deps.gmailProvider as never,
    deps.classifierService as never,
    deps.clientsService as never,
    deps.replyService as never,
    deps.supervisorService as never,
    deps.crmActionsAgent as never,
  );
}

const BASE_PARSED_MESSAGE = {
  id: 'msg1',
  from: 'client@acme.com',
  textPlain: 'I need a product',
  textHtml: '',
  attachments: [],
  labelIds: ['Label_salesbox_123'],
};

const BASE_CLASSIFICATION = {
  messageId: 'msg1',
  intent: 'product inquiry',
  intentConfidence: 0.9,
  isUrgent: false,
};

const BASE_CLIENT_CONTEXT = {
  isNewClient: false,
  clientId: 'client-1',
  status: 'active',
  name: 'Client',
  company: 'Acme',
  historyCount: 3,
  history: [
    {
      date: '2026-08-01T00:00:00.000Z',
      type: 'inbound',
      subject: 'Prior subject',
      summary: 'Prior summary',
      classification: 'product inquiry',
      recommendation: 'Send pricing',
    },
  ],
};

const BASE_FINAL_STATE = {
  extractorResult: {
    featuresInferred: false,
    constraintsInferred: false,
    scaleInferred: false,
    budgetInferred: false,
    timelineInferred: false,
  },
  composerResult: {
    draftText: 'Here is a great product for you.',
    claims: [{ status: 'verified' }],
  },
};

const BASE_DRAFT_RESULT = {
  graphThreadId: 'thread1:msg1',
  state: BASE_FINAL_STATE,
};

describe('AiOrchestratorService', () => {
  describe('happy path — all agents succeed', () => {
    it('returns classification, requirements, draft, and confidence', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'auto_worthy',
        draftAvailable: true,
        hallucinationDetected: false,
        flaggedClaimsCount: 0,
        productConfidence: 0.85,
        clientHistoryConfidence: 0.6,
        knowledgeGapSuggestion: null,
      });

      const result = await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(result.classification).toEqual(
        expect.objectContaining(BASE_CLASSIFICATION),
      );
      expect(result.requirements).toEqual(BASE_FINAL_STATE.extractorResult);
      expect(result.draft).toEqual(BASE_FINAL_STATE.composerResult);
      expect(result.confidence.label).toBe('auto_worthy');
      expect(deps.clientsService.captureInboundEmail).toHaveBeenCalledTimes(2);
      expect(deps.clientsService.getClientContext).toHaveBeenCalledWith(
        'tenant1',
        'client@acme.com',
        'msg1',
      );
      expect(deps.replyService.draftReply).toHaveBeenCalledWith(
        'msg1',
        undefined,
        'tenant1',
        'acc-uuid-1',
        'I need a product',
        'se@tenant.com',
        { id: 'msg1', attachments: [] },
        'product inquiry',
        { clientHistory: BASE_CLIENT_CONTEXT.history },
      );
    });

    it('uses cached GeneralAnalysis row and does NOT call classify()', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'auto_worthy',
        draftAvailable: true,
      });

      await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(deps.classifierService.classify).not.toHaveBeenCalled();
    });
  });

  describe('classifier fallback — GeneralAnalysis not yet in DB', () => {
    it('calls classify() and persists the result when cache misses', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(null); // cache miss
      deps.classifierService.classify.mockResolvedValue({
        intent: 'product inquiry',
        intentConfidence: 0.8,
        isUrgent: false,
        urgencyReason: null,
        reasoning: 'looks like a buying signal',
      });
      deps.prisma.generalAnalysis.create.mockResolvedValue(BASE_CLASSIFICATION);
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'auto_worthy',
        draftAvailable: true,
      });

      await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(deps.classifierService.classify).toHaveBeenCalledTimes(1);
      expect(deps.prisma.generalAnalysis.create).toHaveBeenCalledTimes(1);
    });

    it('handles P2002 race — re-reads the row the background processor wrote', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique
        .mockResolvedValueOnce(null) // first call: cache miss
        .mockResolvedValueOnce(BASE_CLASSIFICATION); // second call: race winner's row
      deps.classifierService.classify.mockResolvedValue({
        intent: 'product inquiry',
        intentConfidence: 0.8,
        isUrgent: false,
        urgencyReason: null,
        reasoning: '',
      });

      // Simulate P2002 (unique constraint violation)
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint',
        { code: 'P2002', clientVersion: '5.0.0', meta: {} },
      );
      deps.prisma.generalAnalysis.create.mockRejectedValue(p2002);

      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'auto_worthy',
        draftAvailable: true,
      });

      // Should NOT throw — should use the row from the second findUnique call.
      const result = await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(result.classification).toEqual(
        expect.objectContaining(BASE_CLASSIFICATION),
      );
    });
  });

  describe('pipeline failure isolation (§6)', () => {
    it('flags the failure honestly instead of faking a hallucinated claim', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockRejectedValue(new Error('Groq timeout'));
      // Real supervisor precedence: pipelineFailed → handle_manually, and it is
      // reported as its own reason. The orchestrator used to force this route by
      // inventing a `hallucinated` claim, which the panel now renders verbatim
      // as "a claim contradicts the knowledge base" — on an email with no draft.
      deps.supervisorService.supervise.mockImplementation(
        (input: {
          pipelineFailed?: boolean;
          composerOutput: { claims: Array<{ status: string }> };
        }) => ({
          label: input.pipelineFailed ? 'handle_manually' : 'auto_worthy',
          labelReason: input.pipelineFailed ? 'pipeline_error' : 'confidence',
          draftAvailable: false,
          hallucinationDetected: false,
          flaggedClaimsCount: 0,
          productConfidence: 0.0,
          clientHistoryConfidence: 0.6,
          knowledgeGapSuggestion: null,
        }),
      );

      const result = await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(result.confidence.label).toBe('handle_manually');
      expect(result.confidence.labelReason).toBe('pipeline_error');
      // No fabricated claim reached the Supervisor.
      expect(deps.supervisorService.supervise).toHaveBeenCalledWith(
        expect.objectContaining({
          pipelineFailed: true,
          composerOutput: { draftText: '', claims: [] },
        }),
      );
      expect(result.draft).toBeNull();
      expect(result.requirements).toBeNull();
      expect(deps.clientsService.captureInboundEmail).toHaveBeenLastCalledWith(
        'tenant1',
        expect.objectContaining({
          messageId: 'msg1',
          classification: 'product inquiry',
        }),
      );
    });

    it('does not rethrow — processEmail resolves even when draftReply rejects', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockRejectedValue(new Error('LLM down'));
      deps.supervisorService.supervise.mockReturnValue({
        label: 'handle_manually',
        draftAvailable: false,
      });

      await expect(
        makeOrchestrator(deps).processEmail('msg1', 'se@tenant.com', 'tenant1'),
      ).resolves.not.toThrow();
    });

    it('gracefully degrades when getOrRunClassification throws', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockRejectedValue(
        new Error('DB connection failed'),
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'handle_manually',
        draftAvailable: false,
      });

      const result = await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(result.classification).toEqual(
        expect.objectContaining({
          id: '',
          intent: 'support',
          intentConfidence: 0.0,
          isUrgent: false,
        }),
      );
      expect(deps.prisma.generalAnalysis.update).not.toHaveBeenCalled();
      expect(deps.clientsService.captureInboundEmail).toHaveBeenLastCalledWith(
        'tenant1',
        expect.objectContaining({
          aiSummary: null,
          classification: null,
        }),
      );
    });
  });

  describe('extractSenderEmail (via processEmail integration)', () => {
    it('strips display name from "Name <email@domain.com>" format', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue({
        ...BASE_PARSED_MESSAGE,
        from: 'John Doe <john@acme.com>',
      });
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'auto_worthy',
        draftAvailable: true,
      });

      await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(deps.clientsService.getClientContext).toHaveBeenCalledWith(
        'tenant1',
        'john@acme.com',
        'msg1',
      );
      expect(deps.clientsService.captureInboundEmail).toHaveBeenNthCalledWith(
        1,
        'tenant1',
        expect.objectContaining({
          senderEmail: 'john@acme.com',
          senderName: 'John Doe',
        }),
      );
    });
  });

  describe('Supervisor — draft gate', () => {
    it('returns null draft when draftAvailable is false (hallucination veto)', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockResolvedValue(BASE_DRAFT_RESULT);
      deps.supervisorService.supervise.mockReturnValue({
        label: 'handle_manually',
        draftAvailable: false, // veto active
        hallucinationDetected: true,
        flaggedClaimsCount: 1,
        productConfidence: 0.4,
        clientHistoryConfidence: 0.6,
        knowledgeGapSuggestion: null,
      });

      const result = await makeOrchestrator(deps).processEmail(
        'msg1',
        'se@tenant.com',
        'tenant1',
      );

      expect(result.draft).toBeNull();
    });
  });
});
