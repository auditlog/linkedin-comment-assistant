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
  buildBackTranslationMessages,
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
import { heuristicIssues, buildCheckMessages, parseCheckResult, buildSpecificFeedback } from '../lib/quality.js';
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

import { targetIdentity, sourceRevision, draftKey, fingerprint, sameTarget } from '../lib/context.js';
import { Operations, abortable, abortError } from '../lib/operations.js';
import { pushVersion, sanitizeDraft } from '../lib/drafts.js';
import { readAttachment, mediaCoverage, MAX_MEDIA_IMAGES, MAX_ATTACHMENTS_BYTES } from '../lib/media.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: mergeSettings({}),
  windowId: null, epoch: 0, sourceRevision: '', draftLoading: false, draftDirty: false,
  versions: [], versionCursor: -1, translationFor: '', attachments: [], selectedPages: new Set(),
  imageCache: new Map(), lastCoverage: '', costs: [], retry: null,
  post: null, // {key, author, text, replyTo, imageUrls, hasSeeMore, tabId, editorToken, manual}
  pendingPost: null, // a post focused on the page while the user had work in progress
  postLanguage: null, // ISO code from the analysis (<post_language>), used to pick style examples
  history: [], // comments the user inserted/copied (src/lib/voice.js), newest first
  check: { status: 'idle', issues: [], checkedText: '', error: '' }, // model quality check of the comment
  harmonic: { status: 'off', company: null, person: null, error: '' }, // optional company/person data
  harmonicPromise: null,
  includeImages: true,
  analysisRaw: '',
  conversation: [], // Claude messages of the comment thread for the current post
  // Config of the "Pisanie i poprawki" group, frozen by writeComment for the whole thread:
  // with thinking off the API forbids changing effort mid-conversation, and a changed
  // thinking setting would invalidate the cache. New settings apply from the next comment.
  writeConfig: null,
  writtenWith: null, // {tone, length} the current comment was written or last revised with
  analysisThinking: '', // streamed thinking summary of the analysis (showThinking)
  resultThinking: '', // streamed thinking summary of the last comment reply
  lastResultThinking: '',
  lastGeneratedComment: '',
  lastResultRaw: '', // raw text of the last successful comment reply (re-rendered after a failed refine)

  commentTranslations: [], // Polish translations of post.existingComments, same order
  // Selection translation uses a separate operation scope and survives post switches.

  translateRaw: '',
  lastTranslateAt: 0,
};

const ops = new Operations((event) => {
  if (event?.type === 'start') state.retry = null;
  renderOperations();
});

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

function costScope(post = state.post) {
  return targetIdentity(post) || 'other';
}

function addCost(message, cfg, task, scope = costScope()) {
  const model = message?.model || cfg.model;
  state.costs.push({ scope, label: task.label, model,
    usd: estimateCostUsd(model, message?.usage), usage: message?.usage || {},
    ms: Date.now() - task.startedAt });
  state.costs = state.costs.slice(-100);
  renderCosts();
}

function renderCosts() {
  const items = state.costs.filter((item) => item.scope === costScope());
  const total = items.reduce((sum, item) => sum + (item.usd || 0), 0);
  const models = [...new Set(items.map((item) => modelLabel(item.model)))].join(', ');
  $('costLine').textContent = items.length
    ? `Model: ${models}. Koszt dla ${KIND_LABELS[postKind()].costScope}: ${formatCost(total)} (szacunek${items.some((item) => item.usd == null) ? ', część kosztu nieznana' : ''}).` : '';
  $('costDetails').hidden = items.length === 0;
  $('costList').replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const u = item.usage;
    li.textContent = `${item.label}: ${modelLabel(item.model)}, ${formatCost(item.usd) || 'koszt nieznany'}, ${(item.ms / 1000).toFixed(1).replace('.', ',')} s. Tokeny: wejście ${u.input_tokens || 0}, wyjście ${u.output_tokens || 0}, cache odczyt ${u.cache_read_input_tokens || 0}, zapis ${u.cache_creation_input_tokens || 0}.`;
    return li;
  }));
}

function renderOperations() {
  const active = ops.active();
  $('operationBar').hidden = !active.length && !state.retry;
  $('stopOperation').hidden = !active.length;
  $('retryOperation').hidden = active.length > 0 || !state.retry;
  $('operationStatus').textContent = active.length ? active.map((task) => task.label).join(' · ') : state.retry ? 'Możesz ponowić ostatnie zadanie.' : '';
  const writing = ops.has('comment');
  $('writeComment').disabled = writing || state.draftLoading;
  $('refineForm').querySelector('button').disabled = writing;
  $('makeSpecific').disabled = writing;
  const currentIndex = state.versions.findIndex((version) => version.comment === $('commentText').value);
  $('undoRevision').disabled = writing || !state.versions.length || currentIndex === 0;
  $('restoreVersion').disabled = writing;
  $('commentText').readOnly = writing;
  const noText = !$('commentText').value.trim();
  $('insertComment').disabled = writing || noText || state.post?.manual || state.post?.tabId == null;
  $('copyComment').disabled = writing || noText;
  $('refreshBackTranslation').disabled = writing || ops.has('backTranslation');
}

function offerRetry(callback, { text = null, epoch = state.epoch, independent = false, taskName = null } = {}) {
  state.retry = { callback, taskName, valid: () => (independent || state.epoch === epoch) && (text == null || $('commentText').value.trim() === text) };
  renderOperations();
}

function taskError(error, cfg, task, statusEl, retry, guard = {}) {
  if (!task.owns()) return;
  const message = describeError(error, cfg);
  setStatus(statusEl, message || 'Przerwano. Dotychczasowy tekst został zachowany.', message ? 'error' : '');
  if (retry) offerRetry(retry, { ...guard, taskName: task.name });
}

function currentVersion() {
  return {
    at: Date.now(), comment: $('commentText').value, translation: $('backTranslation').textContent,
    translationFor: state.translationFor, generated: state.lastGeneratedComment,
    tone: state.writtenWith?.tone || $('tone').value, length: state.writtenWith?.length || $('length').value,
    notes: [...$('notes').children].map((node) => node.textContent), thinking: state.resultThinking,
  };
}

function restoreVersion(version) {
  $('commentText').value = version.comment || '';
  $('backTranslation').textContent = version.translation || '';
  state.translationFor = version.translationFor || '';
  state.lastGeneratedComment = version.generated || '';
  state.resultThinking = version.thinking || '';
  $('resultReasoningText').textContent = state.resultThinking;
  $('resultReasoning').hidden = !state.resultThinking;
  $('notes').replaceChildren(...(version.notes || []).map((text) => {
    const li = document.createElement('li'); li.textContent = text; return li;
  }));
  state.writtenWith = { tone: version.tone || $('tone').value, length: version.length || $('length').value };
  state.versionCursor = state.versions.findIndex((item) => item.comment === version.comment);
  $('resultSection').hidden = !version.comment;
  renderEditState();
  renderQuality();
  renderOperations();
}

