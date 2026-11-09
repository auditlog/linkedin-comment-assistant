// Side panel: the main UI. Flow for one comment:
//   1. post (bound from the LinkedIn page or pasted manually)
//   2. analysis: Polish translation/summary + comment ideas (auto or on demand)
//   3. user instruction/draft in Polish -> comment in the target language
//   4. result: editable comment, back-translation, language notes, refine, insert/copy
//
// All text from LinkedIn and from the model is rendered with textContent (never innerHTML).

import {
  applyLocalDefaults,
  saveSettings,
  activeConfig,
  validateConfig,
  mergeSettings,
  PROVIDERS,
  EFFORT_LEVELS,
} from '../lib/settings.js';
import {
  buildSystemPrompt,
  buildAnalysisMessages,
  buildCommentMessages,
  buildRefineMessage,
  ANALYSIS_TAGS,
  COMMENT_TAGS,
  TONES,
  LENGTHS,
  COMMENT_LANGUAGES,
} from '../lib/prompts.js';
import { parseTagged, parseItems, parseBullets } from '../lib/tagged.js';
import { streamCompletion, describeError } from '../lib/llm.js';
import { fetchImageBlocks } from '../lib/images.js';
import { estimateCostUsd, formatCost, modelLabel } from '../lib/pricing.js';
import { cleanPostText, fallbackPostKey } from '../lib/post-text.js';
import {
  createHistoryEntry,
  addToHistory,
  pickExamples,
  buildVoiceBlock,
  editsSince,
  shouldLearn,
  buildLearnMessages,
  VOICE_TAGS,
  VOICE_FIELDS,
} from '../lib/voice.js';
import { heuristicIssues, buildCheckMessages, parseIssues, buildSpecificFeedback, CHECK_TAGS } from '../lib/quality.js';
import { fetchHarmonicContext, formatBackground, formatMoney } from '../lib/harmonic.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: mergeSettings({}),
  post: null, // {key, author, text, replyTo, imageUrls, hasSeeMore, tabId, editorToken, manual}
  pendingPost: null, // a post focused on the page while the user had work in progress
  postLanguage: null, // ISO code from the analysis (<post_language>), used to pick style examples
  history: [], // comments the user inserted/copied (src/lib/voice.js), newest first
  learning: false,
  check: { status: 'idle', issues: [], checkedText: '', error: '' }, // model quality check of the comment
  harmonic: { status: 'off', company: null, person: null, error: '' }, // optional company/person data
  harmonicPromise: null,
  includeImages: true,
  imageBlocksPromise: null,
  analysisRaw: '',
  conversation: [], // Claude messages of the comment thread for the current post
  lastGeneratedComment: '',
  lastResultRaw: '', // raw text of the last successful comment reply (re-rendered after a failed refine)
  postCostUsd: 0,
  controllers: { analysis: null, comment: null, check: null },
};

// --- small UI helpers -------------------------------------------------------

function setStatus(el, text, kind = '') {
  el.textContent = text || '';
  el.classList.toggle('error', kind === 'error');
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('warn', kind === 'warn');
}

function fillSelect(select, options, value) {
  select.replaceChildren(
    ...Object.entries(options).map(([id, opt]) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = typeof opt === 'string' ? opt : opt.label;
      return option;
    }),
  );
  if (value != null) select.value = value;
}

// Coalesce streaming updates to one DOM update per frame, per target ("analysis", "result").
// The final render must cancel a pending one first: otherwise a stale "streaming"
// frame could run after it and leave the comment read-only with Insert disabled.
const pendingFrames = new Map();
function scheduleRender(key, fn) {
  const pending = pendingFrames.get(key);
  if (pending) cancelAnimationFrame(pending.id);
  const id = requestAnimationFrame(() => {
    pendingFrames.delete(key);
    fn();
  });
  pendingFrames.set(key, { id });
}
function cancelRender(key) {
  const pending = pendingFrames.get(key);
  if (pending) cancelAnimationFrame(pending.id);
  pendingFrames.delete(key);
}

function config() {
  return activeConfig(state.settings);
}

function ensureConfigOrExplain(statusEl) {
  const problem = validateConfig(config());
  if (problem) {
    setStatus(statusEl, problem, 'error');
    return false;
  }
  return true;
}

function addCost(message) {
  const usd = estimateCostUsd(config().model, message?.usage);
  if (usd != null) state.postCostUsd += usd;
  const label = modelLabel(config().model);
  $('costLine').textContent =
    usd == null
      ? `Model: ${label}.`
      : `Model: ${label}. Koszt dla ${KIND_LABELS[postKind()].costScope}: ${formatCost(state.postCostUsd)} (szacunek).`;
}

// --- post -------------------------------------------------------------------

function abortAll() {
  for (const key of Object.keys(state.controllers)) {
    state.controllers[key]?.abort();
    state.controllers[key] = null;
  }
}

// Follow mode binds a post on every comment-box focus; wait a moment before the automatic
// analysis, so clicking through several boxes analyzes only the one the user stays on.
const AUTO_ANALYSIS_DELAY_MS = 600;
let autoAnalysisTimer = null;

/** True when switching posts would throw away something the user typed or received. */
function hasWork() {
  return Boolean($('instruction').value.trim() || $('commentText').value.trim() || state.conversation.length);
}

