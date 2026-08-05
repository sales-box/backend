import { createMiddleware } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import type {
  Decision,
  HumanInTheLoopMiddlewareConfig,
  InterruptOnConfig,
  ToolCall,
} from 'langchain';

interface HITLResumeValue {
  decisions: Decision[];
}

function applyDecision(
  decision: Decision,
  toolCall: ToolCall,
  config: InterruptOnConfig,
): { revisedToolCall: ToolCall | null; toolMessage: ToolMessage | null } {
  const { allowedDecisions } = config;

  if (decision.type === 'approve' && allowedDecisions.includes('approve')) {
    return { revisedToolCall: toolCall, toolMessage: null };
  }

  if (decision.type === 'edit' && allowedDecisions.includes('edit')) {
    const { editedAction } = decision;
    if (!editedAction || typeof editedAction.name !== 'string') {
      throw new Error(
        `Invalid edited action for tool "${toolCall.name}": name must be a string`,
      );
    }
    if (!editedAction.args || typeof editedAction.args !== 'object') {
      throw new Error(
        `Invalid edited action for tool "${toolCall.name}": args must be an object`,
      );
    }
    return {
      revisedToolCall: {
        name: editedAction.name,
        args: editedAction.args,
        id: toolCall.id,
      },
      toolMessage: null,
    };
  }

  if (decision.type === 'reject' && allowedDecisions.includes('reject')) {
    if (
      decision.message !== undefined &&
      typeof decision.message !== 'string'
    ) {
      throw new Error(
        `Rejection message for "${toolCall.name}" must be a string, got ${typeof decision.message}`,
      );
    }
    return {
      revisedToolCall: null, // rejected → do NOT execute
      toolMessage: new ToolMessage({
        content:
          decision.message ??
          `User rejected the tool call for \`${toolCall.name}\` with id ${toolCall.id}`,
        name: toolCall.name,
        tool_call_id: toolCall.id,
        status: 'error',
      }),
    };
  }

  throw new Error(
    `Unexpected decision: ${JSON.stringify(decision)}. ` +
      `Type '${decision.type}' is not allowed for '${toolCall.name}'. ` +
      `Expected one of ${JSON.stringify(allowedDecisions)}.`,
  );
}

export function humanInTheLoopMiddleware(
  options: HumanInTheLoopMiddlewareConfig,
) {
  const descriptionPrefix =
    options.descriptionPrefix ?? 'Tool execution requires approval';

  return createMiddleware({
    name: 'CustomHumanInTheLoopMiddleware',
    afterModel: {
      canJumpTo: ['model'],
      hook: async (state, runtime) => {
        if (!options.interruptOn) return;

        const { messages } = state;
        if (!messages.length) return;

        const lastMessage = [...messages]
          .reverse()
          .find((m) => AIMessage.isInstance(m));
        if (!lastMessage?.tool_calls?.length) return;

        // Resolve per-tool configs: true → all decisions allowed; false → auto-approve (omit)
        const resolvedConfigs: Record<string, InterruptOnConfig> = {};
        for (const [name, cfg] of Object.entries(options.interruptOn)) {
          if (cfg === true)
            resolvedConfigs[name] = {
              allowedDecisions: ['approve', 'edit', 'reject'],
            };
          else if (cfg !== false && cfg.allowedDecisions)
            resolvedConfigs[name] = cfg;
        }

        // Partition tool calls: those needing human review vs. auto-approved
        const interruptToolCalls: ToolCall[] = [];
        const autoApprovedToolCalls: ToolCall[] = [];

        for (const toolCall of lastMessage.tool_calls as ToolCall[]) {
          const cfg = resolvedConfigs[toolCall.name];
          if (!cfg) {
            autoApprovedToolCalls.push(toolCall);
            continue;
          }
          const shouldInterrupt = cfg.when
            ? await cfg.when({ toolCall, tool: undefined, state, runtime })
            : true;

          if (shouldInterrupt) interruptToolCalls.push(toolCall);
          else autoApprovedToolCalls.push(toolCall);
        }

        if (!interruptToolCalls.length) return;

        // Build the interrupt payload shown to the human reviewer
        const actionRequests: unknown[] = [];
        const reviewConfigs: unknown[] = [];

        for (const toolCall of interruptToolCalls) {
          const cfg = resolvedConfigs[toolCall.name];
          const description =
            typeof cfg.description === 'function'
              ? await cfg.description(toolCall, state, runtime)
              : (cfg.description ??
                `${descriptionPrefix}\n\nTool: ${toolCall.name}\nArgs: ${JSON.stringify(toolCall.args, null, 2)}`);

          actionRequests.push({
            name: toolCall.name,
            args: toolCall.args,
            description,
          });
          reviewConfigs.push({
            actionName: toolCall.name,
            allowedDecisions: cfg.allowedDecisions,
            ...(cfg.argsSchema ? { argsSchema: cfg.argsSchema } : {}),
          });
        }

        const resumeValue: HITLResumeValue = interrupt({
          actionRequests,
          reviewConfigs,
        });
        const { decisions } = resumeValue;

        if (!decisions || !Array.isArray(decisions)) {
          throw new Error(
            'Invalid HITLResponse: decisions must be a non-empty array',
          );
        }
        if (decisions.length !== interruptToolCalls.length) {
          throw new Error(
            `Number of decisions (${decisions.length}) does not match ` +
              `number of pending tool calls (${interruptToolCalls.length}).`,
          );
        }

        // Process decisions — seed the execution queue with auto-approved calls
        const revisedToolCalls: ToolCall[] = [...autoApprovedToolCalls];
        const artificialToolMessages: ToolMessage[] = [];

        for (let i = 0; i < decisions.length; i++) {
          const { revisedToolCall, toolMessage } = applyDecision(
            decisions[i],
            interruptToolCalls[i],
            resolvedConfigs[interruptToolCalls[i].name],
          );

          if (revisedToolCall) revisedToolCalls.push(revisedToolCall);
          if (toolMessage) artificialToolMessages.push(toolMessage);
        }

        lastMessage.tool_calls = revisedToolCalls;

        const jumpTo = revisedToolCalls.length === 0 ? 'model' : undefined;

        return {
          messages: [lastMessage, ...artificialToolMessages],
          jumpTo,
        };
      },
    },
  });
}
