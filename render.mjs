import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const profileRoot = path.dirname(fileURLToPath(import.meta.url));
const stackNames = ['Elixir', 'Ada', 'Zig', 'Rust', 'TypeScript', 'Python'];
const numberFormat = new Intl.NumberFormat('en-US');

function requireText(value, label) {
  if (typeof value !== 'string' || value.length > 5000 || !value.isWellFormed()
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value)) {
    throw new TypeError(`${label} must be valid XML text (up to 5000 characters)`);
  }
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}

function requireDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(value).toISOString().slice(0, 10) !== value) throw new TypeError(`${label} must be a valid date`);
}

export function validateProfile(profile) {
  if (!profile || profile.schemaVersion !== 4) throw new TypeError('Unsupported profile schema');
  requireText(profile.owner, 'owner');
  if (profile.owner !== 'crudfifth' || !Array.isArray(profile.sources) || profile.sources.length !== 2
    || profile.sources[0]?.login !== 'crudfifth' || profile.sources[0]?.type !== 'User'
    || profile.sources[1]?.login !== 'CRUD5thOfficial' || profile.sources[1]?.type !== 'Organization') {
    throw new TypeError('Invalid profile sources');
  }
  if (!profile.owner || !Number.isFinite(Date.parse(profile.generatedAt))) throw new TypeError('Invalid profile timestamp or owner');
  for (const name of ['name', 'bio', 'url']) requireText(profile.profile?.[name], `profile.${name}`);
  for (const name of ['followers', 'following', 'publicRepos']) requireCount(profile.profile?.[name], `profile.${name}`);
  for (const name of ['publicCount', 'originalCount', 'stars', 'forks']) requireCount(profile.repositories?.[name], `repositories.${name}`);
  if (profile.repositories.originalCount > profile.repositories.publicCount) throw new TypeError('Original count exceeds public count');
  if (profile.profile.publicRepos > profile.repositories.publicCount) throw new TypeError('Personal repository count exceeds combined public count');
  if (!Array.isArray(profile.languages)) throw new TypeError('Invalid languages');
  const languageNames = new Set();
  let totalBytes = 0;
  for (const language of profile.languages) {
    requireText(language.name, 'language.name');
    requireCount(language.bytes, 'language.bytes');
    if (!language.name || !language.bytes || languageNames.has(language.name)) throw new TypeError('Invalid or repeated language');
    languageNames.add(language.name);
    totalBytes += language.bytes;
  }
  if (!Number.isSafeInteger(totalBytes) || profile.languageScope?.kind !== 'github-language-bytes'
    || !['public', 'public-and-private'].includes(profile.languageScope.visibility)
    || totalBytes !== profile.languageScope.totalBytes) throw new TypeError('Invalid language byte scope or total');
  const activity = profile.activity;
  if (!activity || activity.kind !== 'github-contributions' || activity.subject !== profile.owner
    || activity.visibility !== 'public-and-private' || activity.complete !== true
    || activity.label !== 'コミット・PR等・公開＋非公開') throw new TypeError('Invalid activity scope');
  requireCount(activity.totalCount, 'activity.totalCount');
  requireDate(activity.since, 'activity.since');
  requireDate(activity.until, 'activity.until');
  const end = new Date(profile.generatedAt);
  const expectedStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - 364);
  if (activity.since !== new Date(expectedStart).toISOString().slice(0, 10)
    || activity.until !== end.toISOString().slice(0, 10)
    || !Array.isArray(activity.days) || activity.days.length !== 365) throw new TypeError('Invalid activity date range');
  let totalCount = 0;
  for (const [index, day] of activity.days.entries()) {
    requireCount(day.count, 'activity count');
    if (day.date !== new Date(expectedStart + index * 86_400_000).toISOString().slice(0, 10)) throw new TypeError('Activity days must cover every requested date exactly once in order');
    totalCount += day.count;
  }
  if (!Number.isSafeInteger(totalCount) || totalCount !== activity.totalCount) throw new TypeError('Activity counts do not add up');
  if (!Array.isArray(profile.projects) || profile.projects.length > 100) throw new TypeError('Invalid projects');
  for (const project of profile.projects) {
    for (const name of ['name', 'description', 'url', 'language']) requireText(project[name], `project.${name}`);
    requireCount(project.stars, 'project.stars');
  }
  return profile;
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function textWidth(value, fontSize = 14, isMono = false) {
  return [...value].reduce((width, character) => width + (/[^\u0000-\u00ff]/u.test(character) ? 1 : isMono ? 0.62 : 0.55) * fontSize, 0);
}

