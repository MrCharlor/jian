import { common, createLowlight } from 'lowlight';
import type { ReactNode } from 'react';
import { Markdown } from '../ui/markdown';

const lowlight = createLowlight(common);

type Root = ReturnType<typeof lowlight.highlight>;
type Node = Root['children'][number];

/**
 * Past this many characters a file is shown without colours: the highlighter runs on the main
 * thread, and a multi-megabyte log would freeze the panel while it works.
 */
const HIGHLIGHT_LIMIT = 200_000;

/** The grammar a file is coloured with, by its extension; names are those of highlight.js. */
const LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  diff: 'diff',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  htm: 'xml',
  html: 'xml',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  m: 'objectivec',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  patch: 'diff',
  php: 'php',
  pl: 'perl',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vb: 'vbnet',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

/** Files known by their whole name rather than an extension. */
const NAMED: Record<string, string> = { makefile: 'makefile', '.env': 'bash' };

/** Types whose grammar is known even when the file came without a name. */
const BY_TYPE: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/html': 'xml',
  'text/markdown': 'markdown',
};

export function languageOf(mimeType: string, name?: string) {
  const file = name?.toLowerCase().split('/').pop() ?? '';
  const extension = /\.([a-z0-9]{1,6})$/.exec(file)?.[1];

  return NAMED[file] ?? (extension && LANGUAGES[extension]) ?? BY_TYPE[mimeType];
}

/**
 * The text of a file, or undefined when its bytes are not text. Code sent as a file is stored
 * as `application/octet-stream`, so the name alone cannot promise text: the bytes have to be
 * valid UTF-8 and free of NUL, which binary formats almost never are. A file whose type already
 * says text is read `leniently`: an odd byte becomes a replacement mark instead of hiding it.
 */
export function textOf(data: string, leniently = false) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

  if (leniently) return new TextDecoder().decode(bytes);

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The highlighter's tree as elements, never as HTML, so the file cannot inject markup. */
function render(nodes: Node[], prefix: string): ReactNode[] {
  const out: ReactNode[] = [];

  for (const [index, node] of nodes.entries()) {
    const key = `${prefix}.${index}`;

    if (node.type === 'text') out.push(node.value);
    else if (node.type === 'element') {
      const className = node.properties.className;

      out.push(
        <span key={key} className={Array.isArray(className) ? className.join(' ') : undefined}>
          {render(node.children as Node[], key)}
        </span>,
      );
    }
  }

  return out;
}

/** Source code with its syntax coloured, or plain when the grammar is unknown or it is huge. */
export function Code({ text, language }: { text: string; language?: string }) {
  const known = language && lowlight.registered(language) && text.length <= HIGHLIGHT_LIMIT;

  return (
    <pre className="viewer-code">
      <code>{known ? render(lowlight.highlight(language, text).children, 'c') : text}</code>
    </pre>
  );
}

/** A Markdown document laid out as the release notes are. */
export function MarkdownPage({ text }: { text: string }) {
  return (
    <article className="viewer-document release-notes">
      <Markdown text={text} />
    </article>
  );
}

/**
 * Whether a page relies on what its preview blocks: a script, or a stylesheet, font or image
 * from another site (`https://…` or `//…` in a `<link>`, a `src`, a CSS `url()` or `@import`).
 * A plain link to another site is not counted: it does not change how the page looks.
 */
const BEYOND =
  /<script\b|(?:<link\b[^>]*\bhref|\bsrc(?:set)?)\s*=\s*["']?(?:https?:)?\/\/|(?:url\(|@import)\s*["']?(?:url\(\s*["']?)?(?:https?:)?\/\//i;

export function reachesBeyond(html: string) {
  return BEYOND.test(html);
}

/**
 * An HTML page drawn in a sandboxed frame. The empty sandbox gives it an origin of its own and
 * no scripts, forms, popups or navigation of the panel; the page also inherits the panel's
 * policy, so it loads nothing from other origins. Inline styles and embedded images still
 * show, which is what a generated page or report needs to be read. A page that needs more is
 * told so, rather than left to look broken.
 */
export function HtmlPage({ text, title }: { text: string; title: string }) {
  return (
    <div className="viewer-html">
      {reachesBeyond(text) && (
        <p className="viewer-note" role="note">
          This preview is isolated: scripts do not run and styles, fonts or images from other sites
          do not load, so the page may look incomplete. Download it to open it in full.
        </p>
      )}
      <iframe sandbox="" srcDoc={text} title={title} />
    </div>
  );
}
