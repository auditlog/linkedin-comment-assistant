// End-to-end test of the built extension (dist/) in Chromium:
// LinkedIn and the model APIs are replaced by local fixtures/mocks, so the test
// is free, needs no API key and no LinkedIn login.
// Run: npm run test:e2e

import { test, before, after, beforeEach } from 'node:test';
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

const MESSAGE_REPLY = `<comment>Hi Maria,
thanks for the deck. Tuesday at 10:00 works for me.</comment>
<back_translation>Cześć Maria,
dzięki za deck. Wtorek o 10:00 mi pasuje.</back_translation>
<notes>
- brak uwag
</notes>`;

const THINKING_SUMMARY = 'Streszczenie rozumowania testowego.';

const TRANSLATE_REPLY = `<translation>Świetna robota, zespole!</translation>
<notes>
- „Kudos” to luźne gratulacje.
</notes>`;

const TRANSLATE_COMMENTS_REPLY = `<translations>
<item>Świetna wiadomość! Czy na stoisku pokażecie też panel floty hybrydowej?</item>
<item>Strefy zeroemisyjne są tu prawdziwym motorem zmian.</item>
</translations>`;

const REFINED_REPLY = `<comment>Good luck in Utrecht, see you at the booth!</comment>
<back_translation>Powodzenia w Utrechcie, do zobaczenia na stoisku!</back_translation>
<notes>
- brak uwag
</notes>`;

/**
 * Build an SSE body like the Messages API stream: a thinking block, then the text in chunks.
 * With `thinkingText` (summarized thinking requested) the thinking block streams that summary.
 */
function sseBody(text, model, { thinkingText = '' } = {}) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ];
  for (let i = 0; i < thinkingText.length; i += 20) {
    events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkingText.slice(i, i + 20) } }]);
  }
  events.push(
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-test' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  );
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
  if (userText.includes('<task>back_translate</task>')) {
    reply = '<back_translation>Nie mogę przyjechać, ale życzę udanego wydarzenia.</back_translation>';
  } else if (userText.includes('<feedback>') || userText.includes('changed the settings')) {
    reply = REFINED_REPLY;
  } else if (userText.includes('<task>translate_comments</task>')) {
    reply = TRANSLATE_COMMENTS_REPLY;
  } else if (userText.includes('<task>translate_text</task>')) {
    // Slow enough for a test to switch posts while the translation is still running.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    reply = TRANSLATE_REPLY;
  } else if (userText.includes('<task>check_comment</task>')) {
    // The first comment draft "restates the post"; the refined one and message replies pass.
    reply = userText.includes('see you at the booth') || userText.includes('<conversation')
      ? '<verdict>ok</verdict>\n<issues></issues>'
      : '<verdict>warn</verdict>\n<issues>\n<issue type="restates_post">Komentarz powtarza informacje z posta o targach.</issue>\n</issues>';
  } else if (userText.includes('<task>analyze_post</task>') || userText.includes('<task>analyze_conversation</task>')) reply = ANALYSIS_REPLY;
  else if (userText.includes('<task>write_message</task>')) reply = MESSAGE_REPLY;
  else if (userText.includes('<task>write_comment</task>')) reply = COMMENT_REPLY;
  else if (userText.includes('<feedback>') || userText.includes('changed the settings')) reply = REFINED_REPLY;
  else if (userText.includes('<task>learn_voice</task>')) reply = '<preferences>\n- Pisz krócej i bez pytania na końcu.\n</preferences>';
  const thinkingText = body.thinking?.display === 'summarized' ? THINKING_SUMMARY : '';
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody(reply, body.model, { thinkingText }) });
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
  const mediaFixture = await readFile(path.join(here, 'fixtures', 'media.html'), 'utf8');
  const messagingFixture = await readFile(path.join(here, 'fixtures', 'messaging.html'), 'utf8');
  const shadowChatFixture = await readFile(path.join(here, 'fixtures', 'messaging-shadow.html'), 'utf8');
  // LinkedIn 2026-11: the messaging UI runs in an iframe inside the page shell.
  const iframeShell = `<!doctype html><html><body><div id="root"><main>LinkedIn shell</main>
    <iframe data-testid="interop-iframe" src="/messaging-frame/thread/2-abc/" style="width:900px;height:700px"></iframe></div></body></html>`;
  await context.route('https://www.linkedin.com/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body = fixture;
    if (pathname.startsWith('/feed/media/')) body = mediaFixture;
    else if (pathname.startsWith('/messaging/iframe-shell/')) body = iframeShell;
    else if (pathname.startsWith('/feed/shadow-chat/')) body = shadowChatFixture;
    else if (pathname.startsWith('/messaging/') || pathname.startsWith('/messaging-frame/')) body = messagingFixture;
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
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

beforeEach(async () => {
  // Isolate newly introduced draft storage, while preserving each legacy test's setup.
  await serviceWorker.evaluate(async () => {
    for (const area of [chrome.storage.session, chrome.storage.local]) {
      const data = await area.get(null);
      await area.remove(Object.keys(data).filter((key) => key.startsWith('lca:')));
    }
  });
});

after(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  if (extensionDir) await rm(extensionDir, { recursive: true, force: true });
});

// Optional screenshots for visual review: LCA_SCREENSHOTS=/some/dir npm run test:e2e
async function snap(page, name) {
  const dir = process.env.LCA_SCREENSHOTS;
  if (dir) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  }
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
  await panel.locator('#qualityStatus', { hasText: 'Model nie wykrył problemów w komentarzu' }).waitFor({ timeout: 10000 });
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
  assert.match(await panel.locator('#voiceStats').textContent(), /Komentarze: zapamiętane 3, poprawione ręcznie 3/);
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

test('messaging: reply in a conversation, inserted with line breaks and never sent', async () => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      history: [],
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true },
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/messaging/thread/2-abc/');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const htmlBefore = await page.evaluate(() => document.body.outerHTML);
  const post = await focusPost(page, '#msgEditor');
  assert.equal(await page.evaluate(() => document.body.outerHTML), htmlBefore, 'reading the conversation changes nothing on the page');
  assert.equal(post.kind, 'message');
  assert.equal(post.key, 'msg:thread:2-abc');
  assert.equal(post.author, 'Maria Founder');
  assert.equal(post.authorHeadline, 'CEO at FleetCo | Building fleet analytics');
  assert.deepEqual(post.authorProfile, { url: 'https://www.linkedin.com/in/maria-founder-7/', type: 'person' });
  assert.equal(
    post.text,
    [
      'Maria Founder: Hi! Could we talk about our seed round next week?',
      'Ja: Sure, send me the deck.',
      'Maria Founder: Here it is: fleetco-seed.pdf',
      'Maria Founder: Does Tuesday work for a call?',
    ].join('\n'),
  );
  assert.equal(post.lastIncoming, 'Does Tuesday work for a call?');

  await panel.locator('#postAuthor', { hasText: 'Rozmowa z: Maria Founder' }).waitFor();
  assert.equal(await panel.locator('#postHeading').textContent(), '1Rozmowa');
  assert.match(await panel.locator('#postExcerpt').textContent(), /Ostatnia wiadomość: Does Tuesday work/);
  await panel.locator('#translation').filter({ hasText: /\S/ }).waitFor({ timeout: 10000 });
  const analysisReq = apiRequests.findLast((r) => lastUserText(r.body).includes('<task>analyze_conversation</task>'));
  assert.match(lastUserText(analysisReq.body), /<conversation with="Maria Founder" with_headline="CEO at FleetCo/);

  await panel.locator('#instruction').fill('zaproponuj wtorek 10:00');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Hi Maria'));
  assert.equal(await panel.locator('#resultHeading').textContent(), '4Odpowiedź');
  assert.equal(await panel.locator('#insertComment').textContent(), 'Wstaw do wiadomości');
  const writeReq = apiRequests.findLast((r) => lastUserText(r.body).includes('<task>write_message</task>'));
  assert.match(lastUserText(writeReq.body), /zaproponuj wtorek 10:00/);
  await panel.locator('#qualityStatus', { hasText: 'Model nie wykrył problemów w odpowiedzi' }).waitFor({ timeout: 10000 });

  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Wstawiono do pola wiadomości' }).waitFor();
  const inserted = await page.locator('#msgEditor').innerText();
  assert.match(inserted, /^Hi Maria,\n+thanks for the deck\. Tuesday at 10:00 works for me\.$/, 'line break kept');
  assert.deepEqual(await page.evaluate(() => window.__sent), [], 'nothing was sent');

  const history = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  assert.equal(history[0].kind, 'message');
  assert.equal(history[0].postExcerpt, '', "the other person's messages are not stored");
  assert.equal(history[0].author, '');

  // The chat bubble is another conversation; with work in progress the panel offers a switch.
  await page.locator('#bubbleEditor').click();
  await panel.locator('#pendingPost').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await panel.locator('#pendingPostText').textContent(), /Tom Angel/);
  const bubble = await boundPost();
  assert.equal(bubble.key, 'msg:urn:li:msg_conversation:bubble-1');
  assert.equal(bubble.lastIncoming, 'Are you coming to the AI meetup on Thursday?');
  await snap(panel, '6-messaging');
  await panel.close();
  await page.close();
});

