import { pairDecisions } from './hitl.middleware';

type Decision = Parameters<typeof pairDecisions>[0][number];
type ToolCall = Parameters<typeof pairDecisions>[1][number];

const call = (id: string, name: string) =>
  ({ id, name, args: {} }) as unknown as ToolCall;
const approve = (toolCallId?: string) =>
  ({ type: 'approve', ...(toolCallId ? { toolCallId } : {}) }) as Decision;
const reject = (toolCallId?: string) =>
  ({ type: 'reject', ...(toolCallId ? { toolCallId } : {}) }) as Decision;

const CALLS = [
  call('call_task', 'createTask'),
  call('call_deal', 'createDeal'),
  call('call_note', 'createNote'),
];

describe('pairDecisions', () => {
  describe('with ids — the fix', () => {
    // The 27 Aug incident: the reviewer approved createNote, the approval was
    // applied to createTask by position, and HubSpot created the task.
    it('binds a decision to its action regardless of order', () => {
      const paired = pairDecisions(
        [reject('call_deal'), approve('call_note'), reject('call_task')],
        CALLS,
      );

      const approved = paired
        .filter((p) => p.decision.type === 'approve')
        .map((p) => p.toolCall.name);
      expect(approved).toEqual(['createNote']);
    });

    it('returns one pair per pending tool call, in tool-call order', () => {
      const paired = pairDecisions(
        [approve('call_note'), approve('call_deal'), approve('call_task')],
        CALLS,
      );
      expect(paired.map((p) => p.toolCall.id)).toEqual([
        'call_task',
        'call_deal',
        'call_note',
      ]);
    });

    it('refuses a decision for an action that is not pending', () => {
      expect(() =>
        pairDecisions(
          [approve('call_task'), approve('call_deal'), approve('call_gone')],
          CALLS,
        ),
      ).toThrow(/No decision was supplied/);
    });

    it('refuses a duplicated id rather than letting one win', () => {
      expect(() =>
        pairDecisions(
          [approve('call_task'), approve('call_task'), approve('call_note')],
          CALLS,
        ),
      ).toThrow(/duplicate toolCallId/);
    });

    // Half-identified means the client is mid-upgrade. Pairing the rest by
    // position is exactly the failure this exists to prevent.
    it('refuses a partially identified set', () => {
      expect(() =>
        pairDecisions([approve('call_task'), reject(), reject()], CALLS),
      ).toThrow(/all carry a toolCallId or none/);
    });
  });

  describe('without ids — the fallback', () => {
    // An older client keeps behaving exactly as it does today. The fallback is
    // the previous behaviour, not a new one.
    it('pairs by position, as before', () => {
      const paired = pairDecisions([approve(), reject(), reject()], CALLS);

      expect(paired.map((p) => [p.toolCall.name, p.decision.type])).toEqual([
        ['createTask', 'approve'],
        ['createDeal', 'reject'],
        ['createNote', 'reject'],
      ]);
    });

    it('reproduces the original bug, so the fallback is understood as unsafe', () => {
      // Reviewer meant to approve createNote (index 2 in the list they saw),
      // but the list they were shown had shifted.
      const paired = pairDecisions([approve(), reject(), reject()], CALLS);
      const approved = paired.find((p) => p.decision.type === 'approve');
      expect(approved?.toolCall.name).toBe('createTask');
    });
  });
});
