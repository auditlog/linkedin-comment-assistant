// Backup file (since 0.5.0): move settings, "O mnie", the learned style and the
// history to another computer, or keep a safety copy. It is a one-time transfer,
// not a sync: deletions are not recorded, so an entry removed from the history can
// come back when an older file is imported (README says so).
// API keys go into the file only when the user asks for it.
// See also: exportBackup()/importBackup() in src/sidepanel/sidepanel.js,
// docs/2026-11-10-design-0.5.md (section C).

import { DEFAULT_SETTINGS, PROVIDERS, mergeSettings } from './settings.js';
import { HISTORY_LIMIT } from './voice.js';

export const BACKUP_FORMAT = 'lca-backup';
export const BACKUP_VERSION = 1;
// A real backup is tens of KB (100 history entries); anything far larger is not ours.
export const MAX_BACKUP_BYTES = 2_000_000;
export const BACKUP_TOO_LARGE =
  'Plik jest za duży (ponad 2 MB). Kopia zapasowa wtyczki ma zwykle kilkadziesiąt KB: sprawdź, czy to właściwy plik.';

// Longest strings kept from a file, so a broken or foreign file cannot bloat storage.
const MAX_SETTING_CHARS = 20_000;
const HISTORY_FIELD_CHARS = { postKey: 500, author: 200, postExcerpt: 280, instruction: 500, generated: 5000, final: 5000 };

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether settings carry any API key (a provider key or the Harmonic key).
 * @param {{apiKeys?: Record<string, string>, harmonicApiKey?: string}} settings
 * @returns {boolean}
 */
export function backupHasKeys(settings) {
  return Object.values(settings?.apiKeys ?? {}).some(Boolean) || Boolean(settings?.harmonicApiKey);
}

/**
 * The backup object written to the file.
 * @param {{settings: object, history: Array<object>, includeKeys: boolean, extensionVersion: string, now: number}} args
 * @returns {{format: string, version: number, exportedAt: string, extensionVersion: string, settings: object, history: Array<object>}}
 */
export function buildBackup({ settings, history, includeKeys, extensionVersion, now }) {
  const copy = mergeSettings(settings); // new apiKeys/models objects: the caller's settings stay intact
  if (!includeKeys) {
    copy.apiKeys = Object.fromEntries(Object.keys(copy.apiKeys).map((provider) => [provider, '']));
    copy.harmonicApiKey = '';
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    extensionVersion: String(extensionVersion || ''),
    settings: copy,
    history: (history ?? []).slice(0, HISTORY_LIMIT),
  };
}

/**
 * File name with the local date, e.g. asystent-linkedin-kopia-2026-11-10.json.
 * @param {number} now
 * @returns {string}
 */
