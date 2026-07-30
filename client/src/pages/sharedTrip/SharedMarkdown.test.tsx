import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SharedMarkdown, { sharedUrlTransform } from './SharedMarkdown';

describe('SharedMarkdown', () => {
  describe('rendering', () => {
    it('renders an ordered list with explicit decimal markers', () => {
      const { container } = render(<SharedMarkdown text={'1. First\n2. Second\n3. Third'} />);
      const ol = container.querySelector('ol');
      expect(ol).not.toBeNull();
      expect(ol!.style.listStyle).toContain('decimal');
      expect(container.querySelectorAll('li')).toHaveLength(3);
    });

    it('renders headings, bold, italic, blockquotes and unordered lists', () => {
      const { container, getByText } = render(
        <SharedMarkdown text={'## Roteiro\n\n**bold** and *italic*\n\n> quoted\n\n- a\n- b'} />
      );
      expect(getByText('Roteiro')).toBeTruthy();
      expect(container.querySelector('strong')?.textContent).toBe('bold');
      expect(container.querySelector('em')?.textContent).toBe('italic');
      expect(container.querySelector('blockquote')?.textContent).toContain('quoted');
      expect(container.querySelector('ul')?.style.listStyle).toContain('disc');
    });

    it('renders http links with target=_blank and rel=noopener', () => {
      const { container } = render(<SharedMarkdown text={'[site](https://example.com/x)'} />);
      const a = container.querySelector('a');
      expect(a?.getAttribute('href')).toBe('https://example.com/x');
      expect(a?.getAttribute('target')).toBe('_blank');
      expect(a?.getAttribute('rel')).toContain('noopener');
    });
  });

  describe('XSS hardening (goal 3b probes)', () => {
    it('renders <script> as inert text, not an element', () => {
      const { container } = render(<SharedMarkdown text={'before <script>alert(1)</script> after'} />);
      expect(container.querySelector('script')).toBeNull();
      expect(container.textContent).toContain('before');
    });

    it('never renders raw HTML img/onerror as an element', () => {
      const { container } = render(<SharedMarkdown text={'<img src=x onerror=alert(1)>'} />);
      expect(container.querySelector('img')).toBeNull();
    });

    it('drops javascript: link hrefs', () => {
      const { container } = render(<SharedMarkdown text={'[click](javascript:alert(1))'} />);
      const a = container.querySelector('a[href]');
      expect(a).toBeNull();
    });

    it('drops data: image sources', () => {
      const { container } = render(<SharedMarkdown text={'![x](data:text/html,<script>alert(1)</script>)'} />);
      const img = container.querySelector('img[src]');
      expect(img).toBeNull();
    });
  });

  describe('sharedUrlTransform', () => {
    it('allows http, https, mailto, tel and relative URLs', () => {
      expect(sharedUrlTransform('https://a.b/c')).toBe('https://a.b/c');
      expect(sharedUrlTransform('http://a.b')).toBe('http://a.b');
      expect(sharedUrlTransform('mailto:x@y.z')).toBe('mailto:x@y.z');
      expect(sharedUrlTransform('tel:+5511991910468')).toBe('tel:+5511991910468');
      expect(sharedUrlTransform('/api/shared/t/file/abc')).toBe('/api/shared/t/file/abc');
    });

    it('drops javascript:, data:, vbscript: and file: URLs', () => {
      expect(sharedUrlTransform('javascript:alert(1)')).toBeUndefined();
      expect(sharedUrlTransform('data:text/html,x')).toBeUndefined();
      expect(sharedUrlTransform('vbscript:x')).toBeUndefined();
      expect(sharedUrlTransform('file:///etc/passwd')).toBeUndefined();
    });

    it('is not fooled by embedded tab/newline scheme smuggling', () => {
      expect(sharedUrlTransform('java\tscript:alert(1)')).toBeUndefined();
      expect(sharedUrlTransform('java\nscript:alert(1)')).toBeUndefined();
      expect(sharedUrlTransform(' JAVASCRIPT:alert(1)')).toBeUndefined();
    });
  });
});
