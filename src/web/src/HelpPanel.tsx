import ReactMarkdown, { type Components } from 'react-markdown';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import {
  extractHeadings,
  groupDocs,
  helpSlugFromHref,
  resolveDocHref,
  resolveDocImage,
  slugifyHeading,
  textFromChildren,
} from './docs';
import type { DocContent, DocPage } from './types';
import { MermaidDiagram } from './MermaidDiagram';
import { mermaidSource } from './mermaid';
import { Button, Spinner, cn } from './ui';

type LoadState = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

export interface HelpPanelProps {
  /** Current Help page slug. */
  slug: string;
  onNavigate: (slug: string) => void;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(element: HTMLElement): boolean {
  return element.offsetParent !== null || element.getClientRects().length > 0;
}

function pageTitle(state: LoadState, pages: DocPage[], slug: string): string {
  if (state === 'missing') return 'Page not found';
  if (state === 'error') return 'Could not load page';
  return pages.find((page) => page.slug === slug)?.title ?? 'Documentation';
}

export function HelpPanel({ slug, onNavigate, onClose }: HelpPanelProps) {
  const [pages, setPages] = useState<DocPage[]>([]);
  const [manifest, setManifest] = useState<LoadState>('loading');
  const [doc, setDoc] = useState<DocContent | null>(null);
  const [page, setPage] = useState<LoadState>('loading');
  const [navOpen, setNavOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    setManifest('loading');
    api
      .getDocs()
      .then(({ pages: next }) => {
        if (cancelled) return;
        setPages(next);
        setManifest(next.length > 0 ? 'ready' : 'error');
      })
      .catch(() => {
        if (!cancelled) setManifest('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPage('loading');
    setCopied(false);
    api
      .getDoc(slug)
      .then((content) => {
        if (cancelled) return;
        setDoc(content);
        setPage('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPage(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const groups = useMemo(() => groupDocs(pages), [pages]);
  const headings = useMemo(() => extractHeadings(doc?.markdown ?? ''), [doc?.markdown]);

  const copyMarkdown = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard?.writeText(doc.markdown);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const select = (next: string) => {
    setNavOpen(false);
    onNavigate(next);
  };

  const components: Components = (() => {
    const heading = (level: 1 | 2 | 3 | 4) => {
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      const classes = {
        1: 'mb-3 mt-6 text-2xl font-semibold tracking-tight text-zinc-100 first:mt-0',
        2: 'mb-2 mt-7 border-t border-zinc-900 pt-5 text-lg font-semibold text-zinc-100',
        3: 'mb-1.5 mt-5 text-base font-semibold text-zinc-200',
        4: 'mb-1 mt-4 text-sm font-semibold uppercase tracking-wide text-zinc-400',
      }[level];
      return ({ children }: { children?: ReactNode }) => {
        const id = level === 2 || level === 3 ? slugifyHeading(textFromChildren(children)) : undefined;
        return (
          <Tag id={id} className={cn(classes, 'scroll-mt-4')}>
            {children}
          </Tag>
        );
      };
    };

    return {
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      p: ({ children }) => <p className="mb-3 text-sm leading-relaxed text-zinc-300">{children}</p>,
      ul: ({ children }) => (
        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-zinc-300">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-zinc-300">{children}</ol>
      ),
      li: ({ children }) => <li className="leading-relaxed">{children}</li>,
      strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
      em: ({ children }) => <em className="text-zinc-200">{children}</em>,
      blockquote: ({ children }) => (
        <blockquote className="mb-3 border-l-2 border-zinc-700 pl-3 text-sm italic text-zinc-400">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-6 border-zinc-900" />,
      a: ({ href, children }) => {
        const target = resolveDocHref(href ?? '');
        const helpSlug = helpSlugFromHref(target);
        if (helpSlug) {
          return (
            <a
              href={target}
              className="text-blue-400 underline decoration-blue-900 underline-offset-2 hover:text-blue-300"
              onClick={(event) => {
                event.preventDefault();
                select(helpSlug);
              }}
            >
              {children}
            </a>
          );
        }
        const external = /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
        return (
          <a
            href={target}
            className="text-blue-400 underline decoration-blue-900 underline-offset-2 hover:text-blue-300"
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt }) => (
        <img
          src={resolveDocImage(src ?? '')}
          alt={alt ?? ''}
          loading="lazy"
          className="my-4 w-full rounded-lg border border-zinc-800 bg-zinc-900"
        />
      ),
      pre: ({ children, node }) => {
        const source = mermaidSource(node);
        if (source !== null) return <MermaidDiagram source={source} />;
        return (
          <pre className="mb-3 overflow-x-auto rounded-lg border border-zinc-800 bg-black/50 p-3 font-mono text-[11px] leading-relaxed text-zinc-300 [&>code]:bg-transparent [&>code]:p-0">
            {children}
          </pre>
        );
      },
      code: ({ children }) => (
        <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[12px] text-zinc-200">
          {children}
        </code>
      ),
      table: ({ children }) => (
        <div className="mb-3 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-left text-xs">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-zinc-900/70">{children}</thead>,
      th: ({ children }) => (
        <th className="border-b border-zinc-800 px-2 py-1.5 font-semibold text-zinc-200">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="border-b border-zinc-900 px-2 py-1.5 align-top text-zinc-300">
          {children}
        </td>
      ),
    };
  })();

  const title = pageTitle(page, pages, slug);
  const showArticle = manifest === 'ready';

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Documentation"
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex flex-col bg-zinc-950 outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-900 px-3">
        <button
          type="button"
          aria-label="Documentation menu"
          aria-expanded={navOpen}
          aria-controls="help-nav"
          onClick={() => setNavOpen((value) => !value)}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 md:hidden"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
            <path d="M1.5 3.5h13v1.5h-13zM1.5 7.25h13v1.5h-13zM1.5 11h13v1.5h-13z" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Help</p>
          <p className="truncate text-sm text-zinc-200">{title}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close help"
          onClick={onClose}
          className="rounded-md p-1.5 text-lg leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          ×
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {navOpen ? (
          <div
            className="absolute inset-0 z-10 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={() => setNavOpen(false)}
          />
        ) : null}

        {showArticle ? (
          <aside
            id="help-nav"
            aria-label="Documentation pages"
            className={cn(
              'absolute inset-y-0 left-0 z-20 w-72 shrink-0 overflow-y-auto border-r border-zinc-900 bg-zinc-950 p-3 transition-transform duration-200 md:static md:w-60 md:translate-x-0',
              navOpen ? 'translate-x-0' : '-translate-x-full',
            )}
          >
            <nav className="space-y-5">
              {groups.map((group) => (
                <div key={group.group}>
                  <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                    {group.group}
                  </p>
                  <ul className="space-y-0.5">
                    {group.pages.map((item) => (
                      <li key={item.slug}>
                        <button
                          type="button"
                          aria-current={item.slug === slug ? 'page' : undefined}
                          onClick={() => select(item.slug)}
                          className={cn(
                            'w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                            item.slug === slug
                              ? 'bg-zinc-800 text-zinc-100'
                              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                          )}
                          title={item.description}
                        >
                          {item.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>
        ) : null}

        <main className="min-w-0 flex-1 overflow-y-auto">
          {manifest === 'loading' ? (
            <div className="flex items-center gap-2 p-6 text-sm text-zinc-500">
              <Spinner /> Loading documentation…
            </div>
          ) : null}
          {manifest === 'error' ? (
            <div className="mx-auto max-w-xl p-6">
              <h2 className="text-lg font-semibold text-zinc-100">
                Documentation is not available in this build
              </h2>
              <p className="mt-2 text-sm text-zinc-400">
                This build does not ship the docs directory. Set <code>APS_DOCS_DIR</code> to the
                repository&apos;s <code>docs</code> folder and restart the brain.
              </p>
            </div>
          ) : null}
          {showArticle && page === 'loading' ? (
            <div className="flex items-center gap-2 p-6 text-sm text-zinc-500">
              <Spinner /> Loading page…
            </div>
          ) : null}
          {showArticle && page === 'error' ? (
            <div className="mx-auto max-w-xl p-6">
              <h2 className="text-lg font-semibold text-zinc-100">Could not load this page</h2>
              <p className="mt-2 text-sm text-zinc-400">The docs API did not return this article.</p>
              <a
                href="?help=getting-started"
                className="mt-4 inline-flex rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:border-zinc-500 hover:text-white"
                onClick={(event) => {
                  event.preventDefault();
                  select('getting-started');
                }}
              >
                Back to Getting started
              </a>
            </div>
          ) : null}
          {showArticle && page === 'missing' ? (
            <div className="mx-auto max-w-xl p-6">
              <h2 className="text-lg font-semibold text-zinc-100">Page not found</h2>
              <p className="mt-2 text-sm text-zinc-400">
                No documentation page matches <code>{slug}</code>.
              </p>
              <a
                href="?help=getting-started"
                className="mt-4 inline-flex rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:border-zinc-500 hover:text-white"
                onClick={(event) => {
                  event.preventDefault();
                  select('getting-started');
                }}
              >
                Back to Getting started
              </a>
            </div>
          ) : null}
          {showArticle && page === 'ready' && doc ? (
            <div className="mx-auto flex max-w-5xl gap-8 px-4 py-6">
              <article className="min-w-0 flex-1">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-zinc-900 pb-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                      {doc.group}
                    </p>
                    <h1 className="mt-1 text-xl font-semibold tracking-tight text-zinc-100">
                      {doc.title}
                    </h1>
                    {doc.description ? (
                      <p className="mt-1 text-xs text-zinc-500">{doc.description}</p>
                    ) : null}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void copyMarkdown()}>
                    {copied ? 'Copied' : 'Copy as Markdown'}
                  </Button>
                </div>
                <div className="max-w-none">
                  <ReactMarkdown components={components}>{doc.markdown}</ReactMarkdown>
                </div>
              </article>

              {headings.length > 0 ? (
                <aside className="hidden w-52 shrink-0 xl:block">
                  <div className="sticky top-0 max-h-[calc(100vh-7rem)] overflow-y-auto py-1">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                      On this page
                    </p>
                    <ul className="space-y-1 border-l border-zinc-900">
                      {headings.map((heading) => (
                        <li key={heading.id}>
                          <a
                            href={`#${heading.id}`}
                            className={cn(
                              'block border-l border-transparent py-0.5 text-xs text-zinc-500 hover:border-zinc-600 hover:text-zinc-200',
                              heading.level === 2 ? '-ml-px pl-2' : '-ml-px pl-5',
                            )}
                          >
                            {heading.text}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </aside>
              ) : null}
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
