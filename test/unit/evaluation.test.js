import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVAL_CASES } from '../eval/cases.js';
import { evaluateOutput } from '../../src/lib/evaluation.js';

test('synthetic evaluation set covers distinct comment/DM, translation and quality scenarios', () => {
  assert.equal(EVAL_CASES.length, 34);
  assert.equal(new Set(EVAL_CASES.map((sample) => sample.id)).size, 34);
  for (const task of ['write', 'translate', 'check']) assert.ok(EVAL_CASES.filter((sample) => sample.task === task).length >= 8);
  assert.ok(EVAL_CASES.some((sample) => sample.post?.kind === 'message'));
  assert.ok(EVAL_CASES.every((sample) => sample.rubric));
  assert.ok(EVAL_CASES.some((sample) => sample.post?.kind !== 'message' && sample.aboutMe && sample.voiceNotes));
  assert.ok(EVAL_CASES.some((sample) => sample.post?.kind === 'message' && sample.aboutMe && sample.voiceNotes));
});

test('mechanical evaluator checks the actual output field, not terms hidden in notes', () => {
  const sample = EVAL_CASES.find((item) => item.id === 'post-precise-question');
  const fail = evaluateOutput(sample, '<comment>Great news.</comment><back_translation>Wieści.</back_translation><notes>800 temperature</notes>');
  assert.equal(fail.passedMechanicalChecks, false);
  const pass = evaluateOutput(sample, '<comment>At what temperature were the 800 cycles measured?</comment><back_translation>W jakiej temperaturze?</back_translation><notes></notes>');
  assert.equal(pass.passedMechanicalChecks, true);
  assert.equal(pass.needsHumanReview, true);
});

test('evaluation rejects incomplete protocols, forbidden claims and false success in quality checks', () => {
  const sample = EVAL_CASES.find((item) => item.id === 'dm-decline-not-accept');
  assert.equal(evaluateOutput(sample, '<comment>I cannot attend. I will attend tomorrow.</comment><back_translation></back_translation><notes></notes>').passedMechanicalChecks, false);
  assert.equal(evaluateOutput(sample, '<comment>I cannot attend.</comment>').passedMechanicalChecks, false);
  const quality = EVAL_CASES.find((item) => item.id === 'check-valid-question');
  assert.equal(evaluateOutput(quality, 'Looks good').passedMechanicalChecks, false);
  assert.equal(evaluateOutput(quality, '<verdict>ok</verdict><issues></issues>', { stopReason: 'max_tokens' }).passedMechanicalChecks, false);
});