test('messaging in an iframe (LinkedIn 2026-11): bound with its frame, insert and selection reach that frame', async () => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      history: [],
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true },
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/messaging/iframe-shell/');
  const frame = page.frames().find((f) => f.url().includes('/messaging-frame/'));
  await frame.waitForSelector('#msgEditor');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const shellBefore = await page.evaluate(() => document.body.outerHTML);
  const before = (await boundPost())?.boundAt ?? 0;
  await frame.locator('#msgEditor').click();
  let post;
  for (let i = 0; i < 50 && !(post && post.boundAt !== before); i++) {
    post = await boundPost();
    await page.waitForTimeout(100);
  }
  assert.equal(post.kind, 'message');
  assert.equal(post.author, 'Maria Founder');
  assert.ok(post.frameId > 0, 'the conversation remembers its iframe');
  assert.equal(await page.evaluate(() => document.body.outerHTML), shellBefore, 'the page shell is unchanged');

  await panel.locator('#postAuthor', { hasText: 'Rozmowa z: Maria Founder' }).waitFor();
  await panel.locator('#instruction').fill('zaproponuj wtorek 10:00');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Hi Maria'));
  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Wstawiono do pola wiadomości' }).waitFor();
  assert.match(await frame.locator('#msgEditor').innerText(), /^Hi Maria,\n+thanks for the deck/);
  assert.deepEqual(await frame.evaluate(() => window.__sent), [], 'nothing was sent');

  // Text selected inside the iframe can be used as context too.
  await frame.evaluate(() => {
    const body = document.querySelector('.msg-s-event-listitem__body');
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await panel.locator('#clearPost').click();
  await page.bringToFront();
  await panel.locator('#useSelection').click();
  await panel.locator('#postExcerpt', { hasText: 'Could we talk about our seed round' }).waitFor({ timeout: 5000 });
  await panel.close();
  await page.close();
});

test('chat bubble in a shadow root (real LinkedIn /feed, 2026-11): read, insert, never send', async () => {
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({
      history: [],
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true },
    }),
  );
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/shadow-chat/');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  const shadowBefore = await page.evaluate(() => document.getElementById('interop-outlet').shadowRoot.innerHTML);
  const post = await focusPost(page, '#shadowEditor'); // Playwright CSS pierces open shadow roots
  assert.equal(await page.evaluate(() => document.getElementById('interop-outlet').shadowRoot.innerHTML), shadowBefore, 'nothing changed inside the shadow root');
  assert.equal(post.kind, 'message');
  assert.equal(post.author, 'Kasia Inwestor', 'name taken from her messages when the header is unknown');
  assert.deepEqual(post.authorProfile, { url: 'https://www.linkedin.com/in/kasia-vc-12/', type: 'person' }, 'her profile, not the user own one');
  assert.equal(post.text, 'Kasia Inwestor: Cześć!\nCzy masz chwilę w czwartek na rozmowę o funduszu?\nJa: Hej, chyba tak. O której?\nKasia Inwestor: Może 15:00?');
  assert.equal(post.lastIncoming, 'Może 15:00?');

  await panel.locator('#postAuthor', { hasText: 'Rozmowa z: Kasia Inwestor' }).waitFor();
  await panel.locator('#instruction').fill('potwierdź 15:00');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Hi Maria'));
  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Wstawiono do pola wiadomości' }).waitFor();
  assert.match(await page.locator('#shadowEditor').innerText(), /^Hi Maria,\n+thanks for the deck/);
  assert.deepEqual(await page.evaluate(() => window.__sent), [], 'nothing was sent');
  await panel.close();
  await page.close();
});

test('reasoning settings: groups, frozen write config, visible thinking summary', async () => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.remove('boundPost');
    await chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } });
  });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // 1. Two groups in the settings form.
  await panel.locator('#settingsToggle').click();
  await panel.locator('#effort').selectOption('high');
  await panel.locator('#thinking').selectOption('off');
  await panel.locator('#analysisEffort').selectOption('medium');
  await panel.locator('#showThinking').check();
  await snap(panel, '3b-settings-reasoning');
  await panel.locator('#settingsView button[type="submit"]').click();
  await panel.locator('#settingsStatus', { hasText: 'Zapisano.' }).waitFor();
  await panel.locator('#mainView').waitFor({ state: 'visible' });

  // 2. Analysis uses the analysis group and shows the thinking summary.
  const countBefore = apiRequests.length;
  await focusPost(page, '#editor1');
  await panel.locator('#analysisReasoningText', { hasText: THINKING_SUMMARY }).waitFor({ state: 'attached', timeout: 10000 });
  await panel.locator('#translation', { hasText: 'Volteum jedzie do Utrechtu' }).waitFor({ timeout: 10000 });
  const fresh = () => apiRequests.slice(countBefore);
  const analysisReq = fresh().find((r) => lastUserText(r.body).includes('<task>analyze_post</task>'));
  assert.deepEqual(analysisReq.body.output_config, { effort: 'medium' });
  assert.deepEqual(analysisReq.body.thinking, { type: 'adaptive', display: 'summarized' });
  await panel.locator('#analysisReasoning summary').click();
  await snap(panel, '1b-analysis-thinking');

  // 3. Writing uses the write group: thinking off, effort high, no summary to show.
  await panel.locator('#instruction').fill('Pogratuluj i zapytaj o dane.');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value.startsWith('Good luck in Utrecht! Which');
  });
  const writeReq = fresh().find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
  assert.deepEqual(writeReq.body.thinking, { type: 'between_tools' });
  assert.equal(writeReq.body.output_config.effort, 'high');
  assert.equal(writeReq.body.max_tokens, 16000);
  assert.equal(await panel.locator('#resultReasoning').isHidden(), true);

  // 4. Effort max: "off" is not allowed any more and the form says why.
  await panel.locator('#settingsToggle').click();
  await panel.locator('#effort').selectOption('max');
  assert.equal(await panel.locator('#thinking option[value="off"]').isDisabled(), true);
  assert.equal(await panel.locator('#thinking').inputValue(), 'adaptive');
  assert.match(await panel.locator('#thinkingHint').textContent(), /tylko z Sonnet 5\.5/);
  assert.equal(await panel.locator('#analysisThinking option[value="off"]').isDisabled(), false, 'medium still allows off');
  await panel.locator('#settingsView button[type="submit"]').click();
  await panel.locator('#settingsStatus', { hasText: 'Zapisano.' }).waitFor();
  await panel.locator('#mainView').waitFor({ state: 'visible' });

  // 5. A refinement keeps the frozen config of this comment.
  await panel.locator('#refineInput').fill('krócej');
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value === 'Good luck in Utrecht, see you at the booth!';
  });
  const refineReq = fresh().find((r) => lastUserText(r.body).includes('<feedback>'));
  assert.equal(refineReq.body.output_config.effort, 'high');
  assert.deepEqual(refineReq.body.thinking, { type: 'between_tools' });

  // 6. A new comment takes the new settings.
  const countBeforeRewrite = apiRequests.length;
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value.startsWith('Good luck in Utrecht! Which');
  });
  const rewriteReq = apiRequests.slice(countBeforeRewrite).find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
  assert.equal(rewriteReq.body.output_config.effort, 'max');
  assert.equal(rewriteReq.body.max_tokens, 64000);
  assert.deepEqual(rewriteReq.body.thinking, { type: 'adaptive', display: 'summarized' });
  await panel.locator('#resultReasoningText', { hasText: THINKING_SUMMARY }).waitFor({ state: 'attached' });
  assert.equal(await panel.locator('#resultReasoning').isHidden(), false);

  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } }),
  );
  await panel.close();
  await page.close();
});

