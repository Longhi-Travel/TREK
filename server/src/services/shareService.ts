import { db, canAccessTrip } from '../db/database';
import crypto from 'crypto';
import { loadTagsByPlaceIds } from './queryHelpers';
import { serveFilePath } from './placePhotoCache';
import { getUserSettings } from './settingsService';
import { findShareRow, getSharedFilesPayload, hashFileCode } from './shareFilesService';

const PLACE_PHOTO_PROXY_PREFIX = '/api/maps/place-photo/';

/**
 * Place photo proxy URLs (`/api/maps/place-photo/<id>/bytes`) are served by the
 * JWT-guarded MapsController, so they 401 for an unauthenticated shared-trip
 * viewer. Rewrite them to the public, token-scoped equivalent
 * (`/api/shared/<token>/place-photo/<id>/bytes`) so thumbnails load in a shared
 * link. A simple prefix swap keeps the already-encoded placeId segment intact, so
 * the URL round-trips. Non-proxy URLs (data:, /uploads/, null) pass through.
 */
function rewritePlacePhotoUrl(url: string | null | undefined, token: string): string | null {
  if (typeof url === 'string' && url.startsWith(PLACE_PHOTO_PROXY_PREFIX)) {
    return `/api/shared/${token}/place-photo/${url.slice(PLACE_PHOTO_PROXY_PREFIX.length)}`;
  }
  return url ?? null;
}

interface SharePermissions {
  share_map?: boolean;
  share_bookings?: boolean;
  share_packing?: boolean;
  share_budget?: boolean;
  share_collab?: boolean;
  /** Guest document access — defaults OFF; explicit per-trip opt-in (goal item 13). */
  share_files?: boolean;
  /**
   * Unlock code for sensitive files. undefined = leave unchanged;
   * '' or null = clear; a value = scrypt-hash and store. Never stored or
   * logged in plaintext.
   */
  file_access_code?: string | null;
}

interface ShareTokenInfo {
  token: string;
  created_at: string;
  share_map: boolean;
  share_bookings: boolean;
  share_packing: boolean;
  share_budget: boolean;
  share_collab: boolean;
  share_files: boolean;
  has_file_code: boolean;
}

/**
 * New-link expiry: SHARE_LINK_TTL_DAYS (default 30) after the trip's end date —
 * a share link should outlive the trip briefly, not indefinitely. Trips whose
 * end already passed (or that have none) get now + TTL so a fresh link is
 * never dead on arrival. Existing rows are never touched. Stored and compared
 * in UTC (ISO strings vs SQLite datetime('now')).
 */