function renderEditState() {
  const current = $('commentText').value.trim();
  const stale = Boolean(current) && current !== state.translationFor.trim();
  $('backTranslationStatus').hidden = !stale;
  $('refreshBackTranslation').hidden = !stale;
  $('notesWrap').hidden = current !== state.lastGeneratedComment.trim() || !$('notes').children.length;
  renderRefineHint();
}

function renderVersions() {
  $('versionControls').hidden = state.versions.length === 0;
  fillSelect($('versionSelect'), Object.fromEntries(state.versions.map((item, i) => [String(i),
    `${i + 1}. ${item.comment.slice(0, 55)}${item.comment.length > 55 ? '…' : ''}`])), String(state.versionCursor >= 0 ? state.versionCursor : Math.max(0, state.versions.length - 1)));
  renderOperations();
}

function selectVersion(index) {
  const chosen = state.versions[index];
  if (!chosen || ops.has('comment')) return;
  if (!state.versions.some((item) => item.comment === $('commentText').value)) state.versions = pushVersion(state.versions, currentVersion());
  ops.cancel('check'); ops.cancel('backTranslation');
  state.conversation = []; state.writeConfig = null;
  state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
  restoreVersion(chosen); renderVersions(); persistDraft();
}

function persistDraft() {
  if (!state.post || state.draftLoading) return;
  const version = currentVersion();
  if (!version.comment.trim() && !$('instruction').value.trim() && !$('refineInput').value.trim()) return;
  if ([version.comment, version.translation, version.generated].some((text) => text.length > 20000)
    || $('instruction').value.length > 10000 || $('refineInput').value.length > 5000) {
    setStatus($('draftStatus'), 'Szkic jest za długi do automatycznego zapisu. Skopiuj tekst przed zamknięciem panelu.', 'warn');
    return;
  }
  const epoch = state.epoch;
  const draft = { ...version, at: Date.now(), instruction: $('instruction').value, feedback: $('refineInput').value,
    sourceRevision: state.sourceRevision, hadAttachments: state.attachments.length > 0, versions: state.versions };
  chrome.runtime.sendMessage({ type: 'lca:draft:save', key: draftKey(state.post), draft, persistent: state.settings.persistDrafts })
    .then((result) => {
      if (epoch === state.epoch && !result?.ok) setStatus($('draftStatus'), 'Nie udało się zapisać szkicu. Skopiuj tekst przed zamknięciem panelu.', 'error');
    }).catch(() => {
      if (epoch === state.epoch) setStatus($('draftStatus'), 'Nie udało się zapisać szkicu. Skopiuj tekst przed zamknięciem panelu.', 'error');
    });
}

function ownTextChanged() {
  state.draftDirty = true;
  state.versionCursor = state.versions.findIndex((item) => item.comment === $('commentText').value);
  ops.cancel('check');
  ops.cancel('backTranslation');
  renderEditState(); renderQuality(); renderVersions(); persistDraft();
}

async function restoreDraftForPost(post, epoch) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'lca:draft:load', key: draftKey(post) });
    if (epoch !== state.epoch || state.draftDirty) return;
    const draft = sanitizeDraft(response?.draft);
    if (!draft) return;
    $('instruction').value = draft.instruction;
    $('refineInput').value = draft.feedback;
    state.versions = draft.versions;
    restoreVersion(draft);
    const sourceChanged = draft.sourceRevision !== state.sourceRevision;
    setStatus($('draftStatus'), `Przywrócono Twój szkic.${sourceChanged ? ' Kontekst się zmienił: sprawdź tekst przed wstawieniem.' : ''}${draft.hadAttachments ? ' Dołącz obrazy ponownie, jeśli są nadal potrzebne.' : ''}`);
    renderVersions();
  } catch {
    if (epoch === state.epoch) setStatus($('draftStatus'), 'Nie udało się odczytać zapisanych szkiców.', 'error');
  } finally {
    if (epoch === state.epoch) { state.draftLoading = false; renderOperations(); }
  }
}

// --- post -------------------------------------------------------------------

function abortAll() {
  ops.cancelAll({ scope: 'post', discard: true });
  for (const key of ['analysis', 'result', 'comments', 'backTranslation']) cancelRender(key);
}

// Follow mode binds a post on every comment-box focus; wait a moment before the automatic
// analysis, so clicking through several boxes analyzes only the one the user stays on.
const AUTO_ANALYSIS_DELAY_MS = 600;
let autoAnalysisTimer = null;

/** True when switching posts would throw away something the user typed or received. */
function hasWork() {
  return Boolean($('instruction').value.trim() || $('commentText').value.trim() || state.conversation.length || ops.has('comment') || state.attachments.length);
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
  persistDraft();
  abortAll();
  clearTimeout(autoAnalysisTimer);
  showPendingPost(null);
  const epoch = ++state.epoch;
  state.post = post;
  state.sourceRevision = sourceRevision(post);
  state.retry = null;
  state.analysisRaw = '';
  state.commentTranslations = [];
  state.conversation = [];
  state.writeConfig = null;
  state.writtenInstruction = '';
  state.writtenWith = null;
  state.lastGeneratedComment = '';
  state.lastResultRaw = '';
  state.analysisThinking = '';
  state.resultThinking = '';
  state.lastResultThinking = '';
  state.postLanguage = null;
  state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
  state.includeImages = state.settings.includeImages;
  state.imageCache = new Map();
  state.attachments = [];
  state.lastCoverage = '';
  state.selectedPages = new Set((post?.media?.pages || []).map((page) => page.url));
  state.versions = [];
  state.versionCursor = -1;
  state.translationFor = '';
  state.draftDirty = false;
  state.draftLoading = Boolean(post);
  for (const id of ['instruction', 'commentText', 'refineInput']) $(id).value = '';
  for (const id of ['translateCommentsStatus', 'insertStatus', 'draftStatus', 'analysisStatus', 'attachmentStatus']) setStatus($(id), '');
  $('backTranslation').textContent = '';
  $('backTranslationStatus').hidden = true;
  $('refreshBackTranslation').hidden = true;
  $('refineHint').hidden = true;
  startHarmonic(post);
  renderPost(); renderAnalysis(); renderMedia(); renderVersions(); renderCosts();
  $('resultSection').hidden = true;
  state.autoAnalysisPending = false;
  state.autoAnalysisCancelled = false;
  const key = `lca:panelContext:${state.windowId}`;
  if (post) {
    chrome.storage.session.set({ [key]: post });
    restoreDraftForPost(post, epoch).then(() => {
      if (epoch !== state.epoch || state.autoAnalysisCancelled || hasWork() || !state.post?.text || !state.settings.autoAnalyze) return;
      state.autoAnalysisPending = true;
      renderAnalysis();
      autoAnalysisTimer = setTimeout(runAnalysis, AUTO_ANALYSIS_DELAY_MS);
    });
  } else {
    chrome.storage.session.remove(key);
  }
  renderOperations();
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
    $('postExcerpt').textContent = post.text || (post.imageUrls?.length || post.media
      ? 'Post zawiera obrazy lub inne media. Sprawdź zakres odczytu poniżej.'
      : 'Nie udało się odczytać treści posta. Rozwiń „Pełny tekst posta” i wklej ją ręcznie.');
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
  renderOperations();
}

