/**
 * Classifier TRACE tool — shows every internal stage for each email, so you can
 * SEE what the agent does step by step (no debugger needed):
 *   raw text -> cleaned (prepareEmailText) -> caged (<untrusted_content>)
 *   -> RAW model output -> validated result.
 *
 * Run one email:
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node -r tsconfig-paths/register \
 *     scripts/classifier-eval/trace.ts "your email text here"
 *
 * Run the whole case set (scripts/classifier-eval/cases.jsonl):
 *   ... trace.ts --cases
 *
 * Add --verbose to also print the full caged prompt sent to the model.
 * Costs one real LLM call per email.
 */
import './_env';
import { buildClassifierLlmClient } from './_classifier';
import type { ClassifierLlmClient } from '../../src/modules/ai/classifier/classifier-llm-client.adapter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLASSIFIER_SCHEMA,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TEMPERATURE,
} from '../../src/modules/ai/classifier/classifier.prompts';
import { prepareEmailText } from '../../src/modules/ai/classifier/email-text.util';
import { validateClassification } from '../../src/modules/ai/classifier/validate-classification';

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Case {
  id: string;
  category?: string;
  text: string;
}

function loadCases(): Case[] {
  if (args.includes('--cases')) {
    return fs
      .readFileSync(path.join(__dirname, 'cases.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Case);
  }
  const text = args.filter((a) => !a.startsWith('--')).join(' ');
  return [{ id: 'input', text }];
}

async function traceOne(llm: ClassifierLlmClient, c: Case) {
  console.log('\n' + '─'.repeat(70));
  console.log(`▶ ${c.id}${c.category ? '  [' + c.category + ']' : ''}`);

  // Stage 1 — what the processor stores as "the email" (subject + body).
  const cleaned = prepareEmailText(c.text);
  console.log('\n① RAW        :', JSON.stringify(c.text.slice(0, 120)));
  console.log('② CLEANED    :', JSON.stringify(cleaned.slice(0, 120)));
  if (cleaned.length === 0) {
    console.log(
      '   -> empty after cleaning: processor would SKIP this message.',
    );
    return;
  }

  // Stage 2 — the security cage (prefilter runs here too; watch the logs).
  const caged = llm.wrapUntrustedContent(cleaned, 'email_body');
  if (VERBOSE) console.log('③ CAGED      :\n' + caged);
  else
    console.log(
      '③ CAGED      : <untrusted_content> …' +
        cleaned.length +
        ' chars… </untrusted_content>',
    );

  // Stage 3 — RAW model output (before validation).
  let raw: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      raw = await llm.generateStructured<unknown>({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        userMessage: caged,
        schema: CLASSIFIER_SCHEMA,
        temperature: CLASSIFIER_TEMPERATURE,
      });
      break;
    } catch (e) {
      if (attempt >= 4) {
        console.log(
          '④ RAW MODEL  : <call failed>',
          e instanceof Error ? e.message : e,
        );
        return;
      }
      await sleep(3000);
    }
  }
  console.log('④ RAW MODEL  :', JSON.stringify(raw));

  // Stage 4 — after the trust-boundary validator.
  try {
    const validated = validateClassification(raw);
    console.log('⑤ VALIDATED  :', JSON.stringify(validated));
  } catch (e) {
    console.log(
      '⑤ VALIDATED  : REJECTED ->',
      e instanceof Error ? e.message : e,
    );
    console.log(
      '   (the BullMQ job would retry — this is the trust boundary working)',
    );
  }
}

async function main() {
  const llm = buildClassifierLlmClient();
  const cases = loadCases();
  for (const c of cases) {
    await traceOne(llm, c);
    if (cases.length > 1) await sleep(1200);
  }
  console.log('\n' + '─'.repeat(70));
}

void main();
