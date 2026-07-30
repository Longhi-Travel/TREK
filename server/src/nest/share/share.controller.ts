import { Body, Controller, Delete, Get, Headers, HttpException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { User } from '../../types';
import { ShareService } from './share.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { getClientIp } from '../../services/auditLog';

/**
 * /api/trips/:tripId/share-link — manage a trip's public read-only share token.
 *
 * Byte-identical to the legacy Express route (server/src/routes/share.ts): trip
 * access (404), the 'share_manage' permission (403), and the create-vs-update
 * status split (201 on first creation, 200 on a subsequent update).
 */
@Controller('api/trips/:tripId/share-link')
@UseGuards(JwtAuthGuard)
export class TripShareController {
  constructor(private readonly share: ShareService) {}

  private requireManage(tripId: string, user: User) {
    const trip = this.share.verifyTripAccess(tripId, user.id);
    if (!trip) {
      throw new HttpException({ error: 'Trip not found' }, 404);
    }
    if (!this.share.canManage(trip, user)) {
      throw new HttpException({ error: 'No permission' }, 403);
    }
  }

  @Post()
  create(
    @CurrentUser() user: User,
    @Param('tripId') tripId: string,
    @Body() body: { share_map?: boolean; share_bookings?: boolean; share_packing?: boolean; share_budget?: boolean; share_collab?: boolean; share_files?: boolean; file_access_code?: string | null },
    @Res({ passthrough: true }) res: Response,
  ) {
    this.requireManage(tripId, user);
    if (body.file_access_code !== undefined && body.file_access_code !== null && typeof body.file_access_code !== 'string') {
      throw new HttpException({ error: 'Invalid file access code' }, 400);
    }
    let result: { token: string; created: boolean };
    try {
      result = this.share.createOrUpdate(tripId, user.id, {
        share_map: body.share_map,
        share_bookings: body.share_bookings,
        share_packing: body.share_packing,
        share_budget: body.share_budget,
        share_collab: body.share_collab,
        share_files: body.share_files,
        file_access_code: body.file_access_code,
      });
    } catch (e) {
      throw new HttpException({ error: e instanceof Error ? e.message : 'Invalid share settings' }, 400);
    }
    // 201 only on first creation; an update answers 200, mirroring the legacy route.
    res.status(result.created ? 201 : 200);
    return { token: result.token };
  }

  @Get()
  get(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    if (!this.share.verifyTripAccess(tripId, user.id)) {
      throw new HttpException({ error: 'Trip not found' }, 404);
    }
    const info = this.share.get(tripId);
    return info ? info : { token: null };
  }

  @Delete()
  remove(@CurrentUser() user: User, @Param('tripId') tripId: string) {
    this.requireManage(tripId, user);
    this.share.remove(tripId);
    return { success: true };
  }
}

/**
 * GET /api/shared/:token — public, unauthenticated read-only trip snapshot.
 * Deliberately NOT behind a guard; an invalid/expired token answers 404.
 */
@Controller('api/shared')
export class SharedController {
  constructor(private readonly share: ShareService) {}

  /**
   * Public, token-scoped place-photo proxy. The shared payload rewrites place
   * image URLs to this route so thumbnails load without a session cookie (the
   * /api/maps bytes endpoint is JwtAuthGuard'd). The service validates the token
   * and that the place belongs to its trip; a miss streams nothing and answers
   * 404. Declared before the bare ':token' read route. Streaming mirrors
   * MapsController.placePhotoBytes (cached photos are always JPEG).
   */
  @Get(':token/place-photo/:placeId/bytes')
  placePhotoBytes(@Param('token') token: string, @Param('placeId') placeId: string, @Res() res: Response): void {
    const fp = this.share.getSharedPlacePhotoPath(token, placeId);
    if (!fp) {
      res.status(404).json({ error: 'Photo not cached' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.type('image/jpeg');
    const stream = createReadStream(fp);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Photo not cached' });
    });
    stream.pipe(res);
  }

  /**
   * Token-scoped file bytes for guest document access (share_files). The whole
   * authorization chain lives in shareFilesService.resolveSharedFile: token +
   * expiry + share_files flag + per-share public UUID + live link eligibility.
   * Anything unauthorized answers the same 404 as anything non-existent (no
   * IDOR, no enumeration oracle); only a payload-visible sensitive file
   * lacking a valid unlock token answers 401. Declared before ':token'.
   */
  @Get(':token/file/:publicId')
  fileBytes(
    @Param('token') token: string,
    @Param('publicId') publicId: string,
    @Headers('x-share-unlock') unlock: string | undefined,
    @Res() res: Response,
  ): void {
    const r = this.share.resolveSharedFile(token, publicId, unlock);
    if (r.status === 404) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (r.status === 401) {
      res.status(401).json({ error: 'code_required' });
      return;
    }
    if (!existsSync(r.path)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Sensitive bytes must never land in shared/proxy caches (goal item 11);
    // normal files may cache briefly, privately.
    res.setHeader('Cache-Control', r.sensitive ? 'no-store, private' : 'private, max-age=300');
    const ext = path.extname(r.path).toLowerCase();
    const walletMime =
      ext === '.pkpass' ? 'application/vnd.apple.pkpass' : ext === '.pkpasses' ? 'application/vnd.apple.pkpasses' : null;
    if (walletMime) res.setHeader('Content-Type', walletMime);
    else if (r.file.mime_type) res.setHeader('Content-Type', r.file.mime_type);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(r.file.original_name || 'document').replace(/["\r\n]/g, '')}"`
    );
    // Root-relative sendFile — see FilesDownloadController for why.
    res.sendFile(path.basename(r.path), { root: path.dirname(r.path) });
  }

  /**
   * POST /api/shared/:token/files/unlock — exchange the operator-issued code
   * for a session-scoped unlock token. Strictly application/json (a cross-site
   * form/no-cors POST cannot set that content type without a CORS preflight,
   * which closes the CSRF lockout-griefing vector). Rate limited per
   * (token, IP): 5 failures / 15 min → 1 h temporary lockout. The submitted
   * code is never logged.
   */
  @Post(':token/files/unlock')
  unlock(
    @Param('token') token: string,
    @Body() body: { code?: unknown },
    @Headers('content-type') contentType: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'application/json required' });
      return;
    }
    const shareRow = this.share.findShareRow(token);
    if (!shareRow || !shareRow.share_files || !shareRow.file_code_hash) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const ip = getClientIp(req) || req.ip || 'unknown';
    const gate = this.share.unlockAllowed(token, ip);
    if (!gate.allowed) {
      res.setHeader('Retry-After', String(gate.retryAfterSeconds ?? 3600));
      res.status(429).json({ error: 'locked', retryAfterSeconds: gate.retryAfterSeconds ?? 3600 });
      return;
    }
    const code = typeof body?.code === 'string' ? body.code : '';
    if (!this.share.verifyFileCode(shareRow.file_code_hash, code)) {
      this.share.recordUnlockFailure(token, ip);
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    this.share.recordUnlockSuccess(token, ip);
    const issued = this.share.issueUnlockToken(shareRow.id);
    res.status(200).json({ unlock: issued.token, expiresAt: issued.expiresAt });
  }

  @Get(':token')
  read(@Param('token') token: string) {
    const data = this.share.getSharedTripData(token);
    if (!data) {
      throw new HttpException({ error: 'Invalid or expired link' }, 404);
    }
    return data;
  }
}
