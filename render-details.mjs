import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileIcons } from './profile-icons.mjs';

const profileRoot = path.dirname(fileURLToPath(import.meta.url));
const detailsStart = '<!-- PROFILE DETAILS START -->';
const detailsEnd = '<!-- PROFILE DETAILS END -->';
const assetBaseUrl = 'https://raw.githubusercontent.com/crudfifth/crudfifth/main/assets/';
const featuredTechnologies = ['Elixir', 'Ada', 'Zig', 'Rust', 'TypeScript', 'Python'];
const stackGroups = [
  { label: 'WEB / INTERFACES', lines: [['HTML', 'CSS', 'JavaScript', 'Vue.js'], ['React', 'Svelte', 'Three.js', 'Storybook']] },
  { label: 'SERVER / FRAMEWORKS', lines: [['Node.js', 'PHP', 'Laravel', 'Java', 'Spring'], ['Ruby', 'Ruby on Rails', 'Django']] },
  { label: 'SYSTEMS / TOOLS', lines: [['MySQL', 'PostgreSQL', 'Linux', 'Tor Browser'], ['SonarQube', 'Unity', 'Blender', 'SOLID']] },
];
const socialLinks = [
  { slug: 'x', name: 'X', label: '@CRUD5th', href: 'https://x.com/CRUD5th' },
  { slug: 'portal', name: 'Portal Site', label: 'totomediasite.com', href: 'https://totomediasite.com/' },
  { slug: 'zenn', name: 'Zenn', label: 'zenn.dev/crudfifth', href: 'https://zenn.dev/crudfifth' },
  { slug: 'facebook', name: 'Facebook', label: 'facebook.com', href: 'https://www.facebook.com/profile.php?id=61554965062342' },
  { slug: 'qiita', name: 'Qiita', label: 'qiita.com/CRUD5th', href: 'https://qiita.com/CRUD5th' },
  { slug: 'blood-raven', name: 'Blood Raven', label: 'blood-raven.com', href: 'https://blood-raven.com/' },
  { slug: 'synvrea', name: 'SynVRea', label: 'synvrea.com', href: 'https://synvrea.com/' },
  { slug: 'official', name: 'CRUD5th Official', label: 'crudfifth.com', href: 'https://crudfifth.com/' },
  { slug: 'wantedly', name: 'Wantedly', label: 'wantedly.com/id/CRUD5th', href: 'https://www.wantedly.com/id/CRUD5th' },
  { slug: 'lancers', name: 'Lancers', label: 'lancers.jp/profile/crudfifth', href: 'https://www.lancers.jp/profile/crudfifth' },
  { slug: 'crowdworks', name: 'Crowdworks', label: 'crowdworks.jp', href: 'https://crowdworks.jp/public/employees/5793463' },
  { slug: 'codepen', name: 'CodePen', label: 'codepen.io/CRUD5th', href: 'https://codepen.io/CRUD5th' },
  { slug: 'instagram', name: 'Instagram', label: '@crud5th_toto_', href: 'https://www.instagram.com/crud5th_toto_/' },
];

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function textNode(x, y, value, className = '', attributes = '') {
  return `<text x="${x}" y="${y}" class="${className}" ${attributes}>${xmlEscape(value)}</text>`;
}

function renderIcon(key, x, y, size) {
  const icon = profileIcons[key];
  return `<g class="profile-icon${icon.stroke ? ' line-icon' : ''}" transform="translate(${x} ${y}) scale(${size / 24})" aria-hidden="true">${icon.paths.map((d) => `<path d="${d}"/>`).join('')}</g>`;
}