function truncateText(value, maxWidth, fontSize = 14, isMono = false) {
  if (textWidth(value, fontSize, isMono) <= maxWidth) return value;
  let text = '';
  for (const character of value) {
    if (textWidth(`${text}${character}…`, fontSize, isMono) > maxWidth) break;
    text += character;
  }
  return `${text.trimEnd()}…`;
}

function wrapText(value, maxWidth, fontSize, maxLines) {
  const words = value.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, fontSize) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    line = word;
    while (textWidth(line, fontSize) > maxWidth) {
      let segment = '';
      for (const character of line) {
        if (textWidth(segment + character, fontSize) > maxWidth) break;
        segment += character;
      }
      lines.push(segment);
      line = line.slice(segment.length);
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const lastLine = lines.slice(maxLines - 1).join(' ');
    return [...lines.slice(0, maxLines - 1), truncateText(lastLine, maxWidth, fontSize)];
  }
  return lines;
}

function textNode(x, y, value, className = '', attributes = '') {
  return `<text x="${x}" y="${y}" class="${className}" ${attributes}>${xmlEscape(value)}</text>`;
}

function sectionLabel(index, label, y, trailing = '') {
  return `${textNode(32, y, index, 'mono accent eyebrow')}${textNode(67, y, label, 'mono eyebrow muted')}${trailing ? textNode(768, y, trailing, 'mono eyebrow muted', 'text-anchor="end"') : ''}`;
}

function motionStyles(theme) {
  const palette = theme === 'dark'
    ? { foreground: '#e6edf3', muted: '#9ba7b4', rule: '#263b48', accent: '#36f4ef', secondary: '#ff4cce', soft: '#19303b' }
    : { foreground: '#152537', muted: '#526477', rule: '#c3d5df', accent: '#006b79', secondary: '#a61c78', soft: '#e0eaf0' };
  return `:root{--ink:${palette.foreground};--muted:${palette.muted};--rule:${palette.rule};--accent:${palette.accent};--secondary:${palette.secondary};--soft:${palette.soft};color-scheme:${theme}}
svg{font-size:14px}text{font-family:Arial,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;fill:var(--ink)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.muted{fill:var(--muted)}.accent{fill:var(--accent)}
.eyebrow{font-size:11px;letter-spacing:1.1px}.title{font-size:84px;font-weight:900;letter-spacing:-6px}.owner{font-size:13px}
.rule{fill:none;stroke:var(--rule);stroke-width:1}.metric{font-size:40px;font-weight:700;letter-spacing:-1.5px}.metric-label{font-size:12px}
.activity-line{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:0}
.point{fill:var(--accent)}.track{fill:var(--soft)}.bar{fill:var(--accent)}
.circuit-notch{fill:none;stroke:var(--secondary);stroke-width:1;opacity:.6}
.section-rail{fill:none;stroke:var(--accent);stroke-width:1.5;stroke-dasharray:.12 .88;animation:rail-flow 4.8s linear infinite;animation-delay:var(--delay,0s)}
.section-rail.secondary{stroke:var(--secondary);stroke-width:1;stroke-dasharray:.04 .96;animation-duration:6.4s;animation-direction:reverse;opacity:.72}
.title-ghost{fill:var(--accent);opacity:.34;animation:chromatic-shift 3.8s ease-in-out infinite alternate;clip-path:inset(24% 0 52% 0)}
.title-ghost.secondary{fill:var(--secondary);animation-delay:-1.9s;animation-direction:alternate-reverse;clip-path:inset(67% 0 13% 0)}
.title-scan{fill:none;stroke:var(--accent);stroke-width:1;stroke-dasharray:28 55 2 16;animation:title-scan 3.3s linear infinite;opacity:.7}
.metric-circuit{fill:none;stroke:var(--accent);stroke-width:1.4;stroke-dasharray:.1 .9;animation:rail-flow 3.7s linear infinite,neon-pulse 2.8s ease-in-out infinite alternate;animation-delay:var(--delay,0s)}
.metric-glow{filter:url(#metric-glow-blur);animation:metric-glow-pulse 4.2s ease-in-out infinite;animation-delay:var(--delay,0s)}
.metric-glow-frame{fill:none;stroke:var(--accent);stroke-width:3.5}.metric-glow-value{fill:var(--accent)}
.activity-trail{fill:none;stroke:var(--secondary);stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:.035 .965;animation:activity-trail 5.6s linear infinite;opacity:.88}
.bar-glint{fill:none;stroke:var(--secondary);stroke-width:1;stroke-linecap:round;stroke-dasharray:.08 .92;animation:bar-glint 3.6s linear infinite;animation-delay:var(--delay,0s);opacity:.7}
.stack-glint{fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linecap:round;stroke-dasharray:.24 .76;animation:stack-glint 2.7s linear infinite;animation-delay:var(--delay,0s)}
@keyframes rail-flow{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes neon-pulse{from{opacity:.38}to{opacity:1}}
@keyframes metric-glow-pulse{0%,100%{opacity:.22}50%{opacity:.85}}
@keyframes chromatic-shift{0%{transform:translate(-1.4px,0)}50%{transform:translate(.7px,.5px)}100%{transform:translate(1.4px,0)}}
@keyframes title-scan{from{stroke-dashoffset:101}to{stroke-dashoffset:0}}
@keyframes activity-trail{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes bar-glint{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes stack-glint{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@media(prefers-reduced-motion: reduce){*,*::before,*::after{animation: none !important;opacity: 1 !important;transform:none !important;clip-path: none !important;stroke-dashoffset: 0 !important}.decorative{display:none !important}}
`;
}