function requestSnapshot() {
  return {
    post: structuredClone(state.post), epoch: state.epoch, revision: state.sourceRevision,
    imagesEnabled: state.includeImages, attachments: [...state.attachments],
    selectedPages: [...state.selectedPages], harmonicPromise: state.harmonicPromise,
    system: buildSystemPrompt(state.settings), instruction: $('instruction').value,
    choices: currentChoices(), language: state.settings.commentLanguage, scope: costScope(),
  };
}

async function prepareContext(snapshot, task, waitMs) {
  let timer;
  try {
    const background = snapshot.harmonicPromise ? await abortable(Promise.race([
      snapshot.harmonicPromise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]), task.signal) : null;
    if (!task.current()) throw abortError();
    const post = structuredClone(snapshot.post);
    if (background) post.companyContext = formatBackground(background) || post.companyContext;
    const attachments = snapshot.imagesEnabled ? snapshot.attachments.slice(0, MAX_MEDIA_IMAGES) : [];
    const urls = snapshot.imagesEnabled ? (post.media?.kind === 'document'
      ? snapshot.selectedPages : (post.imageUrls || []).slice(0, 2)).slice(0, MAX_MEDIA_IMAGES - attachments.length) : [];
    const key = fingerprint(urls);
    let failed = 0;
    let blocks = state.imageCache.get(key);
    if (!blocks) {
      blocks = await fetchImageBlocks(urls, fetch, { signal: task.signal, maxImages: MAX_MEDIA_IMAGES, onFailure: () => failed++ });
      if (!task.current()) throw abortError();
      if (!failed) state.imageCache.set(key, blocks);
    }
    post.mediaCoverage = mediaCoverage(post, { imageCount: blocks.length, attachmentCount: attachments.length, failed, imagesEnabled: snapshot.imagesEnabled });
    if (post.hasSeeMore) post.mediaCoverage += '\nTekst posta może być skrócony na stronie.';
    state.lastCoverage = post.mediaCoverage;
    renderMedia();
    return { post, images: [...blocks, ...attachments.map((attachment) => attachment.block)] };
  } finally { clearTimeout(timer); }
}

function renderMedia() {
  const post = state.post;
  $('mediaDetails').hidden = postKind() === 'message';
  const pages = post?.media?.pages || [];
  $('mediaCoverage').textContent = state.lastCoverage || mediaCoverage(post, {
    imageCount: state.includeImages ? pages.filter((page) => state.selectedPages.has(page.url)).length : 0,
    attachmentCount: state.includeImages ? state.attachments.length : 0, imagesEnabled: state.includeImages,
  });
  $('documentPages').replaceChildren(...pages.map((page, i) => {
    const label = document.createElement('label'); label.className = 'check';
    const input = document.createElement('input'); input.type = 'checkbox';
    input.checked = state.selectedPages.has(page.url);
    input.addEventListener('change', () => {
      if (input.checked) state.selectedPages.add(page.url); else state.selectedPages.delete(page.url);
      mediaChanged();
    });
    label.append(input, page.number ? ` Strona ${page.number}` : ` Obraz strony ${i + 1}`);
    return label;
  }));
  $('attachmentList').replaceChildren(...state.attachments.map((item) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = item.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'link'; remove.textContent = 'Usuń';
    remove.setAttribute('aria-label', `Usuń załącznik ${item.name}`);
    remove.addEventListener('click', () => { state.attachments = state.attachments.filter((attachment) => attachment.id !== item.id); mediaChanged(); persistDraft(); });
    li.append(name, remove); return li;
  }));
  const count = pages.length || post?.imageUrls?.length || 0;
  $('imagesToggleWrap').hidden = count + state.attachments.length === 0;
  const selectedCount = Math.min(MAX_MEDIA_IMAGES, (pages.length ? state.selectedPages.size : post?.imageUrls?.length || 0) + state.attachments.length);
  $('imageCount').textContent = selectedCount > 1 ? `(${selectedCount})` : '';
  $('includeImages').checked = state.includeImages;
  if (post?.media) $('mediaDetails').open = true;
}

function mediaChanged() {
  ops.cancel('analysis'); ops.cancel('comment'); ops.cancel('check');
  state.lastCoverage = '';
  state.analysisRaw = ''; state.analysisThinking = '';
  renderAnalysis(); renderMedia();
}

