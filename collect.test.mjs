import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectProfile } from './collect.mjs';
import { generateProfileAssets, renderProfileSvg } from './render.mjs';

function repository(id, overrides = {}) {
  return {
    id, owner: { login: 'crudfifth' }, private: false, fork: false,
    name: `repository-${id}`, html_url: `https://github.com/crudfifth/repository-${id}`,
    description: null, language: 'TypeScript', stargazers_count: 1, forks_count: 2,
    updated_at: '2026-10-01T00:00:00Z', ...overrides,
  };
}

function organizationRepository(id, overrides = {}) {
  return repository(id, { owner: { login: 'CRUD5thOfficial' },
    html_url: `https://github.com/CRUD5thOfficial/repository-${id}`, ...overrides });
}

function profile(publicRepos) {
  return { login: 'crudfifth', type: 'User', name: 'Fixture Name', bio: null,
    followers: 4, following: 5, public_repos: publicRepos, html_url: 'https://github.com/crudfifth' };
}

function organization(publicRepos) {
  return { login: 'CRUD5thOfficial', type: 'Organization', public_repos: publicRepos };
}

async function temporaryOutput(t) {
  const directory = await mkdtemp(join(tmpdir(), 'github-profile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'profile.json');
}

function emptySourceResponse(url) {
  const pathname = new URL(url).pathname;
  return Response.json(pathname === '/users/crudfifth' ? profile(0)
    : pathname === '/orgs/CRUD5thOfficial' ? organization(0) : []);
}

test('HTTP failure rejects and preserves the previous profile byte for byte', async (t) => {
  const outputPath = await temporaryOutput(t);
  const previous = '{"owner":"previous-valid-profile"}\n';
  await writeFile(outputPath, previous);
  const fetchImpl = async () => new Response('Do not log this API response', { status: 503 });
  await assert.rejects(collectProfile({ fetchImpl, outputPath }), /HTTP 503/);
  assert.equal(await readFile(outputPath, 'utf8'), previous);
  assert.deepEqual(await readdir(join(outputPath, '..')), ['profile.json']);
});

test('both sources page repositories and union IDs while retaining personal profile counts', async (t) => {
  const outputPath = await temporaryOutput(t);
  const repositories = Array.from({ length: 101 }, (_, index) => repository(index + 1));
  repositories[0] = repository(1, { fork: true, stargazers_count: 900, forks_count: 900 });
  repositories[1] = repository(2, { language: null });
  repositories[2] = repository(3, { updated_at: '2026-10-31T00:00:00Z' });
  const organizationRepositories = [
    organizationRepository(2, { language: 'Rust', stargazers_count: 5, forks_count: 7, updated_at: '2026-11-01T00:00:00Z' }),
    organizationRepository(201, { stargazers_count: 3, forks_count: 4, updated_at: '2026-11-02T00:00:00Z' }),
  ];
  const paths = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    paths.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === '/users/crudfifth') return Response.json(profile(101));
    if (parsed.pathname === '/orgs/CRUD5thOfficial') return Response.json(organization(2));
    if (parsed.pathname.endsWith('/repos')) {
      assert.equal(parsed.searchParams.get('per_page'), '100');
      assert.equal(parsed.searchParams.get('sort'), 'full_name');
      assert.equal(parsed.searchParams.get('direction'), 'asc');
      if (parsed.pathname.startsWith('/orgs/')) {
        assert.equal(parsed.searchParams.get('type'), 'public');
        return Response.json(organizationRepositories);
      }
      assert.equal(parsed.searchParams.get('type'), 'owner');
      const firstPage = parsed.searchParams.get('page') === '1';
      return Response.json(firstPage ? repositories.slice(0, 100) : repositories.slice(100), {
        headers: firstPage ? { link: '<https://untrusted.invalid/never-fetch>; rel="next"' } : {},
      });
    }
    assert.equal(parsed.searchParams.get('page'), '1');
    assert.equal(parsed.searchParams.get('per_page'), '100');
    if (parsed.pathname === '/users/crudfifth/events/public') return Response.json([
      { id: 'latest', public: true, created_at: '2026-10-31T02:00:00Z' },
      { id: 'older', public: true, created_at: '2026-10-29T23:00:00Z' },
      { id: 'same-day', public: true, created_at: '2026-10-31T03:00:00Z' },
    ], { headers: { link: '<https://untrusted.invalid/never-fetch>; rel="next"' } });
    assert.equal(parsed.pathname, '/orgs/CRUD5thOfficial/events');
    return Response.json([
      { id: 'latest', public: true, created_at: '2026-10-31T02:00:00Z' },
      { id: 'organization-only', public: true, created_at: '2026-11-01T03:00:00Z' },
    ]);
  };

  const collected = await collectProfile({ fetchImpl, outputPath, now: () => new Date('2026-11-02T00:00:00Z') });
  assert.equal(collected.schemaVersion, 2);
  assert.equal(collected.owner, 'crudfifth');
  assert.deepEqual(collected.sources, [{ login: 'crudfifth', type: 'User' }, { login: 'CRUD5thOfficial', type: 'Organization' }]);
  assert.deepEqual(collected.profile, { name: 'Fixture Name', bio: '', followers: 4, following: 5, publicRepos: 101, url: 'https://github.com/crudfifth' });
  assert.deepEqual(collected.repositories, { publicCount: 102, originalCount: 101, stars: 107, forks: 209 });
  assert.deepEqual(collected.languages, [{ name: 'TypeScript', count: 100 }, { name: 'Rust', count: 1 }]);
  assert.deepEqual(collected.projects.map(({ name, url, description }) => ({ name, url, description })), [
    { name: 'CRUD5thOfficial/repository-201', url: 'https://github.com/CRUD5thOfficial/repository-201', description: '' },
    { name: 'CRUD5thOfficial/repository-2', url: 'https://github.com/CRUD5thOfficial/repository-2', description: '' },
    { name: 'crudfifth/repository-3', url: 'https://github.com/crudfifth/repository-3', description: '' },
  ]);
  assert.equal(collected.activity.complete, false);
  assert.equal(collected.activity.eventCount, 4);
  assert.deepEqual(collected.activity.days, [
    { date: '2026-10-29', count: 1 }, { date: '2026-10-30', count: 0 },
    { date: '2026-10-31', count: 2 }, { date: '2026-11-01', count: 1 },
  ]);
  assert.equal(paths.filter((requestPath) => requestPath.includes('/events')).length, 2);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), collected);
  assert.deepEqual(await readdir(join(outputPath, '..')), ['profile.json']);
  assert.match(renderProfileSvg(collected), /crudfifth \+ CRUD5thOfficial/);
});

