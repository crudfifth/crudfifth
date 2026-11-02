import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const owner = 'crudfifth';
const sources = [{ login: owner, type: 'User' }, { login: 'CRUD5thOfficial', type: 'Organization' }];
const apiOrigin = 'https://api.github.com';
const defaultOutputPath = fileURLToPath(new URL('./data/profile.json', import.meta.url));

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Invalid GitHub response: ${message}`);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

async function fetchJson(path, fetchImpl, timeoutMs, token = '', requestLabel = path) {
  let response;
  try {
    response = await fetchImpl(`${apiOrigin}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'crudfifth-profile-collector',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network failure';
    throw new Error(`GitHub GET ${requestLabel}: ${reason}`);
  }
  if (!response.ok) throw new Error(`GitHub GET ${requestLabel}: HTTP ${response.status}`);
  try {
    return { body: await response.json(), link: response.headers.get('link') ?? '' };
  } catch {
    throw new Error(`GitHub GET ${requestLabel}: invalid JSON response`);
  }
}

function validateProfile(profile) {
  requireCondition(profile?.login?.toLowerCase() === owner, 'profile owner');
  requireCondition(isNullableString(profile.name) && isNullableString(profile.bio), 'profile text fields');
  requireCondition(isCount(profile.followers) && isCount(profile.following) && isCount(profile.public_repos), 'profile counts');
  requireCondition(profile.html_url === `https://github.com/${owner}`, 'profile URL');
}

function validateSource(metadata, source) {
  requireCondition(metadata?.login?.toLowerCase() === source.login.toLowerCase(), 'source owner');
  requireCondition(metadata.type === source.type, 'source type');
  requireCondition(isCount(metadata.public_repos), 'source public repository count');
}

function validateRepository(repository, source) {
  requireCondition(isCount(repository?.id), 'repository ID');
  requireCondition(repository.owner?.login?.toLowerCase() === source.login.toLowerCase() && repository.private === false, 'public repository owner');
  requireCondition(typeof repository.fork === 'boolean', 'repository fork flag');
  requireCondition(typeof repository.name === 'string' && repository.name.length > 0, 'repository name');
  requireCondition(repository.html_url === `https://github.com/${source.login}/${repository.name}`, 'repository URL');
  requireCondition(isNullableString(repository.description) && isNullableString(repository.language), 'repository text fields');
  requireCondition(isCount(repository.stargazers_count) && isCount(repository.forks_count), 'repository counts');
  requireCondition(isTimestamp(repository.updated_at), 'repository update timestamp');
}