async function addAttachments() {
  const files = [...($('attachmentFiles').files || [])];
  $('attachmentFiles').value = '';
  if (!files.length) return;
  if (postKind() === 'message') {
    setStatus($('attachmentStatus'), 'Załączniki służą do analizy postów. W rozmowie wklej potrzebny tekst do kontekstu.', 'error'); return;
  }
  if (!state.post) setPost({ key: `manual:${crypto.randomUUID()}`, manual: true, author: '', text: '', tabId: null, imageUrls: [] });
  $('mediaDetails').open = true;
  const task = ops.start('attachments', 'Odczytuję załączniki…');
  try {
    if (files.length + state.attachments.length > MAX_MEDIA_IMAGES) throw new Error('Możesz dodać najwyżej 6 obrazów. Usuń część załączników i spróbuj ponownie.');
    const total = state.attachments.reduce((sum, item) => sum + item.bytes, 0) + files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_ATTACHMENTS_BYTES) throw new Error('Załączniki mogą mieć łącznie najwyżej 12 MB. Zmniejsz obrazy i spróbuj ponownie.');
    const attachments = await abortable(Promise.all(files.map(readAttachment)), task.signal);
    if (!task.current()) return;
    state.attachments.push(...attachments);
    state.includeImages = true;
    mediaChanged(); persistDraft();
    setStatus($('attachmentStatus'), 'Dodano obrazy. Uruchom analizę lub pisanie, żeby użyć ich w zapytaniu.', 'ok');
  } catch (error) {
    if (task.owns()) setStatus($('attachmentStatus'), task.signal.aborted ? 'Przerwano odczyt załączników.' : error.message, task.signal.aborted ? '' : 'error');
  } finally { ops.finish(task); }
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
  if (!text && !state.attachments.length) {
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
  state.translateRaw = '';
  $('translateSource').textContent = '';
  renderTranslation();
  if (!ensureConfigOrExplain(status)) return;
  const task = ops.start('selection', 'Tłumaczę zaznaczenie…', 'selection');
  const cfg = config('analysis');
  const system = buildSystemPrompt(state.settings);
  try {
    const id = tabId ?? (await abortable(chrome.tabs.query({ active: true, currentWindow: true }), task.signal))[0]?.id;
    if (id == null) throw new Error(TRANSLATE_MESSAGES.unreachable);
    let response;
    try { response = await abortable(chrome.tabs.sendMessage(id, { type: 'lca:getSelection' }), task.signal); }
    catch (error) { if (task.signal.aborted) throw error; throw new Error(TRANSLATE_MESSAGES.unreachable); }
    if (!task.current()) return;
    let text = String(response?.text || '').trim();
    if (!text) throw new Error(TRANSLATE_MESSAGES.noSelection);
    const truncated = text.length > MAX_SELECTION_CHARS;
    text = text.slice(0, MAX_SELECTION_CHARS);
    $('translateSource').textContent = `„${text.slice(0, 120)}${text.length > 120 ? '…' : ''}”`;
    setStatus(status, 'Tłumaczę…');
    const { text: raw, message } = await streamCompletion(cfg,
      { system, messages: buildTranslateMessages(text) }, {
        signal: task.signal,
        onText: (partial) => {
          if (!task.current()) return;
          state.translateRaw = partial;
          scheduleRender('translate', () => { if (task.current()) renderTranslation({ streaming: true }); });
        },
      });
    if (!task.current()) return;
    if (!parseTagged(raw, TRANSLATE_TAGS).translation) throw new Error('Model nie zwrócił tłumaczenia. Spróbuj ponownie.');
    state.translateRaw = raw;
    addCost(message, cfg, task, 'selection');
    const cost = formatCost(estimateCostUsd(message.model || cfg.model, message.usage));
    setStatus(status, `${truncated ? TRANSLATE_MESSAGES.truncated + ' ' : ''}${cost ? `Koszt tłumaczenia: ${cost} (szacunek).` : ''}`, truncated ? 'warn' : '');
  } catch (error) {
    taskError(error, cfg, task, status, () => translateSelection({ tabId }), { independent: true });
  } finally {
    if (task.owns()) { cancelRender('translate'); renderTranslation(); }
    ops.finish(task);
  }
}

/**
 * Run a request left by the Alt+Shift+T command (src/background.js), at most once and only
 * when fresh. A request for another window is left for the panel of that window.
 */
async function handleTranslateRequest(request) {
  if (!request || request.at === state.lastTranslateAt) return;
  if (request.windowId != null) {
    const current = await chrome.windows.getCurrent().catch(() => null);
    if (current && current.id !== request.windowId) return;
  }
  if (request.at === state.lastTranslateAt) return; // handled meanwhile (start and onChanged)
  chrome.storage.session.remove('translateRequest');
  if (Date.now() - request.at > 10_000) return; // stale: the panel was opened much later
  state.lastTranslateAt = request.at;
  translateSelection({ tabId: request.tabId });
}

function closeTranslation() {
  if (state.retry?.taskName === 'selection') state.retry = null;
  ops.cancelAll({ scope: 'selection', discard: true });
  cancelRender('translate');
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
  const settings = state.settings;
  const enabled = settings.useHarmonic && settings.harmonicApiKey.trim() && post && !post.manual && post.authorProfile;
  if (!enabled) {
    state.harmonic = { status: 'off', company: null, person: null, error: '' };
    state.harmonicPromise = null; return;
  }
  const task = ops.start('harmonic', 'Pobieram kontekst Harmonic…');
  state.harmonic = { status: 'loading', company: null, person: null, error: '' };
  state.harmonicPromise = fetchHarmonicContext({ profile: post.authorProfile, apiKey: settings.harmonicApiKey.trim(), signal: task.signal })
    .then((ctx) => {
      if (!task.current()) return null;
      state.harmonic = { status: 'done', ...ctx, error: '' };
      state.post = { ...state.post, companyContext: formatBackground(ctx) || null };
      return ctx;
    })
    .catch((error) => {
      if (task.owns()) state.harmonic = { status: 'error', company: null, person: null,
        error: task.signal.aborted ? 'Przerwano pobieranie danych.' : error.message };
      return null;
    })
    .finally(() => { if (task.owns()) renderContext(); ops.finish(task); });
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
  const running = ops.has('translateComments');
  $('translateComments').hidden = others.length === 0 || (state.commentTranslations.length > 0 && !running);
  $('translateComments').disabled = running;
}

/** Translate the comments under the post into Polish (one request, analysis settings). */
async function translateComments() {
  const others = structuredClone(otherComments());
  if (!others.length || !ensureConfigOrExplain($('translateCommentsStatus'))) return;
  const task = ops.start('translateComments', 'Tłumaczę komentarze…');
  const cfg = config('analysis');
  const scope = costScope();
  const system = buildSystemPrompt(state.settings);
  const parse = (raw) => parseItems(parseTagged(raw, TRANSLATE_COMMENTS_TAGS).translations, 'item');
  state.commentTranslations = [];
  setStatus($('translateCommentsStatus'), 'Tłumaczę komentarze…'); renderContext();
  try {
    const { text, message } = await streamCompletion(cfg,
      { system, messages: buildTranslateCommentsMessages(others) }, {
        signal: task.signal,
        onText: (partial) => {
          if (!task.current()) return;
          state.commentTranslations = parse(partial);
          scheduleRender('comments', () => { if (task.current()) renderContext(); });
        },
      });
    if (!task.current()) return;
    const translations = parse(text);
    if (translations.length !== others.length) throw new Error('Model nie przetłumaczył wszystkich komentarzy. Spróbuj ponownie.');
    state.commentTranslations = translations;
    setStatus($('translateCommentsStatus'), '');
    addCost(message, cfg, task, scope);
  } catch (error) {
    taskError(error, cfg, task, $('translateCommentsStatus'), translateComments);
  } finally {
    if (task.owns()) { cancelRender('comments'); ops.finish(task); renderContext(); }
    else ops.finish(task);
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
        $('instruction').focus(); state.draftDirty = true; persistDraft();
      });
      li.append(btn);
      return li;
    }),
  );
  $('runAnalysis').hidden = Boolean(state.analysisRaw) || ops.has('analysis') || state.autoAnalysisPending;
  if (state.autoAnalysisPending && !ops.has('analysis')) setStatus($('analysisStatus'), 'Za chwilę przetłumaczę post…');
}

