import crypto from 'crypto';
import { db } from '../db/database';
import { JWT_SECRET } from '../config';
import { resolveFilePath } from './fileService';
import type { TripFile } from '../types';

/**
 * Guest document access on public share links — the security-critical surface
 * of the white-label fork. Design invariants (tested in
 * tests/integration/shared-files.test.ts):
 *
 * 1. NO IDOR: guests address files ONLY by a per-share random UUID minted into
 *    share_files. Database primary keys never appear in any shared payload or
 *    route. A wrong/foreign public id and a non-existent one are
 *    indistinguishable (both 404).
 * 2. Fail closed: trip_files.sensitivity NULL counts as 'sensitive'. Only an
 *    explicit 'normal' serves without the unlock code.
 * 3. Live authorization: the share_files table only mints identifiers; every
 *    byte served re-checks token validity, expiry, the share_files permission
 *    flag, file liveness AND a qualifying link to an entity the share flags
 *    actually expose. Stale mint rows grant nothing.
 * 4. The unlock code is scrypt-hashed at rest, verified in constant time,
 *    rate-limited per (token, client IP) with a TEMPORARY lockout, and never
 *    logged.
 */

// ---------------------------------------------------------------------------
// Unlock-code hashing (scrypt, constant-time verify)
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

export function hashFileCode(code: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(code, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyFileCode(stored: string | null | undefined, code: string): boolean {
  if (!stored || typeof code !== 'string' || code.length === 0 || code.length > 128) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(code, salt, expected.length, {
      N: parseInt(nStr, 10),
      r: parseInt(rStr, 10),
      p: parseInt(pStr, 10),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session-scoped unlock tokens (HMAC, no server state)
// ---------------------------------------------------------------------------

const UNLOCK_TTL_MS = 4 * 60 * 60 * 1000; // one browsing session, not a credential

function unlockSig(shareTokenId: number, exp: number): string {
  return crypto.createHmac('sha256', `${JWT_SECRET}:share-file-unlock`).update(`${shareTokenId}.${exp}`).digest('base64url');
}

export function issueUnlockToken(shareTokenId: number): { token: string; expiresAt: string } {
  const exp = Date.now() + UNLOCK_TTL_MS;
  return { token: `${shareTokenId}.${exp}.${unlockSig(shareTokenId, exp)}`, expiresAt: new Date(exp).toISOString() };
}

export function verifyUnlockToken(shareTokenId: number, token: string | undefined | null): boolean {
  if (!token || typeof token !== 'string' || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [idStr, expStr, sig] = parts;
  if (String(shareTokenId) !== idStr) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(unlockSig(shareTokenId, exp));
  const actual = Buffer.from(sig);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Unlock rate limiting — per (token, client IP), temporary lockout only
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 60 * 60 * 1000; // 1 hour — never permanent; a stranded client mid-trip must recover

interface LimiterEntry {
  fails: number[];
  lockedUntil: number;
}

const limiter = new Map<string, LimiterEntry>();

export function tokenHash8(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}

function limiterKey(token: string, ip: string): string {
  return `${tokenHash8(token)}|${ip}`;
}

export function unlockAllowed(token: string, ip: string): { allowed: boolean; retryAfterSeconds?: number } {
  const e = limiter.get(limiterKey(token, ip));
  if (!e) return { allowed: true };
  const now = Date.now();
  if (e.lockedUntil > now) return { allowed: false, retryAfterSeconds: Math.ceil((e.lockedUntil - now) / 1000) };
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
  return { allowed: true };
}

export function recordUnlockFailure(token: string, ip: string): void {
  const key = limiterKey(token, ip);
  const now = Date.now();
  const e = limiter.get(key) || { fails: [], lockedUntil: 0 };
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
  e.fails.push(now);
  if (e.fails.length >= MAX_FAILS) {
    e.lockedUntil = now + LOCKOUT_MS;
    e.fails = [];
  }
  limiter.set(key, e);
  // Fact of failure only — the submitted code is NEVER logged.
  console.warn(`[share-files] unlock failed token=${tokenHash8(token)} ip=${ip}`);
  if (limiter.size > 10000) {
    for (const [k, v] of limiter) {
      if (v.lockedUntil < now && v.fails.every((t) => now - t >= WINDOW_MS)) limiter.delete(k);
    }
  }
}

export function recordUnlockSuccess(token: string, ip: string): void {
  limiter.delete(limiterKey(token, ip));
}

/** Test hook. */
export function _resetUnlockLimiter(): void {
  limiter.clear();
}

// ---------------------------------------------------------------------------
// Share-row lookup (constant-time token confirmation)
// ---------------------------------------------------------------------------

export interface ShareFileRow {
  id: number;
  trip_id: number;
  token: string;
  share_map: number;
  share_bookings: number;
  share_files: number;
  file_code_hash: string | null;
}

export function findShareRow(token: string): ShareFileRow | null {
  if (typeof token !== 'string' || !token || token.length > 256) return null;
  const row = db
    .prepare("SELECT * FROM share_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))")
    .get(token) as ShareFileRow | undefined;
  if (!row) return null;
  // The indexed equality lookup already matched; re-confirm with a
  // constant-time compare so token matching never leaks timing (item 12).
  const a = Buffer.from(row.token);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Eligibility + public-id minting
// ---------------------------------------------------------------------------

interface LinkedFile extends TripFile {
  trip_id: number;
  sensitivity: string | null;
  link_reservation_ids: string | null;
  link_place_ids: string | null;
  link_assignment_ids: string | null;
}

/**
 * Every live file of the trip together with the ids of same-trip entities it
 * is linked to (legacy single-link columns + file_links rows). Cross-trip link
 * targets are excluded by the JOIN conditions.
 */
function listLinkedFiles(tripId: number | string): LinkedFile[] {
  return db
    .prepare(
      `SELECT f.*,
        (SELECT group_concat(x.rid) FROM (
           SELECT r0.id AS rid FROM reservations r0 WHERE r0.id = f.reservation_id AND r0.trip_id = f.trip_id
           UNION
           SELECT fl.reservation_id FROM file_links fl JOIN reservations r1 ON r1.id = fl.reservation_id AND r1.trip_id = f.trip_id
             WHERE fl.file_id = f.id AND fl.reservation_id IS NOT NULL
         ) x) AS link_reservation_ids,
        (SELECT group_concat(x.pid) FROM (
           SELECT p0.id AS pid FROM places p0 WHERE p0.id = f.place_id AND p0.trip_id = f.trip_id
           UNION
           SELECT fl.place_id FROM file_links fl JOIN places p1 ON p1.id = fl.place_id AND p1.trip_id = f.trip_id
             WHERE fl.file_id = f.id AND fl.place_id IS NOT NULL
         ) x) AS link_place_ids,
        (SELECT group_concat(fl.assignment_id) FROM file_links fl
           JOIN day_assignments da ON da.id = fl.assignment_id
           JOIN days d ON d.id = da.day_id AND d.trip_id = f.trip_id
           WHERE fl.file_id = f.id AND fl.assignment_id IS NOT NULL) AS link_assignment_ids
      FROM trip_files f
      WHERE f.trip_id = ? AND f.deleted_at IS NULL`
    )
    .all(tripId) as LinkedFile[];
}

function isEligible(f: LinkedFile, perms: { share_map: boolean; share_bookings: boolean }): boolean {
  const hasRes = !!f.link_reservation_ids;
  const hasPlace = !!f.link_place_ids || !!f.link_assignment_ids;
  return (perms.share_bookings && hasRes) || (perms.share_map && hasPlace);
}

function mintPublicIds(shareTokenId: number, fileIds: number[]): Map<number, string> {
  const insert = db.prepare('INSERT OR IGNORE INTO share_files (share_token_id, file_id, public_id) VALUES (?, ?, ?)');
  for (const id of fileIds) insert.run(shareTokenId, id, crypto.randomUUID());
  const rows = db
    .prepare(`SELECT file_id, public_id FROM share_files WHERE share_token_id = ?`)
    .all(shareTokenId) as { file_id: number; public_id: string }[];
  return new Map(rows.map((r) => [r.file_id, r.public_id]));
}

export interface SharedFileMeta {
  id: string; // public UUID — never a database key
  name: string;
  mime: string | null;
  size: number | null;
  sensitivity: 'sensitive' | 'normal';
  description: string | null;
}

export interface SharedFilesPayload {
  reservations: Record<string, SharedFileMeta[]>;
  places: Record<string, SharedFileMeta[]>;
  assignments: Record<string, SharedFileMeta[]>;
}

/**
 * The shared payload's file section: eligible files grouped by the entity ids
 * the page already renders. Contains public UUIDs only.
 */
export function getSharedFilesPayload(
  shareRow: { id: number; trip_id: number },
  perms: { share_map: boolean; share_bookings: boolean }
): SharedFilesPayload {
  const out: SharedFilesPayload = { reservations: {}, places: {}, assignments: {} };
  const files = listLinkedFiles(shareRow.trip_id).filter((f) => isEligible(f, perms));
  if (files.length === 0) return out;
  const ids = mintPublicIds(
    shareRow.id,
    files.map((f) => Number(f.id))
  );
  for (const f of files) {
    const meta: SharedFileMeta = {
      id: ids.get(Number(f.id))!,
      name: f.original_name,
      mime: f.mime_type ?? null,
      size: f.file_size ?? null,
      sensitivity: f.sensitivity === 'normal' ? 'normal' : 'sensitive',
      description: f.description ?? null,
    };
    if (!meta.id) continue;
    const attach = (bucket: Record<string, SharedFileMeta[]>, idList: string | null, allowed: boolean) => {
      if (!allowed || !idList) return;
      for (const entityId of String(idList).split(',')) {
        if (!entityId) continue;
        (bucket[entityId] = bucket[entityId] || []).push(meta);
      }
    };
    attach(out.reservations, f.link_reservation_ids, perms.share_bookings);
    attach(out.places, f.link_place_ids, perms.share_map);
    attach(out.assignments, f.link_assignment_ids, perms.share_map);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

export type SharedFileResolution =
  | { status: 404 }
  | { status: 401 }
  | { status: 200; file: TripFile; path: string; sensitive: boolean };

/**
 * Full authorization chain for one file request. 404 for anything that is not
 * a live, linked, share-exposed file of this token's trip — unauthorized and
 * non-existent are indistinguishable. 401 only for a payload-visible sensitive
 * file lacking a valid unlock token.
 */
export function resolveSharedFile(token: string, publicId: string, unlockToken: string | null | undefined): SharedFileResolution {
  const shareRow = findShareRow(token);
  if (!shareRow || !shareRow.share_files) return { status: 404 };
  if (typeof publicId !== 'string' || publicId.length === 0 || publicId.length > 64) return { status: 404 };

  const mint = db
    .prepare('SELECT file_id FROM share_files WHERE share_token_id = ? AND public_id = ?')
    .get(shareRow.id, publicId) as { file_id: number } | undefined;
  if (!mint) return { status: 404 };

  const perms = { share_map: !!shareRow.share_map, share_bookings: !!shareRow.share_bookings };
  const file = listLinkedFiles(shareRow.trip_id).find((f) => Number(f.id) === mint.file_id);
  if (!file || !isEligible(file, perms)) return { status: 404 };

  const sensitive = file.sensitivity !== 'normal'; // NULL fails closed
  if (sensitive && !verifyUnlockToken(shareRow.id, unlockToken)) return { status: 401 };

  const { resolved, safe } = resolveFilePath(file.filename);
  if (!safe) return { status: 404 };
  return { status: 200, file, path: resolved, sensitive };
}
