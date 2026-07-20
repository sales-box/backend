import { INTENTS } from '@/modules/ai/classifier/classifier.types';

export type ReviewedLabel = 'green' | 'yellow' | 'red';

export const REVIEW_STATUS_BY_LABEL: Record<
  ReviewedLabel,
  'ready' | 'needs-review' | 'manual'
> = {
  green: 'ready',
  yellow: 'needs-review',
  red: 'manual',
};

// "product inquiry" -> "product-inquiry", "follow-up" -> "follow-up"
const toCategoryKey = (intent: string): string =>
  intent.trim().toLowerCase().replace(/\s+/g, '-');

/** Reverse lookup built once from INTENTS: "product-inquiry" -> "product inquiry" */
const INTENT_KEY_TO_INTENT = new Map<string, string>(
  INTENTS.map((intent) => [toCategoryKey(intent), intent]),
);

export const SPECIAL_CATEGORIES = [
  'urgent',
  'ready',
  'needs-review',
  'manual',
  'not-reviewed',
] as const;
export type SpecialCategory = (typeof SPECIAL_CATEGORIES)[number];

export const isSpecialCategory = (
  category: string,
): category is SpecialCategory =>
  (SPECIAL_CATEGORIES as readonly string[]).includes(category);

export const resolveIntentForCategory = (category: string): string | null =>
  INTENT_KEY_TO_INTENT.get(category) ?? null;

export const isKnownCategory = (category: string): boolean =>
  isSpecialCategory(category) || resolveIntentForCategory(category) !== null;

export interface CategorizableAnalysis {
  threadId: string | null;
  isUrgent: boolean;
  intent: string;
  supervisorLabel: string | null;
  reviewedAt: Date | null;
}

/**
 * Decides whether one GeneralAnalysis row belongs to the requested category.
 * Mirrors the bucket semantics used by InboxOverviewScreen on the frontend
 * (urgent / by-intent / review-status / not-reviewed).
 */
export function matchesCategory(
  analysis: CategorizableAnalysis,
  category: string,
): boolean {
  switch (category) {
    case 'urgent':
      return analysis.isUrgent;
    case 'ready':
    case 'needs-review':
    case 'manual':
      return (
        analysis.reviewedAt != null &&
        REVIEW_STATUS_BY_LABEL[analysis.supervisorLabel as ReviewedLabel] ===
          category
      );
    case 'not-reviewed':
      return analysis.reviewedAt == null;
    default: {
      const intent = resolveIntentForCategory(category);
      return intent !== null && analysis.intent === intent;
    }
  }
}
