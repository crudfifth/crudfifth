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
  if (!profile || profile.schemaVersion !== 3) throw new TypeError('Unsupported profile schema');
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
  if (!activity || activity.kind !== 'public-events' || activity.complete !== false) throw new TypeError('Invalid activity scope');
  requireText(activity.label, 'activity.label');
  requireCount(activity.eventCount, 'activity.eventCount');
  if (!Array.isArray(activity.days) || activity.days.length > 370) throw new TypeError('Invalid activity days');
  if (activity.days.length) {
    requireDate(activity.since, 'activity.since');
    requireDate(activity.until, 'activity.until');
    let previousDate = '';
    let eventCount = 0;
    for (const day of activity.days) {
      requireDate(day.date, 'activity day');
      requireCount(day.count, 'activity count');
      if (day.date <= previousDate || day.date < activity.since || day.date > activity.until) throw new TypeError('Activity days must be ordered within the stated range');
      previousDate = day.date;
      eventCount += day.count;
    }
    if (eventCount !== activity.eventCount) throw new TypeError('Activity counts do not add up');
  } else if (activity.eventCount !== 0 || activity.since !== '' || activity.until !== '') {
    throw new TypeError('Empty activity must have zero events and no date range');
  }
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
    ? { foreground: '#e6edf3', muted: '#9ba7b4', rule: '#303b46', accent: '#ff944d', soft: '#1c2833' }
    : { foreground: '#202831', muted: '#576571', rule: '#cbd2d9', accent: '#a8440b', soft: '#e3e8ed' };
  return `:root{--ink:${palette.foreground};--muted:${palette.muted};--rule:${palette.rule};--accent:${palette.accent};--soft:${palette.soft};color-scheme:${theme}}
svg{font-size:14px}text{font-family:Arial,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;fill:var(--ink)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.muted{fill:var(--muted)}.accent{fill:var(--accent)}
.eyebrow{font-size:11px;letter-spacing:1.1px}.title{font-size:84px;font-weight:900;letter-spacing:-6px}.owner{font-size:13px}
.rule{stroke:var(--rule);stroke-width:1}.metric{font-size:40px;font-weight:700;letter-spacing:-1.5px}.metric-label{font-size:12px}
.activity-line{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:0}
.point{fill:var(--accent)}.track{fill:var(--soft)}.bar{fill:var(--accent);transform-box:fill-box;transform-origin:left center}
.intro-type{animation:typewriter 10s steps(52,end) infinite}.stat-reveal,.stack-reveal{animation:stagger-reveal 10s ease-out infinite;animation-delay:var(--delay,0s)}
.activity-line{animation:line-draw 10s ease-in-out infinite}.point{animation:point-pulse 10s ease-out infinite;transform-box:fill-box;transform-origin:center;animation-delay:var(--delay,0s)}
.bar{animation:bar-reveal 10s cubic-bezier(.22,.61,.36,1) infinite;animation-delay:var(--delay,0s)}
@keyframes typewriter{0%{clip-path:inset(0 100% 0 0)}16%,97%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(0 0 0 0)}}
@keyframes stagger-reveal{0%{opacity:.12;transform:translateY(5px)}12%,100%{opacity:1;transform:translateY(0)}}
@keyframes line-draw{0%{stroke-dashoffset:1;opacity:.3}22%,100%{stroke-dashoffset:0;opacity:1}}
@keyframes point-pulse{0%,18%{opacity:.45;transform:scale(.6)}24%{opacity:1;transform:scale(1.8)}32%,100%{opacity:1;transform:scale(1)}}
@keyframes bar-reveal{0%{transform:scaleX(0)}20%,100%{transform:scaleX(1)}}
@media(prefers-reduced-motion: reduce){*,*::before,*::after{animation: none !important;opacity: 1 !important;transform:none !important;clip-path: none !important;stroke-dashoffset: 0 !important}}
`;
}

function renderIntro(profile) {
  const bioLines = wrapText(profile.profile.bio || '自己紹介は未登録です', 734, 15, 2);
  const projectNames = profile.projects.map((project) => project.name).join(' / ');
  return `<g data-section="intro">
${textNode(32, 27, 'INDEPENDENT ENGINEER / PUBLIC PROFILE', 'mono eyebrow muted')}
${textNode(768, 27, `@${truncateText(profile.owner, 160, 11, true)}`, 'mono eyebrow accent', 'text-anchor="end"')}
${textNode(28, 111, 'CRUD5th', 'title')}
${textNode(34, 137, truncateText(profile.profile.name, 700, 13), 'owner muted')}
<g class="intro-type">${bioLines.map((line, index) => textNode(34, 166 + index * 22, line)).join('')}</g>
${textNode(34, 214, projectNames ? `RECENT REPOS  ${truncateText(projectNames, 594, 11, true)}` : 'RECENT REPOS  取得したrepoなし', 'mono eyebrow muted')}
</g>`;
}

