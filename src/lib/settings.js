// Settings model: defaults, merging with stored values, and the active provider config.
// Stored in chrome.storage.local (never storage.sync, so the API key is not
// replicated to other devices through the browser account).

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (bezpośrednio)',
    baseURL: 'https://api.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — szybszy, tańszy' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — staranniejszy' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    // Anthropic-compatible endpoint; the SDK appends /v1/messages.
    baseURL: 'https://openrouter.ai/api',
    keyPlaceholder: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 — szybszy, tańszy' },
      { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 — staranniejszy' },
    ],
  },
};

export const EFFORT_LEVELS = {
  low: 'Niska — najszybciej (zalecane)',
  medium: 'Średnia',
  high: 'Wysoka — wolniej, staranniej',
  default: 'Domyślna modelu (nie wysyłaj parametru)',
};

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'anthropic',
  apiKeys: { anthropic: '', openrouter: '' },
  models: { anthropic: 'claude-sonnet-5-5', openrouter: 'anthropic/claude-sonnet-5.5' },
  effort: 'low',
  aboutMe: '',
  commentLanguage: 'auto',
  autoAnalyze: true,
  includeImages: true,
  tone: 'factual',
  length: 'short',
  localDefaultsApplied: false,
  // "Your voice" (src/lib/voice.js): learn from inserted comments and hand edits.
  learnVoice: true,
  voiceNotes: '',
  voiceLearnedAt: 0,
  // Optional Harmonic.ai enrichment (src/lib/harmonic.js); the key is never a local default.
  useHarmonic: false,
  harmonicApiKey: '',
});

// Non-secret fields that may come from the local, git-ignored file
// local-config/defaults.json (copied to dist/defaults.json by build.mjs).
// API keys are deliberately not on this list, so a key typed into that file
// never ends up in the built extension.
export const LOCAL_DEFAULT_KEYS = ['aboutMe', 'provider', 'models', 'effort', 'commentLanguage', 'tone', 'length'];

/**
 * Keep only allowed, well-typed fields of a local defaults object.
 * @param {unknown} raw
 * @returns {Partial<typeof DEFAULT_SETTINGS>}
 */
export function sanitizeLocalDefaults(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of LOCAL_DEFAULT_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (key === 'models') {
      if (value && typeof value === 'object' && !Array.isArray(value)) out.models = value;
    } else if (typeof value === 'string' && value.trim()) {
      out[key] = key === 'aboutMe' ? value.trim().slice(0, 2000) : value.trim();
    }
  }
  return out;
}

/**
 * Apply local defaults once per browser profile:
 * - no stored settings yet (first run): all allowed fields are used,
 * - existing settings: only an empty "O mnie" is filled; nothing else is overwritten.
 * Afterwards `localDefaultsApplied` is set, so clearing "O mnie" by hand sticks.
 * @param {object|undefined} stored - raw value from chrome.storage.local
 * @param {unknown} rawDefaults - parsed dist/defaults.json
 * @returns {{settings: ReturnType<typeof mergeSettings>, changed: boolean}}
 */
export function applyLocalDefaults(stored, rawDefaults) {
  const defaults = sanitizeLocalDefaults(rawDefaults);
  if (stored?.localDefaultsApplied || Object.keys(defaults).length === 0) {
    return { settings: mergeSettings(stored), changed: false };
  }
  let next;
  if (!stored) {
    next = { ...defaults };
  } else {
    next = { ...stored };
    if (!String(stored.aboutMe || '').trim() && defaults.aboutMe) next.aboutMe = defaults.aboutMe;
  }
  next.localDefaultsApplied = true;
  return { settings: mergeSettings(next), changed: true };
}

/**
 * Merge stored settings over defaults (one level deep for the per-provider maps),
 * ignoring unknown provider ids so a corrupted value cannot break the panel.
 * @param {object|undefined} stored
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function mergeSettings(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const merged = {
    ...DEFAULT_SETTINGS,
    ...s,
    apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(s.apiKeys || {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(s.models || {}) },
  };
  if (!PROVIDERS[merged.provider]) merged.provider = DEFAULT_SETTINGS.provider;
  if (!EFFORT_LEVELS[merged.effort]) merged.effort = DEFAULT_SETTINGS.effort;
  return merged;
}

/**
 * Resolve the config used for API calls.
 * @param {ReturnType<typeof mergeSettings>} settings
 * @returns {{provider: string, providerLabel: string, baseURL: string, apiKey: string, model: string, effort: string}}
 */
export function activeConfig(settings) {
  const provider = PROVIDERS[settings.provider] ? settings.provider : DEFAULT_SETTINGS.provider;
  return {
    provider,
    providerLabel: PROVIDERS[provider].label,
    baseURL: PROVIDERS[provider].baseURL,
    apiKey: (settings.apiKeys?.[provider] || '').trim(),
    model: (settings.models?.[provider] || DEFAULT_SETTINGS.models[provider]).trim(),
    effort: settings.effort,
  };
}

/**
 * Validate the active config before a request; returns a Polish, actionable message or null.
 * @param {ReturnType<typeof activeConfig>} config
 * @returns {string|null}
 */
export function validateConfig(config) {
  if (!config.apiKey) {
    return `Brak klucza API dla: ${config.providerLabel}. Wpisz go w ustawieniach (ikona ⚙).`;
  }
  if (config.provider === 'anthropic' && !config.apiKey.startsWith('sk-ant-')) {
    return 'Klucz Anthropic powinien zaczynać się od „sk-ant-”. Sprawdź, czy to nie jest klucz OpenRouter.';
  }
  if (config.provider === 'openrouter' && !config.apiKey.startsWith('sk-or-')) {
    return 'Klucz OpenRouter powinien zaczynać się od „sk-or-”. Sprawdź, czy to nie jest klucz Anthropic.';
  }
  if (!config.model) {
    return 'Nie wybrano modelu. Wybierz model w ustawieniach (ikona ⚙).';
  }
  return null;
}

/**
 * @param {chrome.storage.StorageArea} storage
 */
export async function loadSettings(storage) {
  const { settings } = await storage.get('settings');
  return mergeSettings(settings);
}

/**
 * @param {chrome.storage.StorageArea} storage
 * @param {object} settings
 */
export async function saveSettings(storage, settings) {
  await storage.set({ settings: mergeSettings(settings) });
}