const analysisCache = new Map();
async function runAnalysis({ force = false } = {}) {
  state.autoAnalysisPending = false;
  clearTimeout(autoAnalysisTimer);
  const status = $('analysisStatus');
  if (!state.post || (!state.post.text && !state.attachments.length && !state.post.media && !state.post.imageUrls?.length)) {
    setStatus(status, 'Brak treści do analizy. Uzupełnij tekst albo dodaj obrazy.', 'error'); return;
  }
  if (!ensureConfigOrExplain(status)) return;
  const snapshot = requestSnapshot();
  const cfg = config('analysis');
  const task = ops.start('analysis', 'Analizuję kontekst…');
  state.analysisRaw = ''; state.analysisThinking = '';
  renderAnalysis(); setStatus(status, 'Tłumaczę i szukam pomysłów…');
  try {
    const { post, images } = await prepareContext(snapshot, task, 3000);
    if (!task.current()) return;
    const messages = buildAnalysisMessages(post, images);
    // Contains only a fingerprint, never a durable copy of the source or user profile.
    const key = fingerprint([snapshot.system, messages, cfg.provider, cfg.model, cfg.effort, cfg.thinking, cfg.showThinking]);
    let result = !force && analysisCache.get(key);
    if (!result) {
      result = await streamCompletion(cfg, { system: snapshot.system, messages }, {
        signal: task.signal,
        onText: (partial) => {
          if (!task.current()) return;
          state.analysisRaw = partial;
          scheduleRender('analysis', () => { if (task.current()) renderAnalysis(); });
        },
        onThinking: (thinking) => {
          if (!task.current()) return;
          state.analysisThinking = thinking;
          scheduleRender('analysis', () => { if (task.current()) renderAnalysis(); });
        },
      });
      if (!task.current()) return;
      if (!parseTagged(result.text, ANALYSIS_TAGS).translation) throw new Error('Model nie zwrócił analizy. Spróbuj ponownie.');
      analysisCache.set(key, result);
      if (analysisCache.size > 10) analysisCache.delete(analysisCache.keys().next().value);
      addCost(result.message, cfg, task, snapshot.scope);
      setStatus(status, '');
    } else setStatus(status, 'Przywrócono identyczną analizę z tej sesji, bez kolejnego zapytania.');
    state.analysisRaw = result.text;
    state.analysisThinking = result.thinking;
    state.postLanguage = (parseTagged(result.text, ['post_language']).post_language || '').toLowerCase().slice(0, 5) || null;
  } catch (error) {
    taskError(error, cfg, task, status, () => runAnalysis({ force: true }));
  } finally {
    if (task.owns()) { cancelRender('analysis'); ops.finish(task); renderAnalysis(); }
    else ops.finish(task);
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
 * Config for the comment conversation: effort, thinking, provider and model stay as
 * frozen by writeComment, but the API key is read fresh, so a key corrected in the
 * settings (e.g. after a 401) works for the next refinement of the same comment.
 */
function frozenWriteConfig() {
  if (!state.writeConfig) return config('write');
  return { ...state.writeConfig, apiKey: (state.settings.apiKeys?.[state.writeConfig.provider] || '').trim() };
}

/** Tone and length chosen in the panel right now. */
function currentChoices() {
  return { tone: $('tone').value, length: $('length').value };
}

/**
 * Tone/length changed since the comment was written (only the changed keys), or null.
 * A refinement passes them to the model, which otherwise keeps the old ones.
 */
function choiceChanges() {
  if (!state.writtenWith || !$('commentText').value.trim()) return null;
  const now = currentChoices();
  const changed = {};
  if (now.tone !== state.writtenWith.tone) changed.tone = now.tone;
  if (now.length !== state.writtenWith.length) changed.length = now.length;
  return Object.keys(changed).length ? { ...changed, kind: postKind() } : null;
}

function renderRefineHint() {
  $('refineHint').hidden = !choiceChanges();
}

/**
 * Send the current conversation and render the reply as the new result.
 * On failure the last (unanswered) user message is removed, so the history stays valid.
 * @returns {Promise<boolean>} true when the reply arrived
 */
async function sendConversation({ task, cfg, system, messages, previous, snapshot, statusText }) {
  $('resultSection').hidden = false;
  setStatus($('insertStatus'), ''); setStatus($('resultStatus'), statusText);
  ops.cancel('check'); ops.cancel('backTranslation');
  state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
  $('qualityBox').hidden = true;
  let partialRaw = '';
  state.resultThinking = '';
  const result = await streamCompletion(cfg, { system, messages }, {
    signal: task.signal,
    onText: (partial) => {
      if (!task.current()) return;
      partialRaw = partial;
      scheduleRender('result', () => { if (task.current()) renderResult(partialRaw, { streaming: true }); });
    },
    onThinking: (thinking) => {
      if (!task.current()) return;
      state.resultThinking = thinking;
      scheduleRender('result', () => { if (task.current()) renderResult(partialRaw, { streaming: true }); });
    },
  });
  if (!task.current()) return false;
  const parsed = parseTagged(result.text, COMMENT_TAGS);
  if (!parsed.comment || (result.message.stop_reason !== 'max_tokens' && !result.text.includes('</comment>'))) {
    throw new Error('Model nie zwrócił kompletnego tekstu. Spróbuj ponownie. Dotychczasowy szkic został zachowany.');
  }
  state.conversation = [...messages, { role: 'assistant', content: result.message.content }];
  state.writeConfig = cfg;
  state.writtenInstruction = snapshot.instruction;
  state.writtenWith = snapshot.choices;
  cancelRender('result'); renderResult(result.text, { streaming: false });
  state.lastResultRaw = result.text;
  state.lastGeneratedComment = $('commentText').value;
  state.translationFor = parsed.back_translation ? state.lastGeneratedComment : '';
  state.lastResultThinking = state.resultThinking;
  state.versions = pushVersion(pushVersion(state.versions, previous), currentVersion());
  state.versionCursor = state.versions.length - 1;
  renderVersions(); renderEditState();
  const truncated = result.message.stop_reason === 'max_tokens';
  setStatus($('resultStatus'), truncated ? 'Odpowiedź została ucięta (limit długości). Spróbuj „Popraw: krócej”.' : '', truncated ? 'warn' : '');
  addCost(result.message, cfg, task, snapshot.scope);
  persistDraft();
  return true;
}

async function writeComment() {
  if (!state.post || state.draftLoading || ops.has('comment')) return;
  const cfg = config('write');
  const problem = validateConfig(cfg);
  if (problem) { $('resultSection').hidden = false; setStatus($('resultStatus'), problem, 'error'); return; }
  const snapshot = requestSnapshot();
  const previous = currentVersion();
  const system = writingSystem();
  const task = ops.start('comment', 'Piszę odpowiedź…');
  state.retry = null;
  $('resultSection').hidden = false;
  setStatus($('resultStatus'), 'Przygotowuję…');
  $('resultSection').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  let success = false;
  try {
    const { post, images } = await prepareContext(snapshot, task, 8000);
    if (!task.current()) return;
    const messages = buildCommentMessages({ post, imageBlocks: images, instruction: snapshot.instruction,
      tone: snapshot.choices.tone, length: snapshot.choices.length, language: snapshot.language });
    success = await sendConversation({ task, cfg, system, messages, previous, snapshot, statusText: 'Piszę…' });
  } catch (error) {
    if (task.owns()) { cancelRender('result'); restoreVersion(previous); }
    taskError(error, cfg, task, $('resultStatus'), writeComment, { text: previous.comment.trim() });
    persistDraft();
  } finally {
    ops.finish(task); renderQuality();
    if (success) runCheck();
  }
}

async function refine(event) {
  event.preventDefault();
  const feedback = $('refineInput').value.trim();
  if (!$('commentText').value.trim() || !state.post) {
    setStatus($('resultStatus'), 'Najpierw napisz albo przywróć szkic.', 'error'); return;
  }
  const changes = choiceChanges();
  if (!feedback && !changes) {
    setStatus($('resultStatus'), 'Wpisz, co poprawić, np. „krócej” albo „bez pytania na końcu”.', 'error'); return;
  }
  const current = $('commentText').value.trim();
  const edited = !state.conversation.length || current !== state.lastGeneratedComment.trim() ? current : null;
  const ok = await sendRevision(buildRefineMessage(feedback, edited, changes), feedback ? 'Poprawiam…' : 'Zmieniam ton i długość…');
  if (ok && $('refineInput').value.trim() === feedback) { $('refineInput').value = ''; persistDraft(); }
}

async function sendRevision(content, statusText) {
  if (ops.has('comment') || state.draftLoading || !state.post) return false;
  const cfg = frozenWriteConfig();
  const problem = validateConfig(cfg);
  if (problem) { setStatus($('resultStatus'), problem, 'error'); return false; }
  const previous = currentVersion();
  const snapshot = requestSnapshot();
  // Profile and voice changes apply to the next request. Capture them before
  // awaiting context, while keeping API configuration and signed history intact.
  const system = writingSystem();
  const conversation = structuredClone(state.conversation);
  const task = ops.start('comment', 'Poprawiam tekst…');
  state.retry = null;
  let success = false;
  try {
    let messages;
    if (conversation.length) messages = [...conversation, { role: 'user', content }];
    else {
      // Restored drafts contain only the user's own text. Rebuild a fresh request
      // from the currently selected source; never persist the old DM/API thread.
      const { post, images } = await prepareContext(snapshot, task, 8000);
      if (!task.current()) return false;
      messages = buildCommentMessages({ post, imageBlocks: images, instruction: snapshot.instruction,
        tone: snapshot.choices.tone, length: snapshot.choices.length, language: snapshot.language });
      const first = messages[0];
      const revision = content.includes('<current_comment>') ? content
        : `${buildRefineMessage('', previous.comment)}\n\n${content}`;
      if (typeof first.content === 'string') first.content += '\n\n' + revision;
      else first.content.push({ type: 'text', text: revision });
    }
    success = await sendConversation({ task, cfg, system, messages, previous, snapshot, statusText });
    return success;
  } catch (error) {
    if (task.owns()) { cancelRender('result'); restoreVersion(previous); }
    taskError(error, cfg, task, $('resultStatus'), () => sendRevision(content, statusText), { text: previous.comment.trim() });
    persistDraft(); return false;
  } finally {
    ops.finish(task); renderQuality();
    if (success) runCheck();
  }
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
        ? '✓ Model nie wykrył problemów w odpowiedzi.'
        : '✓ Model nie wykrył problemów w komentarzu.',
      'ok',
    );
  } else {
    setStatus($('qualityStatus'), stale ? 'Tekst zmieniony po sprawdzeniu.' : 'Nie sprawdzono tej wersji tekstu.');
  }
  $('qualityIssues').replaceChildren(
    ...issues.map((issue) => {
      const li = document.createElement('li');
      li.textContent = issue.message;
      return li;
    }),
  );
  $('makeSpecific').hidden = issues.length === 0 || !$('commentText').value.trim();
  $('recheck').hidden = status === 'running' || !(stale || status === 'error' || status === 'idle');
}