/** Select the contents of the first element matching `selector` (inside `shadowHost`'s root when given). */
async function selectText(page, selector, shadowHost = null) {
  await page.evaluate(
    ([sel, host]) => {
      const root = host ? document.querySelector(host).shadowRoot : document;
      const range = document.createRange();
      range.selectNodeContents(root.querySelector(sel));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [selector, shadowHost],
  );
}

function sourceText(body) {
  const match = lastUserText(body).match(/<source_text>\n([\s\S]*)\n<\/source_text>/);
  return match ? match[1] : null;
}

test('translate selection: button, post switch, long text, no selection, other tab, page unchanged', async () => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.remove('boundPost');
    await chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } });
  });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  // A very long text on the page (added before the snapshot, so the comparison stays exact).
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.id = 'longText';
    div.textContent = 'Fleet data matters. '.repeat(700); // 14 000 characters
    document.body.append(div);
  });
  const htmlBefore = await page.evaluate(() => document.body.outerHTML);
  await selectText(page, '.comments-comment-item__main-content');

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.bringToFront();
  const countBefore = apiRequests.length;
  await panel.locator('#translateSelection').click();
  await panel.locator('#translateCard').waitFor({ state: 'visible' });

  // Switching posts while the translation runs must neither stop it nor close the card.
  let translateReq;
  for (let i = 0; i < 50 && !translateReq; i++) {
    translateReq = apiRequests.slice(countBefore).find((r) => lastUserText(r.body).includes('<task>translate_text</task>'));
    if (!translateReq) await panel.waitForTimeout(100);
  }
  assert.ok(translateReq, 'translation request sent');
  assert.equal(sourceText(translateReq.body), 'Great news! Will you also show the hybrid fleet dashboard at the booth?');
  assert.deepEqual(translateReq.body.output_config, { effort: 'low' }, 'analysis group settings');
  await focusPost(page, '#editor2');
  await panel.locator('#postAuthor', { hasText: 'Jan Kowalski' }).waitFor();
  await panel.locator('#translateResult', { hasText: 'Świetna robota' }).waitFor({ timeout: 10000 });
  assert.match(await panel.locator('#translateNotes').textContent(), /Kudos/);
  assert.match(await panel.locator('#translateSource').textContent(), /Great news!/);
  assert.equal(await panel.locator('#translateCard').isVisible(), true);
  assert.equal(await page.evaluate(() => document.body.outerHTML), htmlBefore, 'page DOM unchanged');
  await snap(panel, '5-translate-selection');

  // Long selection: only the first 10 000 characters go to the model, and the card says so.
  await selectText(page, '#longText');
  await page.bringToFront();
  const countLong = apiRequests.length;
  await panel.locator('#translateSelection').click();
  await panel.locator('#translateStatus', { hasText: 'Przetłumaczono pierwsze 10 000 znaków zaznaczenia.' }).waitFor({ timeout: 10000 });
  const longReq = apiRequests.slice(countLong).find((r) => lastUserText(r.body).includes('<task>translate_text</task>'));
  assert.equal(sourceText(longReq.body).length, 10000);

  // Nothing selected.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.bringToFront();
  await panel.locator('#translateSelection').click();
  await panel.locator('#translateStatus', { hasText: 'Na stronie nie ma zaznaczonego tekstu.' }).waitFor({ timeout: 5000 });

  // A tab without LinkedIn.
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await panel.locator('#translateSelection').click();
  await panel.locator('#translateStatus', { hasText: 'działa na otwartej karcie LinkedIna' }).waitFor({ timeout: 5000 });

  await panel.locator('#closeTranslation').click();
  assert.equal(await panel.locator('#translateCard').isHidden(), true);
  await other.close();
  await panel.close();
  await page.close();
});

test('translate selection inside the chat bubble shadow root, started like the keyboard shortcut', async () => {
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/shadow-chat/');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#translateSelection').waitFor();
  await selectText(page, 'p.msg-s-event-listitem__body', '#interop-outlet');
  const countBefore = apiRequests.length;
  // Alt+Shift+T: the service worker opens the panel and leaves this request in session storage.
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/shadow-chat/' });
    await chrome.storage.session.set({ translateRequest: { tabId: tab.id, at: Date.now() } });
  });
  await panel.locator('#translateResult', { hasText: 'Świetna robota' }).waitFor({ timeout: 10000 });
  const req = apiRequests.slice(countBefore).find((r) => lastUserText(r.body).includes('<task>translate_text</task>'));
  assert.match(sourceText(req.body), /Czy masz chwilę w czwartek/);
  assert.equal(await serviceWorker.evaluate(async () => (await chrome.storage.session.get('translateRequest')).translateRequest), undefined, 'request consumed');
  await panel.close();
  await page.close();
});

test('translate comments under the post', async () => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.remove('boundPost');
    await chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } });
  });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await focusPost(page, '#editor1');
  await panel.locator('#otherComments li').nth(1).waitFor();
  assert.match(await panel.locator('#otherComments li').first().textContent(), /Anna Nowak.*Great news!/s);
  const countBefore = apiRequests.length;
  await panel.locator('#translateComments').click();
  await panel.locator('#otherComments li').first().locator('p.comment-translation', { hasText: 'Świetna wiadomość' }).waitFor({ timeout: 10000 });
  assert.match(await panel.locator('#otherComments li').nth(1).locator('p.comment-translation').textContent(), /Strefy zeroemisyjne/);
  assert.equal(await panel.locator('#translateComments').isHidden(), true);
  const req = apiRequests.slice(countBefore).find((r) => lastUserText(r.body).includes('<task>translate_comments</task>'));
  assert.deepEqual(req.body.output_config, { effort: 'low' }, 'analysis group settings');
  await snap(panel, '6-comment-translations');
  await panel.close();
  await page.close();
});

