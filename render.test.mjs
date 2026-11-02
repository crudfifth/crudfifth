import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateProfileAssets, renderProfileSvg } from './render.mjs';
import { createPreviewServer } from './serve.mjs';

const runFile = promisify(execFile);
const profileRoot = path.dirname(fileURLToPath(import.meta.url));
const profile = {
  schemaVersion: 4, owner: 'crudfifth', generatedAt: '2026-11-02T00:00:00Z',
  sources: [{ login: 'crudfifth', type: 'User' }, { login: 'CRUD5thOfficial', type: 'Organization' }],
  profile: { name: 'Fixture Name', bio: 'Profile fixture', followers: 4, following: 5,
    publicRepos: 5, url: 'https://github.com/crudfifth' },
  repositories: { publicCount: 8, originalCount: 6, stars: 20, forks: 3 },
  languages: [{ name: 'TypeScript', bytes: 300 }, { name: 'Rust', bytes: 100 }],
  languageScope: { kind: 'github-language-bytes', visibility: 'public-and-private', totalBytes: 400 },
  activity: { kind: 'github-contributions', subject: 'crudfifth', visibility: 'public-and-private',
    label: 'コミット・PR等・公開＋非公開', complete: true,
    since: '2025-11-03', until: '2026-11-02', totalCount: 3,
    days: Array.from({ length: 365 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 10, 3) + index * 86_400_000).toISOString().slice(0, 10), count: index === 0 ? 1 : index === 364 ? 2 : 0,
    })) },
  projects: [{ name: 'CRUD5thOfficial/organization-project', description: '', stars: 2,
    language: 'TypeScript', url: 'https://github.com/CRUD5thOfficial/organization-project' }],
};

async function withTempDir(run) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'profile-render-test-'));
  try { await run(rootDir); } finally { await rm(rootDir, { recursive: true, force: true }); }
}

test('all five sections have continuous decorative motion and readable reduced motion', () => {
  const svg = renderProfileSvg(profile, { theme: 'dark' });
  for (const section of ['intro', 'stats', 'activity', 'languages', 'stack']) {
    assert.match(svg, new RegExp(`data-section="${section}"`));
  }
  for (const motion of ['rail-flow', 'neon-pulse', 'chromatic-shift', 'title-scan', 'activity-trail', 'bar-glint', 'stack-glint']) {
    assert.match(svg, new RegExp(`@keyframes ${motion}`));
  }
  assert.match(svg, /prefers-reduced-motion: reduce/);
  assert.match(svg, /animation: none !important/);
  assert.match(svg, /opacity: 1 !important/);
  assert.match(svg, /clip-path: none !important/);
  assert.match(svg, /stroke-dashoffset: 0 !important/);
  assert.match(svg, /\.decorative\{display:none !important\}/);
  assert.doesNotMatch(svg, /@keyframes (?:typewriter|stagger-reveal|line-draw|point-pulse|bar-reveal)/);
  assert.doesNotMatch(svg, /scaleX\(|animation:[^;}]*10s/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|<iframe\b|@import|@font-face/i);
  assert.doesNotMatch(svg, /(?:href|src)\s*=|url\(\s*["']?(?:https?:|data:|\/\/)/i);
  assert.doesNotMatch(svg, /<rect[^>]+(?:width="800"|height="\d+")[^>]+fill="(?!none)/);
});

test('combined counts identify both subjects and keep the personal follower scope', () => {
  const svg = renderProfileSvg(profile);
  assert.match(svg, /GITHUB ACTIVITY/);
  assert.doesNotMatch(svg, /年間貢献数ではありません|SELF-HOSTED SVG/);
  assert.match(svg, /言語別コード量/);
  assert.match(svg, /75\.0%/);
  assert.match(svg, /25\.0%/);
  assert.match(svg, /crudfifth \+ CRUD5thOfficial/);
  assert.match(svg, /個人フォロワー/);
  assert.match(svg, /コミット・PR等・公開＋非公開/);
  assert.match(svg, /個人＋組織・公開＋非公開・非fork/);
  assert.match(svg, /400 bytes/);
  assert.match(svg, />8<|>8<\/tspan>/);
  assert.match(svg, />20<|>20<\/tspan>/);
  assert.match(svg, /3 contributions/);
  assert.doesNotMatch(svg, /PUBLIC ACTIVITY|公開イベント|events|commits/);
});

test('untrusted profile, language and project strings cannot introduce XML or CSS', () => {
  const hostile = structuredClone(profile);
  hostile.profile.name = '<script>& "quoted"';
  hostile.profile.bio = '"/><script>bad()</script> & test';
  hostile.languages[0].name = '<image href="https://example.invalid">';
  hostile.projects[0].name = '<a onclick="bad()">repo</a>';
  hostile.projects[0].description = '<script>repo()</script> & description';
  const svg = renderProfileSvg(hostile);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /&quot;/);
  assert.doesNotMatch(svg, /<script\b|<image\b|<a\b|<[^>]+\son[a-z]+\s*=/i);
});

test('zero contributions retain a full dated calendar and a rendered baseline', () => {
  const empty = structuredClone(profile);
  empty.activity.totalCount = 0;
  empty.activity.days.forEach((day) => { day.count = 0; });
  const svg = renderProfileSvg(empty);
  assert.match(svg, /0 contributions/);
  assert.match(svg, /2025-11-03 — 2026-11-02/);
  assert.equal((svg.match(/<circle class="point"/g) ?? []).length, 365);
  assert.doesNotMatch(svg, /NaN|Infinity|取得できた公開イベントなし/);
});

test('invalid input is rejected before replacing existing assets', async () => {
  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, 'assets'));
    await writeFile(path.join(rootDir, 'assets/profile-dark.svg'), 'previous-dark');
    await writeFile(path.join(rootDir, 'assets/profile-light.svg'), 'previous-light');
    const inputPath = path.join(rootDir, 'invalid.json');
    await writeFile(inputPath, JSON.stringify({ ...profile, languages: [{ name: 'bad', bytes: -1 }] }));
    await assert.rejects(generateProfileAssets({ inputPath, outputDir: rootDir }));
    assert.equal(await readFile(path.join(rootDir, 'assets/profile-dark.svg'), 'utf8'), 'previous-dark');
    assert.equal(await readFile(path.join(rootDir, 'assets/profile-light.svg'), 'utf8'), 'previous-light');
    await writeFile(inputPath, '{bad json');
    await assert.rejects(generateProfileAssets({ inputPath, outputDir: rootDir }));
    assert.equal(await readFile(path.join(rootDir, 'assets/profile-dark.svg'), 'utf8'), 'previous-dark');
  });
});

