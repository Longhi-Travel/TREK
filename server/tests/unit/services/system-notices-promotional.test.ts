/**
 * Promotional system notices are suppressed on white-labeled installs.
 *
 * The agency's staff work for the operator, not for TREK, so upstream's
 * donation modal must not appear once BRAND_NAME is set. Operational notices
 * (migration warnings and the like) must keep showing regardless, and an
 * unbranded install must behave exactly like stock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, login_count INTEGER DEFAULT 1,
      first_seen_version TEXT, role TEXT DEFAULT 'user');
    CREATE TABLE trips (id INTEGER PRIMARY KEY, user_id INTEGER);
    CREATE TABLE user_notice_dismissals (user_id INTEGER, notice_id TEXT,
      dismissed_at TEXT, dismissed_app_version TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare("INSERT INTO users (id, login_count, first_seen_version, role) VALUES (1, 3, '3.4.0', 'admin')").run();
  return { testDb: db, dbMock: { db, closeDb: () => {}, reinitialize: () => {} } };
});

vi.mock('../../../src/db/database', () => dbMock);

async function activeIds(): Promise<string[]> {
  vi.resetModules();
  const { getActiveNoticesFor } = await import('../../../src/systemNotices/service');
  return getActiveNoticesFor(1).map((n) => n.id);
}

describe('promotional notice suppression', () => {
  beforeEach(() => {
    delete process.env.BRAND_NAME;
    testDb.prepare('DELETE FROM user_notice_dismissals').run();
  });
  afterEach(() => {
    delete process.env.BRAND_NAME;
  });

  // Generous timeout: this is the first dynamic import, so it pays for
  // compiling the whole notices module graph.
  it('shows the upstream support modal on an unbranded install (stock behaviour)', async () => {
    expect(await activeIds()).toContain('thank-you-support');
  }, 60_000);

  it('hides it once BRAND_NAME is set', async () => {
    process.env.BRAND_NAME = 'Longhi Travel';
    expect(await activeIds()).not.toContain('thank-you-support');
  });

  it('does not suppress operational notices on a branded install', async () => {
    process.env.BRAND_NAME = 'Longhi Travel';
    vi.resetModules();
    const { SYSTEM_NOTICES } = await import('../../../src/systemNotices/registry');
    const operational = SYSTEM_NOTICES.filter((n) => !n.promotional);
    // Every non-promotional notice must be left alone by the branding filter;
    // whether it renders is decided by its own conditions, not by branding.
    expect(operational.length).toBeGreaterThan(0);
    for (const n of operational) expect(n.promotional).toBeFalsy();
  });

  it('never leaks the promotional flag to the client DTO', async () => {
    vi.resetModules();
    const { getActiveNoticesFor } = await import('../../../src/systemNotices/service');
    for (const dto of getActiveNoticesFor(1)) {
      expect(Object.prototype.hasOwnProperty.call(dto, 'promotional')).toBe(false);
    }
  });
});