test('history view: search, filter, copy, open link, delete', async () => {
  const now = Date.now();
  await serviceWorker.evaluate(async (t) => {
    await chrome.storage.session.remove('boundPost');
    await chrome.storage.local.set({
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true },
      history: [
        { at: t - 1000, kind: 'comment', postKey: 'urn:li:activity:7001', author: 'Volteum', postExcerpt: 'Volteum is heading to Utrecht for Fleet Expo 2026.', instruction: '', generated: 'Good luck!', final: 'Good luck in Utrecht, see you at the booth!', edited: true, language: 'en' },
        { at: t - 2000, kind: 'comment', postKey: 'fallback-xyz', author: '', postExcerpt: 'Pasted post about a product launch.', instruction: '', generated: 'Congrats!', final: 'Congrats on the launch!', edited: false, language: 'en' },
        { at: t - 3000, kind: 'message', postKey: 'msg:thread:2-abc', author: '', postExcerpt: '', instruction: '', generated: '', final: 'Wtorek o 10:00 mi pasuje.', edited: false, language: 'pl' },
      ],
    });
  }, now);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#historyToggle').click();
  await panel.locator('#historyView').waitFor({ state: 'visible' });
  assert.equal(await panel.locator('#mainView').isHidden(), true);
  assert.equal(await panel.locator('#historyToggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await panel.locator('#historyCount').textContent(), '3 ze 100');
  assert.equal(await panel.locator('li.history-item').count(), 3);
  assert.match(await panel.locator('li.history-item').first().textContent(), /poprawiony ręcznie/);
  await snap(panel, '7-history');

  await panel.locator('#historySearch').fill('utrecht');
  assert.equal(await panel.locator('li.history-item').count(), 1);
  await panel.locator('#historySearch').fill('');
  await panel.locator('#historyKind').selectOption('message');
  assert.equal(await panel.locator('li.history-item').count(), 1);
  assert.match(await panel.locator('li.history-item').first().textContent(), /Wtorek o 10:00/);
  await panel.locator('#historyKind').selectOption('all');

  // "Otwórz post" only where the key is a LinkedIn post URN.
  const links = panel.locator('li.history-item a.history-open');
  assert.equal(await links.count(), 1);
  assert.equal(await links.first().getAttribute('href'), 'https://www.linkedin.com/feed/update/urn:li:activity:7001/');
  assert.equal(await links.first().getAttribute('target'), '_blank');
  assert.equal(await panel.locator('li.history-item').first().locator('a.history-open').count(), 1);

  await panel.locator('li.history-item').first().locator('button', { hasText: 'Kopiuj' }).click();
  await panel.locator('li.history-item').first().locator('button', { hasText: 'Skopiowano' }).waitFor();

  await panel.locator('li.history-item').nth(1).locator('button', { hasText: 'Usuń' }).click();
  assert.equal(await panel.locator('li.history-item').count(), 2);
  assert.equal(await panel.locator('#historyCount').textContent(), '2 ze 100');
  const stored = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  assert.deepEqual(stored.map((e) => e.final), ['Good luck in Utrecht, see you at the booth!', 'Wtorek o 10:00 mi pasuje.']);

  await panel.locator('#historyToggle').click();
  await panel.locator('#mainView').waitFor({ state: 'visible' });
  await serviceWorker.evaluate(() => chrome.storage.local.set({ history: [] }));
  await panel.close();
});

test('backup: export without keys, import with preview, bad file', async () => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.remove('boundPost');
    await chrome.storage.local.set({
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, aboutMe: 'Stare O mnie', localDefaultsApplied: true },
      history: [{ at: 1, kind: 'comment', postKey: 'urn:li:activity:1', author: 'A', postExcerpt: '', instruction: '', generated: 'x', final: 'Old comment', edited: false, language: 'en' }],
    });
  });
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#settingsToggle').click();

  // 1. Export: a JSON file without API keys by default.
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.locator('#exportBackup').click()]);
  assert.match(download.suggestedFilename(), /^asystent-linkedin-kopia-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.format, 'lca-backup');
  assert.equal(exported.version, 1);
  assert.equal(exported.settings.apiKeys.anthropic, '');
  assert.equal(exported.settings.aboutMe, 'Stare O mnie');
  assert.equal(exported.history.length, 1);

  // 2. Import with a preview first.
  const file = {
    ...exported,
    settings: { ...exported.settings, aboutMe: 'Zaimportowane O mnie', length: 'long' },
    history: [...exported.history, { ...exported.history[0], at: 2, postKey: 'urn:li:activity:2', final: 'Imported comment' }],
  };
  await panel.setInputFiles('#importFile', { name: 'kopia.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await panel.locator('#importPreview').waitFor({ state: 'visible' });
  const preview = await panel.locator('#importPreview').textContent();
  assert.match(preview, /zostaną obecne/);
  assert.match(preview, /2 wpisy w pliku, w tym 1 nowy/);
  assert.equal(await panel.locator('#aboutMe').inputValue(), 'Stare O mnie', 'nothing changes before "Zastosuj"');
  await snap(panel, '3c-settings-import-preview');

  // 3. Apply: new "O mnie", the existing key stays, history merged.
  await panel.locator('#applyImport').click();
  await panel.locator('#backupStatus', { hasText: 'Zaimportowano kopię z' }).waitFor();
  assert.equal(await panel.locator('#aboutMe').inputValue(), 'Zaimportowane O mnie');
  assert.equal(await panel.locator('#length').inputValue(), 'long', 'imported length applies at once');
  assert.equal(await panel.locator('#importPreview').isHidden(), true);
  const stored = await serviceWorker.evaluate(async () => chrome.storage.local.get(['settings', 'history']));
  assert.equal(stored.settings.apiKeys.anthropic, 'sk-ant-test');
  assert.equal(stored.settings.aboutMe, 'Zaimportowane O mnie');
  assert.deepEqual(stored.history.map((e) => e.final), ['Imported comment', 'Old comment']);

  // 4. A foreign file: a specific error and no changes.
  await panel.setInputFiles('#importFile', { name: 'obcy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'x' })) });
  await panel.locator('#backupStatus', { hasText: 'nie jest kopią' }).waitFor();
  assert.equal(await panel.locator('#importPreview').isHidden(), true);
  const after = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(after.aboutMe, 'Zaimportowane O mnie');

  // 5. Only a Harmonic key: the export status must not claim the file has no keys.
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: '' }, harmonicApiKey: 'h-test', localDefaultsApplied: true } }),
  );
  await panel.reload();
  await panel.locator('#exportIncludeKeys').check();
  const [harmonicDownload] = await Promise.all([panel.waitForEvent('download'), panel.locator('#exportBackup').click()]);
  const withHarmonic = JSON.parse(await readFile(await harmonicDownload.path(), 'utf8'));
  assert.equal(withHarmonic.settings.harmonicApiKey, 'h-test');
  assert.match(await panel.locator('#backupStatus').textContent(), /razem z kluczami API/);

  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ history: [], settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } }),
  );
  await panel.close();
});