function motionStyles(theme) {
  if (!['dark', 'light'].includes(theme)) throw new TypeError('Theme must be dark or light');
  const palette = theme === 'dark'
    ? { ink: '#e6edf3', muted: '#a7b7c7', rule: '#28414f', accent: '#36f4ef', secondary: '#ff4cce' }
    : { ink: '#152537', muted: '#485e73', rule: '#b9ccd8', accent: '#006b79', secondary: '#a61c78' };
  return `:root{--ink:${palette.ink};--muted:${palette.muted};--rule:${palette.rule};--accent:${palette.accent};--secondary:${palette.secondary};color-scheme:${theme}}
text{font-family:Arial,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;fill:var(--ink)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.muted{fill:var(--muted)}.accent{fill:var(--accent)}
.eyebrow{font-size:15px;letter-spacing:1.1px}.heading{font-size:42px;font-weight:700;letter-spacing:-1.5px}.about-heading{font-size:35px;font-weight:700;letter-spacing:-1px}
.frame{fill:none;stroke:var(--rule);stroke-width:1}.notch{fill:none;stroke:var(--secondary);stroke-width:1.5}.rail{fill:none;stroke:var(--accent);stroke-width:1.5;stroke-dasharray:.12 .88;animation:rail-flow 4.8s linear infinite;animation-delay:var(--delay,0s)}
.secondary{stroke:var(--secondary);stroke-dasharray:.04 .96;animation-duration:6.4s;animation-direction:reverse}
.halo{--halo-low:.14;--halo-peak:.7;filter:url(#halo-blur);opacity:.3;animation:halo-pulse 4.2s ease-in-out infinite;animation-delay:var(--delay,0s)}
.halo.soft{--halo-low:.08;--halo-peak:.28}
.halo text{fill:var(--accent);stroke:var(--accent);stroke-width:.4}.halo path{stroke:var(--accent);stroke-width:3;fill:none}
.technology{font-size:30px;font-weight:600;letter-spacing:-1px}.stack-term{font-size:22px}.stack-divider{fill:var(--secondary);font-size:18px}.group-label{font-size:13px;letter-spacing:.8px}.body{font-size:22px}.process{font-size:18px}
.card-name{font-size:24px;font-weight:600;letter-spacing:-.4px}.card-label{font-size:14px}.card-index{font-size:11px;letter-spacing:1px}
.profile-icon{fill:var(--accent)}.line-icon{fill:none;stroke:var(--accent);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.icon-well{fill:none;stroke:var(--rule);stroke-width:1}
@keyframes rail-flow{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes halo-pulse{0%,100%{opacity:var(--halo-low)}50%{opacity:var(--halo-peak)}}
@media(prefers-reduced-motion: reduce){*,*::before,*::after{animation: none !important}.decorative{display:none !important}}
`;
}

function glow(content, phase = 0, strength = '') {
  return `<g class="halo decorative ${strength}" style="--delay:-${phase}s" aria-hidden="true">${content}</g>${content}`;
}