function showPendingPost(post) {
  state.pendingPost = post;
  const banner = $('pendingPost');
  banner.hidden = !post;
  if (post) {
    const who = post.author || 'inny autor';
    const where = postKind(post) === 'message' ? 'w innej rozmowie' : 'pod innym postem';
    const sample = postKind(post) === 'message' ? post.lastIncoming || '' : post.text || '';
    const excerpt = sample.slice(0, 60);
    $('pendingPostText').textContent = `Kliknięto pole ${where}: ${who}${excerpt ? ` („${excerpt}${sample.length > 60 ? '…' : ''}”)` : ''}.`;
  }
}

function setPost(post) {
  abortAll();
  clearTimeout(autoAnalysisTimer);
  showPendingPost(null);
  state.post = post;
  state.analysisRaw = '';
  state.conversation = [];
  state.lastGeneratedComment = '';
  state.lastResultRaw = '';
  state.postLanguage = null;
  state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
  state.postCostUsd = 0;
  state.includeImages = state.settings.includeImages;
  state.imageBlocksPromise = null;
  $('costLine').textContent = '';
  $('instruction').value = '';
  $('commentText').value = '';
  setStatus($('insertStatus'), '');
  startHarmonic(post);
  renderPost();
  renderAnalysis();
  $('resultSection').hidden = true;
  state.autoAnalysisPending = false;
  if (post && post.text && state.settings.autoAnalyze) {
    state.autoAnalysisPending = true;
    renderAnalysis();
    autoAnalysisTimer = setTimeout(runAnalysis, AUTO_ANALYSIS_DELAY_MS);
  }
}

const KIND_LABELS = {
  comment: {
    post: 'Post',
    details: 'Pełny tekst posta (możesz go poprawić)',
    analysis: 'O czym jest post',
    write: 'Co chcesz napisać?',
    result: 'Komentarz',
    insert: 'Wstaw pod postem',
    ideas: 'Pomysły na komentarz',
    writeButton: 'Napisz komentarz',
    clear: 'Wybierz inny post',
    costScope: 'tego posta',
  },
  message: {
    post: 'Rozmowa',
    details: 'Ostatnie wiadomości (możesz je poprawić)',
    analysis: 'O czym jest rozmowa',
    write: 'Co chcesz odpisać?',
    result: 'Odpowiedź',
    insert: 'Wstaw do wiadomości',
    ideas: 'Pomysły na odpowiedź',
    writeButton: 'Napisz odpowiedź',
    clear: 'Wybierz inną rozmowę',
    costScope: 'tej rozmowy',
  },
};

// Length labels must match what the prompt asks for (see LENGTHS and MESSAGE_LENGTHS in prompts.js).
const MESSAGE_LENGTH_LABELS = {
  short: { label: 'Krótka (1–3 zdania)' },
  medium: { label: 'Średnia (akapit)' },
  long: { label: 'Dłuższa (dwa akapity)' },
};

function renderKindLabels(post) {
  const kind = postKind(post);
  const labels = KIND_LABELS[kind];
  for (const el of document.querySelectorAll('[data-label]')) {
    const text = labels[el.dataset.label];
    if (text) el.textContent = text;
  }
  fillSelect($('length'), kind === 'message' ? MESSAGE_LENGTH_LABELS : LENGTHS, $('length').value || state.settings.length);
}

function renderPost() {
  const post = state.post;
  const hasPost = Boolean(post);
  $('emptyPost').hidden = hasPost;
  $('postCard').hidden = !hasPost;
  $('analysisSection').hidden = !hasPost;
  $('writeSection').hidden = !hasPost;
  if (!hasPost) return;

  renderKindLabels(post);
  if (postKind(post) === 'message') {
    $('postAuthor').textContent = `Rozmowa z: ${post.author || 'nieznany rozmówca'}`;
    $('postExcerpt').textContent = post.lastIncoming
      ? `Ostatnia wiadomość: ${post.lastIncoming}`
      : post.text || 'Nie udało się odczytać rozmowy. Rozwiń „Ostatnie wiadomości” i wklej je ręcznie.';
  } else {
    $('postAuthor').textContent = post.author || (post.manual ? 'Post wklejony ręcznie' : 'Autor nieznany');
    $('postExcerpt').textContent = post.text || 'Nie udało się odczytać treści posta. Rozwiń „Pełny tekst posta” i wklej ją ręcznie.';
  }
  $('postReplyBadge').hidden = !post.replyTo;
  $('postReplyTo').hidden = !post.replyTo;
  if (post.replyTo) {
    $('postReplyTo').textContent = `Odpowiadasz na: ${post.replyTo.author ? `${post.replyTo.author}: ` : ''}„${post.replyTo.text.slice(0, 160)}${post.replyTo.text.length > 160 ? '…' : ''}”`;
  }
  $('seeMoreRow').hidden = !post.hasSeeMore || post.manual || post.tabId == null;
  $('postTextEdit').value = post.text || '';
  $('postDetails').open = !post.text;

  const imageCount = post.imageUrls?.length ?? 0;
  $('imagesToggleWrap').hidden = imageCount === 0;
  $('includeImages').checked = state.includeImages;
  $('imageCount').textContent = imageCount > 1 ? `(${imageCount})` : '';
  $('insertComment').disabled = post.manual || post.tabId == null;
  $('insertComment').title = post.manual ? 'Post wklejony ręcznie: użyj „Kopiuj”.' : '';
  renderContext();
}