test('probe script: post mode reports structure without content', async () => {
  const source = await readFile(path.join(projectRoot, 'scripts', 'diagnose-linkedin.js'), 'utf8');
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  await page.locator('#editor1').click();
  const out = await page.evaluate((src) => (0, eval)(src), source);
  assert.match(out, /^mode: post\n/);
  assert.match(out, /data:\{/);
  assert.match(out, /img\.update-components-image__image.*\[src\].* w=\d+/);
  for (const secret of ['Volteum is heading', 'https://media.licdn.com', 'urn:li:activity:7001', 'Anna Nowak', 'Meet us at Fleet Expo', 'Great news!']) {
    assert.ok(!out.includes(secret), `probe output leaks "${secret}"`);
  }
  assert.equal(await page.evaluate(() => typeof document.body.outerHTML), 'string');

  // The chat bubble keeps the old "nearby" mode.
  await page.goto('https://www.linkedin.com/feed/shadow-chat/');
  await page.locator('#shadowEditor').click();
  const chat = await page.evaluate((src) => (0, eval)(src), source);
  assert.match(chat, /^mode: nearby\n/);
  assert.ok(!chat.includes('Czy masz chwilę'), 'no message text');
  await page.close();
});

test('tone and length changed after writing apply to the next refinement', async () => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.remove('boundPost');
    await chrome.storage.local.set({ history: [], settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } });
  });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await focusPost(page, '#editor1');
  await panel.locator('#instruction').fill('Pogratuluj.');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value.startsWith('Good luck in Utrecht! Which');
  });
  assert.equal(await panel.locator('#refineHint').isHidden(), true);

  // Changing the length after writing: the panel says how to apply it.
  await panel.locator('#length').selectOption('long');
  await panel.locator('#refineHint').waitFor({ state: 'visible' });
  assert.match(await panel.locator('#refineHint').textContent(), /Popraw/);
  await snap(panel, '2c-refine-new-length');

  // "Popraw" with an empty field rewrites the text to the new length.
  const countBefore = apiRequests.length;
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value === 'Good luck in Utrecht, see you at the booth!';
  });
  const refineReq = apiRequests.slice(countBefore).find((r) => lastUserText(r.body).includes('changed the settings'));
  assert.ok(refineReq, 'refinement sent');
  assert.match(lastUserText(refineReq.body), /Length: one solid paragraph/);
  assert.doesNotMatch(lastUserText(refineReq.body), /Tone:|<feedback>/);
  assert.equal(await panel.locator('#refineHint').isHidden(), true);

  // The new length is now part of this comment: the next refinement does not repeat it.
  const countNext = apiRequests.length;
  await panel.locator('#refineInput').fill('cieplej');
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('resultStatus').textContent === '');
  let nextReq;
  for (let i = 0; i < 50 && !nextReq; i++) {
    nextReq = apiRequests.slice(countNext).find((r) => lastUserText(r.body).includes('<feedback>'));
    if (!nextReq) await panel.waitForTimeout(100);
  }
  assert.doesNotMatch(lastUserText(nextReq.body), /changed the settings/);

  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } }),
  );
  await panel.close();
  await page.close();
});

test('review fixes: close during the selection read, fresh API key in refinements, shortcut window, history text role', async () => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.remove(['boundPost', 'translateRequest']);
    await chrome.storage.local.set({
      settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true },
      history: [{ at: 1, kind: 'comment', postKey: 'urn:li:activity:1', author: 'A', postExcerpt: '', instruction: '', generated: 'x', final: 'Old comment', edited: false, language: 'en' }],
    });
  });
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/feed/');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // 1. "Zamknij" while the page is still answering (nothing selected: ~200 ms) leaves no stale status.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.bringToFront();
  await panel.locator('#translateSelection').click();
  await panel.locator('#closeTranslation').click();
  await panel.waitForTimeout(600);
  assert.equal(await panel.locator('#translateCard').isHidden(), true);
  assert.equal(await panel.locator('#translateStatus').textContent(), '', 'the aborted request does not write its result');

  // 2. A request for another window is left for the panel of that window.
  const countBefore = apiRequests.length;
  await selectText(page, '.comments-comment-item__main-content');
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/' });
    await chrome.storage.session.set({ translateRequest: { tabId: tab.id, windowId: -42, at: Date.now() } });
  });
  await panel.waitForTimeout(800);
  assert.equal(await panel.locator('#translateCard').isHidden(), true);
  assert.equal(apiRequests.slice(countBefore).some((r) => lastUserText(r.body).includes('<task>translate_text</task>')), false);
  assert.ok(await serviceWorker.evaluate(async () => (await chrome.storage.session.get('translateRequest')).translateRequest), 'not consumed');
  await serviceWorker.evaluate(() => chrome.storage.session.remove('translateRequest'));

  // 3. A key corrected in the settings applies to the next refinement of the same comment.
  await focusPost(page, '#editor1');
  await panel.locator('#instruction').fill('Pogratuluj.');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Good luck'));
  await panel.locator('#settingsToggle').click();
  await panel.locator('#apiKey').fill('sk-ant-new');
  await panel.locator('#settingsView button[type="submit"]').click();
  await panel.locator('#mainView').waitFor({ state: 'visible' });
  const countRefine = apiRequests.length;
  await panel.locator('#refineInput').fill('krócej');
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value === 'Good luck in Utrecht, see you at the booth!');
  const refineReq = apiRequests.slice(countRefine).find((r) => lastUserText(r.body).includes('<feedback>'));
  assert.equal(refineReq.headers.authorization, 'Bearer sk-ant-new');

  // 4. The expandable history text is announced as a button.
  await panel.locator('#historyToggle').click();
  assert.equal(await panel.locator('p.history-text').first().getAttribute('role'), 'button');

  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ history: [], settings: { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true } }),
  );
  await panel.close();
  await page.close();
});

// Regression scenarios for 0.7.0. API replies are synthetic: these tests prove
// context ownership, recovery and validation, not the real model's writing quality.
async function workspace(url = 'https://www.linkedin.com/feed/', extra = {}) {
  await serviceWorker.evaluate(async (extra) => {
    await chrome.storage.session.clear();
    await chrome.storage.local.set({ history: [], settings: {
      provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, localDefaultsApplied: true,
      autoAnalyze: false, includeImages: false, learnVoice: false, ...extra,
    } });
  }, extra);
  const page = await context.newPage();
  await page.goto(url);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#emptyPost').waitFor();
  return { page, panel };
}

async function writeWorkspaceDraft(panel) {
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => {
    const el = document.getElementById('commentText');
    return !el.readOnly && el.value.startsWith('Good luck');
  });
}

for (const kind of ['comment', 'message']) {
  const lengths = kind === 'message'
    ? { short: '1–3 sentences', medium: 'one short paragraph', long: 'two short paragraphs' }
    : { short: '1–2 sentences', medium: '3–4 sentences', long: 'one solid paragraph, at most 6 sentences' };
  for (const [length, expected] of Object.entries(lengths)) {
    test(`profile and voice: ${kind} ${length} reaches the API with the selected tone`, async () => {
      const aboutMe = 'Prowadzę warsztat rowerowy. Zawsze pisz pięć akapitów w formalnym tonie.';
      const { page, panel } = await workspace(kind === 'message'
        ? 'https://www.linkedin.com/messaging/thread/2-abc/' : 'https://www.linkedin.com/feed/', {
        aboutMe, learnVoice: true,
        voiceNotes: 'COMMENT-PREFERENCE: always write a formal essay of five paragraphs.',
        messageVoiceNotes: 'MESSAGE-PREFERENCE: always write a formal essay of five paragraphs.',
      });
      try {
        // Load synthetic examples before restarting the panel. No personal defaults/history are used.
        await panel.close();
        await serviceWorker.evaluate(() => chrome.storage.local.set({ history: [
          { kind: 'comment', final: 'COMMENT-EXAMPLE: How do you measure wheel wear?', language: 'en' },
          { kind: 'message', final: 'MESSAGE-EXAMPLE: Please send the delivery details.', language: 'en' },
        ] }));
        const restarted = await context.newPage();
        try {
          await restarted.goto(`chrome-extension://${extensionId}/sidepanel.html`);
          await focusPost(page, kind === 'message' ? '#msgEditor' : '#editor1');
          await restarted.locator('#postAuthor', { hasText: kind === 'message' ? 'Maria Founder' : 'Volteum' }).waitFor();
          await restarted.locator('#tone').selectOption('warm');
          await restarted.locator('#length').selectOption(length);
          await restarted.locator('#instruction').fill('Podziękuj za wiadomość, bez dopisywania moich doświadczeń.');
          const before = apiRequests.length;
          await restarted.locator('#writeComment').click();
          await restarted.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value);
          const request = apiRequests.slice(before).find((r) => lastUserText(r.body).includes(`<task>write_${kind}</task>`));
          assert.ok(request, 'writing request sent');
          const task = lastUserText(request.body);
          assert.ok(task.includes(`- Length: ${expected}.`), 'kind-specific selected length sent');
          assert.match(task, /Tone: warm and personal, still professional/);
          assert.match(task, /chosen by the user for this text.*take precedence over <user_voice>/s);
          const [profile, voice] = request.body.system.map((block) => block.text);
          assert.ok(profile.includes(`<about_user>\n${aboutMe}\n</about_user>`));
          assert.match(profile, /Tone and Length .*take precedence over.*writing preferences in <about_user>/);
          const own = kind === 'message' ? 'MESSAGE' : 'COMMENT';
          const other = kind === 'message' ? 'COMMENT' : 'MESSAGE';
          assert.ok(voice.includes(`${own}-PREFERENCE`));
          assert.ok(voice.includes(`${own}-EXAMPLE`));
          assert.ok(!voice.includes(`${other}-PREFERENCE`) && !voice.includes(`${other}-EXAMPLE`), 'voice memory is isolated by kind');
          assert.match(voice, /Tone and Length set in the task override/);
          assert.match(voice, /Never.*reuse facts from these examples/);
        } finally { await restarted.close(); }
      } finally { await panel.close(); await page.close(); }
    });
  }
}

