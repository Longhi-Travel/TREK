import { useEffect, useState } from 'react'
import { brandingApi } from '../api/client'

export interface Branding {
  name?: string
  tagline?: string
  logoUrl?: string
  accent?: string
  headerBg?: string
  displayFont?: string
  sourceUrl?: string
}

/**
 * White-label configuration for the authenticated app.
 *
 * The values are fixed for the server process, so the request is made once per
 * page load and shared by every caller. Resolves to `{}` on a stock install or
 * if the request fails, so callers fall back to TREK's own identity.
 */
let cached: Promise<Branding> | null = null

export function fetchBranding(): Promise<Branding> {
  if (!cached) cached = brandingApi.get().then(b => (b || {}) as Branding).catch(() => ({}))
  return cached
}

/** Test hook — drops the module-level cache between cases. */
export function resetBrandingCache(): void {
  cached = null
}

export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>({})
  useEffect(() => {
    let alive = true
    fetchBranding().then(b => { if (alive) setBranding(b) })
    return () => { alive = false }
  }, [])
  return branding
}