/** Ask the model whether the comment adds something (runs after each draft, non-blocking). */
async function runCheck() {
  const comment = $('commentText').value.trim();
  const cfg = config('analysis');
  if (!comment || !state.post || validateConfig(cfg)) return;
  const task = ops.start('check', 'Sprawdzam tekst…');
  const post = structuredClone(state.post);
  const scope = costScope();
  const system = buildSystemPrompt(state.settings);
  const instruction = state.writtenInstruction || $('instruction').value;
  state.check = { status: 'running', issues: [], checkedText: comment, error: '' };
  renderQuality();
  try {
    const { text, message } = await streamCompletion(cfg,
      { system, messages: buildCheckMessages({ post, comment, instruction }) }, { signal: task.signal });
    if (!task.current() || $('commentText').value.trim() !== comment) return;
    addCost(message, cfg, task, scope);
    const checked = parseCheckResult(text, message.stop_reason);
    state.check = { ...checked, checkedText: comment, error: '' };
  } catch (error) {
    if (!task.owns()) return;
    if (task.signal.aborted) {
      state.check = { status: 'idle', issues: [], checkedText: '', error: '' };
    } else {
      state.check = { status: 'error', issues: [], checkedText: comment, error: describeError(error, cfg) };
      offerRetry(runCheck, { text: comment });
    }
  } finally { ops.finish(task); renderQuality(); }
}

async function refreshBackTranslation() {
  const comment = $('commentText').value.trim();
  if (!comment || !ensureConfigOrExplain($('backTranslationStatus'))) return;
  const cfg = config('analysis');
  const system = buildSystemPrompt(state.settings);
  const scope = costScope();
  const task = ops.start('backTranslation', 'Odświeżam tłumaczenie…');
  $('backTranslationStatus').hidden = false;
  setStatus($('backTranslationStatus'), 'Tłumaczę aktualną wersję…');
  try {
    const { text, message } = await streamCompletion(cfg,
      { system, messages: buildBackTranslationMessages(comment) }, { signal: task.signal });
    if (!task.current() || $('commentText').value.trim() !== comment) return;
    addCost(message, cfg, task, scope);
    const translated = parseTagged(text, ['back_translation']).back_translation;
    if (!translated || !text.includes('</back_translation>') || message.stop_reason !== 'end_turn') throw new Error('Model nie zwrócił pełnego tłumaczenia. Spróbuj ponownie.');
    $('backTranslation').textContent = translated;
    state.translationFor = comment;
    renderEditState(); persistDraft();
  } catch (error) {
    taskError(error, cfg, task, $('backTranslationStatus'), refreshBackTranslation, { text: comment });
  } finally { ops.finish(task); }
}