test('saved profile and voice updates apply to the next revision while API settings stay frozen', async () => {
  const { page, panel } = await workspace('https://www.linkedin.com/feed/', {
    aboutMe: 'OLD-PROFILE: prowadzę warsztat rowerowy.',
    voiceNotes: 'OLD-VOICE: use plain words.', effort: 'low', thinking: 'adaptive',
  });
  try {
    await focusPost(page, '#editor1');
    await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
    const beforeWrite = apiRequests.length;
    await writeWorkspaceDraft(panel);
    const original = apiRequests.slice(beforeWrite).find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
    assert.ok(original.body.system[0].text.includes('OLD-PROFILE'));
    assert.deepEqual(original.body.output_config, { effort: 'low' });
    await panel.locator('#settingsToggle').click();
    await panel.locator('#aboutMe').fill('NEW-PROFILE: naprawiam rowery elektryczne.');
    await panel.locator('#voiceNotes').fill('NEW-VOICE: avoid rhetorical questions.');
    await panel.locator('#effort').selectOption('high');
    await panel.locator('#settingsView button[type="submit"]').click();
    await panel.locator('#mainView').waitFor({ state: 'visible' });
    assert.equal(await serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.effort), 'high');
    await panel.locator('#length').selectOption('medium');
    await panel.locator('#tone').selectOption('casual');
    await panel.locator('#refineInput').fill('Użyj aktualnego opisu i stylu.');
    const beforeRevision = apiRequests.length;
    await panel.locator('#refineForm button[type="submit"]').click();
    await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.includes('see you at the booth'));
    const revision = apiRequests.slice(beforeRevision).find((r) => lastUserText(r.body).includes('<feedback>'));
    assert.ok(revision, 'revision sent');
    const system = revision.body.system.map((block) => block.text).join('\n');
    assert.match(system, /NEW-PROFILE/);
    assert.match(system, /NEW-VOICE/);
    assert.doesNotMatch(system, /OLD-PROFILE|OLD-VOICE/);
    assert.match(lastUserText(revision.body), /Length: 3–4 sentences/);
    assert.match(lastUserText(revision.body), /Tone: relaxed and conversational/);
    assert.equal(revision.body.model, original.body.model);
    assert.deepEqual(revision.body.output_config, original.body.output_config);
    assert.deepEqual(revision.body.thinking, original.body.thinking);
    assert.ok(revision.body.messages[1].content.some((block) => block.type === 'thinking' && block.signature === 'sig-test'));
  } finally { await panel.close(); await page.close(); }
});

test('a restored message draft uses the current profile, message voice and new length', async () => {
  const { page, panel } = await workspace('https://www.linkedin.com/messaging/thread/2-abc/', {
    aboutMe: 'OLD-DM-PROFILE: prowadzę warsztat.',
    voiceNotes: 'COMMENT-ONLY: use formal prose.', messageVoiceNotes: 'OLD-DM-VOICE: use plain words.',
  });
  let reopened;
  try {
    await focusPost(page, '#msgEditor');
    await panel.locator('#postAuthor', { hasText: 'Maria Founder' }).waitFor();
    await panel.locator('#writeComment').click();
    await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Hi Maria'));
    await panel.locator('#commentText').fill('My own restored message draft.');
    await panel.locator('#settingsToggle').click();
    await panel.locator('#aboutMe').fill('CURRENT-DM-PROFILE: naprawiam rowery elektryczne.');
    await panel.locator('#messageVoiceNotes').fill('CURRENT-DM-VOICE: address the recipient by first name.');
    await panel.locator('#settingsView button[type="submit"]').click();
    await panel.locator('#mainView').waitFor({ state: 'visible' });
    await panel.close();
    reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await reopened.locator('#draftStatus', { hasText: 'Przywrócono Twój szkic' }).waitFor();
    assert.equal(await reopened.locator('#commentText').inputValue(), 'My own restored message draft.');
    await reopened.locator('#length').selectOption('long');
    await reopened.locator('#tone').selectOption('warm');
    const before = apiRequests.length;
    await reopened.locator('#refineForm button[type="submit"]').click();
    await reopened.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.includes('see you at the booth'));
    const request = apiRequests.slice(before).find((r) => lastUserText(r.body).includes('My own restored message draft.'));
    assert.ok(request, 'fresh revision sent with restored text');
    assert.equal(request.body.messages.length, 1, 'no restored API conversation');
    assert.match(lastUserText(request.body), /<task>write_message<\/task>/);
    assert.match(lastUserText(request.body), /Length: two short paragraphs/);
    assert.match(lastUserText(request.body), /Tone: warm and personal/);
    const system = request.body.system.map((block) => block.text).join('\n');
    assert.match(system, /CURRENT-DM-PROFILE/);
    assert.match(system, /CURRENT-DM-VOICE/);
    assert.doesNotMatch(system, /OLD-DM-PROFILE|OLD-DM-VOICE|COMMENT-ONLY/);
  } finally { await reopened?.close(); await panel.close(); await page.close(); }
});

test('same post: switching to a reply updates its context and the exact insertion target', async () => {
  const { page, panel } = await workspace();
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await focusPost(page, '#replyEditor');
  await panel.locator('#postReplyTo', { hasText: 'Anna Nowak' }).waitFor();
  await writeWorkspaceDraft(panel);
  const req = apiRequests.filter((r) => lastUserText(r.body).includes('<task>write_comment</task>')).at(-1);
  assert.match(lastUserText(req.body), /<reply_to author="Anna Nowak">/);
  // Re-render the editor to exercise the fallback: never choose the main editor.
  await page.locator('#replyEditor').evaluate((el) => el.replaceWith(el.cloneNode(true)));
  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Wstawiono' }).waitFor();
  assert.match(await page.locator('#replyEditor').innerText(), /Good luck/);
  assert.equal(await page.locator('#editor1').innerText(), '');
  await panel.close(); await page.close();
});

test('same conversation refreshes new messages, protects work and rejects insertion into stale context', async () => {
  const { page, panel } = await workspace('https://www.linkedin.com/messaging/thread/2-abc/');
  await focusPost(page, '#msgEditor');
  await panel.locator('#postExcerpt', { hasText: 'Tuesday' }).waitFor();
  await page.locator('.msg-thread .msg-s-event-listitem__body').last().evaluate((el) => el.textContent = 'Actually, Thursday instead.');
  await page.locator('#msgEditor').blur();
  await focusPost(page, '#msgEditor');
  await panel.locator('#postExcerpt', { hasText: 'Thursday' }).waitFor();
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Hi Maria'));
  await page.locator('.msg-thread .msg-s-event-listitem__body').last().evaluate((el) => el.textContent = 'Now please use Friday.');
  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Kontekst na LinkedInie zmienił się' }).waitFor();
  assert.equal(await page.locator('#msgEditor').innerText(), '');
  assert.deepEqual(await page.evaluate(() => window.__sent), []);
  await page.locator('#msgEditor').blur();
  await focusPost(page, '#msgEditor');
  await panel.locator('#pendingPost').waitFor();
  assert.match(await panel.locator('#postExcerpt').textContent(), /Thursday/);
  await panel.close(); await page.close();
});