test('an incomplete personal repository collection rejects and preserves the previous profile', async (t) => {
  const outputPath = await temporaryOutput(t);
  await writeFile(outputPath, 'previous-profile\n');
  const fetchImpl = async (url) => new URL(url).pathname === '/users/crudfifth' ? Response.json(profile(1)) : emptySourceResponse(url);
  await assert.rejects(collectProfile({ fetchImpl, outputPath }), /repository page count does not match/);
  assert.equal(await readFile(outputPath, 'utf8'), 'previous-profile\n');
});

test('a failed later personal repository page preserves the previous profile', async (t) => {
  const outputPath = await temporaryOutput(t);
  await writeFile(outputPath, 'previous-profile\n');
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/users/crudfifth') return Response.json(profile(101));
    if (parsed.pathname !== '/users/crudfifth/repos') return emptySourceResponse(url);
    return parsed.searchParams.get('page') === '1'
      ? Response.json(Array.from({ length: 100 }, (_, index) => repository(index + 1)))
      : new Response(null, { status: 502 });
  };
  await assert.rejects(collectProfile({ fetchImpl, outputPath }), /HTTP 502/);
  assert.equal(await readFile(outputPath, 'utf8'), 'previous-profile\n');
});

test('timeout rejects and preserves the previous profile', async (t) => {
  const outputPath = await temporaryOutput(t);
  await writeFile(outputPath, 'previous-profile\n');
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(profile(0))), 1_000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  await assert.rejects(collectProfile({ fetchImpl, outputPath, timeoutMs: 5 }), /timeout/);
  assert.equal(await readFile(outputPath, 'utf8'), 'previous-profile\n');
});

