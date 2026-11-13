// Opt-in live evaluation of synthetic cases. Default invocation is offline.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EVAL_CASES } from '../test/eval/cases.js';
import { evaluateOutput } from '../src/lib/evaluation.js';
import { buildSystemPrompt, buildCommentMessages, buildTranslateMessages } from '../src/lib/prompts.js';
import { buildCheckMessages } from '../src/lib/quality.js';
import { buildVoiceBlock } from '../src/lib/voice.js';
import { mergeSettings, activeConfig } from '../src/lib/settings.js';
import { streamCompletion, describeError } from '../src/lib/llm.js';

const args = process.argv.slice(2);
const option = (name, fallback = '') => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] || fallback; };
const input = option('--from');
const live = args.includes('--run');
const limit = Number(option('--limit', String(EVAL_CASES.length)));
if (!Number.isInteger(limit) || limit < 1 || limit > EVAL_CASES.length) throw new Error(`--limit musi być liczbą od 1 do ${EVAL_CASES.length}.`);
if (!live && !input) {
  console.log(`${EVAL_CASES.length} syntetyczne przypadki: pisanie komentarzy i DM, tłumaczenie, kontrola faktów i zobowiązań.`);
  console.log('Nie wysłano zapytań. Ocena zapisanych odpowiedzi: npm run eval -- --from plik.json');
  console.log('Płatna próba modelu: npm run eval -- --run --limit 4 [--provider anthropic|openrouter] [--model ID]');
  process.exit(0);
}

const records = [];
if (input) {
  const stored = JSON.parse(await readFile(input, 'utf8'));
  const outputs = Array.isArray(stored) ? stored : stored.records;
  if (!Array.isArray(outputs)) throw new Error('Plik musi zawierać tablicę {id, text} albo raport z polem records.');
  for (const record of outputs.slice(0, limit)) {
    const sample = EVAL_CASES.find((item) => item.id === record.id);
    if (!sample || typeof record.text !== 'string') throw new Error('Nieznany przypadek albo brak tekstu odpowiedzi.');
    records.push({ ...record, evaluation: evaluateOutput(sample, record.text, { stopReason: record.stopReason || 'end_turn' }) });
  }
} else {
  const provider = option('--provider', 'anthropic');
  if (!['anthropic', 'openrouter'].includes(provider)) throw new Error('Nieznany dostawca.');
  const key = process.env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'];
  if (!key) throw new Error('Ustaw ANTHROPIC_API_KEY lub OPENROUTER_API_KEY w środowisku. Skrypt nie czyta kluczy z przeglądarki ani plików.');
  const settings = mergeSettings({ provider, apiKeys: { [provider]: key }, ...(option('--model') ? { models: { [provider]: option('--model') } } : {}) });
  const cfg = activeConfig(settings);
  for (const sample of EVAL_CASES.slice(0, limit)) {
    const system = [buildSystemPrompt({ aboutMe: sample.aboutMe || '' }), buildVoiceBlock({ voiceNotes: sample.voiceNotes || '', kind: sample.post?.kind })];
    const messages = sample.task === 'translate' ? buildTranslateMessages(sample.source)
      : sample.task === 'check' ? buildCheckMessages(sample)
      : buildCommentMessages({ ...sample, imageBlocks: [] });
    const started = Date.now();
    try {
      const { text, message } = await streamCompletion(cfg, { system, messages });
      records.push({ id: sample.id, text, model: message.model || cfg.model, usage: message.usage, stopReason: message.stop_reason,
        elapsedMs: Date.now() - started, evaluation: evaluateOutput(sample, text, { stopReason: message.stop_reason }) });
      console.log(`${sample.id}: ${records.at(-1).evaluation.passedMechanicalChecks ? 'kontrole mechaniczne OK' : 'do sprawdzenia'}`);
    } catch (error) {
      console.error(`${sample.id}: ${describeError(error, cfg) || 'Przerwano.'}`);
      process.exitCode = 1; break;
    }
  }
}
const out = option('--out', '.cache/eval-results.json');
await mkdir(path.dirname(out), { recursive: true });
const passed = records.filter((record) => record.evaluation.passedMechanicalChecks).length;
await writeFile(out, JSON.stringify({ createdAt: new Date().toISOString(), note: 'Kontrole mechaniczne; każdy wynik wymaga oceny semantycznej według rubryki.', passedMechanicalChecks: passed, records }, null, 2));
console.log(`Zapisano ${records.length} wyników: ${passed} przeszło kontrole mechaniczne. Oceń wierność i styl ręcznie według rubryk. Raport: ${out}`);