test('switching during image preparation cancels the old request without mixing posts or images', async () => {
  const { page, panel } = await workspace('https://www.linkedin.com/feed/', { includeImages: true });
  let started;
  const fetching = new Promise((resolve) => started = resolve);
  await panel.route('https://media.licdn.com/**', async (route) => {
    started(); await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG }).catch(() => {});
  });
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  const before = apiRequests.length;
  await panel.locator('#writeComment').click(); await fetching;
  assert.equal(await panel.locator('#writeComment').isDisabled(), true, 'locked before image fetching completes');
  await focusPost(page, '#editor2');
  await panel.locator('#pendingPost').waitFor();
  await panel.locator('#switchPost').click();
  await panel.locator('#postAuthor', { hasText: 'Jan Kowalski' }).waitFor();
  await panel.waitForTimeout(1400);
  assert.equal(apiRequests.slice(before).filter((r) => lastUserText(r.body).includes('<task>write_comment</task>')).length, 0);
  assert.equal(await panel.locator('#commentText').inputValue(), '');
  assert.equal(await panel.locator('#writeComment').isEnabled(), true);
  await writeWorkspaceDraft(panel);
  const req = apiRequests.slice(before).find((r) => lastUserText(r.body).includes('<task>write_comment</task>'));
  assert.match(lastUserText(req.body), /rekrutujemy analityka/);
  assert.equal(typeof req.body.messages[0].content, 'string', 'second post has no image from the first');
  await panel.close(); await page.close();
});

test('draft survives panel recreation; restored text can be refined without persisting the source thread', async () => {
  const { page, panel } = await workspace();
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await panel.locator('#instruction').fill('Mój własny szkic.');
  await writeWorkspaceDraft(panel);
  await panel.locator('#commentText').fill('My own edited draft before copying.');
  await panel.locator('#refineInput').fill('Skróć mój tekst.');
  await panel.close();
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 400, height: 900 });
  await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await reopened.locator('#draftStatus', { hasText: 'Przywrócono Twój szkic' }).waitFor();
  assert.equal(await reopened.locator('#instruction').inputValue(), 'Mój własny szkic.');
  assert.equal(await reopened.locator('#commentText').inputValue(), 'My own edited draft before copying.');
  assert.equal(await reopened.locator('#refineInput').inputValue(), 'Skróć mój tekst.');
  const before = apiRequests.length;
  await reopened.locator('#refineForm button[type="submit"]').click();
  await reopened.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.includes('see you at the booth'));
  const req = apiRequests.slice(before).find((r) => lastUserText(r.body).includes('My own edited draft'));
  assert.ok(req, 'fresh request includes the restored own text');
  assert.equal(req.body.messages.length, 1, 'no persisted API thinking/signatures or source transcript');
  assert.doesNotMatch(lastUserText(req.body), /‹feedback›/, 'a rebuilt thread preserves the real refinement protocol');
  await reopened.locator('#undoRevision').click();
  assert.equal(await reopened.locator('#commentText').inputValue(), 'My own edited draft before copying.');
  await reopened.locator('#undoRevision').click();
  assert.match(await reopened.locator('#commentText').inputValue(), /^Good luck in Utrecht! Which/);
  assert.equal(await reopened.locator('#undoRevision').isDisabled(), true, 'undo walks backwards rather than toggling two versions');
  await snap(reopened, '7-recovered-draft');
  const local = await serviceWorker.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(Object.keys(local).filter((key) => key.startsWith('lca:draft:')).length, 0, 'durable draft retention is opt-in');
  await reopened.close(); await page.close();
});

test('failed refinement keeps manual edits and feedback; stale back-translation refreshes explicitly', async () => {
  const { page, panel } = await workspace();
  await panel.route('https://api.anthropic.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (lastUserText(body).includes('<feedback>')) return route.fulfill({ status: 401, contentType: 'application/json',
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'test failure' } }) });
    return mockApi(route);
  });
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await writeWorkspaceDraft(panel);
  const own = 'I cannot attend, but wish you a successful event.';
  await panel.locator('#commentText').fill(own);
  await panel.locator('#backTranslationStatus', { hasText: 'poprzedniej wersji' }).waitFor();
  await panel.locator('#refreshBackTranslation').click();
  await panel.locator('#backTranslation', { hasText: 'Nie mogę przyjechać' }).waitFor();
  assert.equal(await panel.locator('#backTranslationStatus').isHidden(), true);
  await panel.locator('#refineInput').fill('Skróć, zachowaj odmowę.');
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.locator('#resultStatus', { hasText: '401' }).waitFor();
  assert.equal(await panel.locator('#commentText').inputValue(), own);
  assert.equal(await panel.locator('#refineInput').inputValue(), 'Skróć, zachowaj odmowę.');
  assert.match(await panel.locator('#backTranslation').textContent(), /Nie mogę przyjechać/);
  await snap(panel, '8-preserved-after-error');
  await panel.close(); await page.close();
});

test('invalid or truncated quality output never turns into a green success', async () => {
  const { page, panel } = await workspace();
  await panel.route('https://api.anthropic.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (lastUserText(body).includes('<task>check_comment</task>')) return route.fulfill({ status: 200,
      headers: { 'content-type': 'text/event-stream' }, body: sseBody('No tags, no actual check.', body.model) });
    return mockApi(route);
  });
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await writeWorkspaceDraft(panel);
  await panel.locator('#qualityStatus', { hasText: 'nieprawidłowy wynik kontroli' }).waitFor();
  assert.equal(await panel.locator('#qualityStatus').evaluate((el) => el.classList.contains('ok')), false);
  assert.equal(await panel.locator('#recheck').isVisible(), true);
  assert.equal(await panel.locator('#insertComment').isEnabled(), true, 'quality remains advisory');
  await panel.close(); await page.close();
});

test('Przerwij preserves the last own version and prevents late streaming updates', async () => {
  const { page, panel } = await workspace();
  let began;
  const pending = new Promise((resolve) => began = resolve);
  await panel.route('https://api.anthropic.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (lastUserText(body).includes('<feedback>')) {
      began(); await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return mockApi(route).catch(() => {});
  });
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await writeWorkspaceDraft(panel);
  await panel.locator('#commentText').fill('Preserve this own version.');
  await panel.locator('#refineInput').fill('Skróć.');
  await panel.locator('#refineForm button[type="submit"]').click(); await pending;
  await panel.locator('#stopOperation').click();
  await panel.locator('#resultStatus', { hasText: 'Przerwano' }).waitFor();
  await panel.waitForTimeout(1400);
  assert.equal(await panel.locator('#commentText').inputValue(), 'Preserve this own version.');
  assert.equal(await panel.locator('#refineInput').inputValue(), 'Skróć.');
  assert.equal(await panel.locator('#commentText').isEditable(), true);
  assert.equal(await panel.locator('#retryOperation').isVisible(), true);
  await panel.close(); await page.close();
});

