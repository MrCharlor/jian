/**
 * Attachments for the example conversations, built in the browser so stories need no files:
 * pictures drawn as SVG, voice notes synthesised as WAV, a real one-page PDF and text files.
 */

const encode = (text: string) => btoa(unescape(encodeURIComponent(text)));

/** A stand-in for a channel photo: a flat portrait, inline, so stories need no network. */
export const portrait = (background: string, skin: string) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><circle cx="32" cy="26" r="12" fill="${skin}"/><rect x="12" y="42" width="40" height="30" rx="20" fill="${skin}"/></svg>`,
  )}`;

/** A picture: a flat scene with a caption, sized like a phone photo or a screenshot. */
function picture(caption: string, background: string, ink: string, wide = false) {
  const [width, height] = wide ? [960, 600] : [720, 900];

  return encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect width="${width}" height="${height}" fill="${background}"/>` +
      `<circle cx="${width * 0.72}" cy="${height * 0.3}" r="${height * 0.14}" fill="${ink}" opacity=".18"/>` +
      `<rect x="${width * 0.08}" y="${height * 0.55}" width="${width * 0.84}" height="${height * 0.22}" rx="24" fill="${ink}" opacity=".12"/>` +
      `<rect x="${width * 0.08}" y="${height * 0.12}" width="${width * 0.42}" height="${height * 0.34}" rx="24" fill="#fff" opacity=".7"/>` +
      `<text x="${width * 0.08}" y="${height * 0.9}" font-family="Helvetica, Arial, sans-serif" font-size="${wide ? 40 : 44}" font-weight="700" fill="${ink}">${caption}</text>` +
      '</svg>',
  );
}

/**
 * A voice note: a tone whose loudness rises and falls in syllables, so the player draws a real
 * waveform. Low sample rate keeps a ten-second note small.
 */
function voice(seconds: number, pitch: number, pace = 2.3) {
  const rate = 6000;
  const samples = Math.round(rate * seconds);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (const [index, char] of [...value].entries())
      view.setUint8(offset + index, char.charCodeAt(0));
  };

  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const time = index / rate;
    const syllables = Math.abs(Math.sin(time * pace) * Math.sin(time * pace * 3.1));
    const tone = Math.sin(time * 2 * Math.PI * pitch) + 0.3 * Math.sin(time * 4 * Math.PI * pitch);

    view.setInt16(44 + index * 2, tone * syllables * 9000, true);
  }

  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A one-page PDF the browser's reader opens, with offsets computed so no repair is needed. */
function pdf(title: string, lines: string[]) {
  const stream = [
    'BT /F1 26 Tf 72 720 Td',
    `(${title}) Tj`,
    '/F1 13 Tf 0 -40 Td 18 TL',
    ...lines.map((line) => `(${line}) '`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;

    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;

  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  return btoa(body);
}

type Asset = { mimeType: string; name?: string; data: string };

