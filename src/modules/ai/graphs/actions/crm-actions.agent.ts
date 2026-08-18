import { Inject, Injectable, Logger } from '@nestjs/common';
import { Command } from '@langchain/langgraph';
import { PromptTemplate } from '@langchain/core/prompts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { buildSystemPrompt, USER_PROMPT } from './agent.prompt';
import { AgentFactory } from './agent.factory';
import { CHECKPOINTER_TOKEN } from '../checkpointer/checkpointer.constants';

export interface ActionSuggestion {
  index: number;
  summary: string;
}

interface ActionRequest {
  name: string;
  args: { summary?: string; [key: string]: unknown };
  description?: string;
}

interface LangGraphInterrupt {
  value: unknown;
}

interface LangGraphResult {
  __interrupt__?: LangGraphInterrupt[];
}

/** The slice of LangGraph's state snapshot this file relies on. */
interface GraphStateSnapshot {
  tasks?: Array<{ interrupts?: unknown[] }>;
}

export interface AgentExecutionResult {
  threadId: string;
  isPausedForApproval: boolean;
  suggestions: ActionSuggestion[];
  /**
   * Only meaningful on a resume: did the decisions reach a graph that was
   * actually waiting for them?
   *
   * False means there was nothing paused — the approvals were dropped and
   * nothing was written. Undefined on the suggest path, which never applies
   * anything.
   */
  applied?: boolean;
}

@Injectable()
export class CRMActionsAgent {
  private readonly logger = new Logger(CRMActionsAgent.name);

  constructor(
    private readonly agentFactory: AgentFactory,
    @Inject(CHECKPOINTER_TOKEN) private readonly checkpointer: PostgresSaver,
  ) {}

  public async suggestActions(
    tenantId: string,
    threadId: string,
    senderEmail: string,
    emailContent: string,
  ): Promise<AgentExecutionResult> {
    const agent = await this.agentFactory.createAgentForTenant(tenantId);

    // The prompt is assembled per tenant: the shared reasoning spine plus the
    // object model of whichever CRM they connected. Sharing it verbatim would
    // have a HubSpot agent hunting for Zoho's Leads module.
    const systemMessage = buildSystemPrompt(
      await this.agentFactory.getObjectModelForTenant(tenantId),
    );

    const userMessage = await PromptTemplate.fromTemplate(USER_PROMPT).format({
      currentDate: new Date().toISOString(),
      senderEmail,
      emailContent,
    });

    const messages = [
      { type: 'system', content: systemMessage },
      { type: 'user', content: userMessage },
    ];

    const executionThreadId = `${tenantId}:${threadId}`;

    this.checkpointer.deleteThread(executionThreadId);

    const config = { configurable: { thread_id: executionThreadId } };
    const result = await agent.invoke({ messages }, config);

    return this.formatAgentResult(threadId, result);
  }

  public async resumeWithDecision(
    tenantId: string,
    threadId: string,
    decisions: Array<{ type: 'approve' | 'reject'; message?: string }>,
  ): Promise<AgentExecutionResult> {
    const agent = await this.agentFactory.createAgentForTenant(tenantId);

    const config = { configurable: { thread_id: `${tenantId}:${threadId}` } };

    // Resuming a graph with nothing paused is a no-op that LangGraph reports
    // exactly like a successful run: no interrupts left, so formatAgentResult
    // returns the same shape either way and the panel showed "submitted
    // successfully" over an approval that wrote nothing. Observed after a
    // resume had already failed on this thread — the second attempt came back
    // 201 in 59ms and the approved deal never reached HubSpot.
    if (!(await this.hasPendingApproval(agent, config))) {
      this.logger.warn(
        `Resume for thread ${threadId} found nothing awaiting approval — ` +
          'decisions were not applied.',
      );
      return {
        threadId,
        isPausedForApproval: false,
        suggestions: [],
        applied: false,
      };
    }

    const result = await agent.invoke(
      new Command({
        resume: { decisions },
      }),
      config,
    );

    return { ...this.formatAgentResult(threadId, result), applied: true };
  }

  /** Is this thread actually parked on an approval interrupt? */
  private async hasPendingApproval(
    agent: { getState: (config: unknown) => Promise<GraphStateSnapshot> },
    config: unknown,
  ): Promise<boolean> {
    try {
      const state = await agent.getState(config);
      return (state?.tasks ?? []).some((t) => (t.interrupts ?? []).length > 0);
    } catch (error) {
      // An unreadable state is not a licence to claim success. Treat it as
      // nothing pending; the SE re-runs and loses nothing.
      this.logger.warn(
        `Could not read graph state while resuming: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private formatAgentResult(
    threadId: string,
    result: LangGraphResult,
  ): AgentExecutionResult {
    const interrupts = result?.__interrupt__ || [];

    if (interrupts.length === 0) {
      return {
        threadId,
        isPausedForApproval: false,
        suggestions: [],
      };
    }

    const interruptPayload = interrupts[0]?.value as
      { actionRequests?: ActionRequest[] } | undefined;

    const actionRequests = interruptPayload?.actionRequests ?? [];

    const suggestions = actionRequests.map((req, index) => ({
      index,
      summary: req.args?.summary ?? 'Review this action before approving.',
    }));

    return {
      threadId,
      isPausedForApproval: true,
      suggestions,
    };
  }
}
