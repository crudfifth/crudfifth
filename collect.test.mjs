import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectProfile } from './collect.mjs';
import { generateProfileAssets, renderProfileSvg } from './render.mjs';

const fixtureToken = 'fixture-only-token-never-real';
const fixedNow = '2026-11-02T00:00:00.000Z';
const collect = (options) => collectProfile({ token: fixtureToken, now: () => new Date(fixedNow), ...options });
function repository(id, overrides = {}) {
  return { id, owner: { login: 'crudfifth' }, private: false, fork: false,
    name: `repository-${id}`, html_url: `https://github.com/crudfifth/repository-${id}`,
    description: null, language: 'TypeScript', stargazers_count: 1, forks_count: 2,
    updated_at: '2026-10-01T00:00:00Z', ...overrides };
}
function organizationRepository(id, overrides = {}) {
  return repository(id, { owner: { login: 'CRUD5thOfficial' },
    html_url: `https://github.com/CRUD5thOfficial/repository-${id}`, ...overrides });
}
function profile(count = 0) {
  return { login: 'crudfifth', type: 'User', name: 'Fixture Name', bio: null,
    followers: 4, following: 5, public_repos: count, html_url: 'https://github.com/crudfifth' };
}
function organization(count = 0) { return { login: 'CRUD5thOfficial', type: 'Organization', public_repos: count }; }
function calendarBody({ from = '2025-11-03T00:00:00.000Z', zero = false } = {}) {
  const days = Array.from({ length: 365 }, (_, index) => ({
    date: new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10),
    contributionCount: zero ? 0 : index === 0 ? 1 : index === 364 ? 2 : 0,
  }));
  return { data: { user: { login: 'crudfifth', contributionsCollection: { contributionCalendar: {
    totalContributions: zero ? 0 : 3,
    weeks: Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => ({ contributionDays: days.slice(index * 7, index * 7 + 7) })),
  } } } } };
}
function calendar(body) { return body.data.user.contributionsCollection.contributionCalendar; }
function fixture({ personal = [], organizational = [], graph = () => Response.json(calendarBody()), override } = {}) {
  return async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, `Bearer ${fixtureToken}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!parsed.pathname.includes('/events'), 'events must not be fetched or mixed into personal contributions');
    if (override) { const response = await override(parsed, options); if (response) return response; }
    if (parsed.pathname === '/graphql') {
      assert.equal(options.method, 'POST');
      const request = JSON.parse(options.body);
      assert.match(request.query, /^query\b/);
      assert.doesNotMatch(request.query, /mutation|repository|commitContributionsByRepository/);
      assert.equal(request.variables.login, 'crudfifth');
      return graph(request, options);
    }
    assert.equal(options.method, 'GET');
    if (parsed.pathname === '/user') return Response.json({ login: 'crudfifth' });
    if (parsed.pathname === '/users/crudfifth') return Response.json(profile());
    if (parsed.pathname === '/orgs/CRUD5thOfficial') return Response.json(organization());
    if (parsed.pathname === '/user/repos') return Response.json(personal);
    if (parsed.pathname === '/orgs/CRUD5thOfficial/repos' && parsed.searchParams.get('type') === 'all') return Response.json(organizational);
    if (parsed.pathname.endsWith('/languages')) return Response.json({ Elixir: 300, HTML: 100 });
    return Response.json([]);
  };
}
async function output(t) {
  const directory = await mkdtemp(join(tmpdir(), 'github-activity-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'profile.json');
}

test('authenticated personal calendar is exactly 365 consecutive UTC dates and one captured now', async (t) => {
  const outputPath = await output(t);
  let clockReads = 0;
  const collected = await collect({ outputPath, now: () => { clockReads += 1; return new Date(fixedNow); }, fetchImpl: fixture({ graph: ({ variables }) => {
    assert.deepEqual(variables, { login: 'crudfifth', from: '2025-11-03T00:00:00.000Z', to: fixedNow });
    const body = calendarBody();
    body.data.user.privateRepository = { name: 'never-publish-private-name', description: 'never-publish-private-description', id: 'never-publish-private-id' };
    calendar(body).weeks[0].contributionDays[0].repository = { url: 'https://github.com/never-publish-private-url' };
    return Response.json(body);
  } }) });
  assert.equal(clockReads, 1);
  assert.equal(collected.schemaVersion, 4);
  assert.equal(collected.generatedAt, fixedNow);
  assert.deepEqual(Object.keys(collected.activity).sort(), ['complete', 'days', 'kind', 'label', 'since', 'subject', 'totalCount', 'until', 'visibility']);
  assert.equal(collected.activity.kind, 'github-contributions');
  assert.equal(collected.activity.subject, 'crudfifth');
  assert.equal(collected.activity.visibility, 'public-and-private');
  assert.equal(collected.activity.label, 'コミット・PR等・公開＋非公開');
  assert.equal(collected.activity.complete, true);
  assert.equal(collected.activity.totalCount, 3);
  assert.equal(collected.activity.since, '2025-11-03');
  assert.equal(collected.activity.until, '2026-11-02');
  assert.equal(collected.activity.days.length, 365);
  assert.deepEqual(collected.activity.days[0], { date: '2025-11-03', count: 1 });
  assert.deepEqual(collected.activity.days.at(-1), { date: '2026-11-02', count: 2 });
  assert.equal(collected.activity.days.filter((day) => day.count === 0).length, 363);
  const published = `${await readFile(outputPath, 'utf8')}\n${renderProfileSvg(collected)}`;
  assert.doesNotMatch(published, /never-publish|fixture-only-token|public-events|eventCount/);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), collected);
});

test('zero contributions are a complete dated calendar, not failed retrieval', async (t) => {
  const collected = await collect({ outputPath: await output(t), fetchImpl: fixture({ graph: () => Response.json(calendarBody({ zero: true })) }) });
  assert.equal(collected.activity.totalCount, 0);
  assert.equal(collected.activity.days.length, 365);
  assert.equal(collected.activity.days.every((day) => day.count === 0), true);
  assert.match(renderProfileSvg(collected), /0 contributions/);
});

test('365 inclusive days span leap day and remain stable across a clock midnight', async (t) => {
  for (const timestamp of ['2024-03-01T00:00:00.000Z', '2026-11-01T23:59:59.999Z']) await t.test(timestamp, async (subtest) => {
    let reads = 0;
    const expectedFrom = timestamp.startsWith('2024') ? '2023-03-03T00:00:00.000Z' : '2025-11-02T00:00:00.000Z';
    const collected = await collect({ outputPath: await output(subtest), now: () => new Date(reads++ === 0 ? timestamp : '2030-01-01T00:00:00Z'), fetchImpl: fixture({ graph: ({ variables }) => {
      assert.equal(variables.from, expectedFrom); assert.equal(variables.to, timestamp);
      return Response.json(calendarBody({ from: expectedFrom }));
    } }) });
    assert.equal(reads, 1);
    assert.equal(collected.activity.until, timestamp.slice(0, 10));
    if (timestamp.startsWith('2024')) assert.ok(collected.activity.days.some((day) => day.date === '2024-02-29'));
  });
});

test('credentials are mandatory even on first generation and no public fallback is attempted', async (t) => {
  const outputPath = await output(t);
  let requested = false;
  for (const previous of [null, 'previous-profile']) {
    if (previous) await writeFile(outputPath, previous);
    await assert.rejects(collect({ token: '', outputPath, fetchImpl: () => { requested = true; throw new Error('must not fetch'); } }), /GITHUB_TOKEN|credentials/i);
    assert.equal(requested, false);
    if (previous) assert.equal(await readFile(outputPath, 'utf8'), previous);
    else assert.deepEqual(await readdir(join(outputPath, '..')), []);
  }
});

test('calendar errors and partial data preserve JSON, both SVGs and README without leaking API details', async (t) => {
  const failures = [
    ['HTTP', () => new Response(fixtureToken + ' never-publish-private-name', { status: 403 })],
    ['network', () => { throw new Error(fixtureToken + ' never-publish-private-name'); }],
    ['redirect', () => { throw new TypeError('redirect to never-publish-private-name'); }],
    ['invalid JSON', () => new Response(fixtureToken)],
    ['GraphQL errors', () => Response.json({ ...calendarBody(), errors: [{ message: fixtureToken + ' never-publish-private-name' }] })],
    ['null user', () => Response.json({ data: { user: null } })],
    ['wrong user', () => { const b = calendarBody(); b.data.user.login = 'never-publish-private-name'; return Response.json(b); }],
    ['null calendar', () => { const b = calendarBody(); b.data.user.contributionsCollection.contributionCalendar = null; return Response.json(b); }],
    ['missing date', () => { const b = calendarBody(); calendar(b).weeks[0].contributionDays.pop(); return Response.json(b); }],
    ['duplicate date', () => { const b = calendarBody(); calendar(b).weeks[0].contributionDays[1].date = '2025-11-03'; return Response.json(b); }],
    ['out of order', () => { const b = calendarBody(); calendar(b).weeks.reverse(); return Response.json(b); }],
    ['extra date', () => { const b = calendarBody(); calendar(b).weeks[0].contributionDays.unshift({ date: '2025-11-02', contributionCount: 0 }); return Response.json(b); }],
    ['invalid date', () => { const b = calendarBody(); calendar(b).weeks[0].contributionDays[0].date = '2025-02-30'; return Response.json(b); }],
    ['invalid count', () => { const b = calendarBody(); calendar(b).weeks[0].contributionDays[0].contributionCount = -1; return Response.json(b); }],
    ['fraction count', () => { const b = calendarBody(); calendar(b).weeks[0].contributionDays[0].contributionCount = 0.5; return Response.json(b); }],
    ['total mismatch', () => { const b = calendarBody(); calendar(b).totalContributions += 1; return Response.json(b); }],
    ['unsafe total', () => { const b = calendarBody(); calendar(b).totalContributions = Number.MAX_SAFE_INTEGER + 1; return Response.json(b); }],
    ['timeout', (_request, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(calendarBody())), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    })],
  ];
  for (const [name, graph] of failures) await t.test(name, async (subtest) => {
    const outputPath = await output(subtest); const outputDir = join(outputPath, '..');
    await writeFile(outputPath, 'previous-profile');
    await mkdir(join(outputDir, 'assets'));
    for (const theme of ['dark', 'light']) await writeFile(join(outputDir, `assets/profile-${theme}.svg`), `previous-${theme}`);
    await writeFile(join(outputDir, 'README.md'), 'previous-readme');
    const error = await (async () => {
      await collect({ outputPath, timeoutMs: 5, fetchImpl: fixture({ graph }) });
      await generateProfileAssets({ inputPath: outputPath, outputDir });
    })().then(() => null, (error) => error);
    assert.ok(error instanceof Error, name);
    assert.doesNotMatch(error.message, /fixture-only-token|never-publish/);
    assert.equal(await readFile(outputPath, 'utf8'), 'previous-profile');
    for (const theme of ['dark', 'light']) assert.equal(await readFile(join(outputDir, `assets/profile-${theme}.svg`), 'utf8'), `previous-${theme}`);
    assert.equal(await readFile(join(outputDir, 'README.md'), 'utf8'), 'previous-readme');
    assert.deepEqual((await readdir(outputDir)).sort(), ['README.md', 'assets', 'profile.json']);
  });
});

test('public repository statistics retain both owners, pagination and public-only projects', async (t) => {
  const personal = Array.from({ length: 101 }, (_, index) => repository(index + 1));
  personal[0] = repository(1, { fork: true, stargazers_count: 900 });
  const org = [organizationRepository(201, { stargazers_count: 7, updated_at: '2026-11-01T00:00:00Z' })];
  const requests = [];
  const collected = await collect({ outputPath: await output(t), fetchImpl: fixture({ personal: [], override: (url) => {
    if (url.pathname === '/users/crudfifth') return Response.json(profile(101));
    if (url.pathname === '/orgs/CRUD5thOfficial') return Response.json(organization(1));
    if (url.pathname === '/users/crudfifth/repos') {
      requests.push(url.searchParams.get('page'));
      return Response.json(url.searchParams.get('page') === '1' ? personal.slice(0, 100) : personal.slice(100), { headers: url.searchParams.get('page') === '1' ? { link: '<https://never-follow.invalid>; rel="next"' } : {} });
    }
    if (url.pathname === '/orgs/CRUD5thOfficial/repos' && url.searchParams.get('type') === 'public') return Response.json(org);
  } }) });
  assert.deepEqual(requests, ['1', '2']);
  assert.deepEqual(collected.repositories, { publicCount: 102, originalCount: 101, stars: 107, forks: 202 });
  assert.equal(collected.profile.publicRepos, 101);
  assert.equal(collected.profile.followers, 4);
  assert.equal(collected.projects[0].name, 'CRUD5thOfficial/repository-201');
});

test('authenticated language bytes include private owned non-forks across both owners without exposing metadata', async (t) => {
  const privateRepo = (id, overrides = {}) => repository(id, { private: true, name: `never-publish-private-${id}`, description: 'never-publish-description', ...overrides });
  const requests = [];
  const collected = await collect({ outputPath: await output(t), fetchImpl: fixture({ override: (url) => {
    const owned = url.pathname === '/user/repos' || (url.pathname === '/orgs/CRUD5thOfficial/repos' && url.searchParams.get('type') === 'all');
    if (!owned) return;
    const page = Number(url.searchParams.get('page')); requests.push(`${url.pathname}:${page}`);
    const make = (id, overrides = {}) => privateRepo(id, { ...(url.pathname.startsWith('/orgs/') ? { owner: { login: 'CRUD5thOfficial' } } : {}), ...overrides });
    return Response.json(page === 1 ? Array.from({ length: 100 }, (_, i) => make((url.pathname.startsWith('/orgs/') ? 1000 : 0) + i + 1)) : [make(url.pathname.startsWith('/orgs/') ? 1101 : 101), make(url.pathname.startsWith('/orgs/') ? 19999 : 9999, { fork: true })]);
  } }) });
  assert.deepEqual(requests, ['/user/repos:1', '/user/repos:2', '/orgs/CRUD5thOfficial/repos:1', '/orgs/CRUD5thOfficial/repos:2']);
  assert.equal(collected.languageScope.visibility, 'public-and-private');
  assert.deepEqual(collected.languages, [{ name: 'Elixir', bytes: 60600 }, { name: 'HTML', bytes: 20200 }]);
  assert.deepEqual(collected.repositories, { publicCount: 0, originalCount: 0, stars: 0, forks: 0 });
  assert.deepEqual(collected.projects, []);
  assert.doesNotMatch(JSON.stringify(collected) + renderProfileSvg(collected), /never-publish|fixture-only-token/);
});

test('identity, public metadata, pagination and language failures retain the last profile', async (t) => {
  const cases = [
    ['/user', () => Response.json({ login: 'another-account' }), /authenticated account/],
    ['/user', () => new Response('never-publish', { status: 401 }), /HTTP 401/],
    ['/users/crudfifth', () => Response.json(profile(1)), /repository page count/],
    ['/orgs/CRUD5thOfficial', () => Response.json({ ...organization(), type: 'User' }), /source type/],
    ['/orgs/CRUD5thOfficial', () => new Response('never-publish', { status: 503 }), /HTTP 503/],
    ['/users/crudfifth/repos', () => Response.json([repository(1, { private: true })]), /public repository owner/],
    ['/user/repos', () => Response.json([repository(1), repository(1)]), /duplicate owned/],
    ['/repos/crudfifth/repository-7/languages', () => Response.json({ Elixir: -1 }), /language bytes/],
  ];
  for (const [target, response, pattern] of cases) await t.test(target, async (subtest) => {
    const outputPath = await output(subtest); await writeFile(outputPath, 'previous-profile');
    const error = await collect({ outputPath, fetchImpl: fixture({ personal: [repository(7)], override: (url) => url.pathname === target ? response() : undefined }) }).then(() => null, (error) => error);
    assert.match(error.message, pattern); assert.doesNotMatch(error.message, /never-publish|fixture-only-token/);
    assert.equal(await readFile(outputPath, 'utf8'), 'previous-profile');
  });
});

test('atomic JSON replacement failure removes staged output and preserves the destination', async (t) => {
  const outputPath = await output(t); await mkdir(outputPath); await writeFile(join(outputPath, 'keep.txt'), 'keep');
  await assert.rejects(collect({ outputPath, fetchImpl: fixture() }));
  assert.equal(await readFile(join(outputPath, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(join(outputPath, '..')), ['profile.json']);
});
