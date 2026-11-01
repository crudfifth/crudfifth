import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectProfile } from './collect.mjs';

test('HTTP failure rejects and preserves the previous profile byte for byte', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'github-profile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'profile.json');
  const previous = '{"owner":"previous-valid-profile"}\n';
  await writeFile(outputPath, previous);
  const fetchImpl = async () => new Response('Do not log this API response', { status: 503 });

  await assert.rejects(collectProfile({ fetchImpl, outputPath }), /HTTP 503/);
  assert.equal(await readFile(outputPath, 'utf8'), previous);
  assert.deepEqual(await readdir(directory), ['profile.json']);
});

function repository(id, overrides = {}) {
  return {
    id,
    owner: { login: 'crudfifth' },
    private: false,
    fork: false,
    name: `repository-${id}`,
    html_url: `https://github.com/crudfifth/repository-${id}`,
    description: null,
    language: 'TypeScript',
    stargazers_count: 1,
    forks_count: 2,
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function profile(publicRepos) {
  return { login: 'crudfifth', name: 'Fixture Name', bio: null, followers: 4, following: 5, public_repos: publicRepos, html_url: 'https://github.com/crudfifth' };
}

async function temporaryOutput(t) {
  const directory = await mkdtemp(join(tmpdir(), 'github-profile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'profile.json');
}

test('all repository pages are collected while forks are excluded from owned original statistics', async (t) => {
  const outputPath = await temporaryOutput(t);
  const repositories = Array.from({ length: 101 }, (_, index) => repository(index + 1));
  repositories[0] = repository(1, { fork: true, stargazers_count: 900, forks_count: 900 });
  repositories[1] = repository(2, { language: null, updated_at: '2026-10-31T00:00:00Z' });
  const paths = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    paths.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname.endsWith('/repos')) {
      assert.equal(parsed.searchParams.get('per_page'), '100');
      const firstPage = parsed.searchParams.get('page') === '1';
      return Response.json(firstPage ? repositories.slice(0, 100) : repositories.slice(100), {
        headers: firstPage ? { link: '<https://api.github.com/users/crudfifth/repos?page=2>; rel="next"' } : {},
      });
    }
    if (parsed.pathname.endsWith('/events/public')) {
      assert.equal(parsed.searchParams.get('page'), '1');
      return Response.json([
        { id: 'latest', public: true, created_at: '2026-10-31T02:00:00Z' },
        { id: 'older', public: true, created_at: '2026-10-29T23:00:00Z' },
        { id: 'same-day', public: true, created_at: '2026-10-31T03:00:00Z' },
      ], { headers: { link: '<https://api.github.com/users/crudfifth/events/public?page=2>; rel="next"' } });
    }
    return Response.json(profile(101));
  };

  const collected = await collectProfile({ fetchImpl, outputPath, now: () => new Date('2026-11-01T00:00:00Z') });
  assert.deepEqual(collected.repositories, { publicCount: 101, originalCount: 100, stars: 100, forks: 200 });
  assert.deepEqual(collected.languages, [{ name: 'TypeScript', count: 99 }]);
  assert.equal(collected.projects.length, 3);
  assert.equal(collected.projects[0].name, 'repository-2');
  assert.equal(collected.projects[0].language, '');
  assert.equal(collected.activity.complete, false);
  assert.equal(collected.activity.eventCount, 3);
  assert.equal(collected.activity.since, '2026-10-29');
  assert.equal(collected.activity.until, '2026-10-31');
  assert.deepEqual(collected.activity.days, [{ date: '2026-10-29', count: 1 }, { date: '2026-10-30', count: 0 }, { date: '2026-10-31', count: 2 }]);
  assert.equal(paths.filter((path) => path.includes('/events/public')).length, 1);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), collected);
  assert.deepEqual(await readdir(join(outputPath, '..')), ['profile.json']);
});

test('an incomplete repository collection rejects and preserves the previous profile', async (t) => {
  const outputPath = await temporaryOutput(t);
  const previous = 'previous-profile\n';
  await writeFile(outputPath, previous);
  const fetchImpl = async (url) => new URL(url).pathname.endsWith('/repos') ? Response.json([]) : Response.json(profile(1));
  await assert.rejects(collectProfile({ fetchImpl, outputPath }), /repository page count does not match/);
  assert.equal(await readFile(outputPath, 'utf8'), previous);
});

test('a failed later repository page preserves the previous profile', async (t) => {
  const outputPath = await temporaryOutput(t);
  const previous = 'previous-profile\n';
  await writeFile(outputPath, previous);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/repos')) return Response.json(profile(101));
    return parsed.searchParams.get('page') === '1'
      ? Response.json(Array.from({ length: 100 }, (_, index) => repository(index + 1)))
      : new Response(null, { status: 502 });
  };
  await assert.rejects(collectProfile({ fetchImpl, outputPath }), /HTTP 502/);
  assert.equal(await readFile(outputPath, 'utf8'), previous);
});

test('timeout rejects and preserves the previous profile', async (t) => {
  const outputPath = await temporaryOutput(t);
  const previous = 'previous-profile\n';
  await writeFile(outputPath, previous);
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(profile(0))), 1_000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
  await assert.rejects(collectProfile({ fetchImpl, outputPath, timeoutMs: 5 }), /timeout/);
  assert.equal(await readFile(outputPath, 'utf8'), previous);
});

test('empty public events are explicit and do not create a fictional date range', async (t) => {
  const outputPath = await temporaryOutput(t);
  const fetchImpl = async (url) => Response.json(new URL(url).pathname === '/users/crudfifth' ? profile(0) : []);
  const collected = await collectProfile({ fetchImpl, outputPath });
  assert.deepEqual(collected.activity, { kind: 'public-events', label: '取得できた公開イベントなし', since: '', until: '', complete: false, eventCount: 0, days: [] });
});
