// End-to-end test of the built extension (dist/) in Chromium:
// LinkedIn and the model APIs are replaced by local fixtures/mocks, so the test
// is free, needs no API key and no LinkedIn login.
// Run: npm run test:e2e

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/chromium.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const distDir = path.join(projectRoot, 'dist');

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const ANALYSIS_REPLY = `<translation>Volteum jedzie do Utrechtu. Targi Fleet Expo 2026 odbędą się w Jaarbeurs Utrecht 11 i 12 listopada.</translation>
<image_note>Zapowiedź stoiska na Fleet Expo 2026 z CEO i CTO.</image_note>
<post_language>en</post_language>
<ideas>
<idea>Zapytaj, jakie dane z pojazdów hybrydowych pokażą na stoisku.</idea>
<idea>Podziel się doświadczeniem z flotą mieszaną w Polsce.</idea>
<idea>Pogratuluj wejścia na rynek holenderski, nawiązując do stref zeroemisyjnych.</idea>
</ideas>`;

const COMMENT_REPLY = `<comment>Good luck in Utrecht! Which vehicle data will you show for mixed fleets at the booth?</comment>
<back_translation>Powodzenia w Utrechcie! Jakie dane z pojazdów pokażecie dla flot mieszanych na stoisku?</back_translation>
<notes>
- „Mixed fleets” to naturalne określenie floty mieszanej.
</notes>`;

const REFINED_REPLY = `<comment>Good luck in Utrecht, see you at the booth!</comment>
<back_translation>Powodzenia w Utrechcie, do zobaczenia na stoisku!</back_translation>
<notes>
- brak uwag
</notes>`;

/** Build an SSE body like the Messages API stream: a thinking block, then the text in chunks. */
function sseBody(text, model) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-test' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ];
  for (let i = 0; i < text.length; i += 40) {
    events.push(['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(i, i + 40) } }]);
  }
  events.push(
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 400 } }],
    ['message_stop', { type: 'message_stop' }],
  );
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

let context;
let extensionId;
let serviceWorker;
let userDataDir;
let extensionDir; // temp copy of dist/ with a test defaults.json (keeps the user's own defaults out of tests)
const apiRequests = []; // {url, headers, body}
const harmonicRequests = []; // {url, method, headers}

async function mockHarmonic(route) {
  const request = route.request();
  const url = new URL(request.url());
  harmonicRequests.push({ url: request.url(), method: request.method(), headers: await request.allHeaders() });
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/persons') {
    return json({
      full_name: 'Jan Kowalski',
      linkedin_headline: 'CTO w DataCorp',
      experience: [{ title: 'CTO', company_name: 'DataCorp', is_current_position: true }],
      current_company_urns: ['urn:harmonic:company:77'],
    });
  }
  if (url.pathname.startsWith('/companies/')) {
    return json({ name: 'DataCorp', headcount: 120, stage: 'SEED', funding: { funding_total: 3200000, last_funding_at: '2026-03-15T00:00:00Z', investors: [{ name: 'Example Ventures' }] } });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
}

function lastUserText(body) {
  const last = body.messages[body.messages.length - 1];
  if (typeof last.content === 'string') return last.content;
  return last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function mockApi(route) {
  const request = route.request();
  const body = JSON.parse(request.postData() || '{}');
  const headers = await request.allHeaders();
  apiRequests.push({ url: request.url(), headers, body });
  // API version 2026-10-21: SDKs send API keys as "Authorization: Bearer", not "x-api-key".
  if ((headers.authorization || '') === 'Bearer sk-ant-bad') {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    });
    return;
  }
  const userText = lastUserText(body);
  let reply = 'OK';
  if (userText.includes('<task>check_comment</task>')) {
    // The first draft "restates the post"; the refined one passes.
    reply = userText.includes('see you at the booth')
      ? '<verdict>ok</verdict>\n<issues></issues>'
      : '<verdict>warn</verdict>\n<issues>\n<issue type="restates_post">Komentarz powtarza informacje z posta o targach.</issue>\n</issues>';
  } else if (userText.includes('<task>analyze_post</task>')) reply = ANALYSIS_REPLY;
  else if (userText.includes('<task>write_comment</task>')) reply = COMMENT_REPLY;
  else if (userText.includes('<feedback>')) reply = REFINED_REPLY;
  else if (userText.includes('<task>learn_voice</task>')) reply = '<preferences>\n- Pisz krócej i bez pytania na końcu.\n</preferences>';
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody(reply, body.model) });
}