test('organization failures preserve the previous JSON and both SVGs throughout the pipeline', async (t) => {
  const failureCases = [
    { name: 'metadata HTTP', target: '/orgs/CRUD5thOfficial', response: () => new Response(null, { status: 503 }), error: /HTTP 503/ },
    { name: 'metadata JSON', target: '/orgs/CRUD5thOfficial', response: () => new Response('{bad json'), error: /invalid JSON/ },
    { name: 'metadata identity', target: '/orgs/CRUD5thOfficial', response: () => Response.json({ ...organization(1), type: 'User' }), error: /source type/ },
    { name: 'later repository page HTTP', target: '/orgs/CRUD5thOfficial/repos', laterPage: true, response: () => new Response(null, { status: 502 }), error: /HTTP 502/ },
    { name: 'private repository', target: '/orgs/CRUD5thOfficial/repos', response: () => Response.json([organizationRepository(201, { private: true })]), error: /public repository owner/ },
    { name: 'missing private flag', target: '/orgs/CRUD5thOfficial/repos', response: () => Response.json([organizationRepository(201, { private: undefined })]), error: /public repository owner/ },
    { name: 'wrong repository owner', target: '/orgs/CRUD5thOfficial/repos', response: () => Response.json([repository(201)]), error: /public repository owner/ },
    { name: 'repository count mismatch', target: '/orgs/CRUD5thOfficial/repos', response: () => Response.json([]), error: /repository page count does not match/ },
    { name: 'duplicate repository in source', target: '/orgs/CRUD5thOfficial/repos', response: () => Response.json([organizationRepository(201), organizationRepository(201)]), error: /duplicate repository/ },
    { name: 'events HTTP', target: '/orgs/CRUD5thOfficial/events', response: () => new Response(null, { status: 502 }), error: /HTTP 502/ },
    { name: 'events timeout', target: '/orgs/CRUD5thOfficial/events', response: async (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json([])), 1_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }), error: /timeout/ },
    { name: 'nonpublic event', target: '/orgs/CRUD5thOfficial/events', response: () => Response.json([{ id: 'organization-only', public: false, created_at: '2026-11-01T00:00:00Z' }]), error: /public event timestamp/ },
    { name: 'missing event ID', target: '/orgs/CRUD5thOfficial/events', response: () => Response.json([{ public: true, created_at: '2026-11-01T00:00:00Z' }]), error: /public event ID/ },
  ];
  for (const failureCase of failureCases) await t.test(failureCase.name, async (subtest) => {
    const outputPath = await temporaryOutput(subtest);
    const outputDir = join(outputPath, '..');
    await writeFile(outputPath, 'previous-profile\n');
    await mkdir(join(outputDir, 'assets'));
    for (const theme of ['dark', 'light']) await writeFile(join(outputDir, `assets/profile-${theme}.svg`), `previous-${theme}\n`);
    const fetchImpl = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/orgs/CRUD5thOfficial' && failureCase.target !== parsed.pathname) return Response.json(organization(failureCase.laterPage ? 101 : 1));
      if (parsed.pathname === failureCase.target) {
        if (failureCase.laterPage && parsed.searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, index) => organizationRepository(index + 1)));
        return failureCase.response(url, options);
      }
      if (parsed.pathname === '/orgs/CRUD5thOfficial/repos') return Response.json([organizationRepository(201)]);
      return emptySourceResponse(url);
    };
    await assert.rejects(async () => {
      await collectProfile({ fetchImpl, outputPath, timeoutMs: 5 });
      await generateProfileAssets({ inputPath: outputPath, outputDir });
    }, failureCase.error);
    assert.equal(await readFile(outputPath, 'utf8'), 'previous-profile\n');
    for (const theme of ['dark', 'light']) assert.equal(await readFile(join(outputDir, `assets/profile-${theme}.svg`), 'utf8'), `previous-${theme}\n`);
    assert.deepEqual((await readdir(outputDir)).sort(), ['assets', 'profile.json']);
  });
});

test('empty events across both sources do not create a fictional date range', async (t) => {
  const outputPath = await temporaryOutput(t);
  const collected = await collectProfile({ fetchImpl: async (url) => emptySourceResponse(url), outputPath });
  assert.deepEqual(collected.activity, { kind: 'public-events', label: '取得できた公開イベントなし', since: '', until: '', complete: false, eventCount: 0, days: [] });
});