function svgDocument(width, height, title, description, theme, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="details-title details-description">
<title id="details-title">${xmlEscape(title)}</title>
<desc id="details-description">${xmlEscape(description)}</desc>
<style>${motionStyles(theme)}</style>
<defs><filter id="halo-blur" x="-15%" y="-50%" width="130%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter></defs>
${content}
</svg>\n`;
}

function sectionLabel(number, label, y, trailing = '') {
  return glow(`${textNode(32, y, number, 'mono eyebrow accent')}${textNode(69, y, label, 'mono eyebrow muted')}${trailing ? textNode(768, y, trailing, 'mono group-label muted', 'text-anchor="end"') : ''}`, Number(number) * .6);
}

function sectionRail(y, phase) {
  const line = `<path d="M32 ${y} H768" class="frame"/>`;
  const filterId = `section-rail-glow-${y}`;
  const halo = `<defs><filter id="${filterId}" filterUnits="userSpaceOnUse" x="20" y="${y - 12}" width="760" height="24" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter></defs><g class="halo decorative" style="--delay:-${phase}s;filter:url(#${filterId})" aria-hidden="true">${line}</g>`;
  return `${halo}${line}<g class="decorative" aria-hidden="true" style="--delay:-${phase}s"><path d="M32 ${y - 6} V${y} H50 M750 ${y} H768 V${y + 6}" class="notch"/><path d="M32 ${y} H768" pathLength="1" class="rail"/><path d="M32 ${y} H768" pathLength="1" class="rail secondary"/></g>`;
}

function renderTechnologyTiles() {
  return featuredTechnologies.map((name, index) => {
    const x = 32 + index % 3 * 250;
    const y = 112 + Math.floor(index / 3) * 94;
    const outline = `M${x} ${y + 12} L${x + 12} ${y} H${x + 236} V${y + 66} L${x + 224} ${y + 78} H${x} Z`;
    const label = textNode(x + 62, y + 48, name, 'mono technology', name === 'TypeScript' ? 'style="font-size:27px"' : '');
    return `<g data-featured="${name}">${glow(`<path d="${outline}" class="frame"/>${label}`, index * .67)}
${renderIcon(name.toLowerCase(), x + 18, y + 24, 30)}
<path d="M${x + 1} ${y + 23} V${y + 12} L${x + 12} ${y + 1} H${x + 25}" class="notch"/>
<path d="${outline}" pathLength="1" class="rail decorative" style="--delay:-${index * .67}s" aria-hidden="true"/>
</g>`;
  }).join('\n');
}

function renderStackGroups() {
  return stackGroups.map((group, index) => {
    const y = 329 + index * 72;
    return `${glow(textNode(32, y, group.label, 'mono group-label muted'), index * .7, 'soft')}${group.lines.map((terms, row) => {
      let x = 220;
      const line = terms.map((term, termIndex) => {
        const node = textNode(x, y + row * 30, term, 'mono stack-term');
        x += [...term].length * 13.3 + 34;
        return `${node}${termIndex < terms.length - 1 ? textNode(x - 24, y + row * 30, '/', 'mono stack-divider') : ''}`;
      }).join('');
      return glow(line, index * .7 + row * .43, 'soft');
    }).join('')}`;
  }).join('\n');
}

export function renderDetailsSvg({ theme = 'dark' } = {}) {
  const content = `<g data-section="tech-stack">
${sectionLabel('05', 'TECH STACK', 34, 'LANGUAGES / FRAMEWORKS / TOOLS')}
${glow(textNode(32, 84, 'Across the stack.', 'heading'), .2)}
${renderTechnologyTiles()}
${renderStackGroups()}
${sectionRail(530, 1.6)}
</g>
<g data-section="about">
${sectionLabel('06', 'ABOUT ME', 565, 'TSUNAMI / CRUD5th')}
${glow(textNode(32, 616, 'Web interfaces.', 'about-heading') + textNode(301, 616, 'Low-level systems.', 'about-heading'), 2.2)}
${glow(textNode(32, 657, "I'm Tsunami, building as CRUD5th.", 'body'), 2.3, 'soft')}
${glow(textNode(32, 692, 'I work across full-stack web development, AI & LLMs,', 'body'), 2.9, 'soft')}
${glow(textNode(32, 723, 'and low-level OS development.', 'body'), 3.5, 'soft')}
${['Design', 'Build', 'Release', 'Operate'].map((label, index) => `${glow(textNode(32 + index * 190, 773, label, 'mono process'), index * .7)}${index < 3 ? textNode(174 + index * 190, 773, '→', 'mono process accent') : ''}`).join('')}
${sectionRail(793, 3.2)}
</g>
<g data-section="connect">${sectionLabel('07', 'CONNECT', 833, 'FIND ME ACROSS THE WEB')}</g>`;
  return svgDocument(800, 856, 'Tsunami / CRUD5th — Tech Stack, About Me and Connect', 'Elixir, Ada, Zig, Rust, TypeScript and Python at the core. Web interfaces, server frameworks, systems and tools. Tsunami builds as CRUD5th across full-stack web development, AI & LLMs, and low-level OS development. Design, Build, Release, Operate. Social links follow below.', theme, content);
}

export function renderLinkCardSvg(slug, { theme = 'dark' } = {}) {
  const index = socialLinks.findIndex((link) => link.slug === slug);
  if (index < 0) throw new TypeError('Unknown social link');
  const link = socialLinks[index];
  const outline = 'M12 6 H384 V86 L372 98 H6 V12 Z';
  const name = textNode(88, 45, link.name, 'card-name');
  const content = `${glow(`<path d="${outline}" class="frame"/>${name}`, index * .43)}
<rect x="24" y="28" width="48" height="48" rx="11" class="icon-well"/>
${renderIcon(profileIcons[slug] ? slug : 'web', 32, 36, 32)}
${textNode(88, 72, link.label, 'mono muted card-label')}
${textNode(363, 26, String(index + 1).padStart(2, '0'), 'mono muted card-index', 'text-anchor="end"')}
<path d="M344 62 H362 V44 M344 62 L362 44" class="notch"/>
<path d="M7 28 V13 L13 7 H32 M359 97 H371 L383 85 V73" class="notch"/>
<path d="${outline}" pathLength="1" class="rail decorative" style="--delay:-${index * .43}s" aria-hidden="true"/>
<path d="${outline}" pathLength="1" class="rail secondary decorative" style="--delay:-${index * .43}s" aria-hidden="true"/>`;
  return svgDocument(390, 104, `${link.name} — ${link.label}`, `Open ${link.name}: ${link.label}.`, theme, content);
}

function pictureMarkup(stem, alt, width, images) {
  const imageUrl = (theme) => {
    const name = `${stem}-${theme}.svg`;
    const digest = createHash('sha256').update(images.get(name)).digest('hex').slice(0, 12);
    return `${assetBaseUrl}${name}?v=${digest}`;
  };
  return `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${imageUrl('dark')}">\n  <source media="(prefers-color-scheme: light)" srcset="${imageUrl('light')}">\n  <img src="${imageUrl('light')}" width="${width}" alt="${xmlEscape(alt)}">\n</picture>`;
}