before(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'lca-e2e-'));
  extensionDir = await mkdtemp(path.join(os.tmpdir(), 'lca-ext-'));
  await cp(distDir, extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, 'defaults.json'),
    JSON.stringify({ aboutMe: 'Testowe O mnie z pliku lokalnego', apiKeys: { anthropic: 'sk-ant-from-file' } }),
  );
  const launch = chromiumLaunchOptions(projectRoot);
  context = await chromium.launchPersistentContext(userDataDir, {
    ...launch,
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const fixture = await readFile(path.join(here, 'fixtures', 'feed.html'), 'utf8');
  await context.route('https://www.linkedin.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  await context.route('https://media.licdn.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await context.route('https://api.anthropic.com/**', mockApi);
  await context.route('https://openrouter.ai/**', mockApi);
  await context.route('https://api.harmonic.ai/**', mockHarmonic);

  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(serviceWorker.url()).host;
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, aboutMe: 'CTO w polskiej firmie flotowej' },
    }),
  );
});

after(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  if (extensionDir) await rm(extensionDir, { recursive: true, force: true });
});

// Optional screenshots for visual review: LCA_SCREENSHOTS=/some/dir npm run test:e2e
async function snap(page, name) {
  const dir = process.env.LCA_SCREENSHOTS;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

async function boundPost() {
  return serviceWorker.evaluate(async () => (await chrome.storage.session.get('boundPost')).boundPost);
}

// Follow mode: focusing a comment box binds its post (no button on the page anymore).
async function focusPost(page, editorSelector) {
  const before = (await boundPost())?.boundAt ?? 0;
  await page.locator(editorSelector).click();
  for (let i = 0; i < 50; i++) {
    const post = await boundPost();
    if (post && post.boundAt !== before) return post;
    await page.waitForTimeout(100);
  }
  throw new Error('post was not bound');
}

test('full flow: bind post, analyze, write, refine, insert', async () => {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');

  const htmlBefore = await page.evaluate(() => document.body.outerHTML);
  const post = await focusPost(page, '#editor1');
  // Zero footprint: reading the post must not change LinkedIn's page at all.
  assert.equal(await page.evaluate(() => document.body.outerHTML), htmlBefore, 'page DOM unchanged');
  assert.equal(await page.locator('#lca-host').count(), 0, 'no overlay button');
  assert.equal(post.author, 'Volteum');
  assert.equal(post.key, 'urn:li:activity:7001');
  assert.match(post.text, /Volteum is heading to Utrecht/);
  assert.doesNotMatch(post.text, /The Netherlands is our next market/, '"…więcej" is not clicked automatically');
  assert.equal(post.hasSeeMore, true);
  assert.equal(post.authorHeadline, '', 'a follower count is not a headline');
  assert.deepEqual(post.authorProfile, { url: 'https://www.linkedin.com/company/volteum/', type: 'company' });
  assert.deepEqual(post.existingComments.map((c) => c.author), ['Anna Nowak', 'Piotr Zieliński']);
  assert.doesNotMatch(post.text, /Great news!/, 'comments must not leak into the post text');
  assert.doesNotMatch(post.text, /Lubię to|12 komentarzy/, 'UI labels must be removed');
  assert.deepEqual(post.imageUrls, ['https://media.licdn.com/dms/image/fleet-expo-banner.png']);
  assert.equal(post.replyTo, null);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();

  // Expanding "…more" happens only on the user's click in the panel.
  await panel.locator('#expandPost').click();
  await panel.waitForFunction(() => document.getElementById('postTextEdit').value.includes('The Netherlands is our next market'));
  assert.equal(await panel.locator('#seeMoreRow').isHidden(), true);

  // Auto analysis: translation + 3 ideas.
  await panel.locator('#translation', { hasText: 'Volteum jedzie do Utrechtu' }).waitFor({ timeout: 10000 });
  await panel.locator('#ideas button').nth(2).waitFor();
  assert.equal(await panel.locator('#ideas button').count(), 3);
  assert.match(await panel.locator('#imageNote').textContent(), /Na grafice:/);
  await snap(panel, '1-analysis');
  await snap(page, '0-linkedin-button');

  const analysisReq = apiRequests.find((r) => lastUserText(r.body).includes('<task>analyze_post</task>'));
  assert.ok(analysisReq, 'analysis request sent');
  assert.equal(analysisReq.headers.authorization, 'Bearer sk-ant-test');
  assert.equal(analysisReq.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(analysisReq.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.equal(analysisReq.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(analysisReq.body.output_config, { effort: 'low' });
  assert.equal(analysisReq.body.fallbacks, 'default');
  assert.equal(analysisReq.body.system[0].cache_control.type, 'ephemeral', 'system prompt cached on Anthropic');
  assert.match(analysisReq.body.system[0].text, /CTO w polskiej firmie flotowej/);
  assert.match(analysisReq.body.system[0].text, /<style_en>[\s\S]*<style_pl>/);
  const firstContent = analysisReq.body.messages[0].content;
  assert.equal(firstContent[0].type, 'image', 'post image is sent before the text');
  assert.equal(firstContent[0].source.media_type, 'image/png');

  // Pick an idea, write the comment.
  await panel.locator('#ideas button').first().click();
  assert.match(await panel.locator('#instruction').inputValue(), /Zapytaj, jakie dane/);
  await panel.locator('#writeComment').click();
  // Wait for the end of the stream (the textarea is read-only while text is arriving).
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value.startsWith('Good luck in Utrecht! Which');
  });
  assert.match(await panel.locator('#backTranslation').textContent(), /Powodzenia w Utrechcie/);
  assert.equal(await panel.locator('#notes li').count(), 1);
  assert.match(await panel.locator('#costLine').textContent(), /Sonnet 5\.5.*~\d+,\d c/);
  await snap(panel, '2-comment');

  const writeReq = apiRequests.find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
  assert.match(lastUserText(writeReq.body), /Zapytaj, jakie dane/);
  assert.match(lastUserText(writeReq.body), /Language of the comment: the language the post is written in/);

  // Quality check flags the draft before insertion; "Konkretniej" refines with the issues as feedback.
  await panel.locator('#qualityStatus', { hasText: 'Zanim wstawisz' }).waitFor({ timeout: 10000 });
  await snap(panel, '2b-quality-warning');
  assert.match(await panel.locator('#qualityIssues').textContent(), /powtarza informacje z posta/);
  const checkReq = apiRequests.find((r) => lastUserText(r.body).includes('<task>check_comment</task>'));
  assert.match(lastUserText(checkReq.body), /<comment_to_check>\nGood luck in Utrecht! Which/);
  await panel.locator('#makeSpecific').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value === 'Good luck in Utrecht, see you at the booth!';
  });
  await panel.locator('#qualityStatus', { hasText: 'Komentarz jest konkretny' }).waitFor({ timeout: 10000 });
  const refineReq = apiRequests.find((r) => lastUserText(r.body).includes('<feedback>'));
  assert.match(lastUserText(refineReq.body), /Komentarz ma problemy:\n- Komentarz powtarza informacje z posta o targach\./);
  assert.equal(refineReq.body.messages.length, 3);
  assert.equal(refineReq.body.messages[1].role, 'assistant');
  assert.equal(refineReq.body.messages[1].content[0].type, 'thinking');
  assert.equal(refineReq.body.messages[1].content[0].signature, 'sig-test');
  assert.equal(await panel.locator('#notesWrap').isHidden(), true, '"brak uwag" hides the notes list');

  // Insert into the LinkedIn editor under the right post.
  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Wstawiono' }).waitFor();
  assert.equal((await page.locator('#editor1').innerText()).trim(), 'Good luck in Utrecht, see you at the booth!');
  assert.equal((await page.locator('#editor2').innerText()).trim(), '', 'other posts stay untouched');
  const history = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  assert.equal(history.length, 1, 'inserted comment is remembered for the user voice');
  assert.equal(history[0].final, 'Good luck in Utrecht, see you at the booth!');
  assert.equal(history[0].edited, false);
  assert.equal(history[0].language, 'en');

  // Focusing another post while work is in progress must not drop it: a banner offers the switch.
  await page.locator('#editor2').click();
  await panel.locator('#pendingPost').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await panel.locator('#pendingPostText').textContent(), /Jan Kowalski/);
  assert.equal(await panel.locator('#postAuthor').textContent(), 'Volteum');
  assert.match(await panel.locator('#commentText').inputValue(), /Good luck in Utrecht/);
  await panel.locator('#switchPost').click();
  await panel.locator('#postAuthor', { hasText: 'Jan Kowalski' }).waitFor();
  assert.equal(await panel.locator('#pendingPost').isHidden(), true);

  await panel.close();
  await page.close();
});

