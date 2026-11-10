import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeForSearch, filterHistory, postUrl, removeEntry } from '../../src/lib/history.js';

const entries = [
  { at: 3, kind: 'comment', postKey: 'urn:li:activity:7001', author: 'Volteum', postExcerpt: 'Volteum is heading to Utrecht', final: 'Good luck in Utrecht!' },
  { at: 2, kind: 'message', postKey: 'msg:thread:2-abc', author: '', postExcerpt: '', final: 'Wtorek o 10:00 mi pasuje.' },
  { at: 1, postKey: 'fallback-abc', author: 'Łódź Fleet', postExcerpt: '', final: 'Żółw też dojedzie.' }, // before 0.4.0: no kind
];

test('normalizeForSearch: lower case, no diacritics, ł becomes l', () => {
  assert.equal(normalizeForSearch('ŻÓŁW Łódź Ąę'), 'zolw lodz ae');
});

test('filterHistory finds Polish text without diacritics', () => {
  assert.deepEqual(filterHistory(entries, { kind: 'all', query: 'zolw' }).map((e) => e.at), [1]);
  assert.deepEqual(filterHistory(entries, { kind: 'all', query: 'LODZ' }).map((e) => e.at), [1]);
  assert.deepEqual(filterHistory(entries, { kind: 'all', query: 'heading to' }).map((e) => e.at), [3], 'post excerpt is searched');
  assert.equal(filterHistory(entries, { kind: 'all', query: '  ' }).length, 3, 'blank query keeps everything');
});

test('filterHistory filters by kind and treats legacy entries as comments', () => {
  assert.deepEqual(filterHistory(entries, { kind: 'comment', query: '' }).map((e) => e.at), [3, 1]);
  assert.deepEqual(filterHistory(entries, { kind: 'message', query: '' }).map((e) => e.at), [2]);
  assert.equal(filterHistory(undefined, { kind: 'all', query: '' }).length, 0);
});

test('postUrl builds links only for LinkedIn post URNs', () => {
  assert.equal(postUrl(entries[0]), 'https://www.linkedin.com/feed/update/urn:li:activity:7001/');
  assert.equal(postUrl({ postKey: 'urn:li:ugcPost:42' }), 'https://www.linkedin.com/feed/update/urn:li:ugcPost:42/');
  assert.equal(postUrl({ postKey: 'fallback-abc' }), null);
  assert.equal(postUrl({ postKey: 'msg:thread:2-abc' }), null);
  assert.equal(postUrl({ postKey: 'urn:li:activity:7001/../x' }), null);
  assert.equal(postUrl({ postKey: null }), null);
});

test('removeEntry removes exactly one entry', () => {
  const twins = [...entries, { ...entries[0], at: 9 }];
  const out = removeEntry(twins, entries[0]);
  assert.equal(out.length, 3);
  assert.ok(out.some((e) => e.at === 9), 'same post, other time stays');
  assert.ok(!out.some((e) => e.at === 3 && e.postKey === 'urn:li:activity:7001'));
});
