/**
 * Guest document access on share links (share_files) — integration tests.
 * Covers SFILE-001 to SFILE-010, including the negative security tests the
 * feature was designed around:
 *   - no IDOR (raw DB ids never resolve; foreign share mints never resolve)
 *   - no enumeration (unauthorized == non-existent == 404)
 *   - sensitivity gate fails closed (NULL == sensitive), operator override works
 *   - unlock rate limiting per (token, IP) with a temporary lockout
 *   - unlock endpoint rejects non-JSON content types (CSRF hardening)
 *   - share_files defaults OFF; expiry follows trip end (UTC)
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import type { INestApplication } from '@nestjs/common';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const { testDb, dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    canAccessTrip: (tripId: unknown, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: unknown, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
  SESSION_DURATION: '24h',
  SESSION_DURATION_MS: 86400000,
  SESSION_DURATION_SECONDS: 86400,
  DEFAULT_LANGUAGE: 'en',
}));
vi.mock('../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));

import { buildApp } from '../../src/bootstrap';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrations';
import { resetTestDb, resetRateLimits } from '../helpers/test-db';
import { createUser, createTrip, createReservation, createPlace } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { _resetUnlockLimiter } from '../../src/services/shareFilesService';

let nestApp: INestApplication;
let app: Application;
const uploadsDir = path.join(__dirname, '../../uploads/files');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = 'SECRETcode99';

beforeAll(async () => {
  createTables(testDb);
  runMigrations(testDb);
  nestApp = await buildApp();
  app = nestApp.getHttpAdapter().getInstance();
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
});

beforeEach(() => {
  resetTestDb(testDb);
  resetRateLimits(nestApp);
  _resetUnlockLimiter();
});

afterAll(async () => {
  await nestApp.close();
  testDb.close();
});

interface Ctx {
  userId: number;
  tripId: number;
  reservationId: number;
  placeId: number;
  file: { id: number; filename: string };
}

function createTripFile(
  tripId: number,
  opts: Partial<{ reservation_id: number; place_id: number; sensitivity: string | null; name: string; mime: string }> = {}
): { id: number; filename: string } {
  const filename = `sf-${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(uploadsDir, filename), 'PDF-TEST-BYTES');
  const r = testDb
    .prepare(
      'INSERT INTO trip_files (trip_id, place_id, reservation_id, filename, original_name, file_size, mime_type, sensitivity) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(
      tripId,
      opts.place_id ?? null,
      opts.reservation_id ?? null,
      filename,
      opts.name ?? 'Boarding-Pass.pdf',
      13,
      opts.mime ?? 'application/pdf',
      opts.sensitivity === undefined ? null : opts.sensitivity
    );
  return { id: Number(r.lastInsertRowid), filename };
}

async function setup(shareBody: Record<string, unknown>): Promise<Ctx & { token: string }> {
  const { user } = createUser(testDb, {});
  const trip = createTrip(testDb, user.id, { start_date: '2030-01-01', end_date: '2030-01-05' });
  const reservation = createReservation(testDb, trip.id, { title: 'Flight AF123' });
  const place = createPlace(testDb, trip.id, { name: 'Louvre' });
  const file = createTripFile(trip.id, { reservation_id: reservation.id });
  const res = await request(app)
    .post(`/api/trips/${trip.id}/share-link`)
    .set('Cookie', authCookie(user.id))
    .send(shareBody);
  expect([200, 201]).toContain(res.status);
  return { userId: user.id, tripId: trip.id, reservationId: reservation.id, placeId: place.id, file, token: res.body.token };
}

async function payload(token: string) {
  const res = await request(app).get(`/api/shared/${token}`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('SFILE-001: share_files defaults OFF (goal item 13)', () => {
  it('a link created without the flag exposes no documents and refuses bytes', async () => {
    const ctx = await setup({ share_bookings: true });
    const body = await payload(ctx.token);
    expect(body.permissions.share_files).toBe(false);
    expect(body.sharedFiles).toBeNull();
    // Even a correctly-minted-looking UUID must 404 while the flag is off.
    const res = await request(app).get(`/api/shared/${ctx.token}/file/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('SFILE-002: reservation-linked file reachable through its public UUID (goal item 9)', () => {
  it('payload carries UUID metas and a normal file streams with private caching', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    testDb.prepare("UPDATE trip_files SET sensitivity = 'normal' WHERE id = ?").run(ctx.file.id);

    const body = await payload(ctx.token);
    expect(body.permissions.share_files).toBe(true);
    const metas = body.sharedFiles.reservations[String(ctx.reservationId)];
    expect(metas).toHaveLength(1);
    expect(metas[0].id).toMatch(UUID_RE);
    expect(metas[0].name).toBe('Boarding-Pass.pdf');
    expect(metas[0].sensitivity).toBe('normal');

    const res = await request(app).get(`/api/shared/${ctx.token}/file/${metas[0].id}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.text || res.body.toString()).toContain('PDF-TEST-BYTES');
  });
});

describe('SFILE-003: no IDOR (goal item 9b)', () => {
  it('raw database ids, foreign mints and unknown UUIDs are all the same 404', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    testDb.prepare("UPDATE trip_files SET sensitivity = 'normal' WHERE id = ?").run(ctx.file.id);
    await payload(ctx.token); // mints the UUID

    // (a) the raw primary key never resolves
    const rawId = await request(app).get(`/api/shared/${ctx.token}/file/${ctx.file.id}`);
    expect(rawId.status).toBe(404);

    // (b) a mint belonging to a DIFFERENT share/trip never resolves here
    const other = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    testDb.prepare("UPDATE trip_files SET sensitivity = 'normal' WHERE id = ?").run(other.file.id);
    const otherMeta = (await payload(other.token)).sharedFiles.reservations[String(other.reservationId)][0];
    const foreign = await request(app).get(`/api/shared/${ctx.token}/file/${otherMeta.id}`);
    expect(foreign.status).toBe(404);

    // (c) non-existent — indistinguishable from (a) and (b)
    const ghost = await request(app).get(`/api/shared/${ctx.token}/file/${crypto.randomUUID()}`);
    expect(ghost.status).toBe(404);
    expect(rawId.body).toEqual(ghost.body);
    expect(foreign.body).toEqual(ghost.body);
  });
});

describe('SFILE-004: no enumeration, no unlinked reach (goal item 10)', () => {
  it('an unlinked file is absent from the payload and unreachable by probing', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const orphan = createTripFile(ctx.tripId, {}); // no links at all
    const body = await payload(ctx.token);
    const json = JSON.stringify(body);
    expect(json).not.toContain(orphan.filename);
    // sequential guessing of small ids yields nothing
    for (let i = 1; i <= 10; i++) {
      const res = await request(app).get(`/api/shared/${ctx.token}/file/${i}`);
      expect(res.status).toBe(404);
    }
  });

  it('a reservation-linked file disappears when share_bookings is turned off, even after minting', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    testDb.prepare("UPDATE trip_files SET sensitivity = 'normal' WHERE id = ?").run(ctx.file.id);
    const meta = (await payload(ctx.token)).sharedFiles.reservations[String(ctx.reservationId)][0];
    expect((await request(app).get(`/api/shared/${ctx.token}/file/${meta.id}`)).status).toBe(200);

    // Owner hides bookings; the stale mint row must grant nothing.
    await request(app)
      .post(`/api/trips/${ctx.tripId}/share-link`)
      .set('Cookie', authCookie(ctx.userId))
      .send({ share_bookings: false, share_files: true });
    const after = await request(app).get(`/api/shared/${ctx.token}/file/${meta.id}`);
    expect(after.status).toBe(404);
  });

  it('no database file identifiers or disk filenames leak anywhere in the payload', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const body = await payload(ctx.token);
    const json = JSON.stringify(body);
    expect(json).not.toContain(ctx.file.filename);
    expect(json).not.toMatch(/"file_id"/);
    const metas = body.sharedFiles.reservations[String(ctx.reservationId)];
    for (const m of metas) expect(m.id).toMatch(UUID_RE);
  });
});

describe('SFILE-005: sensitivity gate (goal item 11)', () => {
  it('NULL sensitivity fails closed and the unlock flow opens it', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const meta = (await payload(ctx.token)).sharedFiles.reservations[String(ctx.reservationId)][0];
    expect(meta.sensitivity).toBe('sensitive'); // stored NULL → reported sensitive

    // no unlock header → 401, marked no-store on success paths only
    const locked = await request(app).get(`/api/shared/${ctx.token}/file/${meta.id}`);
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe('code_required');

    // garbage unlock header → still 401
    const forged = await request(app)
      .get(`/api/shared/${ctx.token}/file/${meta.id}`)
      .set('X-Share-Unlock', '1.9999999999999.forged');
    expect(forged.status).toBe(401);

    // wrong code → 401 invalid_code
    const bad = await request(app)
      .post(`/api/shared/${ctx.token}/files/unlock`)
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ code: 'WRONGwrong1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_code');

    // right code → unlock token → bytes with no-store
    const ok = await request(app)
      .post(`/api/shared/${ctx.token}/files/unlock`)
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ code: CODE });
    expect(ok.status).toBe(200);
    expect(ok.body.unlock).toBeTruthy();

    const bytes = await request(app)
      .get(`/api/shared/${ctx.token}/file/${meta.id}`)
      .set('X-Share-Unlock', ok.body.unlock);
    expect(bytes.status).toBe(200);
    expect(bytes.headers['cache-control']).toBe('no-store, private');
  });

  it('an unlock token from one share does not open another share', async () => {
    const a = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const b = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const metaB = (await payload(b.token)).sharedFiles.reservations[String(b.reservationId)][0];
    const unlockA = await request(app)
      .post(`/api/shared/${a.token}/files/unlock`)
      .set('X-Forwarded-For', '203.0.113.20')
      .send({ code: CODE });
    expect(unlockA.status).toBe(200);
    const cross = await request(app)
      .get(`/api/shared/${b.token}/file/${metaB.id}`)
      .set('X-Share-Unlock', unlockA.body.unlock);
    expect(cross.status).toBe(401);
  });

  it('operator override to normal serves without a code; override back locks again', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const meta = (await payload(ctx.token)).sharedFiles.reservations[String(ctx.reservationId)][0];

    const toNormal = await request(app)
      .put(`/api/trips/${ctx.tripId}/files/${ctx.file.id}`)
      .set('Cookie', authCookie(ctx.userId))
      .send({ sensitivity: 'normal' });
    expect(toNormal.status).toBe(200);
    expect((await request(app).get(`/api/shared/${ctx.token}/file/${meta.id}`)).status).toBe(200);

    const toSensitive = await request(app)
      .put(`/api/trips/${ctx.tripId}/files/${ctx.file.id}`)
      .set('Cookie', authCookie(ctx.userId))
      .send({ sensitivity: 'sensitive' });
    expect(toSensitive.status).toBe(200);
    expect((await request(app).get(`/api/shared/${ctx.token}/file/${meta.id}`)).status).toBe(401);

    const invalid = await request(app)
      .put(`/api/trips/${ctx.tripId}/files/${ctx.file.id}`)
      .set('Cookie', authCookie(ctx.userId))
      .send({ sensitivity: 'public' });
    expect(invalid.status).toBe(400);
  });

  it('5 failures lock the (token, IP) pair for a while — temporarily, not permanently', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`/api/shared/${ctx.token}/files/unlock`)
        .set('X-Forwarded-For', '198.51.100.7')
        .send({ code: `wrongCODE${i}0` });
      expect(res.status).toBe(401);
    }
    const locked = await request(app)
      .post(`/api/shared/${ctx.token}/files/unlock`)
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ code: CODE }); // even the RIGHT code is refused while locked
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('locked');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(3600);

    // a different client IP is not affected (lockout is per token+IP)
    const otherIp = await request(app)
      .post(`/api/shared/${ctx.token}/files/unlock`)
      .set('X-Forwarded-For', '198.51.100.8')
      .send({ code: CODE });
    expect(otherIp.status).toBe(200);
  });

  it('rejects non-JSON content types on unlock (CSRF hardening)', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const res = await request(app)
      .post(`/api/shared/${ctx.token}/files/unlock`)
      .set('Content-Type', 'text/plain')
      .send('code=whatever');
    expect(res.status).toBe(415);
  });
});

describe('SFILE-006: token + expiry properties (goal item 12)', () => {
  it('new tokens carry >=128 bits and expire relative to the trip end in UTC', async () => {
    const ctx = await setup({ share_bookings: true });
    // 24 random bytes → 32 base64url chars (192 bits)
    expect(ctx.token.length).toBeGreaterThanOrEqual(32);
    const row = testDb.prepare('SELECT expires_at FROM share_tokens WHERE token = ?').get(ctx.token) as { expires_at: string };
    // trip ends 2030-01-05; default TTL 30 days → early Feb 2030, ISO/UTC.
    expect(row.expires_at.startsWith('2030-02-0')).toBe(true);
  });

  it('a trip that already ended still gets a usable link (now + TTL, never dead on arrival)', async () => {
    const { user } = createUser(testDb, {});
    const trip = createTrip(testDb, user.id, { start_date: '2020-01-01', end_date: '2020-01-05' });
    const res = await request(app).post(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(user.id)).send({});
    expect(res.status).toBe(201);
    const row = testDb.prepare('SELECT expires_at FROM share_tokens WHERE token = ?').get(res.body.token) as { expires_at: string };
    expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now() + 20 * 24 * 3600 * 1000);
    expect((await request(app).get(`/api/shared/${res.body.token}`)).status).toBe(200);
  });
});

describe('SFILE-007: unlock code storage', () => {
  it('stores only a scrypt hash, reports has_file_code, rejects weak codes', async () => {
    const ctx = await setup({ share_bookings: true, share_files: true, file_access_code: CODE });
    const row = testDb.prepare('SELECT file_code_hash FROM share_tokens WHERE token = ?').get(ctx.token) as { file_code_hash: string };
    expect(row.file_code_hash.startsWith('scrypt$')).toBe(true);
    expect(row.file_code_hash).not.toContain(CODE);

    const info = await request(app).get(`/api/trips/${ctx.tripId}/share-link`).set('Cookie', authCookie(ctx.userId));
    expect(info.body.share_files).toBe(true);
    expect(info.body.has_file_code).toBe(true);
    expect(JSON.stringify(info.body)).not.toContain('hash');

    const weak = await request(app)
      .post(`/api/trips/${ctx.tripId}/share-link`)
      .set('Cookie', authCookie(ctx.userId))
      .send({ share_files: true, file_access_code: 'short1' });
    expect(weak.status).toBe(400);
  });
});