test('reply box: post plus the comment being answered', async () => {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const post = await focusPost(page, '#replyEditor');
  assert.equal(post.author, 'Volteum');
  assert.match(post.text, /heading to Utrecht/);
  assert.equal(post.replyTo.author, 'Anna Nowak');
  assert.match(post.replyTo.text, /hybrid fleet dashboard/);
  assert.deepEqual(post.existingComments.map((c) => c.author), ['Piotr Zieliński'], 'the comment being answered is not repeated');
  await page.close();
});

test('photo lightbox like in the screenshot ("Złóż życzenia…")', async () => {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/update/urn:li:activity:7001/');
  const post = await focusPost(page, '#lightboxEditor');
  assert.equal(post.author, 'Volteum');
  assert.match(post.text, /The Netherlands is our next market/);
  assert.doesNotMatch(post.text, /Pokaż tłumaczenie/);
  assert.equal(post.imageUrls.length, 1);
  await page.close();
});

test('OpenRouter via settings form: Bearer token, OpenRouter model id, no Anthropic-only params', async () => {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  await focusPost(page, '#editor2');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#settingsToggle').click();
  await panel.locator('input[name="provider"][value="openrouter"]').check();
  await panel.locator('#apiKey').fill('sk-or-test');
  await panel.locator('#settingsView button[type="submit"]').click();
  await panel.locator('#settingsStatus', { hasText: 'Zapisano.' }).waitFor();
  await panel.locator('#mainView').waitFor({ state: 'visible' });

  const countBefore = apiRequests.length;
  await panel.locator('#postDetails summary').click();
  await panel.locator('#reanalyze').click();
  let req;
  for (let i = 0; i < 100 && !req; i++) {
    req = apiRequests.slice(countBefore).find((r) => r.url.startsWith('https://openrouter.ai/'));
    if (!req) await panel.waitForTimeout(100);
  }
  assert.ok(req, 'request went to OpenRouter');
  assert.equal(new URL(req.url).pathname, '/api/v1/messages');
  assert.equal(req.headers.authorization, 'Bearer sk-or-test');
  assert.equal(apiRequests.slice(countBefore).some((r) => r.url.startsWith('https://api.anthropic.com/')), false);
  assert.equal(req.body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(req.body.fallbacks, undefined);
  assert.equal(typeof req.body.system, 'string', 'no cache_control block sent to OpenRouter');

  // Switch back so other tests keep the Anthropic setup.
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' } } }),
  );
  await panel.close();
  await page.close();
});

