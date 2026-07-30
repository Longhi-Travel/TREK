import fs from 'fs';
import path from 'path';

/**
 * White-label branding, entirely env-driven. Every value is optional; any unset
 * value leaves the stock TREK appearance byte-identical — that invariant is
 * what makes this upstreamable, so treat "no env vars → no behaviour change"
 * as a hard contract.
 *
 *   BRAND_NAME          Product/agency name: index.html <title>, PWA title,
 *                       shared-page footer ("Shared via <name>").
 *   BRAND_TAGLINE       Replaces the hero tagline on the shared page.
 *   BRAND_LOGO_URL      Image URL for the shared-page hero + footer logo.
 *   BRAND_ACCENT        CSS color for the shared page's --accent tokens.
 *   BRAND_HEADER_BG     CSS background for the shared hero + budget card.
 *   BRAND_DISPLAY_FONT  CSS font-family for the shared hero title/tagline.
 *   BRAND_ASSETS_DIR    Directory whose files override same-named files in the
 *                       built client (favicon, /icons/*, /logo-*.svg used by
 *                       the PDF export). Missing files fall through to stock.
 *   SOURCE_CODE_URL     AGPL §13 corresponding-source link for this deployment;
 *                       shown in the shared-page footer when branded.
 */
const trimmed = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

export const BRANDING = {
  name: trimmed(process.env.BRAND_NAME),
  tagline: trimmed(process.env.BRAND_TAGLINE),
  logoUrl: trimmed(process.env.BRAND_LOGO_URL),
  accent: trimmed(process.env.BRAND_ACCENT),
  headerBg: trimmed(process.env.BRAND_HEADER_BG),
  displayFont: trimmed(process.env.BRAND_DISPLAY_FONT),
  sourceUrl: trimmed(process.env.SOURCE_CODE_URL),
  assetsDir: trimmed(process.env.BRAND_ASSETS_DIR),
};

/** Public JSON for GET /api/branding — set values only, never the assets dir. */
export function brandingPayload(): Record<string, string> {
  const { assetsDir: _assetsDir, ...pub } = BRANDING;
  return Object.fromEntries(Object.entries(pub).filter(([, v]) => v != null)) as Record<string, string>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let cachedIndex: string | null | undefined;

/**
 * index.html with the product title/PWA title swapped for BRAND_NAME, read and
 * transformed once at first request. Null when unbranded or the file is
 * missing (dev) — callers fall back to the stock sendFile path.
 */
export function brandedIndexHtml(publicDir: string): string | null {
  if (cachedIndex !== undefined) return cachedIndex;
  if (!BRANDING.name) {
    cachedIndex = null;
    return null;
  }
  try {
    const name = escapeHtml(BRANDING.name);
    cachedIndex = fs
      .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
      .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${name}$2`);
  } catch {
    cachedIndex = null;
  }
  return cachedIndex;
}
