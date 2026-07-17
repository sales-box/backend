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
});
