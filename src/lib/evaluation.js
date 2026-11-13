import { parseTagged } from './tagged.js';
import { parseCheckResult } from './quality.js';

/** Mechanical checks, not an assertion of semantic or translation quality. */
export function evaluateOutput(sample, raw, { stopReason = 'end_turn' } = {}) {
  const failures = [];
  let output = '';
  if (sample.task === 'check') {
    try {
      const result = parseCheckResult(raw, stopReason);
      if (result.status !== sample.verdict) failures.push(`Oczekiwano ${sample.verdict}, otrzymano ${result.status}.`);
      if (sample.issueTypes.length && !result.issues.some((issue) => sample.issueTypes.includes(issue.type))) failures.push('Brak oczekiwanego rodzaju ostrzeżenia.');
    } catch (error) { failures.push(error.message); }
  } else {
    const tag = sample.task === 'translate' ? 'translation' : 'comment';
    output = parseTagged(raw, [tag])[tag] || '';
    if (!output || !raw.includes(`</${tag}>`)) failures.push('Brak kompletnego tekstu w wymaganym formacie.');
    for (const required of sample.task === 'write' ? ['back_translation', 'notes'] : ['notes']) {
      if (!raw.includes(`<${required}>`) || !raw.includes(`</${required}>`)) failures.push(`Brak kompletnego pola ${required}.`);
    }
    if (stopReason !== 'end_turn') failures.push('Model nie zakończył odpowiedzi w zwykły sposób.');
    const lower = output.toLocaleLowerCase();
    for (const term of sample.checks.requires || []) if (!output.includes(term)) failures.push(`Brak wymaganego fragmentu: ${term}`);
    for (const alternatives of sample.checks.requiresAny || []) if (!alternatives.some((term) => lower.includes(term.toLocaleLowerCase()))) failures.push(`Brak któregoś z fragmentów: ${alternatives.join(' / ')}`);
    for (const source of sample.checks.forbids || []) if (new RegExp(source, 'iu').test(output)) failures.push(`Niedozwolony wzorzec: ${source}`);
    if (sample.checks.maxQuestions != null && (output.match(/\?/g) || []).length > sample.checks.maxQuestions) failures.push('Za dużo pytań.');
    const sentences = output.split(/[.!?]+(?:\s|$)/u).filter((part) => part.trim()).length;
    if (sample.checks.maxSentences && sentences > sample.checks.maxSentences) failures.push('Przekroczona liczba zdań (przybliżony pomiar).');
  }
  return { id: sample.id, passedMechanicalChecks: failures.length === 0, failures, needsHumanReview: true, rubric: sample.rubric };
}