test('wrong API key shows a specific error', async () => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.locator('#settingsToggle').click();
  await snap(panel, '3-settings');
  await panel.locator('#apiKey').fill('sk-ant-bad');
  await panel.locator('#testConnection').click();
  await panel.locator('#settingsStatus', { hasText: '401' }).waitFor({ timeout: 10000 });
  assert.match(await panel.locator('#settingsStatus').textContent(), /odrzucił klucz API \(401\)/);
  await panel.close();
});

test('local defaults fill an empty "O mnie" once and never bring API keys', async () => {
  const readSettings = () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, aboutMe: '' } }),
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  let settings;
  for (let i = 0; i < 50; i++) {
    settings = await readSettings();
    if (settings?.localDefaultsApplied) break;
    await panel.waitForTimeout(100);
  }
  assert.equal(settings.aboutMe, 'Testowe O mnie z pliku lokalnego');
  assert.equal(settings.apiKeys.anthropic, 'sk-ant-test', 'API key from the defaults file is ignored');
  await panel.locator('#settingsToggle').click();
  assert.equal(await panel.locator('#aboutMe').inputValue(), 'Testowe O mnie z pliku lokalnego');

  // The user clears "O mnie": reopening the panel must not refill it.
  await panel.locator('#aboutMe').fill('');
  await panel.locator('#settingsView button[type="submit"]').click();
  await panel.locator('#settingsStatus', { hasText: 'Zapisano' }).waitFor();
  await panel.reload();
  await panel.waitForTimeout(300);
  assert.equal((await readSettings()).aboutMe, '');
  await panel.close();
});

