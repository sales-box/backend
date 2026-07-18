import { Prisma } from '@prisma/client';
import { AiOrchestratorService } from './ai-orchestrator.service';

function makeDeps() {
  return {
    prisma: { generalAnalysis: { findUnique: jest.fn(), create: jest.fn() } },
    gmailProvider: { fetchMessage: jest.fn() },
    classifierService: { classify: jest.fn() },
    clientsService: { getClientContext: jest.fn() },
    replyService: { draftReply: jest.fn() },
    supervisorService: { supervise: jest.fn() },
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
  );
}

const BASE_PARSED_MESSAGE = {
  id: 'msg1',
  from: 'client@acme.com',
  textPlain: 'I need a product',
  textHtml: '',
  attachments: [],
};

const BASE_CLASSIFICATION = {
  messageId: 'msg1',
  intent: 'product inquiry',
  intentConfidence: 0.9,
  isUrgent: false,
};

const BASE_CLIENT_CONTEXT = {
  isNewClient: false,
  history: [1, 2, 3],
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
      deps.replyService.draftReply.mockResolvedValue(BASE_FINAL_STATE);
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

      expect(result.classification).toEqual(BASE_CLASSIFICATION);
      expect(result.requirements).toEqual(BASE_FINAL_STATE.extractorResult);
      expect(result.draft).toEqual(BASE_FINAL_STATE.composerResult);
      expect(result.confidence.label).toBe('auto_worthy');
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
      deps.replyService.draftReply.mockResolvedValue(BASE_FINAL_STATE);
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
      deps.replyService.draftReply.mockResolvedValue(BASE_FINAL_STATE);
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
      deps.replyService.draftReply.mockResolvedValue(BASE_FINAL_STATE);
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

      expect(result.classification).toEqual(BASE_CLASSIFICATION);
    });
  });

  describe('pipeline failure isolation (§6)', () => {
    it('routes to handle_manually via the hallucination-veto when draftReply throws', async () => {
      const deps = makeDeps();
      deps.gmailProvider.fetchMessage.mockResolvedValue(BASE_PARSED_MESSAGE);
      deps.prisma.generalAnalysis.findUnique.mockResolvedValue(
        BASE_CLASSIFICATION,
      );
      deps.clientsService.getClientContext.mockResolvedValue(
        BASE_CLIENT_CONTEXT,
      );
      deps.replyService.draftReply.mockRejectedValue(new Error('Groq timeout'));
      // Real supervisor veto logic: any 'hallucinated' claim → handle_manually.
      deps.supervisorService.supervise.mockImplementation(
        (input: { composerOutput: { claims: Array<{ status: string }> } }) => ({
          label: input.composerOutput.claims.some(
            (c) => c.status === 'hallucinated',
          )
            ? 'handle_manually'
            : 'auto_worthy',
          draftAvailable: false,
          hallucinationDetected: true,
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
      expect(result.draft).toBeNull();
      expect(result.requirements).toBeNull();
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
      deps.replyService.draftReply.mockResolvedValue(BASE_FINAL_STATE);
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
      deps.replyService.draftReply.mockResolvedValue(BASE_FINAL_STATE);
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