/** Every attachment, by the key a conversation refers to it with. */
export const assets = {
  whiteboard: {
    mimeType: 'image/svg+xml',
    name: 'whiteboard.jpg',
    data: picture('Whiteboard sketch', '#fff4d6', '#8a5a00'),
  },
  storefront: {
    mimeType: 'image/svg+xml',
    name: 'storefront.png',
    data: picture('Storefront mockup', '#e8e4ff', '#4b3aa8', true),
  },
  dashboard: {
    mimeType: 'image/svg+xml',
    name: 'dashboard.png',
    data: picture('Dashboard, dark', '#1f2430', '#8fb4ff', true),
  },
  receipt: {
    mimeType: 'image/svg+xml',
    name: 'receipt.jpg',
    data: picture('Receipt #4471', '#f4f4f0', '#333333'),
  },
  venue1: {
    mimeType: 'image/svg+xml',
    name: 'venue-1.jpg',
    data: picture('Venue, hall', '#ffe4d6', '#a3431f'),
  },
  venue2: {
    mimeType: 'image/svg+xml',
    name: 'venue-2.jpg',
    data: picture('Venue, stage', '#d6f5e6', '#1f7a4d'),
  },
  venue3: {
    mimeType: 'image/svg+xml',
    name: 'venue-3.jpg',
    data: picture('Venue, lobby', '#d6e9ff', '#2456a3'),
  },
  venue4: {
    mimeType: 'image/svg+xml',
    name: 'venue-4.jpg',
    data: picture('Venue, patio', '#fff3c4', '#8a6d00'),
  },
  venue5: {
    mimeType: 'image/svg+xml',
    name: 'venue-5.jpg',
    data: picture('Venue, parking', '#f3d6ff', '#7a2a99'),
  },
  venue6: {
    mimeType: 'image/svg+xml',
    name: 'venue-6.jpg',
    data: picture('Venue, map', '#e0e0e0', '#444444'),
  },
  poster: {
    mimeType: 'image/svg+xml',
    name: 'poster-v2.png',
    data: picture('Launch poster v2', '#ffd6e0', '#b0204a'),
  },
  launchPlan: {
    mimeType: 'application/pdf',
    name: 'Q3 Launch Plan.pdf',
    data: pdf('Q3 Launch Plan', [
      'Owner: Northwind product team',
      'Beta opens: October 2',
      'Public launch: October 16',
      'Risks: payment provider review, venue deposit',
    ]),
  },
  contract: {
    mimeType: 'application/pdf',
    name: 'Venue contract.pdf',
    data: pdf('Venue contract', ['Deposit: 30% on signature', 'Cancellation: 21 days notice']),
  },
  notes: {
    mimeType: 'text/markdown',
    name: 'release-notes.md',
    data: encode(
      '# Release 2.2\n\n- Sessions as a messenger\n- The gateway conversation\n- Attachments in the composer\n',
    ),
  },
  budget: {
    mimeType: 'text/csv',
    name: 'budget.csv',
    data: encode('item,cost\nvenue,4200\ncatering,1850\nprinting,320\n'),
  },
  config: {
    mimeType: 'application/json',
    name: 'deploy.json',
    data: encode('{\n  "region": "eu-west",\n  "replicas": 3,\n  "canary": true\n}\n'),
  },
  pasted: {
    mimeType: 'text/plain',
    name: 'Pasted Content.txt',
    data: encode(
      Array.from(
        { length: 60 },
        (_, index) =>
          `2026-09-23T14:${String(index).padStart(2, '0')}:07Z worker-${index % 4} ${index % 9 === 0 ? 'ERROR payment webhook timed out after 30s' : 'INFO job completed'}`,
      ).join('\n'),
    ),
  },
  ownerVoice: { mimeType: 'audio/wav', name: 'Voice note.webm', data: voice(7, 190) },
  agentVoice: { mimeType: 'audio/wav', data: voice(11, 240, 2.8) },
  mayaVoice: { mimeType: 'audio/wav', data: voice(5, 260, 3.1) },
  memberVoice: { mimeType: 'audio/wav', data: voice(9, 150, 2) },
  statusPage: {
    mimeType: 'text/html',
    name: 'status.html',
    data: encode(
      '<!doctype html><html><head><style>body{font-family:sans-serif;margin:40px;color:#1f2430}h1{color:#1f7a4d}td{padding:4px 16px 4px 0}</style></head>' +
        '<body><h1>All systems normal</h1><table><tr><td>API</td><td>99.98%</td></tr><tr><td>Workers</td><td>100%</td></tr></table></body></html>',
    ),
  },
  // Code arrives as bytes of no known type; its name is what says it is TypeScript.
  retryJob: {
    mimeType: 'application/octet-stream',
    name: 'retry.ts',
    data: encode(
      "// Retries a webhook with a growing pause, up to five times.\nexport async function retry(send: () => Promise<Response>, attempts = 5) {\n  for (let attempt = 1; attempt <= attempts; attempt += 1) {\n    const response = await send();\n    if (response.ok) return response;\n    await new Promise((done) => setTimeout(done, 2 ** attempt * 100));\n  }\n  throw new Error('The webhook never answered');\n}\n",
    ),
  },
} satisfies Record<string, Asset>;

export type AssetKey = keyof typeof assets;

/** A stable id per attachment, so the same key always opens the same file. */
export const mediaId = (key: AssetKey) =>
  `c0000000-0000-4000-8000-${String(Object.keys(assets).indexOf(key) + 1).padStart(12, '0')}`;

export const media: Record<string, Asset> = Object.fromEntries(
  (Object.keys(assets) as AssetKey[]).map((key) => [mediaId(key), assets[key]]),
);
