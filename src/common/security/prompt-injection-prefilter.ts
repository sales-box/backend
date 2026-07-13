import { Logger } from '@nestjs/common';

const logger = new Logger('PromptInjectionPrefilter');

export const SUSPICIOUS_PATTERNS = [
  // Ignore / override instructions
  /ignore (all |previous |above |the )?instructions/i,
  /ignore (all |previous |above )?prompts/i,
  /ignore everything/i,
  /ignore your instructions/i,
  /ignore prior instructions/i,
  /disregard (all |previous )?instructions/i,
  /forget (all |previous )?instructions/i,
  /override instructions/i,
  /override previous instructions/i,
  /replace your instructions/i,
  /new instructions/i,
  /follow these instructions instead/i,

  // Prompt extraction
  /system prompt/i,
  /developer prompt/i,
  /hidden prompt/i,
  /internal prompt/i,
  /reveal instructions/i,
  /reveal your instructions/i,
  /show your instructions/i,
  /show the system prompt/i,
  /tell me your prompt/i,
  /output your prompt/i,
  /print your instructions/i,
  /output the instructions/i,
  /repeat your instructions/i,
  /repeat the system prompt/i,
  /what were your instructions/i,

  // Role manipulation
  /you are now/i,
  /pretend to be/i,
  /act as/i,
  /roleplay as/i,
  /assume the role of/i,
  /from now on you are/i,
  /you are no longer/i,

  // Jailbreaks
  /dan mode/i,
  /do anything now/i,
  /developer mode/i,
  /jailbreak/i,
  /unrestricted mode/i,
  /god mode/i,
  /root mode/i,

  // Safety bypass
  /bypass (all )?restrictions/i,
  /bypass (all )?rules/i,
  /bypass instructions/i,
  /bypass safeguards/i,
  /disable safety/i,
  /disable guardrails/i,
  /ignore safety/i,
  /ignore rules/i,
  /ignore guardrails/i,

  // System manipulation
  /system\s*:/i,
  /assistant\s*:/i,
  /developer\s*:/i,
  /tool\s*:/i,
  /user\s*:/i,
  /<system>/i,
  /<\/system>/i,
  /<assistant>/i,
  /<\/assistant>/i,

  // Prompt leakage attempts
  /what is your system message/i,
  /show me your hidden instructions/i,
  /display your configuration/i,
  /show your configuration/i,
  /print the prompt/i,

  // Tool manipulation
  /call the tool/i,
  /invoke the tool/i,
  /use the web tool/i,
  /use your tools/i,
  /ignore tool restrictions/i,

  // Data exfiltration
  /reveal confidential/i,
  /reveal secret/i,
  /show hidden/i,
  /show internal/i,
  /leak/i,
  /exfiltrate/i,

  // Instruction delimiters often used in attacks
  /begin (new )?instructions/i,
  /end (all )?instructions/i,
  /###\s*system/i,
  /```system/i,
  /<\|system\|>/i,
  /<\|assistant\|>/i,
];

export function flagSuspiciousContent(text: string): boolean {
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text)) {
      logger.warn(
        `Potential prompt injection detected: matches pattern ${pattern.toString()}`,
      );
      return true;
    }
  }
  return false;
}