function imageBlocks() {
  if (!state.includeImages || !state.post?.imageUrls?.length) return Promise.resolve([]);
  if (!state.imageBlocksPromise) state.imageBlocksPromise = fetchImageBlocks(state.post.imageUrls);
  return state.imageBlocksPromise;
}

async function useSelection() {
  const status = $('globalNotice');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('no tab');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'lca:getSelection' });
    const text = cleanPostText(response?.text || '');
    if (!text) {
      status.hidden = false;
      status.textContent = 'Na stronie nie ma zaznaczonego tekstu. Zaznacz treść posta myszką i spróbuj ponownie.';
      return;
    }
    status.hidden = true;
    setPost({ key: fallbackPostKey('', text), author: '', text, replyTo: null, imageUrls: [], tabId: tab.id, editorToken: null, manual: true });
  } catch {
    status.hidden = false;
    status.textContent = 'Nie udało się pobrać zaznaczenia. Ta funkcja działa tylko na otwartej karcie LinkedIna (odśwież ją, jeśli wtyczka była przed chwilą instalowana).';
  }
}

function useManual() {
  const text = cleanPostText($('manualPostText').value);
  if (!text) {
    $('globalNotice').hidden = false;
    $('globalNotice').textContent = 'Wklej najpierw treść posta do pola powyżej.';
    return;
  }
  $('globalNotice').hidden = true;
  setPost({ key: fallbackPostKey('', text), author: '', text, replyTo: null, imageUrls: [], tabId: null, editorToken: null, manual: true });
}

// --- context (LinkedIn extras + optional Harmonic) ---------------------------

function startHarmonic(post) {
  const s = state.settings;
  const enabled = s.useHarmonic && s.harmonicApiKey.trim() && post && !post.manual && post.authorProfile;
  if (!enabled) {
    state.harmonic = { status: 'off', company: null, person: null, error: '' };
    state.harmonicPromise = null;
    return;
  }
  state.harmonic = { status: 'loading', company: null, person: null, error: '' };
  const key = post.key;
  state.harmonicPromise = fetchHarmonicContext({ profile: post.authorProfile, apiKey: s.harmonicApiKey.trim() })
    .then((ctx) => {
      if (state.post?.key !== key) return;
      state.harmonic = { status: 'done', ...ctx, error: '' };
      const background = formatBackground(ctx);
      state.post = { ...state.post, companyContext: background || null };
    })
    .catch((error) => {
      if (state.post?.key !== key) return;
      state.harmonic = { status: 'error', company: null, person: null, error: error.message };
    })
    .finally(() => {
      if (state.post?.key === key) renderContext();
    });
}