function sectionRail(y, phase) {
  return `<path d="M32 ${y} H768" class="rule"/>
<g class="decorative" aria-hidden="true" style="--delay:-${phase}s">
<path d="M32 ${y - 5} V${y} H46 M754 ${y} H768 V${y + 5}" class="circuit-notch"/>
<path d="M32 ${y} H768" pathLength="1" class="section-rail"/>
<path d="M32 ${y} H768" pathLength="1" class="section-rail secondary"/>
</g>`;
}

function renderIntro(profile) {
  const bioLines = wrapText(profile.profile.bio || '自己紹介は未登録です', 734, 15, 2);
  const projectNames = profile.projects.map((project) => project.name).join(' / ');
  return `<g data-section="intro">
${textNode(32, 27, 'INDEPENDENT ENGINEER / PUBLIC PROFILE', 'mono eyebrow muted')}
${textNode(768, 27, `@${truncateText(profile.owner, 160, 11, true)}`, 'mono eyebrow accent', 'text-anchor="end"')}
<g class="decorative" aria-hidden="true">${textNode(28, 111, 'CRUD5th', 'title title-ghost')}${textNode(28, 111, 'CRUD5th', 'title title-ghost secondary')}</g>
${textNode(28, 111, 'CRUD5th', 'title')}
<path d="M35 122 H382" class="title-scan decorative" aria-hidden="true"/>
${textNode(34, 137, truncateText(profile.profile.name, 700, 13), 'owner muted')}
<g>${bioLines.map((line, index) => textNode(34, 166 + index * 22, line)).join('')}</g>
${textNode(34, 214, projectNames ? `RECENT REPOS  ${truncateText(projectNames, 594, 11, true)}` : 'RECENT REPOS  取得したrepoなし', 'mono eyebrow muted')}
${sectionRail(232, 0.6)}
</g>`;
}

function renderStats(profile) {
  const metrics = [
    ['公開repo', profile.repositories.publicCount], ['公開・非fork repo', profile.repositories.originalCount],
    ['公開repoのstars', profile.repositories.stars], ['個人フォロワー', profile.profile.followers],
  ];
  return `<g data-section="stats">${sectionLabel('01', 'GITHUB SNAPSHOT', 253, 'crudfifth + CRUD5thOfficial')}
<defs><filter id="metric-glow-blur" x="-25%" y="-50%" width="150%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter></defs>
${metrics.map(([label, count], index) => {
    const x = 34 + index * 186;
    const contentX = x + 12;
    const circuit = `M${x} 281 V265 H${x + 18} M${x + 144} 265 H${x + 161} V281 M${x + 161} 327 V343 H${x + 143} M${x + 18} 343 H${x} V327`;
    return `<g><g class="metric-glow decorative" style="--delay:-${(index * 0.8).toFixed(1)}s" aria-hidden="true"><path d="${circuit}" class="metric-glow-frame"/>${textNode(contentX, 310, numberFormat.format(count), 'mono metric metric-glow-value')}</g>
${textNode(contentX, 310, numberFormat.format(count), 'mono metric')}${textNode(contentX, 333, label, 'metric-label muted')}
<path d="${circuit}" class="rule decorative" aria-hidden="true"/>
<path d="${circuit}" class="metric-circuit decorative" pathLength="1" style="--delay:-${(index * 0.7).toFixed(1)}s" aria-hidden="true"/></g>`;
  }).join('')}
${sectionRail(350, 1.7)}
</g>`;
}

