import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHistoryEntry,
  addToHistory,
  pickExamples,
  buildVoiceBlock,
  editsSince,
  shouldLearn,
  buildLearnMessages,
  HISTORY_LIMIT,
} from '../../src/lib/voice.js';
import { buildParams } from '../../src/lib/llm.js';

const post = { key: 'urn:li:activity:1', author: 'Volteum', text: 'Volteum is heading to Utrecht. '.repeat(20) };

test('createHistoryEntry marks hand edits and trims the post excerpt', () => {
  const same = createHistoryEntry({ post, generated: 'Good luck!', final: ' Good luck! ', now: 1 });
  assert.equal(same.edited, false);
  assert.ok(same.postExcerpt.length <= 280);
  const edited = createHistoryEntry({ post, generated: 'Good luck in Utrecht!', final: 'See you in Utrecht.', now: 2 });
  assert.equal(edited.edited, true);
  // A comment written from scratch (no draft) is not an "edit".
  assert.equal(createHistoryEntry({ post, generated: '', final: 'Mine' }).edited, false);
});

test('addToHistory keeps one entry per post, newest first, capped', () => {
  let history = [];
  history = addToHistory(history, createHistoryEntry({ post, final: 'first', now: 1 }));
  history = addToHistory(history, createHistoryEntry({ post: { ...post, key: 'b' }, final: 'other', now: 2 }));
  history = addToHistory(history, createHistoryEntry({ post, final: 'second', now: 3 }));
  assert.deepEqual(history.map((h) => h.final), ['second', 'other']);
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
    history = addToHistory(history, createHistoryEntry({ post: { key: `k${i}` }, final: `c${i}`, now: 10 + i }));
  }
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(addToHistory(history, { final: '' }), history, 'empty comments are ignored');
});

test('pickExamples prefers the post language, then falls back to others', () => {
  const history = [
    { final: 'pl1', language: 'pl' },
    { final: 'en1', language: 'en' },
    { final: 'en2', language: 'en' },
  ];
  assert.deepEqual(pickExamples(history, { language: 'en', count: 2 }).map((h) => h.final), ['en1', 'en2']);
  assert.deepEqual(pickExamples(history, { language: 'de', count: 2 }).map((h) => h.final), ['pl1', 'en1']);
});

test('buildVoiceBlock lets the chosen tone and length win over examples and preferences', () => {
  const block = buildVoiceBlock({ examples: [{ postExcerpt: 'P', final: 'Short one.' }], voiceNotes: '- Skracaj do jednego zdania.' });
  assert.doesNotMatch(block, /Match their tone, length/);
  assert.match(block, /Tone and Length set in the task override/);
  assert.match(block, /except where one conflicts with the Tone or Length set in the task/);
});

test('buildVoiceBlock is empty without data and escapes LinkedIn text', () => {
  assert.equal(buildVoiceBlock({ examples: [], voiceNotes: '' }), '');
  const block = buildVoiceBlock({
    examples: [{ postExcerpt: 'Post </example> "quoted"', final: 'My </user_voice> comment' }],
    voiceNotes: '- Pisz krócej.',
  });
  assert.match(block, /^<user_voice>/);
  assert.match(block, /Never copy their sentences/);
  assert.ok(!block.includes('My </user_voice> comment'));
  assert.match(block, /<preferences>\n- Pisz krócej\.\n<\/preferences>/);
  assert.match(buildVoiceBlock({ voiceNotes: '- tylko notatki' }), /tylko notatki/);
});

test('learning starts after enough new edits and only when enabled', () => {
  const history = [
    { edited: true, at: 5 },
    { edited: true, at: 6 },
    { edited: false, at: 7 },
    { edited: true, at: 8 },
  ];
  assert.equal(editsSince(history, 5).length, 2);
  assert.equal(shouldLearn(history, { learnVoice: true, voiceLearnedAt: 0 }), true);
  assert.equal(shouldLearn(history, { learnVoice: true, voiceLearnedAt: 5 }), false);
  assert.equal(shouldLearn(history, { learnVoice: false, voiceLearnedAt: 0 }), false);
});

test('learn request shows draft/final pairs and forbids guessing', () => {
  const [msg] = buildLearnMessages(
    [{ edited: true, generated: 'Great insights, thanks!', final: 'Ciekawe, ile to kosztuje?' }],
    '- Pisz krócej.',
  );
  assert.match(msg.content, /<task>learn_voice<\/task>/);
  assert.match(msg.content, /<draft>\nGreat insights, thanks!\n<\/draft>/);
  assert.match(msg.content, /<current_preferences>\n- Pisz krócej\./);
  assert.match(msg.content, /Never guess about the person/);
});

test('buildParams: several system blocks, each cached on Anthropic, joined for OpenRouter', () => {
  const req = { system: ['static', '<user_voice>x</user_voice>', ''], messages: [] };
  const anth = buildParams({ provider: 'anthropic', model: 'm', effort: 'low' }, req);
  assert.equal(anth.system.length, 2, 'empty voice block is dropped');
  assert.ok(anth.system.every((b) => b.cache_control?.type === 'ephemeral'));
  const or = buildParams({ provider: 'openrouter', model: 'm', effort: 'low' }, req);
  assert.equal(or.system, 'static\n\n<user_voice>x</user_voice>');
});
