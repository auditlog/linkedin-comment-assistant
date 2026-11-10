import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  buildBackup,
  backupFileName,
  parseBackup,
  mergeHistory,
  applyBackupSettings,
  describeImport,
} from '../../src/lib/backup.js';
import { mergeSettings } from '../../src/lib/settings.js';
import { HISTORY_LIMIT } from '../../src/lib/voice.js';

const settings = mergeSettings({
  apiKeys: { anthropic: 'sk-ant-secret', openrouter: 'sk-or-secret' },
  harmonicApiKey: 'harmonic-secret',
  aboutMe: 'CTO w firmie flotowej',
  effort: 'high',
});
const entry = (at, postKey, final = `Text ${at}`) => ({ at, kind: 'comment', postKey, author: 'A', postExcerpt: 'P', instruction: '', generated: final, final, edited: false, language: 'en' });
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

test('buildBackup leaves API keys out unless asked', () => {
  const plain = buildBackup({ settings, history: [], includeKeys: false, extensionVersion: '0.5.0', now: NOW });
  assert.equal(plain.format, BACKUP_FORMAT);
  assert.equal(plain.version, BACKUP_VERSION);
  assert.equal(plain.exportedAt, '2026-11-10T12:00:00.000Z');
  assert.equal(plain.extensionVersion, '0.5.0');
  assert.deepEqual(plain.settings.apiKeys, { anthropic: '', openrouter: '' });
  assert.equal(plain.settings.harmonicApiKey, '');
  assert.equal(plain.settings.aboutMe, 'CTO w firmie flotowej');
  assert.equal(settings.apiKeys.anthropic, 'sk-ant-secret', 'the input object is not changed');
  const withKeys = buildBackup({ settings, history: [], includeKeys: true, extensionVersion: '0.5.0', now: NOW });
  assert.equal(withKeys.settings.apiKeys.anthropic, 'sk-ant-secret');
  assert.equal(withKeys.settings.harmonicApiKey, 'harmonic-secret');
});

test('backupFileName uses the local date', () => {
  assert.equal(backupFileName(new Date(2026, 0, 5, 23, 30).getTime()), 'asystent-linkedin-kopia-2026-01-05.json');
});

test('parseBackup round-trips a backup', () => {
  const history = [entry(2, 'urn:li:activity:2'), entry(1, 'urn:li:activity:1')];
  const text = JSON.stringify(buildBackup({ settings, history, includeKeys: false, extensionVersion: '0.5.0', now: NOW }));
  const result = parseBackup(text);
  assert.equal(result.ok, true);
  assert.equal(result.backup.settings.aboutMe, 'CTO w firmie flotowej');
  assert.equal(result.backup.settings.effort, 'high');
  assert.equal(result.backup.history.length, 2);
  assert.equal(result.backup.exportedAt, '2026-11-10T12:00:00.000Z');
  assert.equal(result.backup.hasKeys, false);
  const withKeys = parseBackup(JSON.stringify(buildBackup({ settings, history, includeKeys: true, extensionVersion: '0.5.0', now: NOW })));
  assert.equal(withKeys.backup.hasKeys, true);
});

test('parseBackup rejects bad files with specific messages', () => {
  const valid = buildBackup({ settings, history: [], includeKeys: false, extensionVersion: '0.5.0', now: NOW });
  const cases = [
    'not json {',
    JSON.stringify({ format: 'x' }),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, settings: null }),
    JSON.stringify({ ...valid, history: {} }),
    'x'.repeat(MAX_BACKUP_BYTES + 1),
  ];
  const errors = cases.map((text) => parseBackup(text));
  for (const result of errors) {
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 20, result.error);
  }
  assert.equal(new Set(errors.map((r) => r.error)).size, cases.length, 'each problem has its own message');
  assert.match(errors[2].error, /2/, 'names the unsupported version');
});

