// Rough per-request cost estimate shown in the side panel.
// Prices are Anthropic first-party list prices in USD per 1M tokens (state: 2026-11).
// OpenRouter usually bills Claude at the same rates, but its own fees may apply,
// so the number is labelled as an estimate ("~") in the UI.

// cacheRead: price of prompt-cache reads; when omitted, 0.1x of the input price.
/** @type {Record<string, {input: number, output: number, cacheRead?: number, label: string}>} */
const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, label: 'Sonnet 5.5' },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, label: 'Opus 5.5' },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, label: 'Haiku 5.5' },
  'claude-sonnet-5': { input: 2, output: 10, label: 'Sonnet 5' },
  'claude-opus-5': { input: 5, output: 25, label: 'Opus 5' },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, label: 'Fable 5.1' },
};

/**
 * Map provider-specific model ids to Anthropic ids, e.g.
 * "anthropic/claude-sonnet-5.5" -> "claude-sonnet-5-5",
 * "anthropic/claude-sonnet-5.5-20260928" -> "claude-sonnet-5-5".
 * @param {string} modelId
 * @returns {string}
 */
export function normalizeModelId(modelId) {
  return String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, '')
    .replace(/:.*$/, '') // OpenRouter variants like ":batch"
    .replace(/\./g, '-')
    .replace(/-\d{8}$/, ''); // dated snapshot suffix
}

/**
 * Human-friendly model label, falls back to the raw id.
 * @param {string} modelId
 * @returns {string}
 */
export function modelLabel(modelId) {
  return PRICES[normalizeModelId(modelId)]?.label ?? modelId;
}

/**
 * Estimate the cost of one request in USD from the API `usage` object.
 * Cache writes (5-minute TTL) are billed at 1.25x of the input price, cache reads
 * at the model's cache-read price.
 * @param {string} modelId
 * @param {{input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number|null, cache_read_input_tokens?: number|null}} usage
 * @returns {number|null} null when the model's price is unknown
 */
export function estimateCostUsd(modelId, usage) {
  const price = PRICES[normalizeModelId(modelId)];
  if (!price || !usage) return null;
  const cacheReadPrice = price.cacheRead ?? price.input * 0.1;
  const inputUsd =
    ((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25) * price.input +
    (usage.cache_read_input_tokens ?? 0) * cacheReadPrice;
  const outputUsd = (usage.output_tokens ?? 0) * price.output;
  return (inputUsd + outputUsd) / 1_000_000;
}

/**
 * Format a USD amount in US cents with a Polish decimal comma, e.g. 0.0134 -> "~1,3 c".
 * @param {number|null} usd
 * @returns {string}
 */
export function formatCost(usd) {
  if (usd == null) return '';
  const cents = usd * 100;
  const digits = cents < 0.1 ? 2 : 1;
  return `~${cents.toFixed(digits).replace('.', ',')} c`;
}
