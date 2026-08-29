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
  /**
   * Which tool call this suggestion is for, so the approval can be bound to the
   * action rather than to its position in the list. `index` stays for older
   * clients; a decision sent without a toolCallId still pairs positionally.
   */
  toolCallId?: string;
  /** The tool name, so a reviewer can tell a note from a deal. */
  action?: string;
}

interface ActionRequest {
  toolCallId?: string;
  name: string;
  args: { summary?: string; [key: string]: unknown };
  description?: string;
}

interface LangGraphInterrupt {
  value: unknown;
}

interface ToolOutcome {
  tool_call_id?: string;
  name?: string;
  status?: string;
  content?: unknown;
}

interface LangGraphResult {
  __interrupt__?: LangGraphInterrupt[];
  /** Present after a resume; carries one entry per executed tool call. */
  messages?: ToolOutcome[];
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

    // Awaited. Fired-and-forgotten this lost its race against the invoke below
    // and left two runs' messages merged into one thread — the checkpoint from
    // the 27 Aug incident holds both. A wipe that fails is not worth failing the
    // suggest over: the run still produces a fresh proposal, it just carries the
    // previous conversation.
    await this.checkpointer
      .deleteThread(executionThreadId)
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not clear checkpoint ${executionThreadId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    const config = { configurable: { thread_id: executionThreadId } };
    const result = await agent.invoke({ messages }, config);

    return this.formatAgentResult(threadId, result);
  }

  public async resumeWithDecision(
    tenantId: string,
    threadId: string,
    decisions: Array<{
      type: 'approve' | 'reject';
      message?: string;
      toolCallId?: string;
    }>,
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

    this.logToolOutcomes(threadId, result);

    return { ...this.formatAgentResult(threadId, result), applied: true };
  }

  /**
   * Write what each approved tool actually did to the log.
   *
   * LangGraph's ToolNode turns any tool exception into a ToolMessage and lets
   * the graph continue, so a rejected CRM write reaches the panel as a success.
   * That has now hidden three real failures: a note the CRM never received, and
   * two updates Zoho refused with INVALID_DATA naming the exact field.
   *
   * This only logs. The response shape is deliberately unchanged — making
   * `applied` honest means deciding what partial success means to the panel,
   * and that is a bigger change than a diagnostic.
   */
  private logToolOutcomes(threadId: string, result: LangGraphResult): void {
    for (const message of result?.messages ?? []) {
      if (message?.tool_call_id === undefined) continue;

      const name = message.name ?? 'unknown tool';
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);

      if (message.status === 'error') {
        this.logger.error(
          `CRM action ${name} FAILED on thread ${threadId}: ${content?.slice(0, 500)}`,
        );
      } else {
        this.logger.log(`CRM action ${name} ok on thread ${threadId}`);
      }
    }
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
      toolCallId: req.toolCallId,
      action: req.name,
      summary: req.args?.summary ?? 'Review this action before approving.',
    }));

    return {
      threadId,
      isPausedForApproval: true,
      suggestions,
    };
  }
}
