// Claude API access for the side panel. One Anthropic SDK client covers both
// providers: Anthropic directly (`apiKey`; SDK 1.x with API version 2026-10-21
// sends it as `Authorization: Bearer`) and OpenRouter through its
// Anthropic-compatible endpoint (https://openrouter.ai/api, `authToken`).
//
// Requests run in the side panel (an extension page), not in the LinkedIn page,
// so the API key never enters LinkedIn's JavaScript context.

import Anthropic from '@anthropic-ai/sdk';

// Generous cap: outputs here are short, and hitting the cap would cut a comment mid-sentence.
// At xhigh/max effort thinking alone can use tens of thousands of tokens, so those
// levels get a larger cap and a longer wait (docs/2026-11-10-design-0.5.md, section A).
const LONG_EFFORTS = new Set(['xhigh', 'max']);
const MAX_TOKENS = 16000;
const MAX_TOKENS_LONG = 64000;
const TIMEOUT_MS = 120_000;
const TIMEOUT_LONG_MS = 300_000;

export class RefusalError extends Error {
  constructor(category) {
    super('refusal');
    this.name = 'RefusalError';
    this.category = category ?? null;
  }
}

/**
 * Create an SDK client for the active provider config.
 * @param {{provider: string, apiKey: string, baseURL: string}} config
 * @param {typeof Anthropic} [AnthropicClass] - injectable for tests
 */
export function createClient(config, AnthropicClass = Anthropic) {
  // dangerouslyAllowBrowser: the key is the user's own and lives in their browser profile;
  // the SDK then also sends the `anthropic-dangerous-direct-browser-access` header.
  const timeout = LONG_EFFORTS.has(config.effort) ? TIMEOUT_LONG_MS : TIMEOUT_MS;
  const common = { dangerouslyAllowBrowser: true, maxRetries: 2, timeout };
  if (config.provider === 'openrouter') {
    return new AnthropicClass({
      ...common,
      baseURL: config.baseURL,
      authToken: config.apiKey,
      defaultHeaders: { 'X-Title': 'LinkedIn Comment Assistant' },
    });
  }
  return new AnthropicClass({ ...common, apiKey: config.apiKey });
}

/**
 * Build request params. Exported for unit tests.
 * - Thinking: by default the parameter is not sent (adaptive on Sonnet 5.5 / Opus 5.5).
 *   `thinking: 'off'` sends {type: "between_tools"}, which only Sonnet 5.5 accepts and
 *   only at effort low/medium/high; settings.activeConfig guarantees that, so this
 *   function trusts the config. `showThinking` asks for summarized thinking, which
 *   exists only in adaptive mode. Never send {type: "disabled"} or budget_tokens:
 *   both are rejected (400) by the current models.
 * - `effort` controls speed vs depth; xhigh/max get a larger max_tokens.
 * - Server-side refusal fallback is enabled only on the Anthropic API, where the
 *   beta exists; OpenRouter gets the plain request.
 * - The system prompt (~1.5k tokens with the style rules) is marked for prompt caching
 *   on the Anthropic API: analysis, comment and refinements of one post reuse it
 *   within 5 minutes at ~0.1x input price. Not sent to OpenRouter, whose pass-through
 *   of cache_control is unverified.
 * - `system` may be several blocks (static prompt, then the user's voice block); each
 *   gets its own cache breakpoint, so a changed voice block keeps the static part cached.
 * @param {{provider: string, model: string, effort: string}} config
 * @param {{system: string|string[], messages: Array<object>}} request
 */
export function buildParams(config, { system, messages }) {
  const blocks = (Array.isArray(system) ? system : [system]).filter((text) => text && text.trim());
  const params = {
    model: config.model,
    max_tokens: LONG_EFFORTS.has(config.effort) ? MAX_TOKENS_LONG : MAX_TOKENS,
    system:
      config.provider === 'anthropic'
        ? blocks.map((text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } }))
        : blocks.join('\n\n'),
    messages,
  };
  if (config.effort && config.effort !== 'default') {
    params.output_config = { effort: config.effort };
  }
  if (config.thinking === 'off') {
    params.thinking = { type: 'between_tools' };
  } else if (config.showThinking) {
    params.thinking = { type: 'adaptive', display: 'summarized' };
  }
  if (config.provider === 'anthropic') {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

/**
 * Concatenate text blocks of a final message, skipping anything produced before
 * the last refusal-fallback switch (that text came from the model that declined).
 * @param {Array<{type: string, text?: string}>} content
 * @returns {string}
 */
export function finalText(content) {
  let start = 0;
  content.forEach((block, i) => {
    if (block.type === 'fallback') start = i + 1;
  });
  return content
    .slice(start)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Stream one request and report the growing text and thinking summary.
 * @param {object} config - active provider config (see settings.activeConfig)
 * @param {{system: string, messages: Array<object>}} request
 * @param {{onText?: (fullText: string) => void, onThinking?: (fullThinking: string) => void,
 *   signal?: AbortSignal, client?: object}} [options]
 * @returns {Promise<{text: string, thinking: string, message: object}>} final text, the
 *   streamed thinking summary (empty unless summarized thinking was requested) and the
 *   full API message (its `content` must be appended unchanged to continue the conversation)
 */
export async function streamCompletion(config, request, { onText, onThinking, signal, client } = {}) {
  const api = client ?? createClient(config);
  const params = buildParams(config, request);
  const stream =
    config.provider === 'anthropic'
      ? api.beta.messages.stream(params, { signal })
      : api.messages.stream(params, { signal });

  let text = '';
  let thinking = '';
  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'fallback') {
      // Another model takes over after a refusal; restart the visible text and thinking.
      text = '';
      onText?.(text);
      if (thinking) {
        thinking = '';
        onThinking?.(thinking);
      }
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text;
      onText?.(text);
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      thinking += event.delta.thinking;
      onThinking?.(thinking);
    }
  }
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new RefusalError(message.stop_details?.category);
  }
  return { text: finalText(message.content), thinking, message };
}

