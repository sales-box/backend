/**
 * Classifier eval harness. Runs the real classifier over a labeled dataset and
 * reports intent accuracy, a confusion matrix, urgent + sensitive recall, and a
 * confidence-calibration breakdown, plus every miss (with the model's reasoning)
 * so you know exactly which boundary to sharpen in the prompt.
 *
 * Run:
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node -r tsconfig-paths/register \
 *     scripts/classifier-eval/run-eval.ts [path/to/dataset.jsonl]
 *
 * Dataset: one JSON object per line:
 *   {"id":"x","text":"...","expected":{"intent":"support","isUrgent":true}}
 *
 * Targets: intent accuracy >= 90%, sensitive recall = 100%, urgent recall >= 95%.
 * Costs one real LLM call per row (retried on free-tier hiccups).
 */
import './_env';
import { buildClassifier } from './_classifier';
import type { ClassificationResult } from '../../src/modules/ai/classifier/classifier.types';
import type { ClassifierService } from '../../src/modules/ai/classifier/classifier.service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INTENTS } from '../../src/modules/ai/classifier/classifier.types';

interface Row {
  id: string;
  text: string;
  expected: { intent: string; isUrgent: boolean };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (n: number, d: number) =>
  d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;

async function classifyWithRetry(
  c: ClassifierService,
  text: string,
): Promise<ClassificationResult> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await c.classify(text);
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(3000);
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const file = process.argv[2] || path.join(__dirname, 'dataset.jsonl');
  const rows: Row[] = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);

  const classifier = buildClassifier();

  // confusion[expected][predicted] = count
  const confusion: Record<string, Record<string, number>> = {};
  for (const a of INTENTS)
    confusion[a] = Object.fromEntries(INTENTS.map((b) => [b, 0]));

  let intentHits = 0;
  let urgentHits = 0;
  let urgentTotal = 0;
  let sensitiveHits = 0;
  let sensitiveTotal = 0;
  let errored = 0;

  // confidence calibration buckets
  const buckets = [
    { name: '0.90-1.00', lo: 0.9, hi: 1.01, hit: 0, n: 0 },
    { name: '0.70-0.90', lo: 0.7, hi: 0.9, hit: 0, n: 0 },
    { name: '0.00-0.70', lo: 0, hi: 0.7, hit: 0, n: 0 },
  ];

  const misses: string[] = [];

  for (const r of rows) {
    let got;
    try {
      got = await classifyWithRetry(classifier, r.text);
    } catch (e) {
      errored += 1;
      misses.push(
        `  ${r.id}: ERRORED — ${e instanceof Error ? e.message : String(e)}`,
      );
      process.stdout.write('x');
      continue;
    }

    const intentOk = got.intent === r.expected.intent;
    if (confusion[r.expected.intent])
      confusion[r.expected.intent][got.intent] += 1;
    if (intentOk) intentHits += 1;
    else
      misses.push(
        `  ${r.id}: expected ${r.expected.intent}, got ${got.intent} (conf ${got.intentConfidence}) — ${got.reasoning}`,
      );

    if (r.expected.isUrgent) {
      urgentTotal += 1;
      if (got.isUrgent) urgentHits += 1;
    }
    if (r.expected.intent === 'sensitive') {
      sensitiveTotal += 1;
      if (got.intent === 'sensitive') sensitiveHits += 1;
    }

    const b = buckets.find(
      (x) => got.intentConfidence >= x.lo && got.intentConfidence < x.hi,
    );
    if (b) {
      b.n += 1;
      if (intentOk) b.hit += 1;
    }

    process.stdout.write(intentOk ? '.' : 'F');
    await sleep(1200);
  }

  const scored = rows.length - errored;

  console.log('\n\n===== CLASSIFIER EVAL =====');
  console.log(`dataset: ${file}`);
  console.log(`rows: ${rows.length}  scored: ${scored}  errored: ${errored}`);
  console.log(
    `\nIntent accuracy:  ${intentHits}/${scored} = ${pct(intentHits, scored)}   (target >= 90%)`,
  );
  console.log(
    `Urgent recall:    ${urgentHits}/${urgentTotal} = ${pct(urgentHits, urgentTotal)}   (target >= 95%)`,
  );
  console.log(
    `Sensitive recall: ${sensitiveHits}/${sensitiveTotal} = ${pct(sensitiveHits, sensitiveTotal)}   (target = 100%)`,
  );

  console.log(
    '\nConfidence calibration (accuracy within each confidence band):',
  );
  for (const b of buckets)
    console.log(`  ${b.name}: ${b.hit}/${b.n} = ${pct(b.hit, b.n)}`);

  console.log('\nConfusion matrix (rows = expected, cols = predicted):');
  const short = (s: string) =>
    s
      .replace(/[^a-z]/gi, '')
      .slice(0, 6)
      .padEnd(6);
  console.log('  exp\\pred  ' + INTENTS.map(short).join(' '));
  for (const a of INTENTS)
    console.log(
      '  ' +
        short(a) +
        '   ' +
        INTENTS.map((b) => String(confusion[a][b]).padStart(6)).join(' '),
    );

  if (misses.length) {
    console.log('\nMisses / errors:');
    console.log(misses.join('\n'));
  }

  const passed =
    scored > 0 &&
    intentHits / scored >= 0.9 &&
    (sensitiveTotal === 0 || sensitiveHits === sensitiveTotal) &&
    (urgentTotal === 0 || urgentHits / urgentTotal >= 0.95);
  console.log(
    `\n${passed ? 'PASS ✅ (all targets met)' : 'BELOW TARGET ❌ — sharpen the worst-confused pair in classifier.prompts.ts, bump CLASSIFIER_PROMPT_VERSION, re-run'}`,
  );
}

void main();
