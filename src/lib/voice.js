// "Your voice" memory (since 0.3.0): learn how the user actually writes from the
// comments they insert or copy, including their hand edits of the model's draft.
// - History lives only in chrome.storage.local ("history"), newest first.
// - Recent final comments go into the prompt as style examples (<user_voice>).
// - Edits (draft vs. final) are periodically summarized by the model into short,
//   user-editable preferences (settings.voiceNotes).
// No import from LinkedIn pages: bulk reading would be scraping (User Agreement 8.2).
// See also: src/lib/prompts.js (where <user_voice> is used), src/sidepanel/sidepanel.js.

import { escapeForTag } from './prompts.js';

export const HISTORY_LIMIT = 100;
export const EXAMPLE_COUNT = 5;
export const LEARN_AFTER_EDITS = 3;
export const VOICE_TAGS = ['preferences'];

const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Build a history entry for a comment the user inserted or copied.
 * @param {{post: object, instruction?: string, generated?: string, final: string, language?: string|null, now?: number}} args
 */
export function createHistoryEntry({ post, instruction = '', generated = '', final, language = null, now = Date.now() }) {
  return {
    at: now,
    postKey: post?.key ?? null,
    author: post?.author ?? '',
    postExcerpt: normalize(post?.text).slice(0, 280),
    instruction: normalize(instruction).slice(0, 500),
    generated: String(generated ?? '').trim(),
    final: String(final ?? '').trim(),
    edited: Boolean(normalize(generated)) && normalize(generated) !== normalize(final),
    language: language || null,
  };
}

/**
 * Add an entry: newest first, one entry per post (a later insert replaces the earlier one), capped.
 * @param {Array<object>} history
 * @param {object} entry
 * @returns {Array<object>}
 */
export function addToHistory(history, entry) {
  if (!entry?.final) return history ?? [];
  const rest = (history ?? []).filter((item) => !(entry.postKey && item.postKey === entry.postKey));
  return [entry, ...rest].slice(0, HISTORY_LIMIT);
}

/**
 * Style examples: the user's most recent final comments, same language first.
 * @param {Array<object>} history
 * @param {{language?: string|null, count?: number}} [options]
 */
export function pickExamples(history, { language = null, count = EXAMPLE_COUNT } = {}) {
  const usable = (history ?? []).filter((item) => item.final);
  const sameLanguage = language ? usable.filter((item) => item.language === language) : [];
  const others = usable.filter((item) => !sameLanguage.includes(item));
  return [...sameLanguage, ...others].slice(0, count);
}

/**
 * The second system block. Empty string when there is nothing to say,
 * so the cached static system prompt stays the whole prefix.
 * @param {{examples?: Array<object>, voiceNotes?: string}} args
 * @returns {string}
 */
export function buildVoiceBlock({ examples = [], voiceNotes = '' }) {
  const notes = String(voiceNotes ?? '').trim();
  if (examples.length === 0 && !notes) return '';
  const parts = ['<user_voice>'];
  if (examples.length) {
    parts.push(
      "Comments this user actually published (their final wording). Match their tone, length, rhythm and vocabulary. Never copy their sentences, and never reuse facts from these examples in a new comment.",
    );
    for (const item of examples) {
      const about = escapeForTag(item.postExcerpt.slice(0, 160)).replace(/"/g, "'");
      parts.push(`<example post_excerpt="${about}">\n${escapeForTag(item.final)}\n</example>`);
    }
  }
  if (notes) {
    parts.push(`Preferences learned from the user's own edits (follow them):\n<preferences>\n${escapeForTag(notes)}\n</preferences>`);
  }
  parts.push('</user_voice>');
  return parts.join('\n');
}

/**
 * Edited entries newer than the last learning run.
 * @param {Array<object>} history
 * @param {number} learnedAt
 */
export function editsSince(history, learnedAt = 0) {
  return (history ?? []).filter((item) => item.edited && item.at > (learnedAt || 0));
}

/**
 * Should the panel run a learning request now?
 * @param {Array<object>} history
 * @param {{learnVoice?: boolean, voiceLearnedAt?: number}} settings
 */
export function shouldLearn(history, settings) {
  return Boolean(settings?.learnVoice) && editsSince(history, settings?.voiceLearnedAt).length >= LEARN_AFTER_EDITS;
}

/**
 * Messages for the learning request: drafts vs. the user's final versions.
 * Uses up to 12 most recent edited pairs (also older ones, for context).
 * @param {Array<object>} history
 * @param {string} currentNotes
 */
export function buildLearnMessages(history, currentNotes = '') {
  const pairs = (history ?? []).filter((item) => item.edited).slice(0, 12);
  const body = pairs
    .map(
      (item, i) =>
        `<pair n="${i + 1}">\n<draft>\n${escapeForTag(item.generated)}\n</draft>\n<final>\n${escapeForTag(item.final)}\n</final>\n</pair>`,
    )
    .join('\n');
  const text = `<task>learn_voice</task>
Below are comment drafts written by an assistant and the versions the user actually published after editing them by hand.

${body}

<current_preferences>
${escapeForTag(String(currentNotes || '').trim()) || '(none yet)'}
</current_preferences>

Describe how the user changes the drafts, as short writing preferences for future comments. Rules:
- Only what the edits show, ideally in at least two pairs (e.g. shorter sentences, drops the closing question, more direct opening, avoids certain words). Never guess about the person, their opinions or facts.
- Keep current preferences that the edits do not contradict; drop or rewrite those they contradict.
- At most 8 bullets, in Polish, each one line, imperative, e.g. "- Skracaj do jednego zdania, gdy to możliwe."

Answer in exactly this format:
<preferences>
- …
</preferences>`;
  return [{ role: 'user', content: text }];
}
