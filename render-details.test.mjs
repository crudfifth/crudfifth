import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const profileRoot = path.dirname(fileURLToPath(import.meta.url));
const originalTerms = ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'Vue.js', 'Laravel', 'PHP', 'React', 'Node.js', 'Rust', 'SonarQube', 'Storybook', 'MySQL', 'PostgreSQL', 'Java', 'Ruby', 'Python', 'Spring', 'Ruby on Rails', 'Three.js', 'SOLID', 'Django', 'Linux', 'Tor Browser', 'Unity', 'Blender', 'Svelte'];
const originalHrefs = ['https://x.com/CRUD5th', 'https://totomediasite.com/', 'https://zenn.dev/crudfifth', 'https://www.facebook.com/profile.php?id=61554965062342', 'https://qiita.com/CRUD5th', 'https://blood-raven.com/', 'https://synvrea.com/', 'https://crudfifth.com/', 'https://www.wantedly.com/id/CRUD5th', 'https://www.lancers.jp/profile/crudfifth', 'https://crowdworks.jp/public/employees/5793463', 'https://codepen.io/CRUD5th', 'https://www.instagram.com/crud5th_toto_/'];

async function withRenderedProfile(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-details-test-'));
  try {
    await cp(profileRoot, directory, { recursive: true });
    const beforeReadme = await readFile(path.join(directory, 'README.md'), 'utf8');
    const upperImages = await Promise.all(['dark', 'light'].map((theme) => readFile(path.join(directory, `assets/profile-${theme}.svg`), 'utf8')));
    await runFile('npm', ['run', 'render'], { cwd: directory });
    await run(directory, beforeReadme, upperImages);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('render CLI produces all 30 themed SVGs and keeps the complete readable profile contract', async () => {
  await withRenderedProfile(async (directory) => {
    const names = (await readdir(path.join(directory, 'assets'))).sort();
    assert.equal(names.length, 30, 'the legacy renderer replaces assets, so both generators must run');
    assert.equal(names.filter((name) => /^profile-link-[a-z-]+-(dark|light)\.svg$/.test(name)).length, 26);
    for (const name of names) {
      const svg = await readFile(path.join(directory, 'assets', name), 'utf8');
      assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
      assert.match(svg, /prefers-reduced-motion: reduce/);
      assert.match(svg, /animation: none !important/);
      assert.match(svg, /@keyframes rail-flow/);
      assert.doesNotMatch(svg, /filter|feGaussianBlur|feDropShadow|text-shadow|box-shadow|glow|halo/i);
      assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|<iframe\b|<a\b|\son[a-z]+\s*=|@import|@font-face/i);
      assert.doesNotMatch(svg, /(?:href|src)\s*=|url\(\s*["']?(?:https?:|data:|\/\/)/i);
      assert.doesNotMatch(svg, /<rect[^>]+fill="(?!none)/);
      assert.match(svg, /aria-labelledby="[^"]+"/);
    }
    for (const theme of ['dark', 'light']) {
      const svg = await readFile(path.join(directory, `assets/profile-details-${theme}.svg`), 'utf8');
      for (const term of [...originalTerms, 'Elixir', 'Ada', 'Zig']) assert.ok(svg.includes(`>${term}</text>`), `missing ${term}`);
      assert.equal((svg.match(/data-featured=/g) ?? []).length, 6);
      for (const section of ['tech-stack', 'about', 'connect']) assert.ok(svg.includes(`data-section="${section}"`));
      assert.match(svg, /Web interfaces\./);
      assert.match(svg, /Low-level systems\./);
      assert.match(svg, /low-level OS development/);
      const about = svg.match(/<g data-section="about">([\s\S]*?)<g data-section="connect">/)?.[1];
      assert.ok(about, 'missing About Me');
      assert.doesNotMatch(about, /halo|decorative|<filter|class="(?:notch|rail)|animation/);
      for (const y of [530, 793]) assert.match(svg, new RegExp(`<path d="M32 ${y} H768" class="frame"/>`));
      assert.doesNotMatch(svg, /section-rail-glow-|M32 (?:524|787) V|M32 (?:530|793) H768" pathLength/);
      for (const label of ['TECH STACK', 'ABOUT ME', 'CONNECT']) {
        assert.doesNotMatch(svg, new RegExp(`<g class="halo[^>]*>[^<]*(?:<text[^>]*>[^<]*</text>)*<text[^>]*>${label}</text>`));
      }
      assert.doesNotMatch(svg, /aspiring|rather than|expanding into|Noarium|test|generator/i);
    }
  });
});

test('repeated render keeps upper bytes, README prefix and every exact clickable destination', async () => {
  await withRenderedProfile(async (directory, beforeReadme, upperImages) => {
    const readmePath = path.join(directory, 'README.md');
    const readme = await readFile(readmePath, 'utf8');
    assert.equal(readme.split('<!-- PROFILE DETAILS START -->')[0], beforeReadme.split(/<!-- PROFILE DETAILS START -->|## Tech Stack/)[0]);
    assert.deepEqual([...readme.matchAll(/<a href="([^"]+)">/g)].map((match) => match[1]), originalHrefs);
    assert.equal((readme.match(/width="390"/g) ?? []).length, 13);
    assert.equal((readme.match(/<picture>/g) ?? []).length, 15);
    for (const href of originalHrefs) assert.ok(readme.includes(`<a href="${href}">`));
    for (const [index, theme] of ['dark', 'light'].entries()) assert.equal(await readFile(path.join(directory, `assets/profile-${theme}.svg`), 'utf8'), upperImages[index]);
    const names = (await readdir(path.join(directory, 'assets'))).sort();
    const firstImages = await Promise.all(names.map((name) => readFile(path.join(directory, 'assets', name), 'utf8')));
    await runFile('npm', ['run', 'render'], { cwd: directory });
    assert.equal(await readFile(readmePath, 'utf8'), readme);
    assert.deepEqual((await readdir(path.join(directory, 'assets'))).sort(), names);
    assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(directory, 'assets', name), 'utf8'))), firstImages);
  });
});
