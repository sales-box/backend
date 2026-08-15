import { determineKnowledgeGapTopic } from './knowledge-gap-topic';

describe('determineKnowledgeGapTopic', () => {
  it('uses a stable pricing bucket and gives it precedence over demo wording', () => {
    expect(
      determineKnowledgeGapTopic({
        subject: 'Pricing and demo',
        aiSummary: 'The prospect asks for a quote for 10 seats and a demo.',
        classification: 'demo request',
      }),
    ).toBe('pricing');
  });

  it('groups named CRM requests as integrations', () => {
    expect(
      determineKnowledgeGapTopic({
        subject: 'HubSpot',
        aiSummary: 'Asks whether the product integrates with HubSpot.',
        classification: 'product inquiry',
      }),
    ).toBe('integrations');
  });

  it('falls back to the fixed classifier taxonomy, never free-form text', () => {
    expect(
      determineKnowledgeGapTopic({
        subject: 'Hello',
        aiSummary: 'No recognized product keywords.',
        classification: 'demo request',
      }),
    ).toBe('demo_scheduling');
  });
});
