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
  THINKING_MODES,
  canDisableThinking,
} from '../lib/settings.js';
import {
  buildSystemPrompt,
  buildAnalysisMessages,
  buildCommentMessages,
  buildRefineMessage,
  buildTranslateMessages,
  buildTranslateCommentsMessages,
  ANALYSIS_TAGS,
  COMMENT_TAGS,
  TRANSLATE_TAGS,
  TRANSLATE_COMMENTS_TAGS,
  MAX_SELECTION_CHARS,
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
  HISTORY_LIMIT,
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
import { filterHistory, postUrl, removeEntry } from '../lib/history.js';
import {
  buildBackup,
  backupFileName,
  parseBackup,
  mergeHistory,
  applyBackupSettings,
  describeImport,
  MAX_BACKUP_BYTES,
  BACKUP_TOO_LARGE,
  backupHasKeys,
} from '../lib/backup.js';

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
  // Config of the "Pisanie i poprawki" group, frozen by writeComment for the whole thread:
  // with thinking off the API forbids changing effort mid-conversation, and a changed
  // thinking setting would invalidate the cache. New settings apply from the next comment.
  writeConfig: null,
  analysisThinking: '', // streamed thinking summary of the analysis (showThinking)
  resultThinking: '', // streamed thinking summary of the last comment reply
  lastResultThinking: '',
  lastGeneratedComment: '',
  lastResultRaw: '', // raw text of the last successful comment reply (re-rendered after a failed refine)
  postCostUsd: 0,
  controllers: { analysis: null, comment: null, check: null, translateComments: null },
  commentTranslations: [], // Polish translations of post.existingComments, same order
  // Translation of a selection: deliberately outside `controllers`, so switching posts
  // (setPost -> abortAll) neither stops it nor clears its card.
  translateController: null,
  translateRaw: '',
  lastTranslateAt: 0,
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

/** Current API config of a settings group; single requests use "analysis". */
function config(purpose = 'analysis') {
  return activeConfig(state.settings, purpose);
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
  state.commentTranslations = [];
  state.conversation = [];
  state.writeConfig = null;
  state.lastGeneratedComment = '';
  state.lastResultRaw = '';
  state.analysisThinking = '';
  state.resultThinking = '';
  state.lastResultThinking = '';
  state.postLanguage = null;
  state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
  state.postCostUsd = 0;
  state.includeImages = state.settings.includeImages;
  state.imageBlocksPromise = null;
  $('costLine').textContent = '';
  setStatus($('translateCommentsStatus'), '');
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

// --- translation of selected text --------------------------------------------

const TRANSLATE_MESSAGES = {
  noSelection: 'Na stronie nie ma zaznaczonego tekstu. Zaznacz tekst na LinkedInie i spróbuj ponownie.',
  unreachable: 'Tłumaczenie zaznaczenia działa na otwartej karcie LinkedIna. Odśwież kartę, jeśli wtyczka była przed chwilą instalowana lub aktualizowana.',
  truncated: 'Przetłumaczono pierwsze 10 000 znaków zaznaczenia.',
};

function renderTranslation({ streaming = false } = {}) {
  const parsed = parseTagged(state.translateRaw, TRANSLATE_TAGS);
  $('translateResult').textContent = parsed.translation || '';
  const notes = parseBullets(parsed.notes).filter((n) => !/^brak uwag\.?$/i.test(n));
  $('translateNotes').hidden = notes.length === 0;
  $('translateNotes').replaceChildren(
    ...notes.map((note) => {
      const li = document.createElement('li');
      li.textContent = note;
      return li;
    }),
  );
  $('copyTranslation').disabled = streaming || !parsed.translation;
}

/**
 * Translate the text selected on the page (a post, a comment, a message):
 * other languages into Polish, Polish into English. Independent of the selected post.
 * @param {{tabId?: number}} [options] - the tab with the selection; the active tab by default
 */
async function translateSelection({ tabId } = {}) {
  if ($('mainView').hidden) showView('main');
  const status = $('translateStatus');
  $('translateCard').hidden = false;
  state.translateController?.abort();
  state.translateController = null;
  state.translateRaw = '';
  $('translateSource').textContent = '';
  renderTranslation();
  if (!ensureConfigOrExplain(status)) return;

  let text = '';
  try {
    const id = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (id == null) throw new Error('no tab');
    const response = await chrome.tabs.sendMessage(id, { type: 'lca:getSelection' });
    text = String(response?.text || '').trim();
  } catch {
    setStatus(status, TRANSLATE_MESSAGES.unreachable, 'error');
    return;
  }
  if (!text) {
    setStatus(status, TRANSLATE_MESSAGES.noSelection, 'error');
    return;
  }
  const truncated = text.length > MAX_SELECTION_CHARS;
  if (truncated) text = text.slice(0, MAX_SELECTION_CHARS);
  $('translateSource').textContent = `„${text.slice(0, 120)}${text.length > 120 ? '…' : ''}”`;

  const controller = new AbortController();
  state.translateController = controller;
  const cfg = config('analysis');
  setStatus(status, 'Tłumaczę…');
  try {
    const { text: raw } = await streamCompletion(
      cfg,
      { system: buildSystemPrompt(state.settings), messages: buildTranslateMessages(text) },
      {
        signal: controller.signal,
        onText: (partial) => {
          state.translateRaw = partial;
          scheduleRender('translate', () => renderTranslation({ streaming: true }));
        },
      },
    );
    state.translateRaw = raw;
    setStatus(status, truncated ? TRANSLATE_MESSAGES.truncated : '', truncated ? 'warn' : '');
  } catch (error) {
    const msg = describeError(error, cfg);
    if (msg) setStatus(status, msg, 'error');
  } finally {
    if (state.translateController === controller) {
      state.translateController = null;
      cancelRender('translate');
      renderTranslation();
    }
  }
}

/** Run a request left by the Alt+Shift+T command (src/background.js), at most once and only when fresh. */
function handleTranslateRequest(request) {
  if (!request || request.at === state.lastTranslateAt) return;
  chrome.storage.session.remove('translateRequest');
  if (Date.now() - request.at > 10_000) return; // stale: the panel was opened much later
  state.lastTranslateAt = request.at;
  translateSelection({ tabId: request.tabId });
}

function closeTranslation() {
  state.translateController?.abort();
  state.translateController = null;
  state.translateRaw = '';
  $('translateCard').hidden = true;
  setStatus($('translateStatus'), '');
}

async function copyTranslation() {
  const text = parseTagged(state.translateRaw, TRANSLATE_TAGS).translation;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus($('translateStatus'), 'Skopiowano.', 'ok');
  } catch {
    setStatus($('translateStatus'), 'Nie udało się skopiować. Zaznacz tłumaczenie i naciśnij Ctrl+C.', 'error');
  }
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
  const others = otherComments(post);
  $('contextCard').hidden = items.length === 0 && others.length === 0;
  $('contextList').hidden = items.length === 0;
  $('contextList').replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  renderOtherComments(others);
}

/** Comments read together with the post (none for conversations). */
function otherComments(post = state.post) {
  if (!post || postKind(post) === 'message') return [];
  return (post.existingComments || []).filter((c) => c && c.text);
}

function renderOtherComments(others) {
  $('otherCommentsWrap').hidden = others.length === 0;
  $('otherComments').replaceChildren(
    ...others.map((c, i) => {
      const li = document.createElement('li');
      const author = document.createElement('strong');
      author.textContent = c.author || 'Autor nieznany';
      li.append(author, `: ${c.text.slice(0, 200)}${c.text.length > 200 ? '…' : ''}`);
      const translation = state.commentTranslations[i];
      if (translation) {
        const p = document.createElement('p');
        p.className = 'comment-translation';
        p.textContent = translation;
        li.append(p);
      }
      return li;
    }),
  );
  const running = Boolean(state.controllers.translateComments);
  $('translateComments').hidden = others.length === 0 || (state.commentTranslations.length > 0 && !running);
  $('translateComments').disabled = running;
}

/** Translate the comments under the post into Polish (one request, analysis settings). */
async function translateComments() {
  const others = otherComments();
  if (others.length === 0) return;
  const status = $('translateCommentsStatus');
  if (!ensureConfigOrExplain(status)) return;
  state.controllers.translateComments?.abort();
  const controller = new AbortController();
  state.controllers.translateComments = controller;
  const key = state.post.key;
  const cfg = config('analysis');
  const parse = (raw) => parseItems(parseTagged(raw, TRANSLATE_COMMENTS_TAGS).translations, 'item');
  state.commentTranslations = [];
  setStatus(status, 'Tłumaczę komentarze…');
  renderContext();
  try {
    const { text, message } = await streamCompletion(
      cfg,
      { system: buildSystemPrompt(state.settings), messages: buildTranslateCommentsMessages(others) },
      {
        signal: controller.signal,
        onText: (partial) => {
          state.commentTranslations = parse(partial);
          scheduleRender('comments', renderContext);
        },
      },
    );
    state.commentTranslations = parse(text);
    setStatus(status, state.commentTranslations.length ? '' : 'Model nie zwrócił tłumaczeń. Spróbuj ponownie.', state.commentTranslations.length ? '' : 'error');
    addCost(message);
  } catch (error) {
    const msg = describeError(error, cfg);
    if (msg) setStatus(status, msg, 'error');
  } finally {
    if (state.controllers.translateComments === controller) state.controllers.translateComments = null;
    if (state.post?.key === key) {
      cancelRender('comments');
      renderContext();
    }
  }
}

// --- analysis ---------------------------------------------------------------

function renderAnalysis() {
  const parsed = parseTagged(state.analysisRaw, ANALYSIS_TAGS);
  $('translation').textContent = parsed.translation || '';
  $('analysisReasoningText').textContent = state.analysisThinking;
  $('analysisReasoning').hidden = !state.analysisThinking;
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
  state.analysisThinking = '';
  renderAnalysis();
  setStatus(status, 'Tłumaczę post i szukam pomysłów…');
  try {
    await waitForHarmonic(3000);
    const images = await imageBlocks();
    const { text, message } = await streamCompletion(
      config('analysis'),
      { system: buildSystemPrompt(state.settings), messages: buildAnalysisMessages(state.post, images) },
      {
        signal: controller.signal,
        onText: (partial) => {
          state.analysisRaw = partial;
          scheduleRender('analysis', renderAnalysis);
        },
        onThinking: (thinking) => {
          state.analysisThinking = thinking;
          scheduleRender('analysis', renderAnalysis);
        },
      },
    );
    state.analysisRaw = text;
    state.postLanguage = (parseTagged(text, ['post_language']).post_language || '').toLowerCase().slice(0, 5) || null;
    setStatus(status, '');
    addCost(message);
  } catch (error) {
    const msg = describeError(error, config('analysis'));
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
  $('resultReasoningText').textContent = state.resultThinking;
  $('resultReasoning').hidden = !state.resultThinking;
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
  const cfg = state.writeConfig ?? config('write');
  let partialRaw = '';
  state.resultThinking = '';
  try {
    const { text, message } = await streamCompletion(
      cfg,
      { system: writingSystem(), messages: state.conversation },
      {
        signal: controller.signal,
        onText: (partial) => {
          partialRaw = partial;
          scheduleRender('result', () => renderResult(partialRaw, { streaming: true }));
        },
        onThinking: (thinking) => {
          state.resultThinking = thinking;
          scheduleRender('result', () => renderResult(partialRaw, { streaming: true }));
        },
      },
    );
    // Append the full content unchanged (thinking blocks included) to continue the thread.
    state.conversation.push({ role: 'assistant', content: message.content });
    cancelRender('result');
    renderResult(text, { streaming: false });
    state.lastResultRaw = text;
    state.lastResultThinking = state.resultThinking;
    state.lastGeneratedComment = $('commentText').value;
    runCheck();
    setStatus(status, message.stop_reason === 'max_tokens' ? 'Odpowiedź została ucięta (limit długości). Spróbuj „Popraw: krócej”.' : '', message.stop_reason === 'max_tokens' ? 'error' : '');
    addCost(message);
  } catch (error) {
    state.conversation.pop();
    const msg = describeError(error, cfg);
    if (msg) setStatus(status, msg, 'error');
    cancelRender('result');
    state.resultThinking = state.lastResultThinking;
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
  state.lastResultThinking = '';
  state.writeConfig = config('write');
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
  if (!comment || !state.post || validateConfig(config('analysis'))) return;
  state.controllers.check?.abort();
  const controller = new AbortController();
  state.controllers.check = controller;
  state.check = { status: 'running', issues: [], checkedText: comment, error: '' };
  renderQuality();
  try {
    const { text, message } = await streamCompletion(
      config('analysis'),
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
    const msg = describeError(error, config('analysis'));
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
      const { text, message } = await streamCompletion(config('analysis'), {
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
    note(`Nie udało się zaktualizować preferencji stylu: ${describeError(error, config('analysis')) || error.message}`, 'error');
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

/** Show one of the panel views; the topbar buttons reflect which one is open. */
function showView(name) {
  $('mainView').hidden = name !== 'main';
  $('settingsView').hidden = name !== 'settings';
  $('historyView').hidden = name !== 'history';
  $('settingsToggle').setAttribute('aria-expanded', String(name === 'settings'));
  $('historyToggle').setAttribute('aria-expanded', String(name === 'history'));
  if (name === 'history') renderHistory();
}

// --- history view -------------------------------------------------------------

const HISTORY_EMPTY =
  'Brak zapisanych tekstów. Wtyczka zapisuje komentarze i odpowiedzi, które wstawiasz lub kopiujesz, gdy w ustawieniach jest włączone „Ucz się z komentarzy…”.';

function renderHistory() {
  const entries = filterHistory(state.history, { kind: $('historyKind').value, query: $('historySearch').value });
  $('historyCount').textContent = `${state.history.length} ze ${HISTORY_LIMIT}`;
  $('historyEmpty').hidden = entries.length > 0;
  $('historyEmpty').textContent = state.history.length === 0 ? HISTORY_EMPTY : 'Żaden tekst nie pasuje do wyszukiwania.';
  $('historyList').replaceChildren(...entries.map(historyItem));
}

function historyItem(entry) {
  const li = document.createElement('li');
  li.className = 'history-item';

  const meta = document.createElement('p');
  meta.className = 'history-meta';
  const date = document.createElement('span');
  date.textContent = new Date(entry.at).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
  const kind = document.createElement('span');
  kind.className = 'badge';
  kind.textContent = entry.kind === 'message' ? 'Wiadomość' : 'Komentarz';
  meta.append(date, kind);
  if (entry.edited) {
    const edited = document.createElement('span');
    edited.className = 'badge';
    edited.textContent = 'poprawiony ręcznie';
    meta.append(edited);
  }
  li.append(meta);

  if (entry.author || entry.postExcerpt) {
    const post = document.createElement('p');
    post.className = 'history-post';
    post.textContent = [entry.author, entry.postExcerpt].filter(Boolean).join(': ');
    li.append(post);
  }

  const text = document.createElement('p');
  text.className = 'history-text';
  text.textContent = entry.final;
  text.tabIndex = 0;
  text.title = 'Kliknij, aby rozwinąć lub zwinąć';
  text.setAttribute('aria-expanded', 'false');
  const toggle = () => text.setAttribute('aria-expanded', String(text.classList.toggle('expanded')));
  text.addEventListener('click', toggle);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  li.append(text);

  const actions = document.createElement('div');
  actions.className = 'row';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'secondary small';
  copy.textContent = 'Kopiuj';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.final);
      copy.textContent = 'Skopiowano';
    } catch {
      copy.textContent = 'Nie udało się skopiować';
    }
    setTimeout(() => {
      copy.textContent = 'Kopiuj';
    }, 1500);
  });
  actions.append(copy);
  const url = postUrl(entry);
  if (url) {
    const open = document.createElement('a');
    open.className = 'history-open';
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Otwórz post';
    actions.append(open);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = 'Usuń';
  remove.addEventListener('click', async () => {
    // Immediate, without confirmation (design decision); one entry is cheap to lose.
    state.history = removeEntry(state.history, entry);
    await chrome.storage.local.set({ history: state.history });
    renderHistory();
  });
  actions.append(remove);
  li.append(actions);
  return li;
}

function showSettings(show, { intro = false } = {}) {
  showView(show ? 'settings' : 'main');
  $('settingsIntro').hidden = !intro;
  if (show) renderSettingsForm();
}

// [effort select, thinking select, hint] of each settings group.
const REASONING_GROUPS = [
  ['effort', 'thinking', 'thinkingHint'],
  ['analysisEffort', 'analysisThinking', 'analysisThinkingHint'],
];

function formModel() {
  return $('modelSelect').value === '__custom' ? $('modelCustom').value.trim() : $('modelSelect').value;
}

/**
 * Allow "Wyłączone" only where the API accepts it (Sonnet 5.5, effort up to high).
 * A blocked choice falls back to "Automatyczne", and the hint says why, so the form
 * can never save a combination that ends in a 400 (activeConfig guards it as well).
 */
function renderThinkingAvailability() {
  const model = formModel();
  for (const [effortId, thinkingId, hintId] of REASONING_GROUPS) {
    const off = $(thinkingId).querySelector('option[value="off"]');
    if (!off) continue; // selects not filled yet (first render of the form)
    const allowed = canDisableThinking(model, $(effortId).value);
    off.disabled = !allowed;
    if (!allowed && $(thinkingId).value === 'off') $(thinkingId).value = 'adaptive';
    $(hintId).hidden = allowed;
    $(hintId).textContent = allowed ? '' : 'Wyłączenie rozumowania działa tylko z Sonnet 5.5 przy effort do „Wysoka”.';
  }
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
  fillSelect($('thinking'), THINKING_MODES, s.thinking);
  fillSelect($('analysisEffort'), EFFORT_LEVELS, s.analysisEffort);
  fillSelect($('analysisThinking'), THINKING_MODES, s.analysisThinking);
  $('showThinking').checked = s.showThinking;
  renderThinkingAvailability();
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
  renderThinkingAvailability();
}

function readSettingsForm() {
  stashProviderFields();
  return mergeSettings({
    ...state.settings,
    provider: formProvider,
    apiKeys: draft.apiKeys,
    models: draft.models,
    effort: $('effort').value,
    thinking: $('thinking').value,
    analysisEffort: $('analysisEffort').value,
    analysisThinking: $('analysisThinking').value,
    showThinking: $('showThinking').checked,
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

// --- backup -------------------------------------------------------------------

let pendingImport = null; // parsed backup waiting for "Zastosuj"

function formatBackupDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'nieznanego dnia' : date.toLocaleString('pl-PL', { dateStyle: 'long', timeStyle: 'short' });
}

/** Save the stored settings and history to a JSON file (a download; no extra permission). */
function exportBackup() {
  const now = Date.now();
  const backup = buildBackup({
    settings: state.settings,
    history: state.history,
    includeKeys: $('exportIncludeKeys').checked,
    extensionVersion: chrome.runtime.getManifest().version,
    now,
  });
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backupFileName(now);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(
    $('backupStatus'),
    `Zapisano plik ${link.download} w folderze pobranych plików. Kopia zawiera zapisane ustawienia${backupHasKeys(backup.settings) ? ' razem z kluczami API' : ' bez kluczy API'}.`,
    'ok',
  );
}

function hideImportPreview() {
  pendingImport = null;
  $('importPreview').hidden = true;
}

/** Read the chosen file and show what an import would change; nothing is saved yet. */
async function readImportFile() {
  const input = $('importFile');
  const file = input.files?.[0];
  input.value = ''; // choosing the same file again must fire "change"
  hideImportPreview();
  if (!file) return;
  // Check the size before reading, so a huge wrong file is never loaded into memory.
  const result = file.size > MAX_BACKUP_BYTES ? { ok: false, error: BACKUP_TOO_LARGE } : parseBackup(await file.text());
  if (!result.ok) {
    setStatus($('backupStatus'), result.error, 'error');
    return;
  }
  pendingImport = result.backup;
  $('importPreviewTitle').textContent = `Kopia z ${formatBackupDate(result.backup.exportedAt)}. Po zastosowaniu:`;
  $('importPreviewList').replaceChildren(
    ...describeImport({ settings: state.settings, history: state.history }, result.backup).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }),
  );
  $('importPreview').hidden = false;
  setStatus($('backupStatus'), '');
}

async function applyImport() {
  if (!pendingImport) return;
  const backup = pendingImport;
  const settings = applyBackupSettings(state.settings, backup.settings);
  const history = mergeHistory(state.history, backup.history);
  await saveSettings(chrome.storage.local, settings);
  await chrome.storage.local.set({ history });
  state.settings = settings;
  state.history = history;
  hideImportPreview();
  renderSettingsForm();
  // The main view's selects were filled at start; show the imported choices now.
  $('tone').value = settings.tone;
  $('length').value = settings.length;
  setStatus($('backupStatus'), `Zaimportowano kopię z ${formatBackupDate(backup.exportedAt)}.`, 'ok');
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
    // Fixed, cheapest request: low effort, thinking parameter not sent.
    const { text } = await streamCompletion(
      { ...cfg, effort: 'low', thinking: 'adaptive', showThinking: false },
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
  $('historyToggle').addEventListener('click', () => showView($('historyView').hidden ? 'history' : 'main'));
  $('historySearch').addEventListener('input', renderHistory);
  $('historyKind').addEventListener('change', renderHistory);
  $('settingsView').addEventListener('submit', saveSettingsForm);
  $('testConnection').addEventListener('click', testConnection);
  $('exportIncludeKeys').addEventListener('change', () => {
    $('exportKeysWarning').hidden = !$('exportIncludeKeys').checked;
  });
  $('exportBackup').addEventListener('click', exportBackup);
  $('importBackup').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', readImportFile);
  $('applyImport').addEventListener('click', applyImport);
  $('cancelImport').addEventListener('click', () => {
    hideImportPreview();
    setStatus($('backupStatus'), 'Anulowano import. Nic się nie zmieniło.');
  });
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
    renderThinkingAvailability();
  });
  $('modelCustom').addEventListener('input', renderThinkingAvailability);
  $('effort').addEventListener('change', renderThinkingAvailability);
  $('analysisEffort').addEventListener('change', renderThinkingAvailability);

  $('useSelection').addEventListener('click', useSelection);
  $('translateSelection').addEventListener('click', () => translateSelection());
  $('copyTranslation').addEventListener('click', copyTranslation);
  $('closeTranslation').addEventListener('click', closeTranslation);
  $('translateComments').addEventListener('click', translateComments);
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

  // Alt+Shift+T: the request may already be waiting (panel opened by the command)
  // or arrive while the panel is open.
  chrome.storage.session.onChanged.addListener((changes) => handleTranslateRequest(changes.translateRequest?.newValue));
  handleTranslateRequest((await chrome.storage.session.get('translateRequest')).translateRequest);

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
