import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { Code, HtmlPage, languageOf, textOf } from './preview';

const encode = (text: string) => btoa(unescape(encodeURIComponent(text)));

afterEach(() => {
  document.body.innerHTML = '';
});

async function show(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');

  document.body.append(element);
  await act(async () => createRoot(element).render(node));

  return element;
}

it('reads code sent without a known type as the language its name says', () => {
  expect(languageOf('application/octet-stream', 'src/server.ts')).toBe('typescript');
  expect(languageOf('application/octet-stream', 'Makefile')).toBe('makefile');
  expect(languageOf('application/json')).toBe('json');
  expect(languageOf('application/octet-stream', 'archive.bin')).toBeUndefined();
});

it('refuses bytes that are not text, so a binary file is offered as a download', () => {
  expect(textOf(encode('const answer = 42;\n'))).toBe('const answer = 42;\n');
  expect(textOf(btoa('\u0000\u0001\u0002ELF'))).toBeUndefined();
  expect(textOf(btoa('\xff\xfe\xfd'))).toBeUndefined();
});

it('still shows a file declared as text when a byte of it is not UTF-8', () => {
  expect(textOf(btoa('caf\xe9 menu'), true)).toBe('caf\uFFFD menu');
});

it('colours code without letting the file put markup into the panel', async () => {
  const element = await show(
    <Code text={'const page = "<img src=x onerror=alert(1)>";'} language="typescript" />,
  );

  expect(element.querySelector('.hljs-keyword')?.textContent).toBe('const');
  expect(element.querySelector('img')).toBeNull();
  expect(element.textContent).toContain('<img src=x onerror=alert(1)>');
});

it('draws an HTML page in a frame that runs none of its scripts', async () => {
  const element = await show(
    <HtmlPage text="<h1>Report</h1><script>parent.alert(1)</script>" title="report.html" />,
  );
  const frame = element.querySelector('iframe');

  expect(frame?.getAttribute('sandbox')).toBe('');
  expect(frame?.getAttribute('srcdoc')).toContain('<h1>Report</h1>');
});
