import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const owner = 'crudfifth';
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

async function fetchJson(path, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${apiOrigin}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'crudfifth-public-profile-collector',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network failure';
    throw new Error(`GitHub GET ${path}: ${reason}`);
  }
  if (!response.ok) throw new Error(`GitHub GET ${path}: HTTP ${response.status}`);
  try {
    return { body: await response.json(), link: response.headers.get('link') ?? '' };
  } catch {
    throw new Error(`GitHub GET ${path}: invalid JSON response`);
  }
}

function validateProfile(profile) {
  requireCondition(profile?.login?.toLowerCase() === owner, 'profile owner');
  requireCondition(isNullableString(profile.name) && isNullableString(profile.bio), 'profile text fields');
  requireCondition(isCount(profile.followers) && isCount(profile.following) && isCount(profile.public_repos), 'profile counts');
  requireCondition(profile.html_url === `https://github.com/${owner}`, 'profile URL');
}

function validateRepository(repository) {
  requireCondition(isCount(repository?.id), 'repository ID');
  requireCondition(repository.owner?.login?.toLowerCase() === owner && repository.private === false, 'public repository owner');
  requireCondition(typeof repository.fork === 'boolean', 'repository fork flag');
  requireCondition(typeof repository.name === 'string' && repository.name.length > 0, 'repository name');
  requireCondition(repository.html_url === `https://github.com/${owner}/${repository.name}`, 'repository URL');
  requireCondition(isNullableString(repository.description) && isNullableString(repository.language), 'repository text fields');
  requireCondition(isCount(repository.stargazers_count) && isCount(repository.forks_count), 'repository counts');
  requireCondition(isTimestamp(repository.updated_at), 'repository update timestamp');
}

function buildProfile(profile, repositories, events, generatedAt) {
  const originals = repositories.filter((repository) => !repository.fork);
  const languageCounts = new Map();
  for (const repository of originals) {
    if (repository.language !== null) {
      languageCounts.set(repository.language, (languageCounts.get(repository.language) ?? 0) + 1);
    }
  }

  const eventIds = new Set();
  const dayCounts = new Map();
  for (const event of events) {
    requireCondition(typeof event?.id === 'string' && !eventIds.has(event.id), 'public event ID');
    requireCondition(event.public === true && isTimestamp(event.created_at), 'public event timestamp');
    eventIds.add(event.id);
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
    schemaVersion: 1,
    owner,
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
    languages: [...languageCounts].map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'en')),
    activity: {
      kind: 'public-events',
      label: events.length ? '直近に取得できた公開イベント' : '取得できた公開イベントなし',
      since,
      until,
      complete: false,
      eventCount: events.length,
      days,
    },
    projects: originals.toSorted((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.name.localeCompare(right.name, 'en'))
      .slice(0, 3).map((repository) => ({
        name: repository.name,
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

export async function collectProfile({ fetchImpl = fetch, outputPath = defaultOutputPath, timeoutMs = 15_000, now = () => new Date() } = {}) {
  const { body: profile } = await fetchJson(`/users/${owner}`, fetchImpl, timeoutMs);
  validateProfile(profile);
  const repositories = [];
  const repositoryIds = new Set();
  const maximumPages = Math.ceil(profile.public_repos / 100) + 1;
  let reachedLastPage = false;
  for (let page = 1; page <= maximumPages; page += 1) {
    const { body: pageRepositories, link } = await fetchJson(`/users/${owner}/repos?type=owner&sort=full_name&direction=asc&per_page=100&page=${page}`, fetchImpl, timeoutMs);
    requireCondition(Array.isArray(pageRepositories) && pageRepositories.length <= 100, 'repository page');
    for (const repository of pageRepositories) {
      validateRepository(repository);
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
  requireCondition(reachedLastPage && repositories.length === profile.public_repos, 'repository page count does not match public_repos; retry a fresh collection');
  const { body: events } = await fetchJson(`/users/${owner}/events/public?per_page=100&page=1`, fetchImpl, timeoutMs);
  requireCondition(Array.isArray(events) && events.length <= 100, 'public events page');
  const collectedProfile = buildProfile(profile, repositories, events, now().toISOString());
  await writeProfileAtomically(outputPath, collectedProfile);
  return collectedProfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const profile = await collectProfile();
    console.log(JSON.stringify({ saved: true, generatedAt: profile.generatedAt, publicRepositories: profile.repositories.publicCount, originalRepositories: profile.repositories.originalCount, publicEvents: profile.activity.eventCount }));
  } catch (error) {
    console.error(`Collection failed; the existing profile was not replaced. ${error.message}`);
    process.exitCode = 1;
  }
}
