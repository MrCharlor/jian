import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const web = `${root}/apps/gateway-ui/public/brand`;
const wing =
  'M8 68C28 64 45 51 60 27c2 14-2 27-11 37 13-5 26-16 37-33-2 25-15 42-38 50-16 5-30 1-40-13Z';
const body = 'M54 71c11-2 21-8 29-17l10-1-9 7c-7 14-21 24-41 25-8 0-16-2-22-5 13 1 24-2 33-9Z';
const bird = `<path d="${wing}"/><path d="${body}"/>`;
const svg = (content, width, height = width) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`;

await mkdir(web, { recursive: true });
await writeFile(
  `${web}/jian.svg`,
  svg(
    `<title>Jian</title><rect width="96" height="96" fill="#050505"/><g fill="#f5f5f3">${bird}</g>`,
    96,
  ),
);
await writeFile(
  `${web}/jian-mono.svg`,
  svg(`<title>Jian</title><g fill="currentColor">${bird}</g>`, 96),
);

// Embed the font so README renderers do not depend on the viewer's installed typefaces.
const font = await readFile(
  new URL(
    '../node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2',
    import.meta.url,
  ),
);
const banner = svg(
  `<title>Jian — self-hosted agent gateway</title>
<defs><style>@font-face{font-family:Plex;src:url(data:font/woff2;base64,${font.toString('base64')})}text{font-family:Plex,Arial,sans-serif}</style></defs>
<rect width="1440" height="480" fill="#050505"/>
<path d="M0 124h1440M0 402h1440M930 124v278" stroke="#292929"/>
<g transform="translate(96 56) scale(.64)" fill="#f5f5f3">${bird}</g>
<text x="168" y="111" font-size="50" font-weight="600" fill="#f5f5f3">Jian</text>
<text x="96" y="260" font-size="64" font-weight="600" fill="#f5f5f3">One gateway.</text>
<text x="96" y="336" font-size="64" font-weight="600" fill="#f5f5f3">Every agent in focus.</text>
<g transform="translate(990 140) scale(2.6)" fill="#f5f5f3">${bird}</g>
<text x="96" y="443" font-size="18" fill="#a6a6a3">SELF-HOSTED AGENT GATEWAY</text>`,
  1440,
  480,
);
await writeFile(`${web}/readme-banner.svg`, banner);
// Raster copy is portable across Markdown viewers that restrict SVG embedded fonts.
await sharp(Buffer.from(banner)).png().toFile(`${web}/readme-banner.png`);

// A phone keeps the panel on its home screen with this, drawn edge to edge as iOS expects.
const touchIcon = svg(
  `<rect width="1024" height="1024" fill="#050505"/><g transform="translate(0 0) scale(10.67)" fill="#f5f5f3">${bird}</g>`,
  1024,
);
await sharp(Buffer.from(touchIcon)).resize(180).png().toFile(`${web}/apple-touch-icon.png`);
for (const size of [192, 512]) {
  await sharp(Buffer.from(touchIcon)).resize(size).png().toFile(`${web}/icon-${size}.png`);
}
const maskableIcon = svg(
  `<rect width="1024" height="1024" fill="#050505"/><g transform="translate(128 60) scale(8)" fill="#f5f5f3">${bird}</g>`,
  1024,
);
await sharp(Buffer.from(maskableIcon)).resize(512).png().toFile(`${web}/icon-maskable-512.png`);
console.log('Jian: SVG logos, README banner and app icons generated.');