test('your voice: hand edits are learned and both examples and preferences reach the prompt', async () => {
  const edited = (n) => ({
    at: 1000 + n,
    postKey: `urn:li:activity:90${n}`,
    author: 'Someone',
    postExcerpt: `Post number ${n}`,
    instruction: '',
    generated: `Great insights on topic ${n}, thanks for sharing!`,
    final: `Ciekawe ${n}. Jak to liczycie?`,
    edited: true,
    language: 'en',
  });
  await serviceWorker.evaluate(
    (history) =>
      chrome.storage.local.set({
        history,
        settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, learnVoice: true, localDefaultsApplied: true },
      }),
    [edited(1), edited(2), edited(3)],
  );
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#settingsToggle').click();
  assert.match(await panel.locator('#voiceStats').textContent(), /Zapamiętane komentarze: 3, w tym poprawionych ręcznie: 3/);
  await panel.setViewportSize({ width: 400, height: 900 });
  await snap(panel, '5-settings-voice-harmonic');
  await panel.locator('#learnNow').click();
  await panel.locator('#voiceStatus', { hasText: 'Zaktualizowano' }).waitFor({ timeout: 10000 });
  assert.equal(await panel.locator('#voiceNotes').inputValue(), '- Pisz krócej i bez pytania na końcu.');
  const learnReq = apiRequests.findLast((r) => lastUserText(r.body).includes('<task>learn_voice</task>'));
  assert.match(lastUserText(learnReq.body), /<draft>\nGreat insights on topic 1/);
  await panel.locator('#settingsToggle').click();

  await focusPost(page, '#editor2');
  await panel.locator('#postAuthor', { hasText: 'Jan Kowalski' }).waitFor();
  await panel.locator('#instruction').fill('zapytaj o lokalizację biura');
  const before = apiRequests.length;
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value);
  const writeReq = apiRequests.slice(before).find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
  assert.equal(writeReq.body.system.length, 2, 'static prompt + voice block');
  const voice = writeReq.body.system[1].text;
  assert.match(voice, /<user_voice>/);
  assert.match(voice, /Ciekawe 1\. Jak to liczycie\?/);
  assert.match(voice, /Pisz krócej i bez pytania na końcu/);
  await panel.close();
  await page.close();
});

test('richer context: author role, shared link and Harmonic data reach the panel and the prompt', async () => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      history: [],
      settings: {
        provider: 'anthropic',
        apiKeys: { anthropic: 'sk-ant-test' },
        localDefaultsApplied: true,
        useHarmonic: true,
        harmonicApiKey: 'hm-test',
      },
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.setViewportSize({ width: 400, height: 900 });
  const post = await focusPost(page, '#editor2');
  assert.deepEqual(post.authorProfile, { url: 'https://www.linkedin.com/in/jan-kowalski-42/', type: 'person' }, 'not the "liked by" header');
  assert.equal(post.authorHeadline, 'CTO w DataCorp | Analityka danych');
  assert.equal(post.linkPreview.title, 'Analityk danych, Kraków');

  await panel.locator('#contextList', { hasText: 'DataCorp (Harmonic)' }).waitFor({ timeout: 10000 });
  await panel.locator('#translation', { hasText: 'Volteum jedzie' }).waitFor({ timeout: 10000 });
  assert.equal(await panel.locator('#imagesToggleWrap').isHidden(), true, 'no image toggle for a post without images');
  await snap(panel, '4-context-harmonic');
  const contextText = await panel.locator('#contextList').textContent();
  assert.match(contextText, /Autor: CTO w DataCorp/);
  assert.match(contextText, /Udostępniony link: Analityk danych, Kraków/);
  assert.match(contextText, /Rola autora \(Harmonic\): CTO, DataCorp/);
  assert.match(contextText, /etap seed, finansowanie \$3\.2M, ostatnia runda 2026-03-15/);
  const personReq = harmonicRequests.find((r) => r.url.includes('/persons?'));
  assert.equal(personReq.method, 'POST');
  assert.equal(personReq.headers.apikey, 'hm-test');
  assert.match(personReq.url, /linkedin_url=https%3A%2F%2Fwww\.linkedin\.com%2Fin%2Fjan-kowalski-42%2F/);

  await panel.locator('#instruction').fill('zapytaj o zespół');
  const before = apiRequests.length;
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value);
  const writeReq = apiRequests.slice(before).find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
  const userText = lastUserText(writeReq.body);
  assert.match(userText, /author_headline="CTO w DataCorp \| Analityka danych"/);
  assert.match(userText, /<shared_link title="Analityk danych, Kraków">/);
  assert.match(userText, /<background>\nAuthor: CTO at DataCorp\.\nCompany: DataCorp/);
  assert.doesNotMatch(userText, /hm-test/, 'the Harmonic key never reaches the model');
  await panel.close();
  await page.close();
});
