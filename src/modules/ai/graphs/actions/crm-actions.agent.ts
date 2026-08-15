import { Inject, Injectable } from '@nestjs/common';
import { Command } from '@langchain/langgraph';
import { PromptTemplate } from '@langchain/core/prompts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { SYSTEM_PROMPT, USER_PROMPT } from './agent.prompt';
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

export interface AgentExecutionResult {
  threadId: string;
  isPausedForApproval: boolean;
  suggestions: ActionSuggestion[];
}

@Injectable()
export class CRMActionsAgent {
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

    const systemMessage = SYSTEM_PROMPT;

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
    const result = await agent.invoke(
      new Command({
        resume: { decisions },
      }),
      config,
    );

    return this.formatAgentResult(threadId, result);
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