test('file creation failure preserves existing destination and does not claim success', async () => {
  await withTempDir(async (rootDir) => {
    const blockedOutput = path.join(rootDir, 'not-a-directory');
    await writeFile(blockedOutput, 'keep-me');
    const inputPath = path.join(rootDir, 'profile.json');
    await writeFile(inputPath, JSON.stringify(profile));
    await assert.rejects(generateProfileAssets({
      inputPath, outputDir: blockedOutput,
    }));
    assert.equal(await readFile(blockedOutput, 'utf8'), 'keep-me');
  });
});

test('inconsistent counts, unknown theme and invalid numeric values fail explicitly', () => {
  for (const mutation of [
    (input) => { input.repositories.stars = null; },
    (input) => { input.activity.totalCount += 1; },
    (input) => { input.languageScope.totalBytes = 1; },
    (input) => { input.profile.followers = -1; },
    (input) => { input.profile.bio = {}; },
    (input) => { input.schemaVersion = 1; },
    (input) => { input.sources.pop(); },
    (input) => { input.sources.reverse(); },
    (input) => { input.sources[1].type = 'User'; },
    (input) => { input.owner = 'other'; },
    (input) => { input.profile.publicRepos = 9; },
    (input) => { input.activity.complete = false; },
  ]) {
    const input = structuredClone(profile);
    mutation(input);
    assert.throws(() => renderProfileSvg(input));
  }
  assert.throws(() => renderProfileSvg(profile, { theme: 'other' }));
});

test('CLI generates both themed images from schema4 input at the documented entry point', async () => {
  await withTempDir(async (outputDir) => {
    const inputPath = path.join(outputDir, 'profile.json');
    await writeFile(inputPath, JSON.stringify(profile));
    const { stdout } = await runFile(process.execPath, [path.join(profileRoot, 'render.mjs'),
      '--input', inputPath, '--output', outputDir]);
    assert.match(stdout, /profile-dark.svg/);
    for (const theme of ['dark', 'light']) {
      const svg = await readFile(path.join(outputDir, `assets/profile-${theme}.svg`), 'utf8');
      assert.match(svg, /<svg\b/);
      assert.match(svg, /CRUD5th/);
    }
  });
});