test('cost uses the actual per-request model, including a refinement with frozen settings', async () => {
  const { page, panel } = await workspace();
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  const before = apiRequests.length;
  await writeWorkspaceDraft(panel);
  await panel.locator('#qualityStatus', { hasText: 'Zanim wstawisz' }).waitFor();
  await panel.locator('#settingsToggle').click();
  await panel.locator('#modelSelect').selectOption('claude-opus-5-5');
  await panel.locator('#settingsView button[type="submit"]').click();
  await panel.locator('#mainView').waitFor({ state: 'visible' });
  await panel.locator('#refineInput').fill('Krócej');
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.locator('#qualityStatus', { hasText: 'Model nie wykrył' }).waitFor();
  assert.deepEqual(apiRequests.slice(before).map((r) => r.body.model), [
    'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5',
  ]);
  assert.match(await panel.locator('#costLine').textContent(), /~3,5 c/);
  await panel.locator('#costDetails summary').click();
  assert.equal(await panel.locator('#costList li').count(), 4);
  await snap(panel, '9-costs');
  await panel.close(); await page.close();
});

test('document pages and manual slides have bounded, explicit coverage; polls remain read-only', async () => {
  const { page, panel } = await workspace('https://www.linkedin.com/feed/media/', { includeImages: true });
  const html = await page.evaluate(() => document.body.outerHTML);
  const doc = await focusPost(page, '#docEditor');
  assert.equal(doc.media.totalPages, 12);
  assert.equal(doc.media.pages.length, 3);
  await panel.locator('#postAuthor', { hasText: 'Roadmap Team' }).waitFor();
  await panel.locator('#documentPages input').last().uncheck();
  await panel.locator('#attachmentFiles').setInputFiles({ name: 'manual-slide.png', mimeType: 'image/png', buffer: PNG });
  await panel.locator('#attachmentStatus', { hasText: 'Dodano obrazy' }).waitFor();
  const before = apiRequests.length;
  await panel.locator('#runAnalysis').click();
  await panel.locator('#translation', { hasText: 'Volteum jedzie' }).waitFor();
  const req = apiRequests.slice(before).find((r) => lastUserText(r.body).includes('<task>analyze_post</task>'));
  assert.equal(req.body.messages[0].content.filter((b) => b.type === 'image').length, 3);
  assert.match(lastUserText(req.body), /<document title="Product roadmap" total_pages="12">/);
  assert.match(lastUserText(req.body), /Obrazy stron w zapytaniu: 3/);
  assert.match(await panel.locator('#mediaCoverage').textContent(), /Liczba stron dokumentu: 12/);
  await snap(panel, '10-document');
  assert.equal(await page.evaluate(() => document.body.outerHTML), html, 'reading media leaves the page untouched');
  // Attachments count as work: switching is an explicit action.
  const poll = await focusPost(page, '#pollEditor');
  assert.equal(poll.media.options.length, 2);
  await panel.locator('#switchPost').click();
  await panel.locator('#postAuthor', { hasText: 'Research Team' }).waitFor();
  await panel.locator('#runAnalysis').click();
  await panel.locator('#translation', { hasText: 'Volteum jedzie' }).waitFor();
  const pollReq = apiRequests.filter((r) => lastUserText(r.body).includes('<poll>')).at(-1);
  assert.match(lastUserText(pollReq.body), /Which metric would you track first/);
  assert.match(lastUserText(pollReq.body), /Accuracy: 60%/);
  assert.equal(await page.evaluate(() => document.body.outerHTML), html);
  await snap(panel, '11-poll');
  await panel.close(); await page.close();
});

test('persistent own drafts survive a cleared session, contain no DM transcript and can be disabled', async () => {
  const { page, panel } = await workspace('https://www.linkedin.com/messaging/thread/2-abc/', { persistDrafts: true });
  await focusPost(page, '#msgEditor');
  await panel.locator('#postAuthor', { hasText: 'Maria Founder' }).waitFor();
  await panel.locator('#instruction').fill('Only my own instruction.');
  await panel.locator('#writeComment').click();
  await panel.waitForFunction(() => !document.getElementById('commentText').readOnly && document.getElementById('commentText').value.startsWith('Hi Maria'));
  await panel.locator('#commentText').fill('Only my own reply.');
  const readDrafts = () => serviceWorker.evaluate(async () => {
    const data = await chrome.storage.local.get(null);
    return Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith('lca:draft:')));
  });
  for (let i = 0; i < 30; i++) {
    if (JSON.stringify(await readDrafts()).includes('Only my own reply.')) break;
    await panel.waitForTimeout(50);
  }
  const durable = JSON.stringify(await readDrafts());
  assert.match(durable, /Only my own reply/);
  assert.doesNotMatch(durable, /seed round|Does Tuesday|fleetco-seed|companyContext|apiKeys|message\.content|sk-ant-test/);
  await panel.close();
  await serviceWorker.evaluate(() => chrome.storage.session.clear());
  await page.locator('#msgEditor').blur();
  await focusPost(page, '#msgEditor');
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await reopened.locator('#draftStatus', { hasText: 'Przywrócono Twój szkic' }).waitFor();
  assert.equal(await reopened.locator('#commentText').inputValue(), 'Only my own reply.');
  await reopened.locator('#settingsToggle').click();
  await reopened.locator('#persistDrafts').uncheck();
  await reopened.locator('#settingsView button[type="submit"]').click();
  await reopened.locator('#settingsStatus', { hasText: 'Zapisano' }).waitFor();
  assert.deepEqual(await readDrafts(), {});
  await reopened.close(); await page.close();
});

test('follow mode ignores another window and recycled connected editors refuse insertion', async () => {
  const { page, panel } = await workspace();
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await writeWorkspaceDraft(panel);
  await serviceWorker.evaluate(async () => chrome.storage.session.set({ boundPost: {
    key: 'urn:li:activity:999', author: 'Other window', text: 'Different source', windowId: -42,
  } }));
  await panel.waitForTimeout(100);
  assert.equal(await panel.locator('#pendingPost').isHidden(), true);
  assert.equal(await panel.locator('#postAuthor').textContent(), 'Volteum');
  await page.locator('#editor1').evaluate((editor) => editor.closest('[data-urn]').setAttribute('data-urn', 'urn:li:activity:999'));
  await panel.locator('#insertComment').click();
  await panel.locator('#insertStatus', { hasText: 'Kontekst na LinkedInie zmienił się' }).waitFor();
  assert.equal(await page.locator('#editor1').innerText(), '');
  await panel.close(); await page.close();
});

test('panel fits 320/400 px in both themes and keeps running controls below the header', async () => {
  const { page, panel } = await workspace();
  await focusPost(page, '#editor1');
  await panel.locator('#postAuthor', { hasText: 'Volteum' }).waitFor();
  await writeWorkspaceDraft(panel);
  // Show a real retry state to include the operation bar in the layout checks.
  await panel.route('https://api.anthropic.com/**', (route) => route.fulfill({ status: 401, contentType: 'application/json',
    body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'test failure' } }) }));
  await panel.locator('#refineInput').fill('Skróć.');
  await panel.locator('#refineForm button[type="submit"]').click();
  await panel.locator('#resultStatus', { hasText: '401' }).waitFor();
  for (const [width, theme] of [[320, 'dark'], [400, 'light']]) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await panel.locator('#commentText').scrollIntoViewIfNeeded();
    const bounds = await panel.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      headerBottom: document.querySelector('.topbar').getBoundingClientRect().bottom,
      barTop: document.getElementById('operationBar').getBoundingClientRect().top,
    }));
    assert.ok(bounds.width <= bounds.viewport, `no horizontal overflow at ${width}px`);
    assert.ok(bounds.barTop >= bounds.headerBottom - 1, 'operation controls do not hide behind a wrapped header');
    await snap(panel, `12-${width}-${theme}`);
    await panel.locator('#settingsToggle').click();
    await panel.locator('#persistDrafts').waitFor();
    assert.equal(await panel.locator('#persistDrafts').isVisible(), true);
    const settingsWidth = await panel.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(settingsWidth <= width, 'settings fit the panel');
    await snap(panel, `13-settings-${width}-${theme}`);
    await panel.locator('#settingsToggle').click();
  }
  await panel.close(); await page.close();
});
