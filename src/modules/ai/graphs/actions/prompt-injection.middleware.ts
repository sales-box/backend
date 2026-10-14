import { createMiddleware, AIMessage, HumanMessage } from 'langchain';

const INJECTION_PATTERNS: RegExp[] = [
  // Classic instruction overrides
  /ignore (all |any |previous |prior |above |earlier )*instructions?/i,
  /disregard (all |any |your |previous |prior |above )*(system prompt|instructions?|rules?|guidelines?)/i,
  /forget (everything|all instructions?|what you (know|were told))/i,

  // Role-switching / jailbreak
  /you are now\b/i,
  /act as (a |an )?(different|new|another|unrestricted)/i,
  /\bDAN\b/,
  /your (new |real )?role is/i,
  /pretend (you are|to be)/i,

  // System-level override attempts
  /\[system\]/i,
  /<system>/i,
  /###\s*system/i,
  /new instructions?:/i,
  /override (instructions?|system)/i,

  // Confidentiality extraction
  /reveal (your|the) (system prompt|instructions?|rules?)/i,
  /print (your|the) (system prompt|instructions?)/i,
  /what (are|were) your instructions?/i,
];

const BLOCKED_RESPONSE =
  'This request cannot be processed because it appears to contain ' +
  'instructions that attempt to override system behaviour. ' +
  'Please provide a normal email or CRM-related request.';

export function promptInjectionMiddleware() {
  return createMiddleware({
    name: 'PromptInjectionGuardrail',
    beforeAgent: {
      hook: (state) => {
        if (!state.messages?.length) return;

        const lastMessage = state.messages[state.messages.length - 1];

        if (!lastMessage || !HumanMessage.isInstance(lastMessage)) return;

        const content =
          typeof lastMessage.content === 'string' ? lastMessage.content : '';

        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(content)) {
            return {
              messages: [new AIMessage(BLOCKED_RESPONSE)],
              jumpTo: 'end',
            };
          }
        }

        return;
      },
      canJumpTo: ['end'],
    },
  });
}