function renderActivity(profile) {
  const activity = profile.activity;
  const baseline = 458;
  const graphTop = 389;
  const graphWidth = 730;
  const maxCount = Math.max(1, ...activity.days.map((day) => day.count));
  const points = activity.days.map((day, index) => ({
    x: 35 + index * graphWidth / Math.max(1, activity.days.length - 1),
    y: baseline - day.count / maxCount * (baseline - graphTop), date: day.date, count: day.count,
  }));
  const pathData = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const chart = `<path class="activity-line" pathLength="1" d="${pathData}"/>
${points.map((point) => `<circle class="point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="1.8"><title>${point.date}: ${point.count} contributions</title></circle>`).join('')}
<path class="activity-trail decorative" pathLength="1" d="${pathData}" aria-hidden="true"/>`;
  const range = `${activity.since} — ${activity.until}`;
  return `<g data-section="activity">${sectionLabel('02', 'GITHUB ACTIVITY', 372, `${numberFormat.format(activity.totalCount)} contributions`)}
<path d="M35 458 H765" class="rule"/>
${chart}
${textNode(35, 481, range, 'mono muted', 'font-size="11"')}
${textNode(765, 481, activity.label, 'muted', 'text-anchor="end" font-size="11"')}
${sectionRail(519, 2.8)}
</g>`;
}

function renderLanguages(profile, y) {
  const totalBytes = profile.languageScope.totalBytes;
  const rows = profile.languages.map((language, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 35 + column * 382;
    const baseline = y + 65 + row * 35;
    const fraction = language.bytes / Math.max(1, totalBytes);
    return `${textNode(x, baseline, language.name, 'mono', 'font-size="12"')}
${textNode(x + 345, baseline, fraction * 100 < 0.1 ? '<0.1%' : `${(fraction * 100).toFixed(1)}%`, 'mono muted', 'text-anchor="end" font-size="12"')}
<rect class="track" x="${x}" y="${baseline + 8}" width="345" height="4"/>
<rect class="bar" x="${x}" y="${baseline + 8}" width="${(345 * fraction).toFixed(2)}" height="4"/>
<path d="M${x} ${baseline + 15} H${x + 345}" class="bar-glint decorative" pathLength="1" style="--delay:-${(index * 0.21).toFixed(2)}s" aria-hidden="true"/>`;
  }).join('');
  const empty = profile.languages.length ? '' : textNode(35, y + 65, '取得できた言語コード量なし', 'muted');
  const visibility = profile.languageScope.visibility === 'public-and-private' ? '公開＋非公開' : '公開';
  return `<g data-section="languages">${sectionLabel('03', 'LANGUAGES', y)}
${textNode(35, y + 26, `言語別コード量 · 個人＋組織・${visibility}・非fork`, 'muted', 'font-size="12"')}
${textNode(765, y + 26, `${numberFormat.format(totalBytes)} bytes`, 'mono muted', 'font-size="12" text-anchor="end"')}
${rows}${empty}
${sectionRail(y + 57 + Math.max(1, Math.ceil(profile.languages.length / 2)) * 35, 3.9)}
</g>`;
}

function renderStack(y) {
  let x = 35;
  return `<g data-section="stack">${sectionLabel('04', 'TECH STACK', y)}
${stackNames.map((name, index) => {
    const element = `<g>${textNode(x, y + 38, name, 'mono', 'font-size="16"')}${index < stackNames.length - 1 ? textNode(x + textWidth(name, 16, true) + 14, y + 38, '/', 'mono accent') : ''}
<path d="M${x} ${y + 47} h${textWidth(name, 16, true).toFixed(2)}" class="rule decorative" aria-hidden="true"/>
<path d="M${x} ${y + 47} h${textWidth(name, 16, true).toFixed(2)}" class="stack-glint decorative" pathLength="1" style="--delay:-${(index * 0.43).toFixed(2)}s" aria-hidden="true"/></g>`;
    x += textWidth(name, 16, true) + 42;
    return element;
  }).join('')}
</g>`;
}

export function renderProfileSvg(input, { theme = 'dark' } = {}) {
  const profile = validateProfile(input);
  if (!['dark', 'light'].includes(theme)) throw new TypeError('Theme must be dark or light');
  const languageY = 544;
  const languageRows = Math.max(1, Math.ceil(profile.languages.length / 2));
  const stackY = languageY + 82 + languageRows * 35;
  const height = stackY + 102;
  const description = `${profile.profile.bio}. ${profile.projects.map((project) => `${project.name}: ${project.description}`).join('; ')}. crudfifth + CRUD5thOfficial。repo統計は公開データ。言語は個人＋組織の${profile.languageScope.visibility === 'public-and-private' ? '公開＋非公開' : '公開'}・非fork repoのdefault branchをGitHubが判定したコードbytes割合。活動はcrudfifth本人の公開＋非公開のコミット・PR等をGitHubが日別集計した直近365日のcontributions。フォロワーは個人の値。`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}" role="img" aria-labelledby="profile-title profile-description">
<title id="profile-title">${xmlEscape(`CRUD5th — ${profile.profile.name}`)}</title>
<desc id="profile-description">${xmlEscape(description)}</desc>
<style>${motionStyles(theme)}</style>
${renderIntro(profile)}
${renderStats(profile)}${renderActivity(profile)}${renderLanguages(profile, languageY)}${renderStack(stackY)}
${textNode(765, height - 16, `UPDATED ${new Date(profile.generatedAt).toISOString().slice(0, 10)} UTC`, 'mono eyebrow muted', 'text-anchor="end"')}
</svg>\n`;
}