/** Wait for Harmonic data, but never longer than `ms` (the comment must not hang on it). */
function waitForHarmonic(ms) {
  if (!state.harmonicPromise) return Promise.resolve();
  return Promise.race([state.harmonicPromise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

function renderContext() {
  const post = state.post;
  const items = [];
  if (post) {
    if (post.authorHeadline) items.push(`${postKind(post) === 'message' ? 'Rozmówca' : 'Autor'}: ${post.authorHeadline}`);
    if (post.linkPreview?.title) items.push(`Udostępniony link: ${post.linkPreview.title}`);
    const others = post.existingComments || [];
    if (others.length) {
      const names = others.map((c) => c.author).filter(Boolean).join(', ');
      items.push(`Komentarze pod postem uwzględnione przy pisaniu: ${others.length}${names ? ` (${names})` : ''}`);
    }
    const h = state.harmonic;
    if (h.status === 'loading') items.push('Harmonic: pobieram dane…');
    if (h.status === 'error') items.push(`Harmonic: ${h.error}`);
    if (h.status === 'done') {
      if (h.person && (h.person.title || h.person.headline)) {
        items.push(`Rola ${postKind(post) === 'message' ? 'rozmówcy' : 'autora'} (Harmonic): ${h.person.title ? `${h.person.title}${h.person.company ? `, ${h.person.company}` : ''}` : h.person.headline}`);
      }
      if (h.company) {
        const c = h.company;
        const facts = [
          c.stage ? `etap ${String(c.stage).toLowerCase().replace(/_/g, ' ')}` : '',
          formatMoney(c.fundingTotal) ? `finansowanie ${formatMoney(c.fundingTotal)}` : '',
          c.lastFundingAt ? `ostatnia runda ${c.lastFundingAt}` : '',
          c.headcount ? `ok. ${c.headcount} osób` : '',
        ].filter(Boolean);
        items.push(`${c.name} (Harmonic): ${facts.join(', ') || 'brak danych o finansowaniu'}`);
        if (c.investors.length) items.push(`Inwestorzy: ${c.investors.join(', ')}`);
      }
      if (!h.company && !h.person) items.push('Harmonic: brak danych o tej firmie lub osobie.');
    }
  }
  $('contextCard').hidden = items.length === 0;
  $('contextList').replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

// --- analysis ---------------------------------------------------------------

function renderAnalysis() {
  const parsed = parseTagged(state.analysisRaw, ANALYSIS_TAGS);
  $('translation').textContent = parsed.translation || '';
  $('imageNote').hidden = !parsed.image_note;
  $('imageNote').textContent = parsed.image_note ? `Na grafice: ${parsed.image_note}` : '';
  const ideas = parseItems(parsed.ideas, 'idea');
  $('ideasWrap').hidden = ideas.length === 0;
  $('ideas').replaceChildren(
    ...ideas.map((idea) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = idea;
      btn.addEventListener('click', () => {
        $('instruction').value = idea;
        $('instruction').focus();
      });
      li.append(btn);
      return li;
    }),
  );
  $('runAnalysis').hidden = Boolean(state.analysisRaw) || Boolean(state.controllers.analysis) || state.autoAnalysisPending;
  if (state.autoAnalysisPending && !state.controllers.analysis) setStatus($('analysisStatus'), 'Za chwilę przetłumaczę post…');
}

async function runAnalysis() {
  state.autoAnalysisPending = false;
  clearTimeout(autoAnalysisTimer);
  const status = $('analysisStatus');
  if (!state.post?.text) {
    setStatus(status, 'Brak treści posta do analizy. Uzupełnij „Pełny tekst posta”.', 'error');
    return;
  }
  if (!ensureConfigOrExplain(status)) return;
  state.controllers.analysis?.abort();
  const controller = new AbortController();
  state.controllers.analysis = controller;
  state.analysisRaw = '';
  renderAnalysis();
  setStatus(status, 'Tłumaczę post i szukam pomysłów…');
  try {
    await waitForHarmonic(3000);
    const images = await imageBlocks();
    const { text, message } = await streamCompletion(
      config(),
      { system: buildSystemPrompt(state.settings), messages: buildAnalysisMessages(state.post, images) },
      {
        signal: controller.signal,
        onText: (partial) => {
          state.analysisRaw = partial;
          scheduleRender('analysis', renderAnalysis);
        },
      },
    );
    state.analysisRaw = text;
    state.postLanguage = (parseTagged(text, ['post_language']).post_language || '').toLowerCase().slice(0, 5) || null;
    setStatus(status, '');
    addCost(message);
  } catch (error) {
    const msg = describeError(error, config());
    if (msg) setStatus(status, msg, 'error');
  } finally {
    if (state.controllers.analysis === controller) state.controllers.analysis = null;
    cancelRender('analysis');
    renderAnalysis();
  }
}

// --- comment ----------------------------------------------------------------

function renderResult(raw, { streaming }) {
  const parsed = parseTagged(raw, COMMENT_TAGS);
  const comment = parsed.comment ?? '';
  $('commentText').value = comment;
  $('commentText').readOnly = streaming;
  $('backTranslation').textContent = parsed.back_translation || '';
  const notes = parseBullets(parsed.notes).filter((n) => !/^brak uwag\.?$/i.test(n));
  $('notesWrap').hidden = notes.length === 0;
  $('notes').replaceChildren(
    ...notes.map((note) => {
      const li = document.createElement('li');
      li.textContent = note;
      return li;
    }),
  );
  $('insertComment').disabled = streaming || !comment || state.post?.manual || state.post?.tabId == null;
  $('copyComment').disabled = streaming || !comment;
}

/**
 * Send the current conversation and render the reply as the new result.
 * On failure the last (unanswered) user message is removed, so the history stays valid.
 */
async function sendConversation(statusText) {
  const status = $('resultStatus');
  state.controllers.comment?.abort();
  const controller = new AbortController();
  state.controllers.comment = controller;
  $('resultSection').hidden = false;
  setStatus($('insertStatus'), '');
  setStatus(status, statusText);
  $('writeComment').disabled = true;
  state.controllers.check?.abort();
  state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
  $('qualityBox').hidden = true;
  try {
    const { text, message } = await streamCompletion(
      config(),
      { system: writingSystem(), messages: state.conversation },
      {
        signal: controller.signal,
        onText: (partial) => scheduleRender('result', () => renderResult(partial, { streaming: true })),
      },
    );
    // Append the full content unchanged (thinking blocks included) to continue the thread.
    state.conversation.push({ role: 'assistant', content: message.content });
    cancelRender('result');
    renderResult(text, { streaming: false });
    state.lastResultRaw = text;
    state.lastGeneratedComment = $('commentText').value;
    runCheck();
    setStatus(status, message.stop_reason === 'max_tokens' ? 'Odpowiedź została ucięta (limit długości). Spróbuj „Popraw: krócej”.' : '', message.stop_reason === 'max_tokens' ? 'error' : '');
    addCost(message);
  } catch (error) {
    state.conversation.pop();
    const msg = describeError(error, config());
    if (msg) setStatus(status, msg, 'error');
    cancelRender('result');
    renderResult(state.lastResultRaw, { streaming: false });
  } finally {
    if (state.controllers.comment === controller) state.controllers.comment = null;
    $('writeComment').disabled = false;
  }
}

async function writeComment() {
  if (!state.post) return;
  if (!ensureConfigOrExplain($('resultStatus'))) {
    $('resultSection').hidden = false;
    return;
  }
  $('resultSection').hidden = false;
  setStatus($('resultStatus'), 'Przygotowuję…');
  // Bring step 4 into view so the comment is visible while it streams in.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('resultSection').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  await waitForHarmonic(8000);
  const images = await imageBlocks();
  state.conversation = buildCommentMessages({
    post: state.post,
    imageBlocks: images,
    instruction: $('instruction').value,
    tone: $('tone').value,
    length: $('length').value,
    language: state.settings.commentLanguage,
  });
  state.lastGeneratedComment = '';
  state.lastResultRaw = '';
  await sendConversation('Piszę komentarz…');
}

async function refine(event) {
  event.preventDefault();
  const feedback = $('refineInput').value.trim();
  if (!feedback) {
    setStatus($('resultStatus'), 'Wpisz, co poprawić, np. „krócej” albo „bez pytania na końcu”.', 'error');
    return;
  }
  if (state.conversation.length === 0) {
    setStatus($('resultStatus'), 'Najpierw napisz komentarz (krok 3).', 'error');
    return;
  }
  const current = $('commentText').value.trim();
  const edited = current && current !== state.lastGeneratedComment.trim() ? current : null;
  state.conversation.push({ role: 'user', content: buildRefineMessage(feedback, edited) });
  $('refineInput').value = '';
  await sendConversation('Poprawiam…');
}

// --- quality check ---------------------------------------------------------

function currentIssues() {
  const comment = $('commentText').value.trim();
  const fromModel = state.check.checkedText === comment ? state.check.issues : [];
  const heuristics = heuristicIssues(comment, state.post?.text, { kind: postKind() });
  // Model findings first; drop a heuristic finding when the model reported the same type.
  const modelTypes = new Set(fromModel.map((issue) => issue.type));
  return [...fromModel, ...heuristics.filter((issue) => !modelTypes.has(issue.type))];
}

function renderQuality() {
  const comment = $('commentText').value.trim();
  const box = $('qualityBox');
  const streaming = $('commentText').readOnly;
  box.hidden = !comment || streaming;
  if (box.hidden) return;
  const issues = currentIssues();
  const { status } = state.check;
  const stale = ['ok', 'warn', 'error'].includes(status) && state.check.checkedText !== comment;
  if (status === 'running') {
    setStatus($('qualityStatus'), issues.length ? 'Zanim wstawisz, sprawdź (dokładniejsza ocena w toku):' : 'Sprawdzam, czy komentarz nie jest ogólnikowy…', issues.length ? 'warn' : '');
  } else if (issues.length) {
    setStatus($('qualityStatus'), 'Zanim wstawisz, sprawdź:', 'warn');
  } else if (status === 'error' && !stale) {
    setStatus($('qualityStatus'), `Nie udało się sprawdzić komentarza: ${state.check.error}`, 'error');
  } else if (status === 'ok' && !stale) {
    setStatus(
      $('qualityStatus'),
      postKind() === 'message'
        ? '✓ Odpowiedź jest konkretna i odnosi się do ostatniej wiadomości.'
        : '✓ Komentarz jest konkretny: nie powtarza posta i nie brzmi ogólnikowo.',
      'ok',
    );
  } else {
    setStatus($('qualityStatus'), stale ? 'Tekst zmieniony po sprawdzeniu.' : '');
  }
  $('qualityIssues').replaceChildren(
    ...issues.map((issue) => {
      const li = document.createElement('li');
      li.textContent = issue.message;
      return li;
    }),
  );
  $('makeSpecific').hidden = issues.length === 0 || state.conversation.length === 0;
  $('recheck').hidden = status === 'running' || !(stale || status === 'error');
}

/** Ask the model whether the comment adds something (runs after each draft, non-blocking). */
async function runCheck() {
  const comment = $('commentText').value.trim();
  if (!comment || !state.post || validateConfig(config())) return;
  state.controllers.check?.abort();
  const controller = new AbortController();
  state.controllers.check = controller;
  state.check = { status: 'running', issues: [], checkedText: comment, error: '' };
  renderQuality();
  try {
    const { text, message } = await streamCompletion(
      config(),
      {
        system: buildSystemPrompt(state.settings),
        messages: buildCheckMessages({ post: state.post, comment, instruction: $('instruction').value }),
      },
      { signal: controller.signal },
    );
    const parsed = parseTagged(text, CHECK_TAGS);
    const issues = parseIssues(parsed.issues);
    state.check = { status: issues.length || /warn/i.test(parsed.verdict || '') ? 'warn' : 'ok', issues, checkedText: comment, error: '' };
    addCost(message);
  } catch (error) {
    const msg = describeError(error, config());
    if (msg === null) return; // aborted by a newer draft
    state.check = { status: 'error', issues: [], checkedText: comment, error: msg };
  } finally {
    if (state.controllers.check === controller) state.controllers.check = null;
    renderQuality();
  }
}

async function makeSpecific() {
  const issues = currentIssues();
  if (!issues.length || state.conversation.length === 0) return;
  const current = $('commentText').value.trim();
  const edited = current && current !== state.lastGeneratedComment.trim() ? current : null;
  state.conversation.push({ role: 'user', content: buildRefineMessage(buildSpecificFeedback(issues), edited) });
  await sendConversation('Poprawiam: konkretniej…');
}

// --- your voice -------------------------------------------------------------

/** "comment" or "message" (private conversation, since 0.4.0). */
function postKind(post = state.post) {
  return post?.kind === 'message' ? 'message' : 'comment';
}

/** System blocks for writing: static prompt (cached) + the user's voice for this kind of text. */
function writingSystem() {
  const kind = postKind();
  const examples = state.settings.learnVoice ? pickExamples(state.history, { language: state.postLanguage, kind }) : [];
  const voiceNotes = state.settings[VOICE_FIELDS[kind].notes];
  return [buildSystemPrompt(state.settings), buildVoiceBlock({ examples, voiceNotes, kind })];
}

async function recordHistory(finalText) {
  if (!state.settings.learnVoice || !state.post) return;
  const entry = createHistoryEntry({
    post: state.post,
    instruction: $('instruction').value,
    generated: state.lastGeneratedComment,
    final: finalText,
    language: state.postLanguage,
  });
  state.history = addToHistory(state.history, entry);
  await chrome.storage.local.set({ history: state.history });
  if (shouldLearn(state.history, state.settings, entry.kind)) {
    learnVoice({ statusEl: $('insertStatus'), append: true, kinds: [entry.kind] });
  }
}

/** Summarize the user's edits into preferences, separately for comments and messages. */
async function learnVoice({ statusEl, append = false, kinds = ['comment', 'message'] } = {}) {
  if (state.learning) return;
  const todo = kinds.filter((kind) => state.history.some((item) => item.edited && (item.kind || 'comment') === kind));
  if (todo.length === 0) {
    setStatus(statusEl, 'Brak poprawionych tekstów do nauki. Wtyczka uczy się z komentarzy i wiadomości, które zmienisz ręcznie przed wstawieniem.', 'error');
    return;
  }
  if (validateConfig(config())) return;
  state.learning = true;
  const note = (text, kind) => setStatus(statusEl, append && statusEl.textContent ? `${statusEl.textContent} ${text}` : text, kind);
  const done = [];
  try {
    for (const kind of todo) {
      const fields = VOICE_FIELDS[kind];
      const { text, message } = await streamCompletion(config(), {
        system: buildSystemPrompt(state.settings),
        messages: buildLearnMessages(state.history, state.settings[fields.notes], kind),
      });
      const preferences = parseTagged(text, VOICE_TAGS).preferences;
      if (!preferences) throw new Error('Model nie zwrócił listy preferencji.');
      state.settings = mergeSettings({ ...state.settings, [fields.notes]: preferences, [fields.learnedAt]: Date.now() });
      await saveSettings(chrome.storage.local, state.settings);
      if (!$('settingsView').hidden) $(fields.notes).value = preferences;
      addCost(message);
      done.push(kind === 'message' ? 'wiadomości' : 'komentarzy');
    }
    renderVoiceStats();
    note(`Zaktualizowano Twoje preferencje stylu dla: ${done.join(' i ')} (Ustawienia → Twój styl).`, 'ok');
  } catch (error) {
    note(`Nie udało się zaktualizować preferencji stylu: ${describeError(error, config()) || error.message}`, 'error');
  } finally {
    state.learning = false;
  }
}

function renderVoiceStats() {
  const line = (kind, label) => {
    const items = state.history.filter((item) => (item.kind || 'comment') === kind);
    const edited = items.filter((item) => item.edited).length;
    const waiting = editsSince(state.history, state.settings[VOICE_FIELDS[kind].learnedAt], kind).length;
    return items.length
      ? `${label}: zapamiętane ${items.length}, poprawione ręcznie ${edited}, nowe poprawki od ostatniej nauki ${waiting}.`
      : `${label}: brak.`;
  };
  $('voiceStats').textContent = state.history.length
    ? `${line('comment', 'Komentarze')} ${line('message', 'Wiadomości')}`
    : 'Brak zapamiętanych tekstów. Pojawią się po pierwszym „Wstaw” albo „Kopiuj”.';
  $('learnNow').disabled = !state.history.some((item) => item.edited);
  $('clearHistory').disabled = state.history.length === 0;
}

async function clearHistory() {
  if (!window.confirm('Usunąć wszystkie zapamiętane komentarze i wiadomości? Preferencje stylu zostaną.')) return;
  state.history = [];
  await chrome.storage.local.set({ history: [] });
  renderVoiceStats();
  setStatus($('voiceStatus'), 'Historia wyczyszczona.', 'ok');
}

async function copyComment() {
  const text = $('commentText').value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus($('insertStatus'), 'Skopiowano. Wklej komentarz w pole pod postem (Ctrl+V).', 'ok');
    await recordHistory(text);
  } catch {
    setStatus($('insertStatus'), 'Nie udało się skopiować. Zaznacz tekst komentarza i naciśnij Ctrl+C.', 'error');
  }
}

async function insertComment() {
  const text = $('commentText').value.trim();
  const post = state.post;
  if (!text || !post || post.tabId == null) return;
  let response = null;
  try {
    // Only the frame the post or conversation came from (messaging is in an iframe).
    response = await chrome.tabs.sendMessage(
      post.tabId,
      { type: 'lca:insert', editorToken: post.editorToken, postKey: post.key, text },
      { frameId: post.frameId ?? 0 },
    );
  } catch {
    response = { ok: false, reason: 'tab-unreachable' };
  }
  if (response?.ok) {
    setStatus(
      $('insertStatus'),
      postKind() === 'message'
        ? 'Wstawiono do pola wiadomości. Przeczytaj ją jeszcze raz na LinkedInie i wyślij przyciskiem LinkedIna.'
        : 'Wstawiono pod postem. Przeczytaj go jeszcze raz na LinkedInie i kliknij „Opublikuj”.',
      'ok',
    );
    await recordHistory(text);
    return;
  }
  // Fallback: clipboard, with a precise reason.
  const reasons = {
    'editor-missing': 'Pole tekstowe zniknęło (LinkedIn przeładował post lub rozmowę albo karta jest zamknięta).',
    'insert-failed': 'LinkedIn nie przyjął wstawionego tekstu.',
    'tab-unreachable': 'Karta z postem jest zamknięta albo została przeładowana.',
  };
  try {
    await navigator.clipboard.writeText(text);
    setStatus($('insertStatus'), `${reasons[response?.reason] ?? 'Nie udało się wstawić tekstu.'} Komentarz skopiowano: kliknij w pole pod postem i wklej (Ctrl+V).`, 'error');
    await recordHistory(text);
  } catch {
    setStatus($('insertStatus'), `${reasons[response?.reason] ?? 'Nie udało się wstawić tekstu.'} Skopiuj komentarz ręcznie.`, 'error');
  }
}

// --- settings view ----------------------------------------------------------

function showSettings(show, { intro = false } = {}) {
  $('settingsView').hidden = !show;
  $('mainView').hidden = show;
  $('settingsToggle').setAttribute('aria-expanded', String(show));
  $('settingsIntro').hidden = !intro;
  if (show) renderSettingsForm();
}

let formProvider = 'anthropic';

function renderSettingsForm() {
  const s = state.settings;
  formProvider = s.provider;
  $('providerOptions').replaceChildren(
    ...Object.entries(PROVIDERS).map(([id, p]) => {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'provider';
      input.value = id;
      input.checked = id === s.provider;
      input.addEventListener('change', () => {
        stashProviderFields();
        formProvider = id;
        renderProviderFields();
      });
      label.append(input, ` ${p.label}`);
      return label;
    }),
  );
  draft = { apiKeys: { ...s.apiKeys }, models: { ...s.models } };
  renderProviderFields();
  fillSelect($('effort'), EFFORT_LEVELS, s.effort);
  fillSelect($('commentLanguage'), COMMENT_LANGUAGES, s.commentLanguage);
  $('aboutMe').value = s.aboutMe;
  $('autoAnalyze').checked = s.autoAnalyze;
  $('includeImagesDefault').checked = s.includeImages;
  $('learnVoice').checked = s.learnVoice;
  $('useHarmonic').checked = s.useHarmonic;
  $('harmonicApiKey').value = s.harmonicApiKey;
  $('voiceNotes').value = s.voiceNotes;
  $('messageVoiceNotes').value = s.messageVoiceNotes;
  setStatus($('voiceStatus'), '');
  renderVoiceStats();
  setStatus($('settingsStatus'), '');
}

// Per-provider values being edited (so switching the radio does not lose a typed key).
let draft = { apiKeys: {}, models: {} };

function stashProviderFields() {
  draft.apiKeys[formProvider] = $('apiKey').value.trim();
  draft.models[formProvider] = $('modelSelect').value === '__custom' ? $('modelCustom').value.trim() : $('modelSelect').value;
}

function renderProviderFields() {
  const provider = PROVIDERS[formProvider];
  $('apiKey').value = draft.apiKeys[formProvider] || '';
  $('apiKey').placeholder = provider.keyPlaceholder;
  $('keyLink').href = provider.keyUrl;
  const options = Object.fromEntries(provider.models.map((m) => [m.id, m.label]));
  options.__custom = 'Inny model…';
  const current = draft.models[formProvider] || provider.models[0].id;
  const known = provider.models.some((m) => m.id === current);
  fillSelect($('modelSelect'), options, known ? current : '__custom');
  $('modelCustom').hidden = known;
  $('modelCustom').value = known ? '' : current;
}

function readSettingsForm() {
  stashProviderFields();
  return mergeSettings({
    ...state.settings,
    provider: formProvider,
    apiKeys: draft.apiKeys,
    models: draft.models,
    effort: $('effort').value,
    aboutMe: $('aboutMe').value.trim(),
    commentLanguage: $('commentLanguage').value,
    autoAnalyze: $('autoAnalyze').checked,
    includeImages: $('includeImagesDefault').checked,
    learnVoice: $('learnVoice').checked,
    useHarmonic: $('useHarmonic').checked,
    harmonicApiKey: $('harmonicApiKey').value.trim(),
    voiceNotes: $('voiceNotes').value.trim(),
    messageVoiceNotes: $('messageVoiceNotes').value.trim(),
  });
}

async function saveSettingsForm(event) {
  event.preventDefault();
  const next = readSettingsForm();
  const problem =
    validateConfig(activeConfig(next)) ||
    (next.useHarmonic && !next.harmonicApiKey ? 'włączono Harmonic, ale brakuje klucza API Harmonic.' : null);
  await saveSettings(chrome.storage.local, next);
  state.settings = next;
  if (problem) {
    setStatus($('settingsStatus'), `Zapisano, ale: ${problem}`, 'error');
    return;
  }
  setStatus($('settingsStatus'), 'Zapisano.', 'ok');
  setTimeout(() => showSettings(false), 600);
}

async function testConnection() {
  const candidate = readSettingsForm();
  const cfg = activeConfig(candidate);
  const problem = validateConfig(cfg);
  if (problem) {
    setStatus($('settingsStatus'), problem, 'error');
    return;
  }
  setStatus($('settingsStatus'), `Łączę się z: ${cfg.providerLabel}…`);
  try {
    const { text } = await streamCompletion(
      { ...cfg, effort: 'low' },
      { system: 'Reply with exactly: OK', messages: [{ role: 'user', content: 'ping' }] },
    );
    setStatus($('settingsStatus'), `Połączenie działa (${modelLabel(cfg.model)} odpowiedział: „${text.trim().slice(0, 40)}”).`, 'ok');
  } catch (error) {
    setStatus($('settingsStatus'), describeError(error, cfg) || 'Przerwano.', 'error');
  }
}

// --- init -------------------------------------------------------------------

async function expandPost() {
  const post = state.post;
  if (!post || post.tabId == null) return;
  const notice = $('globalNotice');
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(
      post.tabId,
      { type: 'lca:expand', editorToken: post.editorToken, postKey: post.key },
      { frameId: post.frameId ?? 0 },
    );
  } catch {
    response = null;
  }
  if (!response?.ok || !response.post) {
    notice.hidden = false;
    notice.textContent = 'Nie udało się rozwinąć posta: karta z postem jest zamknięta albo została przeładowana. Kliknij ponownie w pole komentarza pod postem.';
    return;
  }
  notice.hidden = true;
  const changed = response.post.text !== post.text;
  state.post = { ...post, text: response.post.text, hasSeeMore: response.post.hasSeeMore, imageUrls: response.post.imageUrls };
  renderPost();
  if (changed && state.settings.autoAnalyze) runAnalysis();
}

function bindEvents() {
  $('settingsToggle').addEventListener('click', () => showSettings($('settingsView').hidden));
  $('settingsView').addEventListener('submit', saveSettingsForm);
  $('testConnection').addEventListener('click', testConnection);
  $('learnNow').addEventListener('click', () => learnVoice({ statusEl: $('voiceStatus') }));
  $('clearHistory').addEventListener('click', clearHistory);
  $('toggleKey').addEventListener('click', () => {
    const show = $('apiKey').type === 'password';
    $('apiKey').type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? 'Ukryj' : 'Pokaż';
    $('toggleKey').setAttribute('aria-pressed', String(show));
  });
  $('modelSelect').addEventListener('change', () => {
    const custom = $('modelSelect').value === '__custom';
    $('modelCustom').hidden = !custom;
    if (custom) $('modelCustom').focus();
  });

  $('useSelection').addEventListener('click', useSelection);
  $('expandPost').addEventListener('click', expandPost);
  $('switchPost').addEventListener('click', () => {
    if (state.pendingPost) setPost(state.pendingPost);
  });
  $('useManual').addEventListener('click', useManual);
  $('clearPost').addEventListener('click', () => {
    chrome.storage.session.remove('boundPost');
    setPost(null);
  });
  $('includeImages').addEventListener('change', (e) => {
    state.includeImages = e.target.checked;
  });
  $('reanalyze').addEventListener('click', () => {
    const text = cleanPostText($('postTextEdit').value);
    state.post = { ...state.post, text };
    renderPost();
    runAnalysis();
  });
  $('runAnalysis').addEventListener('click', runAnalysis);
  $('writeComment').addEventListener('click', writeComment);
  $('instruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      writeComment();
    }
  });
  $('tone').addEventListener('change', () => persistChoice({ tone: $('tone').value }));
  $('length').addEventListener('change', () => persistChoice({ length: $('length').value }));
  $('refineForm').addEventListener('submit', refine);
  $('commentText').addEventListener('input', renderQuality);
  $('makeSpecific').addEventListener('click', makeSpecific);
  $('recheck').addEventListener('click', runCheck);
  $('insertComment').addEventListener('click', insertComment);
  $('copyComment').addEventListener('click', copyComment);
}

