import { Injectable } from '@nestjs/common';
import { canAccessTrip } from '../../db/database';
import { checkPermission } from '../../services/permissions';
import type { User } from '../../types';
import * as svc from '../../services/shareService';
import * as filesSvc from '../../services/shareFilesService';

type Trip = NonNullable<ReturnType<typeof canAccessTrip>>;

/**
 * Thin Nest wrapper around the existing share service. Trip access, the
 * 'share_manage' permission and the token SQL reuse the legacy code unchanged.
 */
@Injectable()
export class ShareService {
  verifyTripAccess(tripId: string, userId: number) {
    return canAccessTrip(tripId, userId);
  }

  canManage(trip: Trip, user: User): boolean {
    return checkPermission('share_manage', user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  createOrUpdate(tripId: string, userId: number, permissions: Parameters<typeof svc.createOrUpdateShareLink>[2]) {
    return svc.createOrUpdateShareLink(tripId, userId, permissions);
  }
  get(tripId: string) { return svc.getShareLink(tripId); }
  remove(tripId: string) { return svc.deleteShareLink(tripId); }
  getSharedTripData(token: string) { return svc.getSharedTripData(token); }
  getSharedPlacePhotoPath(token: string, placeId: string) { return svc.getSharedPlacePhotoPath(token, placeId); }

  // Guest document access (share_files) — see services/shareFilesService.ts.
  resolveSharedFile(token: string, publicId: string, unlockToken: string | null | undefined) {
    return filesSvc.resolveSharedFile(token, publicId, unlockToken);
  }
  findShareRow(token: string) { return filesSvc.findShareRow(token); }
  unlockAllowed(token: string, ip: string) { return filesSvc.unlockAllowed(token, ip); }
  recordUnlockFailure(token: string, ip: string) { filesSvc.recordUnlockFailure(token, ip); }
  recordUnlockSuccess(token: string, ip: string) { filesSvc.recordUnlockSuccess(token, ip); }
  verifyFileCode(hash: string | null | undefined, code: string) { return filesSvc.verifyFileCode(hash, code); }
  issueUnlockToken(shareTokenId: number) { return filesSvc.issueUnlockToken(shareTokenId); }
}
