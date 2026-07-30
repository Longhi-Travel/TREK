import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * Markdown renderer for the public shared page (day notes, emergency info).
 *
 * Security posture — this is the only place guest-visible Markdown is turned
 * into DOM, so the rules live here rather than at each call site:
 * - No rehype-raw and no dangerouslySetInnerHTML: raw HTML in a note renders
 *   as inert text, never as elements.
 * - Link/image URLs pass sharedUrlTransform, which allowlists http/https/
 *   mailto/tel and drops everything else (javascript:, data:, vbscript:, …).
 *   tel: is included beyond the usual trio because the emergency block's
 *   one-tap phone numbers render through this component.
 * - Links open in a new tab with rel="noopener noreferrer".
 */

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

export function sharedUrlTransform(value: string): string | undefined {
  // The HTML URL parser strips tab/CR/LF anywhere in a URL, so "jav\tascript:"
  // reaches the browser as javascript: — strip them before scheme detection.
  const url = String(value || '')
    .replace(/[\t\n\r]/g, '')
    .trim();
  if (!url) return undefined;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  // Scheme-less URLs are relative (or protocol-relative) and resolve within
  // the page's own http(s) origin scheme.
  if (!scheme) return url;
  return ALLOWED_SCHEMES.has(scheme[1].toLowerCase()) ? url : undefined;
}

const blockGap = { margin: '0 0 8px' } as const;

export default function SharedMarkdown({ text }: { text: string }) {
  return (
    <div
      className="text-content-secondary"
      style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', lineHeight: 1.55, wordBreak: 'break-word' }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={sharedUrlTransform}
        components={{
          h1: ({ children }) => (
            <div className="text-content" style={{ ...blockGap, fontSize: 'calc(16px * var(--fs-scale-subtitle, 1))', fontWeight: 700, marginTop: 4 }}>{children}</div>
          ),
          h2: ({ children }) => (
            <div className="text-content" style={{ ...blockGap, fontSize: 'calc(14.5px * var(--fs-scale-subtitle, 1))', fontWeight: 700, marginTop: 4 }}>{children}</div>
          ),
          h3: ({ children }) => (
            <div className="text-content" style={{ ...blockGap, fontSize: 'calc(13.5px * var(--fs-scale-subtitle, 1))', fontWeight: 600, marginTop: 2 }}>{children}</div>
          ),
          h4: ({ children }) => (
            <div className="text-content" style={{ ...blockGap, fontWeight: 600 }}>{children}</div>
          ),
          p: ({ children }) => <p style={blockGap}>{children}</p>,
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-on"
                style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          // Tailwind's preflight zeroes list styles; restore explicit markers so
          // a 26-step route keeps its numbers.
          ol: ({ children }) => (
            <ol style={{ ...blockGap, paddingLeft: 26, listStyle: 'decimal outside' }}>{children}</ol>
          ),
          ul: ({ children }) => (
            <ul style={{ ...blockGap, paddingLeft: 24, listStyle: 'disc outside' }}>{children}</ul>
          ),
          li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '8px 0',
                padding: '4px 12px',
                borderLeft: '3px solid var(--accent)',
                color: 'var(--text-muted)',
              }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code
              className="bg-surface-tertiary"
              style={{ padding: '1px 5px', borderRadius: 4, fontSize: '0.9em' }}
            >
              {children}
            </code>
          ),
          hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--border-primary)', margin: '10px 0' }} />,
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '8px 0' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.95em' }}>{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{ border: '1px solid var(--border-primary)', padding: '4px 8px', textAlign: 'left' }}>{children}</th>
          ),
          td: ({ children }) => (
            <td style={{ border: '1px solid var(--border-primary)', padding: '4px 8px' }}>{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