async function makeSpecific() {
  const issues = currentIssues();
  if (!issues.length || !$('commentText').value.trim()) return;
  const current = $('commentText').value.trim();
  const edited = current && current !== state.lastGeneratedComment.trim() ? current : null;
  await sendRevision(buildRefineMessage(buildSpecificFeedback(issues), edited, choiceChanges()), 'Poprawiam: konkretniej…');
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

async function recordHistory(finalText, captured = null) {
  if (!state.settings.learnVoice || !state.post) return;
  const entry = captured || createHistoryEntry({ post: state.post, instruction: $('instruction').value,
    generated: state.lastGeneratedComment, final: finalText, language: state.postLanguage });
  state.history = addToHistory(state.history, entry);
  await chrome.storage.local.set({ history: state.history });
  if (shouldLearn(state.history, state.settings, entry.kind)) {
    learnVoice({ statusEl: $('insertStatus'), append: true, kinds: [entry.kind] });
  }
}

/** Summarize the user's edits into preferences, separately for comments and messages. */
async function learnVoice({ statusEl, append = false, kinds = ['comment', 'message'] } = {}) {
  if (ops.has('learning')) return;
  const history = structuredClone(state.history);
  const settings = structuredClone(state.settings);
  const todo = kinds.filter((kind) => history.some((item) => item.edited && (item.kind || 'comment') === kind));
  if (!todo.length) { setStatus(statusEl, 'Brak poprawionych tekstów do nauki. Zmień szkic ręcznie przed wstawieniem lub kopiowaniem.', 'error'); return; }
  const cfg = config('analysis');
  if (validateConfig(cfg)) return;
  const scope = costScope();
  const epoch = state.epoch;
  const task = ops.start('learning', 'Uczę się Twojego stylu…', 'panel');
  const done = [];
  try {
    for (const kind of todo) {
      const fields = VOICE_FIELDS[kind];
      const { text, message } = await streamCompletion(cfg, {
        system: buildSystemPrompt(settings), messages: buildLearnMessages(history, settings[fields.notes], kind),
      }, { signal: task.signal });
      if (!task.current()) return;
      const preferences = parseTagged(text, VOICE_TAGS).preferences;
      if (!preferences || !text.includes('</preferences>')) throw new Error('Model nie zwrócił pełnej listy preferencji.');
      state.settings = mergeSettings({ ...state.settings, [fields.notes]: preferences, [fields.learnedAt]: Date.now() });
      await saveSettings(chrome.storage.local, state.settings);
      if (!task.current()) return;
      if (!$('settingsView').hidden) $(fields.notes).value = preferences;
      addCost(message, cfg, task, scope);
      done.push(kind === 'message' ? 'wiadomości' : 'komentarzy');
    }
    renderVoiceStats();
    if (state.epoch === epoch || statusEl === $('voiceStatus')) {
      const note = `Zaktualizowano Twoje preferencje stylu dla: ${done.join(' i ')} (Ustawienia → Twój styl).`;
      setStatus(statusEl, append && statusEl.textContent ? `${statusEl.textContent} ${note}` : note, 'ok');
    }
  } catch (error) {
    if (state.epoch === epoch || statusEl === $('voiceStatus')) taskError(error, cfg, task, statusEl, null);
  } finally { ops.finish(task); }
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
  if (!text || ops.has('comment') || !state.post) return;
  const epoch = state.epoch;
  const captured = createHistoryEntry({ post: state.post, instruction: $('instruction').value,
    generated: state.lastGeneratedComment, final: text, language: state.postLanguage });
  try {
    await navigator.clipboard.writeText(text);
    if (epoch === state.epoch) setStatus($('insertStatus'), 'Skopiowano. Wklej tekst do właściwego pola na LinkedInie (Ctrl+V).', 'ok');
    await recordHistory(text, captured);
  } catch {
    if (epoch === state.epoch) setStatus($('insertStatus'), 'Nie udało się skopiować. Zaznacz tekst i naciśnij Ctrl+C.', 'error');
  }
}

async function insertComment() {
  const text = $('commentText').value.trim();
  const post = state.post;
  if (!text || !post || post.tabId == null || ops.has('comment')) return;
  const epoch = state.epoch;
  const captured = createHistoryEntry({ post, instruction: $('instruction').value, generated: state.lastGeneratedComment, final: text, language: state.postLanguage });
  let response = null;
  try {
    // Only the frame the post or conversation came from (messaging is in an iframe).
    response = await chrome.tabs.sendMessage(
      post.tabId,
      { type: 'lca:insert', editorToken: post.editorToken, postKey: post.key, text, expectedTarget: targetIdentity(post), expectedRevision: state.sourceRevision },
      { frameId: post.frameId ?? 0 },
    );
  } catch {
    response = { ok: false, reason: 'tab-unreachable' };
  }
  if (epoch !== state.epoch) return;
  if (response?.ok) {
    setStatus(
      $('insertStatus'),
      postKind() === 'message'
        ? 'Wstawiono do pola wiadomości. Przeczytaj ją jeszcze raz na LinkedInie i wyślij przyciskiem LinkedIna.'
        : 'Wstawiono pod postem. Przeczytaj go jeszcze raz na LinkedInie i kliknij „Opublikuj”.',
      'ok',
    );
    await recordHistory(text, captured);
    return;
  }
  // Fallback: clipboard, with a precise reason.
  const reasons = {
    'context-changed': 'Kontekst na LinkedInie zmienił się. Kliknij ponownie we właściwe pole i sprawdź szkic.',
    'editor-missing': 'Pole tekstowe zniknęło (LinkedIn przeładował post lub rozmowę albo karta jest zamknięta).',
    'insert-failed': 'LinkedIn nie przyjął wstawionego tekstu.',
    'tab-unreachable': 'Karta z postem jest zamknięta albo została przeładowana.',
  };
  try {
    await navigator.clipboard.writeText(text);
    setStatus($('insertStatus'), `${reasons[response?.reason] ?? 'Nie udało się wstawić tekstu.'} Komentarz skopiowano: kliknij w pole pod postem i wklej (Ctrl+V).`, 'error');
    await recordHistory(text, captured);
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
  text.setAttribute('role', 'button');
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
  $('persistDrafts').checked = s.persistDrafts;
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
    persistDrafts: $('persistDrafts').checked,
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
  if (!next.persistDrafts) await chrome.runtime.sendMessage({ type: 'lca:draft:clearPersistent' });
  persistDraft();
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
  if (!settings.persistDrafts) await chrome.runtime.sendMessage({ type: 'lca:draft:clearPersistent' });
  state.history = history;
  persistDraft();
  hideImportPreview();
  renderSettingsForm();
  // The main view's selects were filled at start; show the imported choices now.
  $('tone').value = settings.tone;
  $('length').value = settings.length;
  setStatus($('backupStatus'), `Zaimportowano kopię z ${formatBackupDate(backup.exportedAt)}.`, 'ok');
}

async function testConnection() {
  const candidate = readSettingsForm();
  const cfg = { ...activeConfig(candidate), effort: 'low', thinking: 'adaptive', showThinking: false };
  const problem = validateConfig(cfg);
  if (problem) { setStatus($('settingsStatus'), problem, 'error'); return; }
  const task = ops.start('connection', 'Sprawdzam połączenie…', 'panel');
  setStatus($('settingsStatus'), `Łączę się z: ${cfg.providerLabel}…`);
  try {
    const { text, message } = await streamCompletion(cfg,
      { system: 'Reply with exactly: OK', messages: [{ role: 'user', content: 'ping' }] }, { signal: task.signal });
    if (!task.current()) return;
    addCost(message, cfg, task, costScope());
    setStatus($('settingsStatus'), `Połączenie działa (${modelLabel(cfg.model)} odpowiedział: „${text.trim().slice(0, 40)}”).`, 'ok');
  } catch (error) { taskError(error, cfg, task, $('settingsStatus'), testConnection, { independent: true }); }
  finally { ops.finish(task); }
}

// --- init -------------------------------------------------------------------

async function expandPost() {
  const post = structuredClone(state.post);
  if (!post || post.tabId == null) return;
  const task = ops.start('expand', 'Rozwijam post…');
  const notice = $('globalNotice');
  try {
    const response = await abortable(chrome.tabs.sendMessage(post.tabId,
      { type: 'lca:expand', editorToken: post.editorToken, postKey: post.key, expectedTarget: targetIdentity(post) },
      { frameId: post.frameId ?? 0 }), task.signal);
    if (!task.current()) return;
    if (!response?.ok || !response.post) throw new Error('Nie udało się rozwinąć posta. Kliknij ponownie we właściwe pole na LinkedInie.');
    notice.hidden = true;
    const changed = response.post.text !== post.text;
    state.post = { ...state.post, ...response.post };
    state.sourceRevision = sourceRevision(response.post);
    state.lastCoverage = ''; state.imageCache.clear();
    renderPost(); renderMedia(); persistDraft();
    chrome.storage.session.set({ [`lca:panelContext:${state.windowId}`]: state.post });
    if (changed && state.settings.autoAnalyze) runAnalysis();
  } catch (error) {
    if (task.owns() && !task.signal.aborted) { notice.hidden = false; notice.textContent = error.message || 'Nie udało się rozwinąć posta.'; }
  } finally { ops.finish(task); }
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
  $('includeImages').addEventListener('change', (e) => { state.includeImages = e.target.checked; mediaChanged(); });
  $('reanalyze').addEventListener('click', () => {
    const text = cleanPostText($('postTextEdit').value);
    state.post = { ...state.post, text };
    ops.cancel('comment'); ops.cancel('check');
    renderPost();
    runAnalysis({ force: true });
  });
  $('runAnalysis').addEventListener('click', runAnalysis);
  $('writeComment').addEventListener('click', writeComment);
  $('instruction').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      writeComment();
    }
  });
  $('tone').addEventListener('change', () => {
    persistChoice({ tone: $('tone').value });
    renderRefineHint(); persistDraft();
  });
  $('length').addEventListener('change', () => {
    persistChoice({ length: $('length').value });
    renderRefineHint(); persistDraft();
  });
  $('refineForm').addEventListener('submit', refine);
  $('commentText').addEventListener('input', ownTextChanged);
  $('instruction').addEventListener('input', () => { state.draftDirty = true; persistDraft(); });
  $('refineInput').addEventListener('input', () => { state.draftDirty = true; persistDraft(); });
  $('refreshBackTranslation').addEventListener('click', refreshBackTranslation);
  $('attachmentFiles').addEventListener('change', addAttachments);
  $('chooseAttachments').addEventListener('click', () => $('attachmentFiles').click());
  $('undoRevision').addEventListener('click', () => {
    let index = state.versions.findIndex((item) => item.comment === $('commentText').value);
    if (index < 0) { state.versions = pushVersion(state.versions, currentVersion()); index = state.versions.length - 1; }
    if (index > 0) selectVersion(index - 1);
  });
  $('restoreVersion').addEventListener('click', () => selectVersion(Number($('versionSelect').value)));
  $('stopOperation').addEventListener('click', () => { clearTimeout(autoAnalysisTimer); state.autoAnalysisPending = false; state.autoAnalysisCancelled = true; ops.cancelAll(); });
  $('retryOperation').addEventListener('click', () => {
    const retry = state.retry; state.retry = null; renderOperations();
    if (retry?.valid()) retry.callback();
    else { $('globalNotice').hidden = false; $('globalNotice').textContent = 'Tekst lub kontekst się zmienił. Uruchom zadanie ponownie dla bieżącej wersji.'; }
  });
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

