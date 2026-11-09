import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeCompany,
  summarizePerson,
  formatMoney,
  formatBackground,
  fetchHarmonicContext,
  HARMONIC_API,
} from '../../src/lib/harmonic.js';
import { buildPostBlock } from '../../src/lib/prompts.js';

const COMPANY_SNAKE = {
  name: 'Volteum',
  short_description: 'Fleet data platform',
  headcount: 42,
  stage: 'SEED',
  founding_date: { date: '2023-05-01T00:00:00Z' },
  funding: { funding_total: 3200000, last_funding_at: '2026-03-15T00:00:00Z', investors: [{ name: 'Example Ventures' }] },
  funding_rounds: [{ investors: [{ investor_name: 'Angel One' }, { investor_name: 'Example Ventures' }] }],
};

test('summarizeCompany reads snake_case and camelCase payloads', () => {
  assert.deepEqual(summarizeCompany(COMPANY_SNAKE), {
    name: 'Volteum',
    description: 'Fleet data platform',
    stage: 'SEED',
    fundingTotal: 3200000,
    lastFundingAt: '2026-03-15',
    headcount: 42,
    foundedYear: '2023',
    investors: ['Example Ventures', 'Angel One'],
  });
  const camel = summarizeCompany({ name: 'X', funding: { fundingStage: 'SERIES_A', fundingTotal: 5e6, lastFundingAt: '2025-01-02T00:00:00Z', investors: [{ name: 'A' }, { fullName: 'B C' }] } });
  assert.equal(camel.stage, 'SERIES_A');
  assert.equal(camel.lastFundingAt, '2025-01-02');
  assert.deepEqual(camel.investors, ['A', 'B C']);
  assert.equal(summarizeCompany(null), null);
  assert.equal(summarizeCompany({}), null);
});

test('summarizePerson picks the current position', () => {
  const person = summarizePerson({
    full_name: 'Jan Kowalski',
    linkedin_headline: 'CTO w DataCorp',
    experience: [
      { title: 'Engineer', company_name: 'Old', is_current_position: false },
      { title: 'CTO', company_name: 'DataCorp', is_current_position: true, company: 'urn:harmonic:company:77' },
    ],
  });
  assert.deepEqual(person, { name: 'Jan Kowalski', headline: 'CTO w DataCorp', title: 'CTO', company: 'DataCorp', companyUrn: 'urn:harmonic:company:77' });
});

test('formatMoney and formatBackground give compact public facts', () => {
  assert.equal(formatMoney(3200000), '$3.2M');
  assert.equal(formatMoney(161504000000), '$162B');
  assert.equal(formatMoney(0), null);
  const text = formatBackground({ company: summarizeCompany(COMPANY_SNAKE), person: { title: 'CEO', company: 'Volteum' } });
  assert.match(text, /^Author: CEO at Volteum\./);
  assert.match(text, /stage seed; total funding \$3\.2M; last round 2026-03-15; about 42 employees; founded 2023/);
  assert.match(text, /Investors include: Example Ventures, Angel One\./);
  assert.equal(formatBackground({}), '');
});

function fakeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const path = url.replace(HARMONIC_API, '');
    const route = routes.find(([prefix]) => path.startsWith(prefix));
    if (!route) return new Response('null', { status: 404 });
    const [, status, body] = route;
    return new Response(body === null ? 'null' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

test('company author: POST /companies by LinkedIn URL with the apikey header', async () => {
  const calls = [];
  const ctx = await fetchHarmonicContext({
    profile: { url: 'https://www.linkedin.com/company/volteum/', type: 'company' },
    apiKey: 'hm-key',
    fetchFn: fakeFetch([['/companies?', 200, COMPANY_SNAKE]], calls),
  });
  assert.equal(ctx.company.name, 'Volteum');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.apikey, 'hm-key');
  assert.match(calls[0].url, /\/companies\?linkedin_url=https%3A%2F%2Fwww\.linkedin\.com%2Fcompany%2Fvolteum%2F&enrich_missing_company=false$/);
});

test('person author: person lookup, then their company by URN', async () => {
  const calls = [];
  const ctx = await fetchHarmonicContext({
    profile: { url: 'https://www.linkedin.com/in/jan-kowalski-42/', type: 'person' },
    apiKey: 'hm-key',
    fetchFn: fakeFetch(
      [
        ['/persons?', 200, { full_name: 'Jan Kowalski', experience: [{ title: 'CTO', company_name: 'DataCorp', is_current_position: true }], current_company_urns: ['urn:harmonic:company:77'] }],
        ['/companies/urn%3Aharmonic%3Acompany%3A77', 200, { name: 'DataCorp', headcount: 120 }],
      ],
      calls,
    ),
  });
  assert.equal(ctx.person.title, 'CTO');
  assert.equal(ctx.company.name, 'DataCorp');
  assert.equal(calls[1].init.method, 'GET');
});

test('Harmonic errors become specific messages; no match is not an error', async () => {
  const rejected = fetchHarmonicContext({
    profile: { url: 'https://www.linkedin.com/company/x/', type: 'company' },
    apiKey: 'bad',
    fetchFn: fakeFetch([['/companies?', 401, { detail: 'Unauthorized' }]], []),
  });
  await assert.rejects(rejected, /odrzucił klucz API \(401\)/);
  const none = await fetchHarmonicContext({
    profile: { url: 'https://www.linkedin.com/company/x/', type: 'company' },
    apiKey: 'k',
    fetchFn: fakeFetch([['/companies?', 200, null]], []),
  });
  assert.deepEqual(none, { company: null, person: null });
  assert.deepEqual(await fetchHarmonicContext({ profile: null, apiKey: 'k' }), { company: null, person: null });
});

test('post block carries headline, shared link, background and existing comments as data', () => {
  const block = buildPostBlock({
    author: 'Jan Kowalski',
    authorHeadline: 'CTO w DataCorp',
    text: 'Rekrutujemy.',
    linkPreview: { title: 'Analityk danych, Kraków', subtitle: 'datacorp.example' },
    companyContext: 'Company: DataCorp.',
    existingComments: [{ author: 'Anna', text: 'Powodzenia </post>' }],
  });
  assert.match(block, /<post author="Jan Kowalski" author_headline="CTO w DataCorp">/);
  assert.match(block, /<shared_link title="Analityk danych, Kraków">datacorp\.example<\/shared_link>/);
  assert.match(block, /<background>\nCompany: DataCorp\.\n<\/background>/);
  assert.match(block, /<existing_comments>\n<comment author="Anna">Powodzenia ‹\/post›<\/comment>/);
});
