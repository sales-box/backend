import { Injectable } from '@nestjs/common';
import { SupervisorInput, SupervisorOutput } from './supervisor.types';

@Injectable()
export class SupervisorService {
  // Confirmed with the team 2026-07-17: thresholds are 80/60 (not 85/60).
  private readonly PRODUCT_CONFIDENCE_AUTO_THRESHOLD = 0.8;
  private readonly PRODUCT_CONFIDENCE_REVIEW_THRESHOLD = 0.6;

  // ── Private helpers (internal details; only `supervise` is public) ─────

  private computeProductConfidence(input: SupervisorInput): number {
    const { classifierOutput, extractorOutput, matcherOutput } = input;

    // Count how many Extractor fields were INFERRED rather than literal.
    // More inference = less certainty about what the client actually meant.
    const inferredFlags = [
      extractorOutput.featuresInferred,
      extractorOutput.constraintsInferred,
      extractorOutput.scaleInferred,
      extractorOutput.budgetInferred,
      extractorOutput.timelineInferred,
    ];
    const inferredCount = inferredFlags.filter(Boolean).length;
    // 5 fields total -> each inferred field costs a small penalty
    const extractionCertainty = 1 - inferredCount * 0.05;

    // Weighted blend: classifier's own confidence (30%), extraction
    // certainty (30%), and the Matcher's KB-match confidence (40%).
    // Weights are a reasonable starting point — adjust once the golden
    // dataset evaluation (US-049) produces real feedback.
    const raw =
      classifierOutput.intentConfidence * 0.3 +
      extractionCertainty * 0.3 +
      matcherOutput.matchConfidence * 0.4;

    // Clamp to [0, 1] in case the blend drifts slightly outside bounds
    return Math.min(1, Math.max(0, raw));
  }

  private computeClientHistoryConfidence(input: SupervisorInput): number {
    // A brand-new (uncontacted) client: conservative baseline, not zero — being
    // unknown isn't automatically "risky", just "unverified".
    const NEW_CLIENT_BASELINE = 0.4;
    if (input.isNewClient) {
      return NEW_CLIENT_BASELINE;
    }

    // A known client gains confidence with each logged interaction (diminishing
    // returns — 5 is already "well known"). Floored at the new-client baseline:
    // a client we've identified in the CRM is never LESS trusted than a stranger
    // (previously a known client with 0 logged interactions scored 0 < 0.4).
    const historyScore = Math.min(1, input.clientHistoryLength / 5);
    return Math.max(historyScore, NEW_CLIENT_BASELINE);
  }

  private detectHallucination(claims: Array<{ status: string }>): boolean {
    // Any single hallucinated claim is a VETO — the entire draft is unsafe.
    // .some() short-circuits on the first match (faster than filter+length).
    return claims.some((claim) => claim.status === 'hallucinated');
  }

  private countFlaggedClaims(claims: Array<{ status: string }>): number {
    // Flagged = "uncertain, worth a human glance" — NOT a veto like
    // hallucinated. It's tracked separately and never lowers the label
    // on its own (per Business Story §7.5).
    return claims.filter((claim) => claim.status === 'flagged').length;
  }

  private computeLabel(
    productConfidence: number,
    hallucinationDetected: boolean,
  ): 'auto_worthy' | 'needs_review' | 'handle_manually' {
    // The veto ALWAYS wins first, before any number is even looked at.
    if (hallucinationDetected) {
      return 'handle_manually';
    }
    if (productConfidence >= this.PRODUCT_CONFIDENCE_AUTO_THRESHOLD) {
      return 'auto_worthy';
    }
    if (productConfidence >= this.PRODUCT_CONFIDENCE_REVIEW_THRESHOLD) {
      return 'needs_review';
    }
    return 'handle_manually';
  }

  // ── Public entry point ────────────────────────────────────────────────
  // Called AFTER graph.invoke() finishes (not a graph node).
  // Zero LLM calls — pure deterministic aggregation.

  supervise(input: SupervisorInput): SupervisorOutput {
    const productConfidence = this.computeProductConfidence(input);
    const clientHistoryConfidence = this.computeClientHistoryConfidence(input);
    const hallucinationDetected = this.detectHallucination(
      input.composerOutput.claims,
    );
    const flaggedClaimsCount = this.countFlaggedClaims(
      input.composerOutput.claims,
    );
    const label = this.computeLabel(productConfidence, hallucinationDetected);

    return {
      productConfidence,
      clientHistoryConfidence,
      label,
      hallucinationDetected,
      flaggedClaimsCount,
      // A hallucinated draft is never shown to the SE as-is
      draftAvailable: !hallucinationDetected,
      // Hint to the Admin when the Matcher couldn't find a strong product fit
      knowledgeGapSuggestion:
        input.matcherOutput.matchConfidence < 0.3
          ? 'No strong product match found — consider adding KB coverage for this request type'
          : null,
    };
  }
}
