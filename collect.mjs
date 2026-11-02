import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
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

async function fetchJson(path, fetchImpl, timeoutMs, token = '', requestLabel = path, queryRequest) {
  const method = queryRequest ? 'POST' : 'GET';
  let response;
  try {
    response = await fetchImpl(`${apiOrigin}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'crudfifth-profile-collector',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(queryRequest ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(queryRequest ? { body: JSON.stringify(queryRequest) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network failure';
    throw new Error(`GitHub ${method} ${requestLabel}: ${reason}`);
  }
  if (!response.ok) throw new Error(`GitHub ${method} ${requestLabel}: HTTP ${response.status}`);
  try {
    return { body: await response.json(), link: response.headers.get('link') ?? '' };
  } catch {
    throw new Error(`GitHub ${method} ${requestLabel}: invalid JSON response`);
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

function buildProfile(profile, repositories, activity, languages, generatedAt) {
  const originals = repositories.filter((repository) => !repository.fork);

  return {
    schemaVersion: 4,
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
    languageScope: { kind: 'github-language-bytes', visibility: 'public-and-private', totalBytes: languages.reduce((sum, language) => sum + language.bytes, 0) },
    activity,
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

async function collectContributions(fetchImpl, timeoutMs, token, generatedAt) {
  const end = new Date(generatedAt);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - 364));
  const since = start.toISOString().slice(0, 10);
  const until = end.toISOString().slice(0, 10);
  const { body } = await fetchJson('/graphql', fetchImpl, timeoutMs, token, 'personal contribution calendar', {
    query: `query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        login
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    variables: { login: owner, from: start.toISOString(), to: generatedAt },
  });
  requireCondition(body && !Object.hasOwn(body, 'errors'), 'contribution calendar query failed');
  requireCondition(body.data?.user?.login?.toLowerCase() === owner, 'contribution calendar subject');
  const calendar = body.data.user.contributionsCollection?.contributionCalendar;
  requireCondition(isCount(calendar?.totalContributions) && Array.isArray(calendar.weeks), 'contribution calendar');
  const days = [];
  let totalCount = 0;
  for (const week of calendar.weeks) {
    requireCondition(Array.isArray(week?.contributionDays), 'contribution calendar week');
    for (const day of week.contributionDays) {
      const expectedDate = new Date(start.getTime() + days.length * 86_400_000).toISOString().slice(0, 10);
      requireCondition(days.length < 365 && day?.date === expectedDate, 'contribution calendar must contain every requested date exactly once in order');
      requireCondition(isCount(day.contributionCount), 'contribution calendar count');
      totalCount += day.contributionCount;
      requireCondition(Number.isSafeInteger(totalCount), 'contribution calendar total');
      // Only dates and counts cross into the public snapshot, including anonymous private contributions.
      days.push({ date: day.date, count: day.contributionCount });
    }
  }
  requireCondition(days.length === 365 && totalCount === calendar.totalContributions, 'contribution calendar completeness or total');
  return { kind: 'github-contributions', subject: owner, visibility: 'public-and-private',
    label: 'コミット・PR等・公開＋非公開', since, until, complete: true, totalCount, days };
}

export async function collectProfile({ fetchImpl = fetch, outputPath = defaultOutputPath, timeoutMs = 15_000, now = () => new Date(), token = process.env.GITHUB_TOKEN ?? '' } = {}) {
  requireCondition(typeof token === 'string' && !/[\r\n]/.test(token), 'authentication token');
  if (!token.trim()) throw new Error('GITHUB_TOKEN credentials are required to collect public-and-private personal contributions');
  const generatedAt = now().toISOString();
  const { body: identity } = await fetchJson('/user', fetchImpl, timeoutMs, token, 'authenticated user');
  requireCondition(identity?.login?.toLowerCase() === owner, 'authenticated account must match profile owner');
  const { body: profile } = await fetchJson(`/users/${owner}`, fetchImpl, timeoutMs, token);
  validateProfile(profile);
  const repositoriesById = new Map();
  for (const source of sources) {
    const metadata = source.type === 'User' ? profile : (await fetchJson(`/orgs/${source.login}`, fetchImpl, timeoutMs, token)).body;
    validateSource(metadata, source);
    for (const repository of await collectRepositories(source, metadata.public_repos, fetchImpl, timeoutMs, token)) {
      repositoriesById.set(repository.id, repository);
    }
  }
  const activity = await collectContributions(fetchImpl, timeoutMs, token, generatedAt);
  const languageRepositoriesById = new Map();
  for (const source of sources) {
    for (const repository of await collectOwnedRepositories(source, fetchImpl, timeoutMs, token)) {
      requireCondition(!languageRepositoriesById.has(repository.id), 'duplicate owned repository across sources');
      languageRepositoriesById.set(repository.id, repository);
    }
  }
  const languages = await collectLanguageBytes([...languageRepositoriesById.values()], fetchImpl, timeoutMs, token);
  const collectedProfile = buildProfile(profile, [...repositoriesById.values()], activity, languages, generatedAt);
  await writeProfileAtomically(outputPath, collectedProfile);
  return collectedProfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const profile = await collectProfile();
    console.log(JSON.stringify({ saved: true, generatedAt: profile.generatedAt, publicRepositories: profile.repositories.publicCount, originalRepositories: profile.repositories.originalCount, personalContributions: profile.activity.totalCount, languageVisibility: profile.languageScope.visibility, languageBytes: profile.languageScope.totalBytes }));
  } catch (error) {
    console.error(`Collection failed; the existing profile was not replaced. ${error.message}`);
    process.exitCode = 1;
  }
}