test('preview serves img assets on localhost and denies source, data and path escape', async () => {
  const server = createPreviewServer({ rootDir: profileRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(address.address, '127.0.0.1');
    const preview = await fetch(`${baseUrl}/`);
    assert.equal(preview.status, 200);
    const html = await preview.text();
    assert.match(html, /<img\b/);
    assert.match(html, /静止画/);
    assert.match(html, /再読み込み/);
    assert.match(html, /明色/);
    assert.match(html, /暗色/);
    assert.match(html, /prefers-reduced-motion/);
    for (const target of ['/collect.mjs', '/data/profile.json', '/denied.txt',
      '/%2e%2e%2fdenied.txt', '/assets/%2e%2e%2fdata/profile.json']) {
      const response = await fetch(`${baseUrl}${target}`);
      assert.equal(response.status, 404, target);
    }
    assert.equal((await fetch(`${baseUrl}/`, { method: 'POST' })).status, 405);
  } finally { server.close(); await once(server, 'close'); }
});

test('preview server refuses symlink assets outside the output root', async () => {
  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, 'assets'));
    await writeFile(path.join(rootDir, 'secret.txt'), 'do-not-serve');
    await symlink(path.join(rootDir, 'secret.txt'), path.join(rootDir, 'assets/profile-dark.svg'));
    const server = createPreviewServer({ rootDir });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/assets/profile-dark.svg`);
      assert.equal(response.status, 404);
    } finally { server.close(); await once(server, 'close'); }
  });
});


test('every language is displayed in two columns with percentages and a content-sized canvas', () => {
  const input = structuredClone(profile);
  input.languages = Array.from({ length: 51 }, (_, index) => ({ name: `Language${index + 1}`, bytes: 1 }));
  input.languageScope.totalBytes = 51;
  const svg = renderProfileSvg(input);
  for (const language of input.languages) assert.match(svg, new RegExp(`>${language.name}<`));
  assert.equal((svg.match(/class="bar"/g) ?? []).length, 51);
  assert.match(svg, /<text x="35"/);
  assert.match(svg, /<text x="417"/);
  const height = Number(svg.match(/height="(\d+)"/)[1]);
  assert.ok(height > 1500);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});


test('365 day points remain fixed while an aria-hidden trail follows the real activity path', () => {
  const svg = renderProfileSvg(profile);
  const points = [...svg.matchAll(/<circle class="point" cx="([\d.]+)" cy="([\d.]+)"/g)];
  assert.equal(points.length, 365);
  assert.equal(Number(points[0][1]), 35);
  assert.equal(Number(points.at(-1)[1]), 765);
  assert.ok(points.every((point) => Number(point[2]) >= 389 && Number(point[2]) <= 458));
  const base = svg.match(/<path class="activity-line"[^>]* d="([^"]+)"/)[1];
  const trail = svg.match(/<path class="activity-trail decorative"[^>]* d="([^"]+)"/)[1];
  assert.equal(trail, base);
  assert.match(svg, /class="activity-trail decorative"[^>]*aria-hidden="true"/);
});

test('incomplete dates and other-person/public-only scope fail before rendering', () => {
  for (const mutate of [
    (activity) => { activity.subject = 'someone-else'; },
    (activity) => { activity.visibility = 'public'; },
    (activity) => { activity.days.pop(); },
    (activity) => { activity.days[1].date = activity.days[0].date; },
    (activity) => { activity.since = '2025-11-02'; },
    (activity) => { activity.until = '2026-11-01'; },
  ]) { const input = structuredClone(profile); mutate(input.activity); assert.throws(() => renderProfileSvg(input)); }
});

test('render synchronizes the existing three raw image cache queries with final SVG digests', async () => {
  await withTempDir(async (rootDir) => {
    const readme = await readFile(path.join(profileRoot, 'README.md'), 'utf8');
    await writeFile(path.join(rootDir, 'README.md'), readme);
    const inputPath = path.join(rootDir, 'profile.json');
    await writeFile(inputPath, JSON.stringify(profile));
    await generateProfileAssets({ inputPath, outputDir: rootDir });
    const updated = await readFile(path.join(rootDir, 'README.md'), 'utf8');
    const urls = [...updated.matchAll(/https:\/\/raw\.githubusercontent\.com\/crudfifth\/crudfifth\/main\/assets\/profile-(dark|light)\.svg\?v=([a-f0-9]{12})/g)];
    assert.equal(urls.length, 3);
    for (const [, theme, digest] of urls) assert.equal(digest, createHash('sha256').update(await readFile(path.join(rootDir, `assets/profile-${theme}.svg`))).digest('hex').slice(0, 12));
    assert.equal(updated.replace(/\?v=[a-f0-9]+/g, ''), readme.replace(/\?v=[a-f0-9]+/g, ''));
    assert.deepEqual((await readdir(rootDir)).sort(), ['README.md', 'assets', 'profile.json']);
  });
});

test('a README preparation failure preserves both previous assets', async () => {
  await withTempDir(async (rootDir) => {
    const inputPath = path.join(rootDir, 'profile.json');
    await writeFile(inputPath, JSON.stringify(profile));
    await mkdir(path.join(rootDir, 'README.md'));
    await mkdir(path.join(rootDir, 'assets'));
    for (const theme of ['dark', 'light']) await writeFile(path.join(rootDir, `assets/profile-${theme}.svg`), `previous-${theme}`);
    await assert.rejects(generateProfileAssets({ inputPath, outputDir: rootDir }));
    for (const theme of ['dark', 'light']) assert.equal(await readFile(path.join(rootDir, `assets/profile-${theme}.svg`), 'utf8'), `previous-${theme}`);
  });
});


test('motion keeps actual bar widths and does not animate any data label or circle', () => {
  const svg = renderProfileSvg(profile);
  const bars = [...svg.matchAll(/<rect class="bar"[^>]*width="([\d.]+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(bars, [258.75, 86.25]);
  assert.doesNotMatch(svg, /\.(?:bar|point|metric|metric-label|intro-type|stat-reveal|stack-reveal)\{[^}]*animation:/);
  assert.match(svg, /class="bar-glint decorative"/);
  assert.match(svg, /class="metric-circuit decorative"/);
  assert.match(svg, /class="stack-glint decorative"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.doesNotMatch(svg, />[^<]*(?:REALTIME|LIVE)[^<]*</);
});
