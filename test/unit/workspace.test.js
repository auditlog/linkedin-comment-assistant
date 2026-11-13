import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetIdentity, sourceRevision, draftKey } from '../../src/lib/context.js';
import { Operations, abortable } from '../../src/lib/operations.js';
import { DraftRepository, sanitizeDraft, pushVersion, DRAFT_TTL_MS, VERSION_LIMIT, DRAFT_LIMIT } from '../../src/lib/drafts.js';
import { parseCheckResult } from '../../src/lib/quality.js';
import { fetchImageBlock } from '../../src/lib/images.js';
import { mediaCoverage, readAttachment, MAX_ATTACHMENT_BYTES } from '../../src/lib/media.js';
import { buildAnalysisMessages, buildBackTranslationMessages } from '../../src/lib/prompts.js';
import { fetchHarmonicContext } from '../../src/lib/harmonic.js';

const post = { key: 'urn:li:activity:100', text: 'Original selected post', imageUrls: [], kind: 'comment' };
const now = 1800000000000;
function storage() {
  const data = {};
  return { data,
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}

test('context distinguishes replies under one post and ignores transport churn', () => {
  const a = { ...post, replyTo: { key: 'comment:1', author: 'A', text: 'Question one' } };
  const b = { ...post, replyTo: { key: 'comment:2', author: 'B', text: 'Question two' } };
  assert.notEqual(targetIdentity(a), targetIdentity(b));
  assert.notEqual(targetIdentity(a), targetIdentity(post));
  assert.equal(sourceRevision(a), sourceRevision({ ...a, editorToken: 'new', boundAt: 12, tabId: 99, companyContext: 'Public enrichment' }));
  assert.notEqual(sourceRevision(a), sourceRevision({ ...a, text: 'Updated source' }));
  assert.notEqual(sourceRevision(a), sourceRevision({ ...a, replyTo: { ...a.replyTo, text: 'Changed question' } }));
  assert.match(draftKey(a), /^lca:draft:[a-z0-9-]+$/);
  assert.ok(!draftKey(a).includes('Question'));
  assert.equal(sourceRevision({ ...a, authorProfile: { url: 'https://example.com', type: 'person' } }),
    sourceRevision({ ...a, authorProfile: { type: 'person', url: 'https://example.com' } }), 'storage dictionary order cannot invalidate an unchanged editor');
});

test('operations prevent an older finally from removing the replacement operation', () => {
  const ops = new Operations();
  const old = ops.start('write', 'Writing');
  const fresh = ops.start('write', 'Replacement');
  assert.equal(old.signal.aborted, true);
  assert.equal(old.owns(), false);
  ops.finish(old);
  assert.equal(fresh.current(), true);
  ops.cancel('write');
  assert.equal(fresh.current(), false);
  assert.equal(fresh.owns(), true, 'cancel keeps ownership so the previous draft can be restored');
});

test('post reset aborts only post tasks, leaving selection translation running', () => {
  const ops = new Operations();
  const source = ops.start('analysis', 'Analyze');
  const independent = ops.start('selection', 'Translate', 'selection');
  ops.cancelAll({ scope: 'post', discard: true });
  assert.equal(source.owns(), false);
  assert.equal(independent.current(), true);
});

test('abortable stops waiting even when the underlying work ignores the signal', async () => {
  const controller = new AbortController();
  const waiting = abortable(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('drafts strip credentials, source transcript, model history, thoughts and attachment data', () => {
  const own = { at: now, comment: 'My own reply', instruction: 'Reply politely', versions: [{ comment: 'Earlier reply', at: now, thinking: 'Private source' }] };
  const result = sanitizeDraft({ ...own, apiKey: 'not-a-real-key', post: { text: 'Private source' },
    conversation: [{ content: 'Private source' }], thinking: 'Private source', attachments: [{ data: 'Private source' }] }, now);
  assert.equal(result.comment, own.comment);
  assert.equal(result.versions[0].comment, 'Earlier reply');
  assert.doesNotMatch(JSON.stringify(result), /Private source|not-a-real-key|apiKey|conversation|attachments/);
  assert.equal(sanitizeDraft({ ...own, at: now - DRAFT_TTL_MS - 1 }, now), null);
});

test('versions retain a bounded set of distinct own texts', () => {
  let versions = [];
  for (let i = 0; i < 20; i++) versions = pushVersion(versions, { at: now + i, comment: `Own version ${i}` });
  assert.equal(versions.length, VERSION_LIMIT);
  assert.equal(versions.at(-1).comment, 'Own version 19');
  versions = pushVersion(versions, { at: now, comment: 'Own version 19' });
  assert.equal(versions.length, VERSION_LIMIT);
});

test('worker draft queue writes in order, recovers across panels and keeps persistence opt-in', async () => {
  const session = storage(), local = storage();
  const repo = new DraftRepository(session, local, () => now);
  const key = draftKey(post);
  const first = repo.save(key, { at: now, comment: 'First' });
  const last = repo.save(key, { at: now + 1, comment: 'Latest' });
  const read = repo.load(key);
  await Promise.all([first, last]);
  assert.equal((await read).comment, 'Latest');
  assert.equal(local.data[key], undefined);
  await repo.save(key, { at: now + 2, comment: 'Persistent own text' }, true);
  const replacement = new DraftRepository(storage(), local, () => now);
  assert.equal((await replacement.load(key)).comment, 'Persistent own text');
  await replacement.clearPersistent();
  assert.equal(await replacement.load(key), null);
});

test('draft repository rejects foreign keys and prunes expired/excess drafts', async () => {
  const session = storage(), local = storage();
  const repo = new DraftRepository(session, local, () => now);
  await repo.save('settings', { at: now, comment: 'No overwrite' }, true);
  assert.equal(session.data.settings, undefined);
  for (let i = 0; i < DRAFT_LIMIT + 3; i++) await repo.save(`lca:draft:${i}`, { at: now + i, comment: `Draft ${i}` }, true);
  assert.equal(Object.keys(local.data).filter((key) => key.startsWith('lca:draft:')).length, DRAFT_LIMIT);
  assert.equal(await repo.load('lca:draft:0'), null);
});

test('quality never reports success for missing, truncated, inconsistent or empty warning output', () => {
  for (const raw of ['Unexpected plain text', '<verdict>ok</verdict>', '<verdict>ok</verdict><issues>',
    '<verdict>warn</verdict><issues></issues>', '<verdict>ok</verdict><issues><issue type="language">Bad grammar</issue></issues>']) {
    assert.throws(() => parseCheckResult(raw));
  }
  assert.throws(() => parseCheckResult('<verdict>ok</verdict><issues></issues>', 'max_tokens'));
  assert.deepEqual(parseCheckResult('<verdict>ok</verdict><issues></issues>'), { status: 'ok', issues: [] });
  assert.equal(parseCheckResult('<verdict>warn</verdict><issues><issue type="commitment">Unrequested promise</issue></issues>').status, 'warn');
});

test('image preparation has a timeout and respects user cancellation before any API call', async () => {
  assert.equal(await fetchImageBlock('https://media.licdn.com/test.png', () => new Promise(() => {}), { timeoutMs: 10 }), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchImageBlock('https://media.licdn.com/test.png', () => { throw new Error('must not fetch'); }, { signal: controller.signal }), { name: 'AbortError' });
});

test('Harmonic cancellation remains active while waiting for the response body', async () => {
  const controller = new AbortController();
  let began;
  const readingBody = new Promise((resolve) => began = resolve);
  const call = fetchHarmonicContext({ profile: { type: 'company', url: 'https://www.linkedin.com/company/example/' }, apiKey: 'synthetic', signal: controller.signal,
    fetchFn: async () => ({ status: 200, ok: true, text: () => { began(); return new Promise(() => {}); } }),
  });
  await readingBody;
  controller.abort();
  await assert.rejects(call, { name: 'AbortError' });
});

test('manual attachment rejects oversized/foreign/mislabelled content and accepts image bytes', async () => {
  await assert.rejects(readAttachment({ type: 'application/pdf', size: 10 }), /PNG/);
  await assert.rejects(readAttachment({ type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 }), /3,5 MB/);
  await assert.rejects(readAttachment({ type: 'image/png', size: 8, async arrayBuffer() { return new TextEncoder().encode('<script>').buffer; } }), /poprawnego obrazu/);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const attachment = await readAttachment({ name: 'Slide.png', type: 'image/png', size: bytes.length, async arrayBuffer() { return bytes.buffer; } });
  assert.equal(attachment.block.type, 'image');
  assert.equal(attachment.name, 'Slide.png');
});

test('media context states missing coverage and includes polls without inventing unseen pages', () => {
  const document = { ...post, media: { kind: 'document', title: 'Roadmap', totalPages: 12, pages: [] } };
  assert.match(mediaCoverage(document), /bez slajdów/);
  assert.match(mediaCoverage(document, { imageCount: 2, failed: 1 }), /Obrazy stron w zapytaniu: 2.*Liczba stron dokumentu: 12/s);
  assert.match(mediaCoverage(document, { failed: 1 }), /Nie pobrano 1/);
  const poll = { ...post, media: { kind: 'poll', question: 'Which date?', options: ['Monday', 'Friday'], complete: true } };
  assert.match(buildAnalysisMessages(poll)[0].content, /<poll>[\s\S]*Monday[\s\S]*Friday/);
  assert.match(buildBackTranslationMessages('No <secret> promises')[0].content, /No ‹secret› promises/);
});

test('draft budget prunes older records and expiry cleanup never removes unrelated settings', async () => {
  const session = storage(), local = storage();
  let clock = now;
  const repo = new DraftRepository(session, local, () => clock);
  await local.set({ settings: { privateSetting: 'keep' } });
  const own = { comment: 'x'.repeat(20000), translation: 'y'.repeat(20000), generated: 'z'.repeat(20000), translationFor: 'x'.repeat(20000) };
  for (let i = 0; i < 8; i++) await repo.save(`lca:draft:${i}`, { ...own, at: now + i, versions: Array.from({ length: 8 }, () => ({ ...own, at: now })) }, true);
  assert.ok(local.data['lca:draftIndex'].reduce((sum, entry) => sum + entry.bytes, 0) <= 4000000);
  assert.equal((await repo.load('lca:draft:7')).comment.length, 20000);
  clock = now + DRAFT_TTL_MS + 100;
  await repo.prune();
  assert.equal(Object.keys(local.data).filter((key) => key.startsWith('lca:draft:')).length, 0);
  assert.equal(local.data.settings.privateSetting, 'keep');
});

test('persistence consent is evaluated when the worker commits, not when the panel queues a write', async () => {
  const session = storage(), local = storage();
  const repo = new DraftRepository(session, local, () => now);
  let consent = true;
  const save = repo.save(draftKey(post), { at: now, comment: 'Own text' }, () => consent);
  consent = false;
  await save;
  assert.equal(local.data[draftKey(post)], undefined);
  assert.equal((await repo.load(draftKey(post))).comment, 'Own text');
});
