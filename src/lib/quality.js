// Pre-insert quality check (since 0.3.0). LinkedIn says it demotes generic content and
// replies that "simply restate the original post without sharing anything new"
// (news.linkedin.com, 2026-05-20), so the panel flags such comments before insertion.
// Two layers:
// - instant heuristics below (no API call; also run on the user's hand edits),
// - a model check (<task>check_comment</task>, see buildCheckMessages) after each draft.
// The check only warns; inserting stays the user's decision.

import { escapeForTag, buildPostBlock } from './prompts.js';

export const CHECK_TAGS = ['verdict', 'issues'];
export const ISSUE_TYPES = ['restates_post', 'generic', 'ai_pattern', 'unsupported_claim', 'language'];

// Phrases that make a comment portable to any post or read as AI-written.
// Word boundaries are Unicode-aware on purpose: JavaScript's \b and \w only know ASCII,
// so /\bświetny/ would never match "Świetny" and /kluczow\w+/ would miss "kluczową".
const phrase = (source) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, 'iu');

const GENERIC_PHRASES = [
  'great (?:post|insights?|share|read|points?)',
  "thanks? (?:you )?for sharing",
  'love (?:this|it)',
  'so true',
  "couldn'?t agree more",
  'well said',
  'this is (?:huge|amazing|great)',
  'spot on',
  'świetn(?:y|e) (?:post|wpis|spostrzeżeni\\p{L}*)',
  'dzięki za (?:podzielenie się|ten wpis|ten post)',
  'ciekaw(?:y|e) (?:post|wpis|spostrzeżeni\\p{L}*)',
  'nic dodać,? nic ująć',
].map(phrase);
const AI_PHRASES = [
  'delv(?:e|ing)',
  'game[- ]?changer',
  'exciting times',
  'testament to',
  'pivotal',
  "it'?s not just",
  'warto (?:zauważyć|podkreślić)',
  'w dzisiejszych czasach',
  'kluczow\\p{L}+',
].map(phrase);
const EMOJI = /\p{Extended_Pictographic}/u;
const STOPWORDS = new Set(
  'the and for with that this from your you our are was were will have has into about they them their what when which while there here then than also just very more most such only over a an of to in on at is it be as by or we i my me so if not no but can its'.split(' '),
);

function contentWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ąćęłńóśźż]+/i)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/**
 * Instant checks without the model.
 * @param {string} comment
 * @param {string} postText
 * @returns {Array<{type: string, message: string}>}
 */
export function heuristicIssues(comment, postText = '') {
  const text = String(comment ?? '').trim();
  if (!text) return [];
  const issues = [];
  const generic = GENERIC_PHRASES.map((re) => text.match(re)?.[0]).filter(Boolean);
  if (generic.length) {
    issues.push({ type: 'generic', message: `Ogólnikowa formuła: „${generic.join('”, „')}”. Pasuje pod każdy post.` });
  }
  const ai = AI_PHRASES.map((re) => text.match(re)?.[0]).filter(Boolean);
  if (ai.length) {
    issues.push({ type: 'ai_pattern', message: `Zwroty typowe dla tekstów AI: „${ai.join('”, „')}”.` });
  }
  const format = [];
  if (text.includes('—')) format.push('myślnik „—”');
  if (/(^|\s)#[\p{L}\d_]+/u.test(text)) format.push('hashtag');
  if (EMOJI.test(text)) format.push('emoji');
  if ((text.match(/!/g) || []).length > 2) format.push('dużo wykrzykników');
  if (format.length) issues.push({ type: 'ai_pattern', message: `Elementy, które rzucają się w oczy jako AI: ${format.join(', ')}.` });

  // Restating: almost every content word of a short comment already appears in the post.
  const words = contentWords(text);
  const postWords = new Set(contentWords(postText));
  if (words.length >= 5 && postWords.size) {
    const overlap = words.filter((w) => postWords.has(w)).length / words.length;
    if (overlap >= 0.8) {
      issues.push({ type: 'restates_post', message: 'Prawie wszystkie słowa komentarza są wzięte z posta. Może tylko go powtarzać.' });
    }
  }
  return issues;
}

/**
 * Messages for the model check.
 * @param {{post: object, comment: string, instruction?: string}} args
 */
export function buildCheckMessages({ post, comment, instruction = '' }) {
  const text = `<task>check_comment</task>
${buildPostBlock(post)}

<user_input>
${escapeForTag(String(instruction).trim()) || '(empty)'}
</user_input>

<comment_to_check>
${escapeForTag(String(comment).trim())}
</comment_to_check>

Check the comment the user is about to publish under this post. Report only real problems:
- restates_post: it only repeats what the post says and adds nothing (no experience, insight, specific question or specific congratulation).
- generic: it could be posted unchanged under a different post.
- ai_pattern: it reads as AI-written (patterns from your style rules).
- unsupported_claim: it states facts about the user (experience, company, numbers, opinions) that are not in <user_input> or <about_user>.
- language: a grammar or wording error in the comment's language.

Answer in exactly this format, each reason in Polish, one short sentence quoting the problematic fragment where useful:
<verdict>ok</verdict> or <verdict>warn</verdict>
<issues>
<issue type="restates_post">…</issue>
</issues>
Leave <issues></issues> empty when the verdict is ok.`;
  return [{ role: 'user', content: text }];
}

/**
 * Parse <issue type="…">…</issue> items (types outside ISSUE_TYPES are kept as "other").
 * @param {string|null} block
 * @returns {Array<{type: string, message: string}>}
 */
export function parseIssues(block) {
  if (!block) return [];
  const issues = [];
  const re = /<issue type="([a-z_]+)">([\s\S]*?)<\/issue>/g;
  let match;
  while ((match = re.exec(block))) {
    const message = match[2].trim();
    if (message) issues.push({ type: ISSUE_TYPES.includes(match[1]) ? match[1] : 'other', message });
  }
  return issues;
}

/**
 * Feedback for the "Konkretniej" (more specific) refinement, built from the found issues.
 * @param {Array<{type: string, message: string}>} issues
 * @returns {string}
 */
export function buildSpecificFeedback(issues) {
  const reasons = issues.map((issue) => `- ${issue.message}`).join('\n');
  return `Komentarz ma problemy:\n${reasons}\nPopraw je: dodaj jeden konkretny szczegół z posta albo z mojego polecenia, usuń ogólniki i nie wymyślaj faktów o mnie.`;
}