test('parseBackup drops malformed history entries and caps at the limit', () => {
  const valid = buildBackup({ settings, history: [], includeKeys: false, extensionVersion: '0.5.0', now: NOW });
  const many = Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => entry(1000 - i, `urn:li:activity:${i}`));
  const bad = [null, 'text', { at: 5, final: '' }, { at: 'yesterday', final: 'x' }, { at: 6, final: 42 }, { at: 7, final: 'ok', kind: 'evil', edited: 'yes', author: 5 }];
  const result = parseBackup(JSON.stringify({ ...valid, history: [...bad, ...many] }));
  assert.equal(result.ok, true);
  assert.equal(result.backup.history.length, HISTORY_LIMIT);
  const kept = result.backup.history.find((e) => e.at === 7);
  assert.ok(kept, 'the entry with a valid final text is kept');
  assert.equal(kept.kind, 'comment');
  assert.equal(kept.edited, false);
  assert.equal(kept.author, '');
  assert.ok(!result.backup.history.some((e) => e.at === 5 || e.at === 6));
});

test('mergeHistory keeps the newer entry per post and caps at 100', () => {
  const current = [entry(10, 'urn:li:activity:1', 'current newer'), entry(5, 'urn:li:activity:2', 'current older'), entry(4, null, 'no key')];
  const imported = [entry(8, 'urn:li:activity:1', 'imported older'), entry(9, 'urn:li:activity:2', 'imported newer'), entry(4, null, 'no key'), entry(3, 'urn:li:activity:3', 'only in file')];
  const merged = mergeHistory(current, imported);
  assert.deepEqual(merged.map((e) => e.final), ['current newer', 'imported newer', 'no key', 'only in file']);
  const big = Array.from({ length: 80 }, (_, i) => entry(i, `urn:li:activity:a${i}`));
  const big2 = Array.from({ length: 80 }, (_, i) => entry(100 + i, `urn:li:activity:b${i}`));
  const capped = mergeHistory(big, big2);
  assert.equal(capped.length, HISTORY_LIMIT);
  assert.equal(capped[0].at, 179, 'newest first');
});

test('applyBackupSettings keeps current keys when the file has none', () => {
  const current = mergeSettings({ apiKeys: { anthropic: 'sk-ant-current', openrouter: '' }, harmonicApiKey: 'h-current', aboutMe: 'stare' });
  const imported = mergeSettings({ apiKeys: { anthropic: '', openrouter: 'sk-or-file' }, harmonicApiKey: '', aboutMe: 'nowe', localDefaultsApplied: false });
  const next = applyBackupSettings(current, imported);
  assert.equal(next.aboutMe, 'nowe');
  assert.equal(next.apiKeys.anthropic, 'sk-ant-current');
  assert.equal(next.apiKeys.openrouter, 'sk-or-file');
  assert.equal(next.harmonicApiKey, 'h-current');
  assert.equal(next.localDefaultsApplied, true);
});

test('describeImport counts new history entries', () => {
  const current = { settings, history: [entry(10, 'urn:li:activity:1')] };
  const backup = { settings: mergeSettings({}), history: [entry(9, 'urn:li:activity:1'), entry(8, 'urn:li:activity:2'), entry(7, 'urn:li:activity:3')], hasKeys: false, exportedAt: '2026-11-10T12:00:00.000Z' };
  const lines = describeImport(current, backup);
  assert.ok(lines.some((l) => /zostaną zastąpione/.test(l)));
  assert.ok(lines.includes('Klucze API: brak w pliku, zostaną obecne.'));
  assert.ok(lines.includes('Historia: 3 wpisy w pliku, w tym 2 nowe.'), lines.join(' | '));
  assert.ok(describeImport(current, { ...backup, hasKeys: true }).includes('Klucze API: zostaną wczytane z pliku.'));
  assert.ok(describeImport(current, { ...backup, history: [] }).includes('Historia: brak wpisów w pliku, obecna zostaje bez zmian.'));
});