function buildProfile(profile, repositories, events, languages, visibility, generatedAt) {
  const originals = repositories.filter((repository) => !repository.fork);

  const dayCounts = new Map();
  for (const event of events) {
    const date = new Date(event.created_at).toISOString().slice(0, 10);
    dayCounts.set(date, (dayCounts.get(date) ?? 0) + 1);
  }
  const dates = [...dayCounts.keys()].sort();
  const since = dates[0] ?? '';
  const until = dates.at(-1) ?? '';
  const days = [];
  if (since) {
    for (const date = new Date(`${since}T00:00:00Z`); date.toISOString().slice(0, 10) <= until; date.setUTCDate(date.getUTCDate() + 1)) {
      const day = date.toISOString().slice(0, 10);
      days.push({ date: day, count: dayCounts.get(day) ?? 0 });
    }
  }

  return {
    schemaVersion: 3,
    owner,
    sources: sources.map((source) => ({ ...source })),
    generatedAt,
    profile: {
      name: profile.name ?? profile.login,
      bio: profile.bio ?? '',
      followers: profile.followers,
      following: profile.following,
      publicRepos: profile.public_repos,
      url: profile.html_url,
    },
    repositories: {
      publicCount: repositories.length,
      originalCount: originals.length,
      stars: originals.reduce((sum, repository) => sum + repository.stargazers_count, 0),
      forks: originals.reduce((sum, repository) => sum + repository.forks_count, 0),
    },
    languages,
    languageScope: { kind: 'github-language-bytes', visibility, totalBytes: languages.reduce((sum, language) => sum + language.bytes, 0) },
    activity: {
      kind: 'public-events',
      label: events.length ? '個人＋組織の公開イベント・取得分' : '取得できた公開イベントなし',
      since,
      until,
      complete: false,
      eventCount: events.length,
      days,
    },
    projects: originals.toSorted((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || `${left.owner.login}/${left.name}`.localeCompare(`${right.owner.login}/${right.name}`, 'en'))
      .slice(0, 3).map((repository) => ({
        name: `${repository.owner.login}/${repository.name}`,
        description: repository.description ?? '',
        url: repository.html_url,
        stars: repository.stargazers_count,
        language: repository.language ?? '',
      })),
  };
}

async function writeProfileAtomically(outputPath, profile) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function collectRepositories(source, publicRepoCount, fetchImpl, timeoutMs, token) {
  const repositories = [];
  const repositoryIds = new Set();
  const maximumPages = Math.ceil(publicRepoCount / 100) + 1;
  const basePath = source.type === 'User' ? `/users/${source.login}/repos?type=owner` : `/orgs/${source.login}/repos?type=public`;
  let reachedLastPage = false;
  for (let page = 1; page <= maximumPages; page += 1) {
    const { body: pageRepositories, link } = await fetchJson(`${basePath}&sort=full_name&direction=asc&per_page=100&page=${page}`, fetchImpl, timeoutMs, token);
    requireCondition(Array.isArray(pageRepositories) && pageRepositories.length <= 100, 'repository page');
    for (const repository of pageRepositories) {
      validateRepository(repository, source);
      requireCondition(!repositoryIds.has(repository.id), 'duplicate repository across pages');
      repositoryIds.add(repository.id);
      repositories.push(repository);
    }
    const hasNextPage = /rel="next"/.test(link);
    if (pageRepositories.length < 100 && !hasNextPage) {
      reachedLastPage = true;
      break;
    }
    requireCondition(pageRepositories.length === 100, 'incomplete repository page');
  }
  requireCondition(reachedLastPage && repositories.length === publicRepoCount, 'repository page count does not match public_repos; retry a fresh collection');
  return repositories;
}

async function collectOwnedRepositories(source, fetchImpl, timeoutMs, token) {
  const repositories = [];
  const repositoryIds = new Set();
  const basePath = source.type === 'User' ? '/user/repos?type=owner' : `/orgs/${source.login}/repos?type=all`;
  for (let page = 1; ; page += 1) {
    const { body: pageRepositories, link } = await fetchJson(`${basePath}&sort=full_name&direction=asc&per_page=100&page=${page}`, fetchImpl, timeoutMs, token, 'owned repository page');
    requireCondition(Array.isArray(pageRepositories) && pageRepositories.length <= 100, 'owned repository page');
    for (const repository of pageRepositories) {
      // /user/repos can include accessible repositories; ownership stays an explicit boundary.
      if (repository?.owner?.login?.toLowerCase() !== source.login.toLowerCase()) continue;
      requireCondition(isCount(repository.id), 'owned repository ID');
      requireCondition(typeof repository.private === 'boolean' && typeof repository.fork === 'boolean', 'owned repository visibility or fork flag');
      requireCondition(typeof repository.name === 'string' && repository.name.length > 0, 'owned repository name');
      requireCondition(!repositoryIds.has(repository.id), 'duplicate owned repository across pages');
      repositoryIds.add(repository.id);
      repositories.push({ id: repository.id, owner: source.login, name: repository.name, fork: repository.fork });
    }
    const hasNextPage = /rel="next"/.test(link);
    if (pageRepositories.length < 100 && !hasNextPage) break;
    requireCondition(pageRepositories.length === 100, 'incomplete owned repository page');
  }
  return repositories;
}

async function collectLanguageBytes(repositories, fetchImpl, timeoutMs, token) {
  const languageBytes = new Map();
  let totalBytes = 0;
  for (const repository of repositories) {
    if (repository.fork) continue;
    const repositoryOwner = typeof repository.owner === 'string' ? repository.owner : repository.owner.login;
    const { body: languages } = await fetchJson(`/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repository.name)}/languages`, fetchImpl, timeoutMs, token, 'repository languages');
    requireCondition(languages !== null && typeof languages === 'object' && !Array.isArray(languages), 'repository language bytes');
    for (const [name, bytes] of Object.entries(languages)) {
      requireCondition(name.length > 0 && name.length <= 100 && name.isWellFormed() && !/[\u0000-\u001F\uFFFE\uFFFF]/u.test(name) && isCount(bytes), 'repository language bytes');
      if (!bytes) continue;
      totalBytes += bytes;
      requireCondition(Number.isSafeInteger(totalBytes), 'language byte total exceeds safe integer range');
      languageBytes.set(name, (languageBytes.get(name) ?? 0) + bytes);
    }
  }
  return [...languageBytes].map(([name, bytes]) => ({ name, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name, 'en'));
}

async function preventScopeDowngrade(outputPath, token) {
  if (token) return;
  let previous;
  try { previous = await readFile(outputPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') return; throw error; }
  let profile;
  try { profile = JSON.parse(previous); } catch { return; }
  if (profile?.languageScope?.visibility === 'public-and-private') {
    throw new Error('GITHUB_TOKEN credentials are required to refresh the existing public-and-private language snapshot');
  }
}

export async function collectProfile({ fetchImpl = fetch, outputPath = defaultOutputPath, timeoutMs = 15_000, now = () => new Date(), token = process.env.GITHUB_TOKEN ?? '' } = {}) {
  requireCondition(typeof token === 'string' && !/[\r\n]/.test(token), 'authentication token');
  await preventScopeDowngrade(outputPath, token);
  if (token) {
    const { body: identity } = await fetchJson('/user', fetchImpl, timeoutMs, token, 'authenticated user');
    requireCondition(identity?.login?.toLowerCase() === owner, 'authenticated account must match profile owner');
  }
  const { body: profile } = await fetchJson(`/users/${owner}`, fetchImpl, timeoutMs, token);
  validateProfile(profile);
  const repositoriesById = new Map();
  const eventsById = new Map();
  for (const source of sources) {
    const metadata = source.type === 'User' ? profile : (await fetchJson(`/orgs/${source.login}`, fetchImpl, timeoutMs, token)).body;
    validateSource(metadata, source);
    for (const repository of await collectRepositories(source, metadata.public_repos, fetchImpl, timeoutMs, token)) {
      repositoriesById.set(repository.id, repository);
    }
    const eventsPath = source.type === 'User' ? `/users/${source.login}/events/public` : `/orgs/${source.login}/events`;
    const { body: events } = await fetchJson(`${eventsPath}?per_page=100&page=1`, fetchImpl, timeoutMs, token);
    requireCondition(Array.isArray(events) && events.length <= 100, 'public events page');
    for (const event of events) {
      requireCondition(typeof event?.id === 'string' && event.id.length > 0, 'public event ID');
      requireCondition(event.public === true && isTimestamp(event.created_at), 'public event timestamp');
      eventsById.set(event.id, event);
    }
  }
  const languageRepositoriesById = new Map(repositoriesById);
  if (token) {
    languageRepositoriesById.clear();
    for (const source of sources) {
      for (const repository of await collectOwnedRepositories(source, fetchImpl, timeoutMs, token)) {
        requireCondition(!languageRepositoriesById.has(repository.id), 'duplicate owned repository across sources');
        languageRepositoriesById.set(repository.id, repository);
      }
    }
  }
  const languages = await collectLanguageBytes([...languageRepositoriesById.values()], fetchImpl, timeoutMs, token);
  const collectedProfile = buildProfile(profile, [...repositoriesById.values()], [...eventsById.values()], languages, token ? 'public-and-private' : 'public', now().toISOString());
  await writeProfileAtomically(outputPath, collectedProfile);
  return collectedProfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const profile = await collectProfile();
    console.log(JSON.stringify({ saved: true, generatedAt: profile.generatedAt, publicRepositories: profile.repositories.publicCount, originalRepositories: profile.repositories.originalCount, publicEvents: profile.activity.eventCount, languageVisibility: profile.languageScope.visibility, languageBytes: profile.languageScope.totalBytes }));
  } catch (error) {
    console.error(`Collection failed; the existing profile was not replaced. ${error.message}`);
    process.exitCode = 1;
  }
}