function computeShareExpiry(tripId: string): string {
  const ttlDays = Math.max(1, parseInt(process.env.SHARE_LINK_TTL_DAYS || '30', 10) || 30);
  const trip = db.prepare('SELECT end_date FROM trips WHERE id = ?').get(tripId) as { end_date: string | null } | undefined;
  const now = Date.now();
  let base = now;
  if (trip?.end_date) {
    const end = Date.parse(`${trip.end_date}T23:59:59Z`);
    if (Number.isFinite(end) && end > now) base = end;
  }
  return new Date(base + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Creates a new share link or updates the permissions on an existing one.
 * Returns an object with the token string and whether it was newly created.
 */
export function createOrUpdateShareLink(
  tripId: string,
  createdBy: number,
  permissions: SharePermissions
): { token: string; created: boolean } {
  const {
    share_map = true,
    share_bookings = true,
    share_packing = false,
    share_budget = false,
    share_collab = false,
    share_files = false,
    file_access_code,
  } = permissions;

  if (file_access_code !== undefined && file_access_code !== null && file_access_code !== '') {
    if (!/^[A-Za-z0-9]{10,64}$/.test(file_access_code)) {
      throw new Error('File access code must be 10-64 letters/digits');
    }
  }
  // undefined → keep stored hash; ''/null → clear; value → replace.
  const codeHash =
    file_access_code === undefined ? undefined : file_access_code ? hashFileCode(file_access_code) : null;

  const existing = db.prepare('SELECT token FROM share_tokens WHERE trip_id = ?').get(tripId) as { token: string } | undefined;
  if (existing) {
    db.prepare('UPDATE share_tokens SET share_map = ?, share_bookings = ?, share_packing = ?, share_budget = ?, share_collab = ?, share_files = ? WHERE trip_id = ?')
      .run(share_map ? 1 : 0, share_bookings ? 1 : 0, share_packing ? 1 : 0, share_budget ? 1 : 0, share_collab ? 1 : 0, share_files ? 1 : 0, tripId);
    if (codeHash !== undefined) {
      db.prepare('UPDATE share_tokens SET file_code_hash = ? WHERE trip_id = ?').run(codeHash, tripId);
    }
    return { token: existing.token, created: false };
  }

  // 192-bit URL-safe token (item 12: ≥128 bits). Expiry follows the trip's end
  // date — see computeShareExpiry. Pre-migration NULL rows stay valid.
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = computeShareExpiry(tripId);
  db.prepare('INSERT INTO share_tokens (trip_id, token, created_by, share_map, share_bookings, share_packing, share_budget, share_collab, share_files, file_code_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tripId, token, createdBy, share_map ? 1 : 0, share_bookings ? 1 : 0, share_packing ? 1 : 0, share_budget ? 1 : 0, share_collab ? 1 : 0, share_files ? 1 : 0, codeHash ?? null, expiresAt);
  return { token, created: true };
}

/**
 * Returns share token info for a trip, or null if no share link exists.
 */
export function getShareLink(tripId: string): ShareTokenInfo | null {
  const row = db.prepare('SELECT * FROM share_tokens WHERE trip_id = ?').get(tripId) as any;
  if (!row) return null;
  return {
    token: row.token,
    created_at: row.created_at,
    share_map: !!row.share_map,
    share_bookings: !!row.share_bookings,
    share_packing: !!row.share_packing,
    share_budget: !!row.share_budget,
    share_collab: !!row.share_collab,
    share_files: !!row.share_files,
    has_file_code: !!row.file_code_hash,
  };
}

/**
 * Deletes the share token for a trip.
 */
export function deleteShareLink(tripId: string): void {
  db.prepare('DELETE FROM share_tokens WHERE trip_id = ?').run(tripId);
}

/**
 * Loads the full public trip data for a share token, filtered by the token's
 * permission flags. Returns null if the token is invalid or the trip is gone.
 */
export function getSharedTripData(token: string): Record<string, any> | null {
  // findShareRow validates expiry and re-confirms the token equality in
  // constant time (item 12).
  const shareRow = findShareRow(token) as any;
  if (!shareRow) return null;

  const tripId = shareRow.trip_id;

  // Trip
  const trip = db.prepare('SELECT id, title, description, start_date, end_date, cover_image, currency, emergency_info, updated_at FROM trips WHERE id = ?').get(tripId) as Record<string, any> | undefined;
  if (!trip) return null;

  // Passive change signal: both stamps are UTC CURRENT_TIMESTAMP strings in the
  // same format, so a lexicographic compare is a date compare. Non-null only
  // when the itinerary changed after this share link was created.
  const updatedSinceShare =
    trip.updated_at && shareRow.created_at && String(trip.updated_at) > String(shareRow.created_at)
      ? trip.updated_at
      : null;

  // Days with assignments
  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId) as any[];
  const dayIds = days.map(d => d.id);

  let assignments: Record<number, any[]> = {};
  let dayNotes: Record<number, any[]> = {};
  if (dayIds.length > 0) {
    const ph = dayIds.map(() => '?').join(',');
    const allAssignments = db.prepare(`
      SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
        p.lat, p.lng, p.address, p.website, p.category_id, p.price, p.currency as place_currency,
        COALESCE(da.assignment_time, p.place_time) as place_time,
        COALESCE(da.assignment_end_time, p.end_time) as end_time,
        p.duration_minutes, p.notes as place_notes, p.image_url, p.transport_mode,
        c.name as category_name, c.color as category_color, c.icon as category_icon
      FROM day_assignments da
      JOIN places p ON da.place_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE da.day_id IN (${ph})
      ORDER BY da.order_index ASC, da.created_at ASC
    `).all(...dayIds);

    const placeIds = [...new Set(allAssignments.map((a: any) => a.place_id))];
    const tagsByPlace = loadTagsByPlaceIds(placeIds, { compact: true });

    const byDay: Record<number, any[]> = {};
    for (const a of allAssignments as any[]) {
      if (!byDay[a.day_id]) byDay[a.day_id] = [];
      byDay[a.day_id].push({
        id: a.id, day_id: a.day_id, order_index: a.order_index, notes: a.notes,
        place: {
          id: a.place_id, name: a.place_name, description: a.place_description,
          lat: a.lat, lng: a.lng, address: a.address, website: a.website, category_id: a.category_id,
          price: a.price, place_time: a.place_time, end_time: a.end_time,
          image_url: rewritePlacePhotoUrl(a.image_url, token), transport_mode: a.transport_mode,
          category: a.category_id ? { id: a.category_id, name: a.category_name, color: a.category_color, icon: a.category_icon } : null,
          tags: tagsByPlace[a.place_id] || [],
        }
      });
    }
    assignments = byDay;

    const allNotes = db.prepare(`SELECT * FROM day_notes WHERE day_id IN (${ph}) ORDER BY sort_order ASC, created_at ASC`).all(...dayIds);
    const notesByDay: Record<number, any[]> = {};
    for (const n of allNotes as any[]) {
      if (!notesByDay[n.day_id]) notesByDay[n.day_id] = [];
      notesByDay[n.day_id].push(n);
    }
    dayNotes = notesByDay;
  }

  // Places
  const places = (db.prepare(`
    SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.trip_id = ? ORDER BY p.created_at DESC
  `).all(tripId) as any[]).map((p) => ({ ...p, image_url: rewritePlacePhotoUrl(p.image_url, token) }));

  // Reservations — include per-day positions so the client can render the same order as the planner
  const reservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ? ORDER BY reservation_time ASC').all(tripId) as any[];

  const dayPositions = db.prepare(`
    SELECT rdp.reservation_id, rdp.day_id, rdp.position
    FROM reservation_day_positions rdp
    JOIN reservations r ON rdp.reservation_id = r.id
    WHERE r.trip_id = ?
  `).all(tripId) as { reservation_id: number; day_id: number; position: number }[];

  const posMap = new Map<number, Record<number, number>>();
  for (const dp of dayPositions) {
    if (!posMap.has(dp.reservation_id)) posMap.set(dp.reservation_id, {});
    posMap.get(dp.reservation_id)![dp.day_id] = dp.position;
  }
  for (const r of reservations) {
    r.day_positions = posMap.get(r.id) || null;
  }

  // Accommodations
  const accommodations = db.prepare(`
    SELECT a.*, p.name as place_name, p.address as place_address, p.lat as place_lat, p.lng as place_lng
    FROM day_accommodations a JOIN places p ON a.place_id = p.id
    WHERE a.trip_id = ?
  `).all(tripId);

  // Packing — a public viewer is neither owner nor recipient, so only Common items
  // may surface; never a co-member's private/personal packing items (#858).
  const packing = db.prepare('SELECT * FROM packing_items WHERE trip_id = ? AND is_private = 0 ORDER BY sort_order ASC').all(tripId);

  // Budget
  const budget = db.prepare('SELECT * FROM budget_items WHERE trip_id = ? ORDER BY category ASC').all(tripId);

  // Categories
  const categories = db.prepare('SELECT * FROM categories').all();

  const permissions = {
    share_map: !!shareRow.share_map,
    share_bookings: !!shareRow.share_bookings,
    share_packing: !!shareRow.share_packing,
    share_budget: !!shareRow.share_budget,
    share_collab: !!shareRow.share_collab,
    share_files: !!shareRow.share_files,
  };

  // Guest-visible documents: public UUIDs grouped by the entity ids the page
  // renders. Nothing here when the owner left documents off. Note for the
  // payload audit (goal item 10): this is the ONLY place file identifiers
  // enter the shared payload, and they are per-share mints, not DB keys.
  const sharedFiles = permissions.share_files
    ? getSharedFilesPayload({ id: shareRow.id, trip_id: tripId }, permissions)
    : null;

  // Collab messages (only if owner chose to share)
  const collabMessages = permissions.share_collab
    ? db.prepare('SELECT m.*, u.username, u.avatar FROM collab_messages m JOIN users u ON m.user_id = u.id WHERE m.trip_id = ? AND m.deleted = 0 ORDER BY m.created_at').all(tripId)
    : [];

  // Display currency the share owner sees in their Costs view. A public viewer has
  // no logged-in user, so the owner's per-user `default_currency` (with the admin
  // instance default already merged in by getUserSettings) is embedded in the
  // payload and used by the client to convert every expense — otherwise guests
  // fall back to the trip's base currency and see the wrong totals (#1361).
  // getUserSettings merges admin defaults under the user's own settings, so this
  // honours per-user → admin-default; we then fall back to trip currency → EUR.
  let baseCurrency = (trip as { currency?: string }).currency || 'EUR';
  if (shareRow.created_by != null) {
    const ownerDefault = getUserSettings(shareRow.created_by)['default_currency'];
    if (typeof ownerDefault === 'string' && ownerDefault.trim()) {
      baseCurrency = ownerDefault.trim();
    }
  }

  // Honour every share flag server-side — the client gates these too, but it must
  // not rely on that (mirrors journeyShareService). share_map covers the whole
  // itinerary: days, their assignments/notes, and the place list with coordinates,
  // addresses and notes. Withhold it when the owner disabled the map.
  return {
    trip, baseCurrency, categories, permissions, updatedSinceShare, sharedFiles,
    days: permissions.share_map ? days : [],
    assignments: permissions.share_map ? assignments : {},
    dayNotes: permissions.share_map ? dayNotes : {},
    places: permissions.share_map ? places : [],
    reservations: permissions.share_bookings ? reservations : [],
    accommodations: permissions.share_bookings ? accommodations : [],
    packing: permissions.share_packing ? packing : [],
    budget: permissions.share_budget ? budget : [],
    collab: collabMessages,
  };
}

/**
 * Resolves the on-disk path for a cached place photo requested through a public
 * share link. Validates that the token is valid + unexpired and that the place
 * actually belongs to that token's trip (matched via the stored proxy URL, which
 * covers both Google `placeId` and Wikimedia `coords:` pseudo-IDs without
 * depending on google_place_id). Returns null — never throws — so the caller
 * answers a plain 404, mirroring the authenticated bytes endpoint.
 */
export function getSharedPlacePhotoPath(token: string, placeId: string): string | null {
  const shareRow = db.prepare(
    "SELECT trip_id, share_map FROM share_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
  ).get(token) as { trip_id: string; share_map: number } | undefined;
  if (!shareRow) return null;
  // Place photos belong to the map/itinerary section — withhold them when the
  // owner disabled the map, matching getSharedTripData which no longer returns
  // the places (and thus their ids) in that case.
  if (!shareRow.share_map) return null;

  const expectedUrl = `${PLACE_PHOTO_PROXY_PREFIX}${encodeURIComponent(placeId)}/bytes`;
  const place = db.prepare(
    'SELECT 1 FROM places WHERE trip_id = ? AND image_url = ?'
  ).get(shareRow.trip_id, expectedUrl);
  if (!place) return null;

  return serveFilePath(placeId);
}
