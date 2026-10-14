import { createMiddleware } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import type {
  Decision,
  HumanInTheLoopMiddlewareConfig,
  InterruptOnConfig,
  ToolCall,
} from 'langchain';

/**
 * A decision may carry the id of the tool call it was made for.
 *
 * It did not, and the pairing was by array position alone — so an approval was
 * bound to a POSITION in the panel's list rather than to an action. When that
 * list changed underneath (a different email, a panel reload, a re-analysis),
 * the approval silently re-targeted whatever now sat at that index. Verified on
 * 27 Aug: an approved `createNote` was applied to `createTask`, which HubSpot
 * duly created, while the note was recorded as rejected.
 */
type IdentifiedDecision = Decision & { toolCallId?: string };

interface HITLResumeValue {
  decisions: IdentifiedDecision[];
}

/**
 * Line each decision up with the tool call it was actually made for.
 *
 * Matched by id when every decision carries one. When none do, it falls back to
 * the original positional pairing so an older client keeps working exactly as
 * it does today — the fallback is the previous behaviour, not a new one.
 *
 * A partial set is refused rather than guessed at: half-identified decisions
 * mean the client is mid-upgrade, and pairing the rest by position is the very
 * failure this exists to stop.
 */
export function pairDecisions(
  decisions: IdentifiedDecision[],
  toolCalls: ToolCall[],
): Array<{ decision: IdentifiedDecision; toolCall: ToolCall }> {
  const identified = decisions.filter(
    (d) => typeof d.toolCallId === 'string' && d.toolCallId.length > 0,
  );

  if (identified.length === 0) {
    return toolCalls.map((toolCall, i) => ({
      decision: decisions[i],
      toolCall,
    }));
  }

  if (identified.length !== decisions.length) {
    throw new Error(
      `Decisions must all carry a toolCallId or none may: ${identified.length} of ${decisions.length} did.`,
    );
  }

  const byId = new Map(identified.map((d) => [d.toolCallId, d]));
  if (byId.size !== identified.length) {
    throw new Error('Decisions contain a duplicate toolCallId.');
  }

  return toolCalls.map((toolCall) => {
    const decision = byId.get(toolCall.id);
    if (!decision) {
      throw new Error(
        `No decision was supplied for pending tool call ${toolCall.name} (${toolCall.id ?? 'no id'}).`,
      );
    }
    return { decision, toolCall };
  });
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
            toolCallId: toolCall.id,
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

        for (const { decision, toolCall } of pairDecisions(
          decisions,
          interruptToolCalls,
        )) {
          const { revisedToolCall, toolMessage } = applyDecision(
            decision,
            toolCall,
            resolvedConfigs[toolCall.name],
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
