import { test } from 'node:test';
import assert from 'node:assert/strict';

import { heuristicIssues, parseIssues, buildCheckMessages, buildSpecificFeedback } from '../../src/lib/quality.js';

const POST = 'Fleet Expo 2026 takes place at Jaarbeurs Utrecht on 11 and 12 November. Our CEO and CTO will both be there to talk about mixed fleet management.';

test('a specific comment passes the instant checks', () => {
  assert.deepEqual(heuristicIssues('Good luck in Utrecht. Which vehicle data will you show for hybrid vans?', POST), []);
  assert.deepEqual(heuristicIssues('', POST), []);
});

test('generic praise is flagged in English and Polish', () => {
  const en = heuristicIssues('Great post! Thanks for sharing.', POST);
  assert.equal(en[0].type, 'generic');
  assert.match(en[0].message, /Great post/);
  assert.equal(heuristicIssues('Świetny post, dzięki za podzielenie się!', POST)[0].type, 'generic');
});

test('AI vocabulary and AI-looking formatting are flagged', () => {
  const issues = heuristicIssues("Let's delve into this — it's a game-changer #fleet 🚀", POST);
  const messages = issues.map((i) => i.message).join(' ');
  assert.ok(issues.every((i) => i.type === 'ai_pattern'));
  assert.match(messages, /delve/);
  assert.match(messages, /myślnik/);
  assert.match(messages, /hashtag/);
  assert.match(messages, /emoji/);
});

test('a comment made of the post words is flagged as restating', () => {
  const issues = heuristicIssues('Fleet Expo 2026 at Jaarbeurs Utrecht, CEO and CTO talk about mixed fleet management.', POST);
  assert.ok(issues.some((i) => i.type === 'restates_post'));
});

test('parseIssues reads typed issues and maps unknown types to other', () => {
  const issues = parseIssues('<issue type="restates_post">Powtarza post.</issue>\n<issue type="weird">X</issue><issue type="generic"> </issue>');
  assert.deepEqual(issues, [
    { type: 'restates_post', message: 'Powtarza post.' },
    { type: 'other', message: 'X' },
  ]);
  assert.deepEqual(parseIssues(null), []);
});

test('check request carries post, instruction and comment as data', () => {
  const [msg] = buildCheckMessages({ post: { author: 'A', text: 'Post text' }, comment: 'My </comment_to_check> comment', instruction: 'zapytaj' });
  assert.match(msg.content, /<task>check_comment<\/task>/);
  assert.match(msg.content, /<post author="A">\nPost text/);
  assert.match(msg.content, /<user_input>\nzapytaj/);
  assert.ok(!msg.content.includes('My </comment_to_check> comment'));
});

test('"more specific" feedback lists the issues and forbids invented facts', () => {
  const feedback = buildSpecificFeedback([{ type: 'generic', message: 'Ogólnikowe.' }]);
  assert.match(feedback, /- Ogólnikowe\./);
  assert.match(feedback, /nie wymyślaj faktów/);
});