// Settings groups as named in the panel (see REASONING_GROUPS in src/sidepanel/sidepanel.js).
const GROUP_LABELS = { write: 'Pisanie i poprawki', analysis: 'Analiza, tłumaczenia i kontrola' };

/**
 * What to change after a 400 about thinking or effort (e.g. a provider that does not
 * accept these parameters). The advice must match what buildParams actually sent:
 * with "Automatyczne" thinking the parameter only appears because of the summary.
 * @param {string} detail - API error message
 * @param {{thinking?: string, showThinking?: boolean, purpose?: string}} [config]
 * @returns {string}
 */
function settingsHint(detail, config) {
  const group = GROUP_LABELS[config?.purpose];
  const where = group ? `W grupie „${group}” ustaw` : 'Ustaw';
  // Write settings are frozen for the comment (see sendConversation in the panel).
  const when = config?.purpose === 'write' ? ' Zmiana zadziała od następnego „Napisz komentarz”.' : '';
  if (/thinking/i.test(detail)) {
    if (config?.thinking === 'off') return ` ${where} „Rozumowanie” na „Automatyczne” (ustawienia, ikona ⚙).${when}`;
    if (config?.showThinking) return ` Wyłącz „Pokaż tok rozumowania” w ustawieniach (ikona ⚙).${when}`;
    return ` Ustaw „Rozumowanie” na „Automatyczne” i wyłącz „Pokaż tok rozumowania” w ustawieniach (ikona ⚙).${when}`;
  }
  if (/output_config|effort/i.test(detail)) return ` ${where} effort na „Domyślna modelu” (ustawienia, ikona ⚙).${when}`;
  return '';
}

/**
 * Translate an error into a specific, actionable Polish message.
 * Returns null for user-initiated cancellation (nothing to show).
 * @param {unknown} err
 * @param {{providerLabel: string, model: string}} config
 * @returns {string|null}
 */
export function describeError(err, config) {
  const who = config?.providerLabel ?? 'dostawca';
  if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') return null;
  if (err instanceof RefusalError) {
    return 'Model odmówił odpowiedzi na to zapytanie. Zmień polecenie albo spróbuj innego modelu.';
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return `${who} odrzucił klucz API (401). Sprawdź klucz w ustawieniach (ikona ⚙).`;
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `Brak dostępu (403): klucz nie ma uprawnień do modelu „${config.model}” albo konto jest zablokowane.`;
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `Model „${config.model}” nie istnieje u dostawcy ${who} (404). Sprawdź nazwę modelu w ustawieniach.`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Za dużo zapytań w krótkim czasie (429). Odczekaj chwilę i spróbuj ponownie.';
  }
  if (err instanceof Anthropic.BadRequestError) {
    // The API body is {type: "error", error: {type, message}}; prefer that human-readable message.
    const detail = err.error?.error?.message || err.message || '';
    return `${who} odrzucił zapytanie (400): ${detail}${settingsHint(detail, config)}`;
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const minutes = LONG_EFFORTS.has(config?.effort) ? 5 : 2;
    return `${who} nie odpowiedział w ciągu ${minutes} minut. Spróbuj ponownie albo wybierz niższy effort.`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `Brak połączenia z: ${who}. Sprawdź internet albo czy dostawca działa.`;
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) {
      return 'Brak środków na koncie OpenRouter (402). Doładuj konto na openrouter.ai.';
    }
    if (err.status === 529 || (err.status && err.status >= 500)) {
      return `Serwery dostawcy ${who} są przeciążone lub mają awarię (${err.status}). Spróbuj za chwilę.`;
    }
    return `Błąd API ${err.status ?? ''}: ${err.message}`;
  }
  return `Nieoczekiwany błąd: ${err?.message ?? String(err)}`;
}