function receiveBoundPost(next) {
  if (!next || (next.windowId != null && state.windowId != null && next.windowId !== state.windowId)) return;
  showSettings(false);
  if (sameTarget(state.post, next) && state.sourceRevision === sourceRevision(next)) {
    state.post = { ...state.post, tabId: next.tabId, frameId: next.frameId, editorToken: next.editorToken };
    showPendingPost(null); renderPost(); return;
  }
  if (state.post && hasWork()) {
    showPendingPost(next); return;
  }
  setPost(next);
}

async function init() {
  new ResizeObserver(([entry]) => {
    document.documentElement.style.setProperty('--topbar-height', `${entry.target.getBoundingClientRect().height}px`);
  }).observe(document.querySelector('.topbar'));
  state.windowId = (await chrome.windows.getCurrent().catch(() => null))?.id ?? null;
  bindEvents();
  const { settings: stored } = await chrome.storage.local.get('settings');
  const { settings, changed } = applyLocalDefaults(stored, await loadLocalDefaults());
  state.settings = settings;
  if (changed) await saveSettings(chrome.storage.local, settings);
  fillSelect($('tone'), TONES, state.settings.tone);
  fillSelect($('length'), LENGTHS, state.settings.length);
  state.history = (await chrome.storage.local.get('history')).history ?? [];
  chrome.storage.session.onChanged.addListener((changes) => {
    handleTranslateRequest(changes.translateRequest?.newValue);
    if (changes.boundPost?.newValue) receiveBoundPost(changes.boundPost.newValue);
  });
  const key = `lca:panelContext:${state.windowId}`;
  const data = await chrome.storage.session.get([key, 'boundPost', 'translateRequest']);
  const remembered = data[key];
  const bound = data.boundPost;
  const initial = remembered || (bound && (bound.windowId == null || bound.windowId === state.windowId) ? bound : null);
  setPost(initial);
  handleTranslateRequest(data.translateRequest);
  if (validateConfig(config())) showSettings(true, { intro: true });
}

init();
