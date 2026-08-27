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
    // Every pattern here has to be unambiguously about money.
    //
    // This rule is FIRST, so whatever it matches outranks security, legal,
    // integrations, onboarding, product, support and demo. Two of the patterns
    // used to be ordinary English verbs — /\bcosts?\b/ matched "costs the
    // client time" and /\b(?:plan|...)s?\b/ matched "plans to" — so a SOC 2
    // question was filed under Pricing, the security topic never got its own
    // row, and the dashboard told the admin to go write pricing docs.
    //
    // "cost" and "plan" only count when something nearby makes them financial.
    patterns: [
      /\bpric(?:e|es|ing)\b/i,
      /\bhow much\b/i,
      /\bcost of\b/i,
      /\bcosts?\s+(?:\$|\d|per\b)/i,
      /\b(?:total|annual|monthly|licen[cs]e|seat|subscription)\s+costs?\b/i,
      /\bquotes?\b/i,
      /\bbudget\b/i,
      /\bdiscounts?\b/i,
      /\bsubscription\s+(?:cost|fee|price|plan)/i,
      /\b(?:pricing|price|paid|billing)\s+(?:plan|tier)s?\b/i,
      /\b(?:plan|tier)s?\s+(?:cost|price|include)/i,
      /\bper[-\s](?:seat|user|month|year)\b/i,
      /\blicen[cs](?:e|ing)\s+(?:cost|fee|price)\b/i,
      /\bupgrade\s+(?:my|our|the)?\s*(?:plan|tier|subscription)\b/i,
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
    // Insurance, liability and bonding sit here rather than in their own bucket:
    // a client asking for a certificate of insurance is asking what the contract
    // obliges us to, and SG-SRV-2026 answers all three in its "Scope and role"
    // section. Added after a live test where a real client asked exactly this —
    // it only landed here because the summary happened to say "before signing a
    // contract", and the same question phrased without that word fell through
    // to "other". Ordered after security_and_compliance, so an SOC 2 question
    // that merely mentions an insurer stays a security gap.
    patterns: [
      /\b(?:contract|terms|sla|dpa|legal|cancellation|renewal)\b/i,
      /\b(?:insurance|insurer|insured|liability|liable|indemnity|indemnify)\b/i,
      /\bbond(?:ed|ing)\b/i,
      /\bcertificate of insurance\b/i,
    ],
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

function firstMatchingRule(text: string): string | null {
  if (!text.trim()) return null;
  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.key;
    }
  }
  return null;
}

export function determineKnowledgeGapTopic(
  input: KnowledgeGapTopicInput,
): string {
  // The summary is what THIS email is about; the subject is whatever the thread
  // was named when it started. Weighting them equally meant a long "Re: Pricing
  // proposal - Acme" thread filed every later question under pricing, however
  // far the conversation had moved — and resolving that one row dismissed all
  // of them. Ask the summary first, and fall back to the subject only when the
  // summary carries no signal.
  return (
    firstMatchingRule(input.aiSummary ?? '') ??
    firstMatchingRule(input.subject ?? '') ??
    CLASSIFICATION_FALLBACKS[
      input.classification?.trim().toLowerCase() ?? ''
    ] ??
    'other'
  );
}