export async function generateProfileAssets({ inputPath = path.join(profileRoot, 'data/profile.json'), outputDir = profileRoot } = {}) {
  const profile = JSON.parse(await readFile(inputPath, 'utf8'));
  const images = ['dark', 'light'].map((theme) => ({ name: `profile-${theme}.svg`, svg: renderProfileSvg(profile, { theme }) }));
  const readmePath = path.join(outputDir, 'README.md');
  let updatedReadme;
  try {
    const readme = await readFile(readmePath, 'utf8');
    const imageUrl = /https:\/\/raw\.githubusercontent\.com\/crudfifth\/crudfifth\/main\/assets\/profile-(dark|light)\.svg(?:\?v=[^"\s<>]+)?/g;
    updatedReadme = readme.replace(imageUrl, (_url, theme) => {
      const svg = images.find((image) => image.name === `profile-${theme}.svg`).svg;
      const digest = createHash('sha256').update(svg).digest('hex').slice(0, 12);
      return `https://raw.githubusercontent.com/crudfifth/crudfifth/main/assets/profile-${theme}.svg?v=${digest}`;
    });
    if (updatedReadme === readme) updatedReadme = undefined;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(outputDir, '.profile-assets-'));
  const assetsDir = path.join(outputDir, 'assets');
  const backupDir = `${stagingDir}.previous`;
  const stagedReadme = `${stagingDir}.readme`;
  let hasBackup = false;
  try {
    for (const image of images) await writeFile(path.join(stagingDir, image.name), image.svg, { flag: 'wx' });
    if (updatedReadme !== undefined) await writeFile(stagedReadme, updatedReadme, { flag: 'wx' });
    try {
      if (!(await stat(assetsDir)).isDirectory()) throw new Error('assets destination must be a directory');
      await rename(assetsDir, backupDir);
      hasBackup = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let assetsReplaced = false;
    try {
      await rename(stagingDir, assetsDir);
      assetsReplaced = true;
      if (updatedReadme !== undefined) await rename(stagedReadme, readmePath);
    } catch (error) {
      if (assetsReplaced) await rm(assetsDir, { recursive: true, force: true });
      if (hasBackup) await rename(backupDir, assetsDir);
      throw error;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(stagedReadme, { force: true });
  }
  if (hasBackup) await rm(backupDir, { recursive: true, force: true });
  return images.map((image) => path.join(assetsDir, image.name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const argument = process.argv[index];
      if (!['--input', '--output'].includes(argument) || !process.argv[index + 1]) throw new Error('Usage: node render.mjs [--input profile.json] [--output directory]');
      options[argument === '--input' ? 'inputPath' : 'outputDir'] = path.resolve(process.argv[index + 1]);
    }
    console.log((await generateProfileAssets(options)).join('\n'));
  } catch (error) { console.error(`Profile generation failed: ${error.message}`); process.exitCode = 1; }
}