export function buildReadmeDetails(images) {
  return `${detailsStart}\n${pictureMarkup('profile-details', 'Tech Stack: Elixir, Ada, Zig, Rust, TypeScript, Python and a broad web, server and systems toolkit. About Tsunami / CRUD5th: full-stack web, AI & LLMs and low-level OS development. Design → Build → Release → Operate. Connect below.', 800, images)}\n\n${socialLinks.map((link) => `<a href="${link.href}">\n${pictureMarkup(`profile-link-${link.slug}`, `${link.name}: ${link.label}`, 390, images)}\n</a>`).join('\n')}\n${detailsEnd}\n`;
}

export async function generateDetailsAssets({ outputDir = profileRoot } = {}) {
  const images = new Map();
  for (const theme of ['dark', 'light']) {
    images.set(`profile-details-${theme}.svg`, renderDetailsSvg({ theme }));
    for (const link of socialLinks) images.set(`profile-link-${link.slug}-${theme}.svg`, renderLinkCardSvg(link.slug, { theme }));
  }
  const readmePath = path.join(outputDir, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  const start = readme.indexOf(detailsStart);
  const end = readme.indexOf(detailsEnd);
  const legacyStart = readme.indexOf('## Tech Stack');
  if (start < 0 && legacyStart < 0 || start >= 0 && (end < start || readme.indexOf(detailsStart, start + detailsStart.length) >= 0)) {
    throw new Error('README must contain one complete details region or the original Tech Stack section');
  }
  const updatedReadme = start >= 0
    ? `${readme.slice(0, start)}${buildReadmeDetails(images)}${readme.slice(end + detailsEnd.length).replace(/^\n/, '')}`
    : `${readme.slice(0, legacyStart)}${buildReadmeDetails(images)}`;
  const assetsDir = path.join(outputDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  for (const [name, svg] of images) await writeFile(path.join(assetsDir, name), svg);
  await writeFile(readmePath, updatedReadme);
  return images;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateDetailsAssets();
}