export function backupFileName(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `asystent-linkedin-kopia-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** Keep only known settings with the type of their default value. */
function sanitizeSettings(raw) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (isObject(fallback)) {
      // apiKeys, models: per-provider strings only
      if (!isObject(value)) continue;
      out[key] = Object.fromEntries(
        Object.entries(value)
          .filter(([provider, text]) => provider in fallback && typeof text === 'string')
          .map(([provider, text]) => [provider, text.trim().slice(0, 500)]),
      );
    } else if (typeof value === typeof fallback) {
      out[key] = typeof value === 'string' ? value.slice(0, MAX_SETTING_CHARS) : value;
    }
  }
  return mergeSettings(out);
}

/** A history entry with the fields voice.js creates, or null when it is unusable. */
function sanitizeEntry(raw) {
  if (!isObject(raw) || typeof raw.final !== 'string' || !raw.final.trim() || !Number.isFinite(raw.at)) return null;
  const text = (key) => (typeof raw[key] === 'string' ? raw[key].slice(0, HISTORY_FIELD_CHARS[key]) : '');
  return {
    at: raw.at,
    kind: raw.kind === 'message' ? 'message' : 'comment',
    postKey: typeof raw.postKey === 'string' && raw.postKey ? text('postKey') : null,
    author: text('author'),
    postExcerpt: text('postExcerpt'),
    instruction: text('instruction'),
    generated: text('generated'),
    final: text('final').trim(),
    edited: raw.edited === true,
    language: typeof raw.language === 'string' && raw.language ? raw.language.slice(0, 10) : null,
  };
}

/**
 * Read and check a backup file. Never throws; problems come back as Polish messages.
 * @param {string} text - file contents
 * @returns {{ok: true, backup: {settings: object, history: Array<object>, exportedAt: string, hasKeys: boolean}}
 *   | {ok: false, error: string}}
 */
export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) {
    return { ok: false, error: BACKUP_TOO_LARGE };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Plik nie jest poprawnym plikiem JSON. Wybierz plik „asystent-linkedin-kopia-….json” zapisany przez „Eksportuj do pliku”.' };
  }
  if (!isObject(data) || data.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'Ten plik nie jest kopią zapasową Asystenta komentarzy LinkedIn. Wybierz plik zapisany przez „Eksportuj do pliku”.' };
  }
  if (data.version !== BACKUP_VERSION) {
    return {
      ok: false,
      error: `Kopia ma wersję formatu ${String(data.version)}, a ta wersja wtyczki obsługuje tylko wersję ${BACKUP_VERSION}. Zaktualizuj wtyczkę i spróbuj ponownie.`,
    };
  }
  if (!isObject(data.settings)) {
    return { ok: false, error: 'W pliku brakuje ustawień, więc jest uszkodzony albo niekompletny. Zapisz kopię ponownie na komputerze, z którego przenosisz wtyczkę.' };
  }
  if (data.history !== undefined && !Array.isArray(data.history)) {
    return { ok: false, error: 'Historia w pliku ma zły format, więc plik jest uszkodzony. Zapisz kopię ponownie na komputerze, z którego przenosisz wtyczkę.' };
  }
  const settings = sanitizeSettings(data.settings);
  const history = (data.history ?? []).map(sanitizeEntry).filter(Boolean).slice(0, HISTORY_LIMIT);
  return {
    ok: true,
    backup: { settings, history, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '', hasKeys: backupHasKeys(settings) },
  };
}

// One entry per post, like addToHistory in voice.js; entries without a post key
// (should not happen) are matched by time and text.
const entryKey = (entry) => (entry.postKey ? `post:${entry.postKey}` : `at:${entry.at}:${entry.final}`);

/**
 * Join the current history with an imported one: the newer entry per post wins,
 * newest first, at most HISTORY_LIMIT entries.
 * @param {Array<object>} current
 * @param {Array<object>} imported
 * @returns {Array<object>}
 */
export function mergeHistory(current, imported) {
  const byKey = new Map();
  for (const entry of [...(current ?? []), ...(imported ?? [])]) {
    const key = entryKey(entry);
    const previous = byKey.get(key);
    if (!previous || entry.at > previous.at) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
}

/**
 * Settings after an import: everything from the file, except that an empty key in the
 * file keeps the current one. `localDefaultsApplied` stops defaults.json from
 * filling "O mnie" over the imported value.
 * @param {object} current
 * @param {object} imported - settings from parseBackup
 * @returns {object}
 */
export function applyBackupSettings(current, imported) {
  const apiKeys = {};
  for (const provider of Object.keys(PROVIDERS)) {
    apiKeys[provider] = imported.apiKeys?.[provider] || current.apiKeys?.[provider] || '';
  }
  return mergeSettings({
    ...imported,
    apiKeys,
    harmonicApiKey: imported.harmonicApiKey || current.harmonicApiKey || '',
    localDefaultsApplied: true,
  });
}

/** Polish plural: 1 wpis, 2–4 wpisy, 5+ wpisów (12–14 too). */
function plural(n, one, few, many) {
  if (n === 1) return one;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/**
 * Summary shown before an import is applied.
 * @param {{settings: object, history: Array<object>}} current
 * @param {{history: Array<object>, hasKeys: boolean}} backup
 * @returns {string[]}
 */
export function describeImport(current, backup) {
  const lines = [
    'Ustawienia, „O mnie” i Twój styl: zostaną zastąpione.',
    backup.hasKeys ? 'Klucze API: zostaną wczytane z pliku.' : 'Klucze API: brak w pliku, zostaną obecne.',
  ];
  const total = backup.history.length;
  if (total === 0) {
    lines.push('Historia: brak wpisów w pliku, obecna zostaje bez zmian.');
  } else {
    const known = new Set((current.history ?? []).map(entryKey));
    const fresh = backup.history.filter((entry) => !known.has(entryKey(entry))).length;
    lines.push(`Historia: ${total} ${plural(total, 'wpis', 'wpisy', 'wpisów')} w pliku, w tym ${fresh} ${plural(fresh, 'nowy', 'nowe', 'nowych')}.`);
  }
  return lines;
}
