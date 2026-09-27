'use client';

import { ChevronLeft, ChevronRight, CodeXml, Download, Eye, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { kindNames, type LoadedMedia, nameOf, readsAsText, size } from './media';
import { Code, HtmlPage, languageOf, MarkdownPage, textOf } from './preview';
import { ZoomableImage } from './zoom';

/** How long the viewer takes to fade out; the CSS animation runs for the same time. */
const CLOSING_MS = 160;

/** Documents drawn as they read, with their source one click away. */
const RENDERED = new Set(['text/html', 'text/markdown']);

/**
 * What a document is shown as: text formats, and files of an unnamed type whose name says
 * code, as text; anything whose bytes turn out not to be text, as a download.
 */
function textView(media: LoadedMedia) {
  const language = languageOf(media.mimeType, media.name);
  const declared = readsAsText(media.mimeType);

  if (!declared && !(media.mimeType === 'application/octet-stream' && language)) return undefined;

  const text = textOf(media.data, declared);

  return text === undefined ? undefined : { text, language };
}

/**
 * A PDF shown by the browser's own reader. It reads from a local blob address, released when
 * the document changes or the viewer closes.
 */
function Pdf({ media }: { media: LoadedMedia }) {
  const url = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([Uint8Array.from(atob(media.data), (char) => char.charCodeAt(0))], {
          type: 'application/pdf',
        }),
      ),
    [media.data],
  );

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return <iframe className="viewer-pdf" src={url} title={nameOf(media)} />;
}

/**
 * The attachments of one message, one at a time over the whole screen. The arrows and the
 * keyboard move between them; Escape, the close button and a click outside close it.
 */
export function MediaViewer({
  items,
  start,
  close,
}: {
  items: LoadedMedia[];
  start: number;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(Math.max(start, 0));
  const [closing, setClosing] = useState(false);
  const [source, setSource] = useState(false);
  // Plays the way out before the dialog goes; a second request while it plays changes nothing.
  const leave = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(close, CLOSING_MS);
  };
  const media = items[index];
  const many = items.length > 1;
  const step = (by: number) => {
    setIndex((current) => (current + by + items.length) % items.length);
    setSource(false);
  };
  const text = useMemo(() => (media ? textView(media) : undefined), [media]);

  useEffect(() => {
    ref.current?.showModal();

    return () => ref.current?.close();
  }, []);

  if (!media) return null;

  return (
    <dialog
      ref={ref}
      className="viewer"
      data-closing={closing}
      aria-label={nameOf(media)}
      onCancel={(event) => {
        event.preventDefault();
        leave();
      }}
      onKeyDown={(event) => {
        if (many && event.key === 'ArrowRight') step(1);
        if (many && event.key === 'ArrowLeft') step(-1);
      }}
      onClick={(event) => {
        // Only the empty space around the content is hit directly: that is a click outside it.
        const target = event.target as HTMLElement;

        if (target === event.currentTarget || target.classList.contains('viewer-stage')) leave();
      }}
    >
      <header>
        <strong>
          {media.mimeType.startsWith('image/') ? (media.name ?? 'Image') : nameOf(media)}
        </strong>
        {many && (
          <span>
            {index + 1} / {items.length}
          </span>
        )}
        {text && RENDERED.has(media.mimeType) && (
          <button
            type="button"
            className="viewer-button"
            aria-label={source ? 'Show preview' : 'Show source'}
            aria-pressed={source}
            onClick={() => setSource(!source)}
          >
            {source ? <Eye size={18} /> : <CodeXml size={18} />}
          </button>
        )}
        <a
          className="viewer-button"
          href={media.url}
          download={nameOf(media)}
          aria-label="Download"
        >
          <Download size={18} />
        </a>
        <button type="button" className="viewer-button" aria-label="Close" onClick={leave}>
          <X size={20} />
        </button>
      </header>
      <div className="viewer-stage">
        {media.mimeType.startsWith('image/') ? (
          <ZoomableImage
            key={media.id}
            src={media.url}
            alt={media.name ?? 'Image attachment'}
            dismiss={leave}
          />
        ) : media.mimeType === 'application/pdf' ? (
          <Pdf media={media} />
        ) : media.mimeType.startsWith('video/') ? (
          // biome-ignore lint/a11y/useMediaCaption: A file someone sent; it has no captions to offer.
          <video className="viewer-video" src={media.url} controls />
        ) : text && !source && media.mimeType === 'text/html' ? (
          <HtmlPage key={media.id} text={text.text} title={nameOf(media)} />
        ) : text && !source && media.mimeType === 'text/markdown' ? (
          <MarkdownPage key={media.id} text={text.text} />
        ) : text ? (
          <Code key={media.id} text={text.text} language={text.language} />
        ) : (
          <div className="viewer-file">
            <strong>{nameOf(media)}</strong>
            <span>
              {kindNames[media.mimeType] ?? media.mimeType} · {size(media.bytes)}
            </span>
            <p>No preview for this format.</p>
            <a className="button primary" href={media.url} download={nameOf(media)}>
              <Download size={16} />
              Download
            </a>
          </div>
        )}
      </div>
      {many && (
        <>
          <button
            type="button"
            className="viewer-button viewer-previous"
            aria-label="Previous"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            className="viewer-button viewer-next"
            aria-label="Next"
            onClick={() => step(1)}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </dialog>
  );
}
