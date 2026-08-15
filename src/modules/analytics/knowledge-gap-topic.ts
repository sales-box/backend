export type KnowledgeGapTopicInput = {
  subject: string;
  aiSummary: string;
  classification: string | null;
};

type TopicRule = {
  key: string;
  patterns: RegExp[];
};

// Ordered deliberately: a pricing question that also requests a demo is a
// pricing knowledge gap. The stable keys make counting deterministic; the
// linked Interaction preserves the specific request that raised the gap.
const TOPIC_RULES: TopicRule[] = [
  {
    key: 'pricing',
    patterns: [
      /\bpric(?:e|es|ing)\b/i,
      /\bcosts?\b/i,
      /\bquotes?\b/i,
      /\bbudget\b/i,
      /\bdiscounts?\b/i,
      /\bsubscriptions?\b/i,
      /\b(?:plan|tier|license|licence|seat)s?\b/i,
    ],
  },
  {
    key: 'integrations',
    patterns: [
      /\bintegrat(?:e|es|ed|ion|ions)\b/i,
      /\bapi\b/i,
      /\bwebhooks?\b/i,
      /\b(?:hubspot|salesforce|zoho|zapier|slack|teams)\b/i,
    ],
  },
  {
    key: 'security_and_compliance',
    patterns: [
      /\bsecurity\b/i,
      /\b(?:sso|saml|soc\s?2|gdpr|iso\s?27001|encryption|compliance|privacy)\b/i,
    ],
  },
  {
    key: 'implementation_and_onboarding',
    patterns: [
      /\b(?:implementation|implement|setup|deploy|deployment|onboarding|migration|training)\b/i,
    ],
  },
  {
    key: 'contract_and_legal',
    patterns: [/\b(?:contract|terms|sla|dpa|legal|cancellation|renewal)\b/i],
  },
  {
    key: 'product_capabilities',
    patterns: [
      /\b(?:feature|features|capability|capabilities|functionality)\b/i,
      /\b(?:can|does) (?:it|the product|your product)\b/i,
    ],
  },
  {
    key: 'support',
    patterns: [
      /\b(?:support|error|bug|issue|broken|not working|failed|failure)\b/i,
    ],
  },
  {
    key: 'demo_scheduling',
    patterns: [
      /\b(?:demo|demonstration|meeting|call|schedule|availability)\b/i,
    ],
  },
];

const CLASSIFICATION_FALLBACKS: Record<string, string> = {
  'product inquiry': 'product_capabilities',
  'demo request': 'demo_scheduling',
  support: 'support',
  sensitive: 'contract_and_legal',
  'follow-up': 'follow_up_context',
};

export function determineKnowledgeGapTopic(
  input: KnowledgeGapTopicInput,
): string {
  const searchable = [input.subject, input.aiSummary]
    .filter(Boolean)
    .join('\n');

  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(searchable))) {
      return rule.key;
    }
  }

  const classification = input.classification?.trim().toLowerCase() ?? '';
  return CLASSIFICATION_FALLBACKS[classification] ?? 'other';
}
