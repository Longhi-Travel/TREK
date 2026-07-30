import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { brandingApi, shareApi } from '../../api/client'
import { useExchangeRates } from '../../hooks/useExchangeRates'

export interface SharedBranding {
  name?: string
  tagline?: string
  logoUrl?: string
  accent?: string
  headerBg?: string
  displayFont?: string
  sourceUrl?: string
}

/**
 * Shared-trip (public) data hook — owns the token lookup, the read-only share
 * fetch and the view state (selected day, active tab, language picker).
 * SharedTripPage is a pure wiring container; the post-load derivations
 * (sortedDays, map places, …) stay in the page next to the JSX that uses them.
 * Behaviour is identical to the previous in-component logic.
 */
export function useSharedTrip() {
  const { token } = useParams<{ token: string }>()
  // The shared payload is an open-ended snapshot (trip, days, assignments, …),
  // matched 1:1 from the public share endpoint — kept loosely typed as before.
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  // Non-null when the snapshot came from the offline service-worker cache —
  // the page shows a "cached copy from <date>" banner so nobody acts on stale
  // emergency contacts without knowing.
  const [cachedAt, setCachedAt] = useState<string | null>(null)
  // Env-driven white-label branding; {} on a stock install (or when the fetch
  // fails) so every consumer falls back to stock TREK appearance.
  const [brand, setBrand] = useState<SharedBranding>({})
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState('plan')
  const [showLangPicker, setShowLangPicker] = useState(false)

  useEffect(() => {
    if (!token) return
    // Branding resolves with the snapshot so the hero paints branded on first
    // render instead of flashing stock TREK.
    Promise.all([
      shareApi.getSharedTripCached(token),
      brandingApi.get().catch(() => ({}) as Record<string, string>),
    ])
      .then(([{ data, cachedAt }, branding]) => {
        setBrand(branding || {})
        setData(data)
        setCachedAt(cachedAt)
      })
      .catch(() => setError(true))
  }, [token])

  // Offline support: register the shared-page service worker and, once the
  // snapshot is in, ask it to precache the shell + hashed assets + trip JSON so
  // the itinerary (and its pinned emergency block) survives airplane mode from
  // the very first visit.
  useEffect(() => {
    if (!token || !data || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let cancelled = false
    navigator.serviceWorker
      .register('/shared-sw.js')
      .then((reg) => {
        if (cancelled) return
        const target = reg.active || reg.waiting || reg.installing
        const send = (sw: ServiceWorker | null) => {
          if (!sw) return
          const assets = performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .filter((u) => {
              try {
                const p = new URL(u, location.origin)
                return p.origin === location.origin && /^\/(assets|icons|fonts)\//.test(p.pathname)
              } catch {
                return false
              }
            })
          sw.postMessage({
            type: 'precache',
            urls: [location.pathname, `/api/shared/${token}`, '/api/branding', ...assets],
          })
        }
        if (target && target.state === 'activated') send(target)
        else if (target) target.addEventListener('statechange', () => target.state === 'activated' && send(target))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [token, data])

  // The server now withholds the whole itinerary when the owner disabled the map
  // (share_map=false), so the Plan tab has nothing to show — land on the first
  // section the owner actually shared instead of an empty map.
  useEffect(() => {
    if (!data) return
    const p = data.permissions || {}
    if (p.share_map === false && activeTab === 'plan') {
      setActiveTab(
        p.share_bookings ? 'bookings' : p.share_packing ? 'packing' : p.share_budget ? 'budget' : p.share_collab ? 'collab' : 'plan'
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Budget display currency = what the share owner sees in Costs (embedded in the
  // payload as baseCurrency), falling back to the trip's own currency, then EUR.
  // Convert every expense into it via live FX, mirroring CostsPanel — a public
  // viewer has no settings store, so the base comes from the payload (#1361).
  const base = String(data?.baseCurrency || data?.trip?.currency || 'EUR').toUpperCase()
  const { convert } = useExchangeRates(base)

  return { data, error, cachedAt, brand, base, convert, selectedDay, setSelectedDay, activeTab, setActiveTab, showLangPicker, setShowLangPicker }
}
