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

  describe('everyday verbs must not be read as pricing', () => {
    // `pricing` is rule #0 so anything it matches outranks every other bucket.
    // Two of its patterns used to be ordinary English verbs, so a security or
    // support gap was filed under Pricing and the real topic never got a row.
    it('"plans to" is a verb, not a pricing plan', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'SOC 2 report request',
          aiSummary: 'Client plans to run a SOC 2 review before purchase.',
          classification: 'product inquiry',
        }),
      ).toBe('security_and_compliance');
    });

    it('"costs the client time" is not a price question', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Daily outage',
          aiSummary:
            'This outage costs the client time every day; they need support.',
          classification: 'support',
        }),
      ).toBe('support');
    });

    it('"licence to operate" is not a licence fee', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Regulator question',
          aiSummary: 'Their licence to operate depends on our GDPR posture.',
          classification: 'product inquiry',
        }),
      ).toBe('security_and_compliance');
    });

    it('still recognises a genuine price question', () => {
      for (const aiSummary of [
        'How much does it cost for 20 seats?',
        'They asked for a quote.',
        'What is the cost of the annual subscription?',
        'Is there a discount for non-profits?',
        'Which pricing tier includes SSO?',
        'What is the per-seat price?',
      ]) {
        expect(
          determineKnowledgeGapTopic({
            subject: 'Question',
            aiSummary,
            classification: 'product inquiry',
          }),
        ).toBe('pricing');
      }
    });
  });

  describe('insurance and liability are contractual questions', () => {
    // Found in live testing: a real client asked for a certificate of insurance
    // and who carries liability during installation. It only landed in
    // contract_and_legal because the summary happened to say "before signing a
    // contract" — the same question phrased without that word fell through to
    // "other", so the gap was filed under nothing useful.
    it('classifies a certificate-of-insurance request', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Certificate of insurance',
          aiSummary:
            'The client requests proof of insurance before work starts.',
          classification: 'product inquiry',
        }),
      ).toBe('contract_and_legal');
    });

    it('classifies a liability question with no contract wording', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Liability cover for the Nasr City job',
          aiSummary:
            'The client asks who is liable if a panel is damaged during installation, and wants the indemnity clause.',
          classification: 'product inquiry',
        }),
      ).toBe('contract_and_legal');
    });

    it('classifies a bonded-crew question', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Crew question',
          aiSummary: 'They ask whether your installation crews are bonded.',
          classification: 'product inquiry',
        }),
      ).toBe('contract_and_legal');
    });

    it('does not steal a security question that merely mentions insurance', () => {
      // security_and_compliance is ordered first, so an SOC 2 question stays
      // there even when the sentence also carries an insurance word.
      expect(
        determineKnowledgeGapTopic({
          subject: 'Audit',
          aiSummary:
            'Our insurer wants to see your SOC 2 report and GDPR posture.',
          classification: 'product inquiry',
        }),
      ).toBe('security_and_compliance');
    });
  });

  describe('a stale thread subject must not decide the topic', () => {
    // Long threads keep their original "Re: ..." subject. Weighting it equally
    // with the current summary filed every later question on the thread under
    // the first question's topic, and resolving that one row dismissed them all.
    it('prefers what this email is actually about', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Re: Pricing proposal - Acme',
          aiSummary: 'Now asks whether we are SOC 2 certified.',
          classification: 'product inquiry',
        }),
      ).toBe('security_and_compliance');
    });

    it('still uses the subject when the summary says nothing useful', () => {
      expect(
        determineKnowledgeGapTopic({
          subject: 'Question about your API',
          aiSummary: 'Follow-up from the client.',
          classification: 'product inquiry',
        }),
      ).toBe('integrations');
    });
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
