import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectProfile } from './collect.mjs';
import { generateProfileAssets, renderProfileSvg } from './render.mjs';
import { createPreviewServer } from './serve.mjs';

const runFile = promisify(execFile);
const profileRoot = path.dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(await readFile(path.join(profileRoot, 'data/profile.json'), 'utf8'));

async function withTempDir(run) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'profile-render-test-'));
  try { await run(rootDir); } finally { await rm(rootDir, { recursive: true, force: true }); }
}

test('five sections animate and reduced motion preserves the final readable state', () => {
  const svg = renderProfileSvg(profile, { theme: 'dark' });
  for (const section of ['intro', 'stats', 'activity', 'languages', 'stack']) {
    assert.match(svg, new RegExp(`data-section="${section}"`));
  }
  for (const motion of ['typewriter', 'stagger-reveal', 'line-draw', 'point-pulse', 'bar-reveal']) {
    assert.match(svg, new RegExp(`@keyframes ${motion}`));
  }
  assert.match(svg, /prefers-reduced-motion: reduce/);
  assert.match(svg, /animation: none !important/);
  assert.match(svg, /opacity: 1 !important/);
  assert.match(svg, /clip-path: none !important/);
  assert.match(svg, /stroke-dashoffset: 0 !important/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|<iframe\b|@import|@font-face/i);
  assert.doesNotMatch(svg, /(?:href|src)\s*=|url\(\s*["']?(?:https?:|data:|\/\/)/i);
  assert.doesNotMatch(svg, /<rect[^>]+(?:width="800"|height="\d+")[^>]+fill="(?!none)/);
});

test('real counts keep their measured scope and missing-language denominator', () => {
  const svg = renderProfileSvg(profile);
  assert.match(svg, /公開イベント・取得分/);
  assert.match(svg, /年間貢献数ではありません/);
  assert.match(svg, /主言語別repo件数/);
  assert.match(svg, /判定済み 13 \/ 290/);
  assert.match(svg, /未判定 277/);
  assert.match(svg, />291<|>291<\/tspan>/);
  assert.match(svg, />286<|>286<\/tspan>/);
  assert.match(svg, /21 events/);
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

test('actual collector output with zero events and empty dates renders explicit empty state', async () => {
  await withTempDir(async (rootDir) => {
    const publicProfile = { login: 'crudfifth', name: 'Collector fixture', bio: null,
      followers: 0, following: 0, public_repos: 0, html_url: 'https://github.com/crudfifth' };
    const fetchImpl = async (url) => Response.json(new URL(url).pathname === '/users/crudfifth' ? publicProfile : []);
    const empty = await collectProfile({ fetchImpl, outputPath: path.join(rootDir, 'empty-profile.json') });
    assert.equal(empty.activity.since, '');
    assert.equal(empty.activity.until, '');
    const svg = renderProfileSvg(empty);
    assert.match(svg, /取得できた公開イベントなし/);
    assert.match(svg, /主言語を判定できたrepoなし/);
    assert.match(svg, /判定済み 0 \/ 0/);
    assert.match(svg, /未判定 0/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  });
});

test('invalid input is rejected before replacing existing assets', async () => {
  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, 'assets'));
    await writeFile(path.join(rootDir, 'assets/profile-dark.svg'), 'previous-dark');
    await writeFile(path.join(rootDir, 'assets/profile-light.svg'), 'previous-light');
    const inputPath = path.join(rootDir, 'invalid.json');
    await writeFile(inputPath, JSON.stringify({ ...profile, languages: [{ name: 'bad', count: -1 }] }));
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
    await assert.rejects(generateProfileAssets({
      inputPath: path.join(profileRoot, 'data/profile.json'), outputDir: blockedOutput,
    }));
    assert.equal(await readFile(blockedOutput, 'utf8'), 'keep-me');
  });
});

test('inconsistent counts, unknown theme and invalid numeric values fail explicitly', () => {
  for (const mutation of [
    (input) => { input.repositories.stars = null; },
    (input) => { input.activity.eventCount += 1; },
    (input) => { input.repositories.originalCount = 1; },
    (input) => { input.profile.followers = -1; },
    (input) => { input.profile.bio = {}; },
  ]) {
    const input = structuredClone(profile);
    mutation(input);
    assert.throws(() => renderProfileSvg(input));
  }
  assert.throws(() => renderProfileSvg(profile, { theme: 'other' }));
});

test('CLI generates both themed images from the real input at the documented entry point', async () => {
  await withTempDir(async (outputDir) => {
    const { stdout } = await runFile(process.execPath, [path.join(profileRoot, 'render.mjs'),
      '--input', path.join(profileRoot, 'data/profile.json'), '--output', outputDir]);
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
