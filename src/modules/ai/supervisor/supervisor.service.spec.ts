import { SupervisorService } from './supervisor.service';
import { SupervisorInput } from './supervisor.types';

// Helper: returns a "golden path" input (everything confident, no hallucination).
// Each test overrides only the field(s) relevant to the scenario being tested.
function makeInput(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    classifierOutput: {
      intent: 'product inquiry',
      intentConfidence: 0.9,
      isUrgent: false,
    },
    extractorOutput: {
      featuresInferred: false,
      constraintsInferred: false,
      scaleInferred: false,
      budgetInferred: false,
      timelineInferred: false,
    },
    matcherOutput: { matchConfidence: 0.9 },
    composerOutput: {
      draftText: 'Sample reply',
      claims: [{ status: 'verified' }],
    },
    clientHistoryLength: 5,
    isNewClient: false,
    ...overrides,
  };
}

describe('SupervisorService', () => {
  // No NestJS test module needed — zero external dependencies in the constructor
  const service = new SupervisorService();

  it('routes a high-confidence, no-hallucination case to auto_worthy', () => {
    const result = service.supervise(makeInput());
    expect(result.label).toBe('auto_worthy');
    expect(result.hallucinationDetected).toBe(false);
    expect(result.draftAvailable).toBe(true);
  });

  it('ALWAYS forces handle_manually when a claim is hallucinated, regardless of confidence', () => {
    const result = service.supervise(
      makeInput({
        composerOutput: {
          draftText: 'Sample reply',
          claims: [{ status: 'hallucinated' }],
        },
      }),
    );
    expect(result.label).toBe('handle_manually');
    expect(result.draftAvailable).toBe(false);
    expect(result.hallucinationDetected).toBe(true);
  });

  it('gives a new client a conservative baseline history confidence, not zero', () => {
    const result = service.supervise(
      makeInput({ isNewClient: true, clientHistoryLength: 0 }),
    );
    expect(result.clientHistoryConfidence).toBe(0.4);
  });

  it('counts flagged claims without letting them override the label alone', () => {
    const result = service.supervise(
      makeInput({
        composerOutput: {
          draftText: 'Sample reply',
          claims: [{ status: 'flagged' }, { status: 'verified' }],
        },
      }),
    );
    expect(result.flaggedClaimsCount).toBe(1);
    expect(result.label).toBe('auto_worthy'); // flagged alone doesn't force a downgrade
  });

  it('returns needs_review when productConfidence is between 0.6 and 0.85', () => {
    // Low classifier confidence + low matcher confidence => low productConfidence
    const result = service.supervise(
      makeInput({
        classifierOutput: {
          intent: 'product inquiry',
          intentConfidence: 0.5,
          isUrgent: false,
        },
        matcherOutput: { matchConfidence: 0.6 },
      }),
    );
    // productConfidence = 0.5*0.3 + 1.0*0.3 + 0.6*0.4 = 0.15 + 0.30 + 0.24 = 0.69
    expect(result.label).toBe('needs_review');
  });

  it('returns handle_manually when productConfidence is below 0.6', () => {
    const result = service.supervise(
      makeInput({
        classifierOutput: {
          intent: 'product inquiry',
          intentConfidence: 0.2,
          isUrgent: false,
        },
        matcherOutput: { matchConfidence: 0.2 },
        extractorOutput: {
          featuresInferred: true,
          constraintsInferred: true,
          scaleInferred: true,
          budgetInferred: true,
          timelineInferred: true,
        },
      }),
    );
    // productConfidence = 0.2*0.3 + 0.75*0.3 + 0.2*0.4 = 0.06 + 0.225 + 0.08 = 0.365 (all inferred: 1-5*0.05=0.75)
    expect(result.label).toBe('handle_manually');
  });

  it('suggests a knowledge gap when matchConfidence < 0.3', () => {
    const result = service.supervise(
      makeInput({ matcherOutput: { matchConfidence: 0.2 } }),
    );
    expect(result.knowledgeGapSuggestion).not.toBeNull();
    expect(result.knowledgeGapSuggestion).toContain('KB coverage');
  });

  it('returns null knowledgeGapSuggestion when matchConfidence >= 0.3', () => {
    const result = service.supervise(makeInput());
    expect(result.knowledgeGapSuggestion).toBeNull();
  });

  it('caps clientHistoryConfidence at 1.0 even with many interactions', () => {
    const result = service.supervise(
      makeInput({ isNewClient: false, clientHistoryLength: 100 }),
    );
    expect(result.clientHistoryConfidence).toBe(1);
  });

  // ── Intent and urgency routing ──────────────────────────────────────────
  // Confidence answers "can we answer this accurately?", not "is it safe to
  // answer at all?" — so intent is consulted before the numeric thresholds.

  describe('sensitive intent', () => {
    const sensitive = {
      intent: 'sensitive',
      intentConfidence: 0.97,
      isUrgent: false,
    };

    it('routes to handle_manually even at maximum confidence', () => {
      const result = service.supervise(
        makeInput({
          classifierOutput: sensitive,
          matcherOutput: { matchConfidence: 1 },
        }),
      );
      expect(result.label).toBe('handle_manually');
      expect(result.labelReason).toBe('sensitive_intent');
    });

    it('still exposes the real confidence score rather than degrading it', () => {
      const result = service.supervise(
        makeInput({
          classifierOutput: sensitive,
          matcherOutput: { matchConfidence: 1 },
        }),
      );
      // The score is displayed in the panel and persisted to analytics; the
      // label must change without the number being falsified.
      expect(result.productConfidence).toBeGreaterThanOrEqual(0.8);
    });

    it('keeps the draft available so the SE can edit rather than start blank', () => {
      const result = service.supervise(
        makeInput({ classifierOutput: sensitive }),
      );
      expect(result.draftAvailable).toBe(true);
    });

    it('is outranked by the hallucination veto', () => {
      const result = service.supervise(
        makeInput({
          classifierOutput: sensitive,
          composerOutput: {
            draftText: 'x',
            claims: [{ status: 'hallucinated' }],
          },
        }),
      );
      expect(result.label).toBe('handle_manually');
      expect(result.labelReason).toBe('hallucination');
      expect(result.draftAvailable).toBe(false);
    });
  });

  describe('urgency', () => {
    it('caps an otherwise auto_worthy thread at needs_review', () => {
      const result = service.supervise(
        makeInput({
          classifierOutput: {
            intent: 'demo request',
            intentConfidence: 0.9,
            isUrgent: true,
          },
        }),
      );
      expect(result.label).toBe('needs_review');
      expect(result.labelReason).toBe('urgent');
    });

    it('never lifts a low-confidence thread out of handle_manually', () => {
      const result = service.supervise(
        makeInput({
          classifierOutput: {
            intent: 'support',
            intentConfidence: 0.2,
            isUrgent: true,
          },
          matcherOutput: { matchConfidence: 0 },
        }),
      );
      expect(result.label).toBe('handle_manually');
      expect(result.labelReason).toBe('confidence');
    });

    it('leaves a needs_review thread where it is', () => {
      const result = service.supervise(
        makeInput({
          classifierOutput: {
            intent: 'support',
            intentConfidence: 0.7,
            isUrgent: true,
          },
          matcherOutput: { matchConfidence: 0.6 },
        }),
      );
      expect(result.label).toBe('needs_review');
    });
  });

  // ── Client history routing ──────────────────────────────────────────────
  // The panel used to re-derive this client-side with a 60/60 OR-gate that
  // disagreed with the backend. The policy lives here now, in one place.

  describe('thin client history', () => {
    it('caps an unknown sender at needs_review even with a perfect draft', () => {
      const result = service.supervise(
        makeInput({
          isNewClient: true,
          clientHistoryLength: 0,
          matcherOutput: { matchConfidence: 1 },
        }),
      );
      expect(result.label).toBe('needs_review');
      expect(result.labelReason).toBe('thin_history');
    });

    it('never pushes a thin relationship down to handle_manually', () => {
      // Unknown is not dangerous. The draft is as good as productConfidence
      // says; we just don't sign the SE's name to it automatically.
      const result = service.supervise(
        makeInput({ isNewClient: true, clientHistoryLength: 0 }),
      );
      expect(result.label).not.toBe('handle_manually');
      expect(result.draftAvailable).toBe(true);
    });

    it('still caps at 2 logged interactions', () => {
      // max(min(1, 2/5), 0.4) = 0.4 — below the 0.6 review threshold
      const result = service.supervise(
        makeInput({ isNewClient: false, clientHistoryLength: 2 }),
      );
      expect(result.label).toBe('needs_review');
      expect(result.labelReason).toBe('thin_history');
    });

    it('clears the cap at 3 logged interactions', () => {
      // max(min(1, 3/5), 0.4) = 0.6 — exactly at the threshold, so allowed
      const result = service.supervise(
        makeInput({ isNewClient: false, clientHistoryLength: 3 }),
      );
      expect(result.label).toBe('auto_worthy');
      expect(result.labelReason).toBe('confidence');
    });

    it('is outranked by urgency, which is the more actionable reason', () => {
      const result = service.supervise(
        makeInput({
          isNewClient: true,
          clientHistoryLength: 0,
          classifierOutput: {
            intent: 'demo request',
            intentConfidence: 0.9,
            isUrgent: true,
          },
        }),
      );
      expect(result.label).toBe('needs_review');
      expect(result.labelReason).toBe('urgent');
    });

    it('does not lift a low-confidence thread out of handle_manually', () => {
      // A cap only ever lowers. Thin history must not become a promotion.
      const result = service.supervise(
        makeInput({
          isNewClient: true,
          clientHistoryLength: 0,
          classifierOutput: {
            intent: 'support',
            intentConfidence: 0.2,
            isUrgent: false,
          },
          matcherOutput: { matchConfidence: 0 },
        }),
      );
      expect(result.label).toBe('handle_manually');
      expect(result.labelReason).toBe('confidence');
    });
  });

  describe('pipeline failure', () => {
    // The draft graph threw. Previously the orchestrator faked a hallucinated
    // claim to force this route, which made the panel tell the SE that a claim
    // contradicted the KB on an email that had no draft at all.
    const failed = {
      pipelineFailed: true,
      composerOutput: { draftText: '', claims: [] },
    };

    it('routes to handle_manually with its own reason, not hallucination', () => {
      const result = service.supervise(makeInput(failed));
      expect(result.label).toBe('handle_manually');
      expect(result.labelReason).toBe('pipeline_error');
    });

    it('does not claim a hallucination was detected', () => {
      const result = service.supervise(makeInput(failed));
      expect(result.hallucinationDetected).toBe(false);
      expect(result.draftAvailable).toBe(false);
    });

    it('outranks every other reason, including a sensitive intent', () => {
      const result = service.supervise(
        makeInput({
          ...failed,
          classifierOutput: {
            intent: 'sensitive',
            intentConfidence: 0.97,
            isUrgent: true,
          },
        }),
      );
      expect(result.labelReason).toBe('pipeline_error');
    });

    it('leaves a successful run untouched', () => {
      const result = service.supervise(makeInput({ pipelineFailed: false }));
      expect(result.label).toBe('auto_worthy');
      expect(result.draftAvailable).toBe(true);
    });
  });

  it('reports "confidence" as the reason on the ordinary path', () => {
    const result = service.supervise(makeInput());
    expect(result.label).toBe('auto_worthy');
    expect(result.labelReason).toBe('confidence');
  });
});
