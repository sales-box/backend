import { CRMActionsAgent } from './crm-actions.agent';
import type { AgentFactory } from './agent.factory';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ZOHO_OBJECT_MODEL } from './agent.prompt';

const mockInvoke = jest.fn();
const mockGetState = jest.fn();

function makeAgent(): CRMActionsAgent {
  const factory = {
    createAgentForTenant: jest
      .fn()
      .mockResolvedValue({ invoke: mockInvoke, getState: mockGetState }),
    getObjectModelForTenant: jest.fn().mockResolvedValue(ZOHO_OBJECT_MODEL),
  } as unknown as AgentFactory;

  const checkpointer = {
    deleteThread: jest.fn(),
  } as unknown as PostgresSaver;

  return new CRMActionsAgent(factory, checkpointer);
}

/** A graph parked on an approval interrupt. */
const PAUSED = {
  tasks: [{ interrupts: [{ value: { actionRequests: [] } }] }],
};

/** A graph that has already run to completion. */
const FINISHED = { tasks: [] };

beforeEach(() => jest.clearAllMocks());

describe('resumeWithDecision', () => {
  it('applies the decisions when the graph is waiting for them', async () => {
    mockGetState.mockResolvedValue(PAUSED);
    mockInvoke.mockResolvedValue({ __interrupt__: [] });

    const result = await makeAgent().resumeWithDecision('t1', 'thread-1', [
      { type: 'approve' },
    ]);

    expect(mockInvoke).toHaveBeenCalled();
    expect(result.applied).toBe(true);
  });

  it('reports that nothing was applied when nothing was pending', async () => {
    // LangGraph answers a resume-with-nothing-paused exactly like a successful
    // run — no interrupts left — so without this check the panel showed
    // "submitted successfully" over approvals that were silently dropped.
    mockGetState.mockResolvedValue(FINISHED);

    const result = await makeAgent().resumeWithDecision('t1', 'thread-1', [
      { type: 'approve' },
    ]);

    expect(result.applied).toBe(false);
    expect(result.isPausedForApproval).toBe(false);
  });

  it('does not invoke the graph when there is nothing to resume', async () => {
    mockGetState.mockResolvedValue(FINISHED);

    await makeAgent().resumeWithDecision('t1', 'thread-1', [
      { type: 'approve' },
    ]);

    // Invoking anyway is what produced the phantom success: a no-op run that
    // looks identical to a real one.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('treats an unreadable graph state as nothing pending, never as success', async () => {
    mockGetState.mockRejectedValue(new Error('checkpointer unreachable'));

    const result = await makeAgent().resumeWithDecision('t1', 'thread-1', [
      { type: 'approve' },
    ]);

    expect(result.applied).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