async function persistChoice(partial) {
  state.settings = mergeSettings({ ...state.settings, ...partial });
  await saveSettings(chrome.storage.local, state.settings);
}

async function loadLocalDefaults() {
  try {
    const response = await fetch(chrome.runtime.getURL('defaults.json'));
    return response.ok ? await response.json() : {};
  } catch {
    return {}; // no file or invalid JSON: run without local defaults
  }
}

async function init() {
  bindEvents();
  // Settings + optional local defaults (dist/defaults.json, built from the git-ignored
  // local-config/defaults.json): fills an empty "O mnie" once, never overwrites edits.
  const { settings: stored } = await chrome.storage.local.get('settings');
  const { settings, changed } = applyLocalDefaults(stored, await loadLocalDefaults());
  state.settings = settings;
  if (changed) await saveSettings(chrome.storage.local, settings);
  fillSelect($('tone'), TONES, state.settings.tone);
  fillSelect($('length'), LENGTHS, state.settings.length);

  state.history = (await chrome.storage.local.get('history')).history ?? [];
  const { boundPost } = await chrome.storage.session.get('boundPost');
  setPost(boundPost ?? null);

  chrome.storage.session.onChanged.addListener((changes) => {
    const next = changes.boundPost?.newValue;
    if (!next) return;
    showSettings(false);
    if (state.post && !state.post.manual && next.key === state.post.key) {
      // Same post focused again: keep translation, draft and result; just update the target editor.
      state.post = { ...state.post, tabId: next.tabId, frameId: next.frameId, editorToken: next.editorToken };
      showPendingPost(null);
      renderPost();
      return;
    }
    if (state.post && hasWork()) {
      // Never drop the user's work because they clicked another comment box.
      showPendingPost(next);
      return;
    }
    setPost(next);
  });

  if (validateConfig(config())) showSettings(true, { intro: true });
}

init();
