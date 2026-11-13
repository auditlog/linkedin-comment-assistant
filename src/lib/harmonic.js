// Optional Harmonic.ai enrichment (since 0.3.0): public facts about the post author's
// company (stage, funding, headcount, investors) and the author's role, shown in the
// panel and passed to the model as <background>.
//
// API shape from third-party connector docs (withone.ai, 2026-11), NOT verified against
// Harmonic's own reference, which was not reachable:
//   POST https://api.harmonic.ai/companies?linkedin_url=…&enrich_missing_company=false
//   POST https://api.harmonic.ai/persons?linkedin_url=…
//   GET  https://api.harmonic.ai/companies/{id_or_urn}
//   auth header "apikey: <key>" (from Harmonic's published Python snippets, per search results)
// Field names are read defensively (snake_case and camelCase), because the REST schema of
// the "funding" object was not documented. Team lists/notes are deliberately not used:
// no documented REST endpoint, and private team data must not reach the model.
// NOTE: when Harmonic changes or confirms its API, update the paths and summarize* here.

export const HARMONIC_API = 'https://api.harmonic.ai';
import { abortable, abortError } from './operations.js';
const TIMEOUT_MS = 8000;

export class HarmonicError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'HarmonicError';
    this.status = status;
  }
}

/**
 * One Harmonic call; returns parsed JSON or null when Harmonic has no match.
 * @param {string} method
 * @param {string} path - including the query string
 * @param {{apiKey: string, fetchFn?: typeof fetch}} options
 */
async function call(method, path, { apiKey, fetchFn = fetch, signal }) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, TIMEOUT_MS);
  try {
    const response = await abortable(fetchFn(`${HARMONIC_API}${path}`, {
      method, headers: { apikey: apiKey, accept: 'application/json' }, signal: controller.signal,
    }), controller.signal);
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new HarmonicError(`Harmonic odrzucił klucz API (${response.status}). Sprawdź klucz w ustawieniach i czy Twój plan Harmonic obejmuje dostęp do API.`, response.status);
    }
    if (response.status === 429) throw new HarmonicError('Harmonic: za dużo zapytań (429). Spróbuj za chwilę.', 429);
    if (!response.ok) {
      let detail = '';
      try {
        const body = await abortable(response.json(), controller.signal);
        detail = body?.detail?.[0]?.msg || body?.detail || body?.message || '';
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      throw new HarmonicError(`Harmonic zwrócił błąd ${response.status}${detail ? `: ${detail}` : ''}.`, response.status);
    }
    // Keep cancellation and the timeout active through the body, not just headers.
    const text = await abortable(response.text(), controller.signal);
    return !text || text === 'null' ? null : JSON.parse(text);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof HarmonicError) throw error;
    throw new HarmonicError(controller.signal.aborted ? 'Harmonic nie odpowiedział w ciągu 8 sekund.'
      : error instanceof SyntaxError ? 'Harmonic zwrócił niepoprawną odpowiedź. Spróbuj ponownie.' : 'Brak połączenia z Harmonic.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

const pick = (obj, ...keys) => {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

/**
 * Public facts about a company (null when nothing usable came back).
 * @param {object|null} raw
 */
export function summarizeCompany(raw) {
  if (!raw || typeof raw !== 'object' || !raw.name) return null;
  const funding = raw.funding || {};
  const investorNames = [];
  const addInvestor = (item) => {
    const name = typeof item === 'string' ? item : item?.name || item?.investor_name || item?.fullName || item?.full_name;
    if (name && !investorNames.includes(name)) investorNames.push(name);
  };
  (funding.investors || []).forEach(addInvestor);
  (raw.funding_rounds || raw.fundingRounds || []).forEach((round) => (round?.investors || []).forEach(addInvestor));
  const founding = pick(raw, 'founding_date.date', 'founding_date', 'foundingDate.date', 'foundingDate');
  return {
    name: String(raw.name),
    description: String(pick(raw, 'short_description', 'description') || '').slice(0, 300),
    stage: pick(raw, 'stage', 'funding.funding_stage', 'funding.fundingStage', 'funding.last_funding_type') || null,
    fundingTotal: pick(raw, 'funding.funding_total', 'funding.fundingTotal') ?? null,
    lastFundingAt: String(pick(raw, 'funding.last_funding_at', 'funding.lastFundingAt') || '').slice(0, 10) || null,
    headcount: pick(raw, 'headcount', 'corrected_headcount') ?? null,
    foundedYear: founding ? String(founding).slice(0, 4) : null,
    investors: investorNames.slice(0, 5),
  };
}

/**
 * The author's name, headline and current role (null when nothing usable came back).
 * @param {object|null} raw
 */
export function summarizePerson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const current = (raw.experience || []).find((exp) => exp?.is_current_position) || null;
  return {
    name: pick(raw, 'full_name', 'fullName') || '',
    headline: pick(raw, 'linkedin_headline', 'headline') || '',
    title: current?.title || '',
    company: current?.company_name || '',
    companyUrn: (raw.current_company_urns || [])[0] || (typeof current?.company === 'string' ? current.company : null),
  };
}

/** "$3.2M", "$161.5B" */
export function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) return `$${(n / size).toFixed(n / size >= 100 ? 0 : 1).replace(/\.0$/, '')}${suffix}`;
  }
  return `$${Math.round(n)}`;
}

/**
 * Plain-text background for the model (English, public facts only).
 * @param {{company?: object|null, person?: object|null}} ctx
 * @returns {string}
 */
export function formatBackground({ company = null, person = null } = {}) {
  const lines = [];
  if (person && (person.title || person.headline)) {
    lines.push(`Author: ${person.title ? `${person.title}${person.company ? ` at ${person.company}` : ''}` : person.headline}.`);
  }
  if (company) {
    lines.push(`Company: ${company.name}${company.description ? `. ${company.description}` : ''}`);
    const facts = [];
    if (company.stage) facts.push(`stage ${String(company.stage).toLowerCase().replace(/_/g, ' ')}`);
    const money = formatMoney(company.fundingTotal);
    if (money) facts.push(`total funding ${money}`);
    if (company.lastFundingAt) facts.push(`last round ${company.lastFundingAt}`);
    if (company.headcount) facts.push(`about ${company.headcount} employees`);
    if (company.foundedYear) facts.push(`founded ${company.foundedYear}`);
    if (facts.length) lines.push(`Facts: ${facts.join('; ')}.`);
    if (company.investors.length) lines.push(`Investors include: ${company.investors.join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * Look up the post author: company page -> company; person profile -> person and their company.
 * @param {{profile: {url: string, type: 'person'|'company'}|null, apiKey: string, fetchFn?: typeof fetch}} args
 * @returns {Promise<{company: object|null, person: object|null}>}
 */
export async function fetchHarmonicContext({ profile, apiKey, fetchFn = fetch, signal }) {
  if (!profile?.url || !apiKey) return { company: null, person: null };
  const query = (url) => encodeURIComponent(url);
  if (profile.type === 'company') {
    const raw = await call('POST', `/companies?linkedin_url=${query(profile.url)}&enrich_missing_company=false`, { apiKey, fetchFn, signal });
    return { company: summarizeCompany(raw), person: null };
  }
  const person = summarizePerson(await call('POST', `/persons?linkedin_url=${query(profile.url)}`, { apiKey, fetchFn, signal }));
  let company = null;
  if (person?.companyUrn) {
    try {
      company = summarizeCompany(await call('GET', `/companies/${encodeURIComponent(person.companyUrn)}`, { apiKey, fetchFn, signal }));
    } catch {
      // The person is still useful without their company.
      company = null;
    }
  }
  return { company, person };
}