function renderStats(profile) {
  const metrics = [
    ['公開repo', profile.repositories.publicCount], ['公開・非fork repo', profile.repositories.originalCount],
    ['公開repoのstars', profile.repositories.stars], ['個人フォロワー', profile.profile.followers],
  ];
  return `<g data-section="stats">${sectionLabel('01', 'GITHUB SNAPSHOT', 253, 'crudfifth + CRUD5thOfficial')}
${metrics.map(([label, count], index) => `<g class="stat-reveal" style="--delay:${index * 0.12}s">${textNode(34 + index * 186, 309, numberFormat.format(count), 'mono metric')}${textNode(36 + index * 186, 332, label, 'metric-label muted')}</g>`).join('')}
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
    y: baseline - day.count / maxCount * (baseline - graphTop), count: day.count,
  }));
  const pathData = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const chart = activity.eventCount > 0
    ? `<path class="activity-line" pathLength="1" d="${pathData}"/>
${points.filter((point) => point.count > 0).map((point, index) => `<circle class="point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" style="--delay:${index * 0.1}s"/>`).join('')}`
    : textNode(35, 421, '取得できた公開イベントなし', 'muted');
  const range = activity.days.length ? `${activity.since} — ${activity.until}` : '取得期間なし';
  return `<g data-section="activity">${sectionLabel('02', 'PUBLIC ACTIVITY', 372, `${activity.eventCount} events`)}
<path d="M35 458 H765" class="rule"/>
${chart}
${textNode(35, 481, range, 'mono muted', 'font-size="11"')}
${textNode(765, 481, '個人＋組織の公開イベント・取得分', 'muted', 'text-anchor="end" font-size="11"')}
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
<rect class="bar" x="${x}" y="${baseline + 8}" width="${(345 * fraction).toFixed(2)}" height="4" style="--delay:${index * 0.06}s"/>`;
  }).join('');
  const empty = profile.languages.length ? '' : textNode(35, y + 65, '取得できた言語コード量なし', 'muted');
  const visibility = profile.languageScope.visibility === 'public-and-private' ? '公開＋非公開' : '公開';
  return `<g data-section="languages">${sectionLabel('03', 'LANGUAGES', y)}
${textNode(35, y + 26, `言語別コード量 · 個人＋組織・${visibility}・非fork`, 'muted', 'font-size="12"')}
${textNode(765, y + 26, `${numberFormat.format(totalBytes)} bytes`, 'mono muted', 'font-size="12" text-anchor="end"')}
${rows}${empty}
</g>`;
}

function renderStack(y) {
  let x = 35;
  return `<g data-section="stack">${sectionLabel('04', 'TECH STACK', y)}
${stackNames.map((name, index) => {
    const element = `<g class="stack-reveal" style="--delay:${index * 0.1}s">${textNode(x, y + 38, name, 'mono', 'font-size="16"')}${index < stackNames.length - 1 ? textNode(x + textWidth(name, 16, true) + 14, y + 38, '/', 'mono accent') : ''}</g>`;
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
  const description = `${profile.profile.bio}. ${profile.projects.map((project) => `${project.name}: ${project.description}`).join('; ')}. crudfifth + CRUD5thOfficial。repo統計と活動は公開データ。言語は個人＋組織の${profile.languageScope.visibility === 'public-and-private' ? '公開＋非公開' : '公開'}・非fork repoのdefault branchをGitHubが判定したコードbytes割合。活動は個人＋組織の公開イベント取得分。フォロワーは個人の値。`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}" role="img" aria-labelledby="profile-title profile-description">
<title id="profile-title">${xmlEscape(`CRUD5th — ${profile.profile.name}`)}</title>
<desc id="profile-description">${xmlEscape(description)}</desc>
<style>${motionStyles(theme)}</style>
${renderIntro(profile)}
<path d="M32 232 H768 M32 350 H768 M32 519 H768 M32 ${stackY - 25} H768" class="rule"/>
${renderStats(profile)}${renderActivity(profile)}${renderLanguages(profile, languageY)}${renderStack(stackY)}
${textNode(765, height - 16, `UPDATED ${new Date(profile.generatedAt).toISOString().slice(0, 10)} UTC`, 'mono eyebrow muted', 'text-anchor="end"')}
</svg>\n`;
}

export async function generateProfileAssets({ inputPath = path.join(profileRoot, 'data/profile.json'), outputDir = profileRoot } = {}) {
  const profile = JSON.parse(await readFile(inputPath, 'utf8'));
  const images = ['dark', 'light'].map((theme) => ({ name: `profile-${theme}.svg`, svg: renderProfileSvg(profile, { theme }) }));
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(outputDir, '.profile-assets-'));
  const assetsDir = path.join(outputDir, 'assets');
  const backupDir = `${stagingDir}.previous`;
  let hasBackup = false;
  try {
    for (const image of images) await writeFile(path.join(stagingDir, image.name), image.svg, { flag: 'wx' });
    try {
      if (!(await stat(assetsDir)).isDirectory()) throw new Error('assets destination must be a directory');
      await rename(assetsDir, backupDir);
      hasBackup = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stagingDir, assetsDir); }
    catch (error) {
      if (hasBackup) await rename(backupDir, assetsDir);
      throw error;
    }
  } finally { await rm(stagingDir, { recursive: true, force: true }); }
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
