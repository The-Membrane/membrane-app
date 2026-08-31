// SSR-safe localStorage access for the Builder. The proto persisted calls, the seed book,
// and the view mode directly to window.localStorage; every access here is guarded so the
// same code is inert during server render (proto :1440, :2335, :2547).

import { CAL_KEY, SEEDS_KEY, VIEW_KEY } from '../fixtures'
import { Forecast, SeedBookEntry } from '../types'

const hasWindow = () => typeof window !== 'undefined'

export function loadCalls(): { calls: Forecast[]; skipped: number } {
  if (!hasWindow()) return { calls: [], skipped: 0 }
  try {
    const raw = window.localStorage.getItem(CAL_KEY)
    if (!raw) return { calls: [], skipped: 0 }
    const d = JSON.parse(raw)
    return {
      calls: Array.isArray(d.calls)
        ? d.calls.filter((f: Forecast) => f && typeof f.p === 'number' && (f.o === 0 || f.o === 1))
        : [],
      skipped: typeof d.skipped === 'number' ? d.skipped : 0,
    }
  } catch {
    // private mode, quota, or corrupt JSON
    return { calls: [], skipped: 0 }
  }
}

export function saveCalls(calls: Forecast[], skipped: number): void {
  if (!hasWindow()) return
  try {
    window.localStorage.setItem(CAL_KEY, JSON.stringify({ calls, skipped, v: 1 }))
  } catch {
    /* ignore */
  }
}

export function loadSeedBook(): Record<string, SeedBookEntry> {
  if (!hasWindow()) return {}
  try {
    const r = window.localStorage.getItem(SEEDS_KEY)
    return r ? JSON.parse(r) : {}
  } catch {
    return {}
  }
}

export function saveSeedBook(bk: Record<string, SeedBookEntry>): void {
  if (!hasWindow()) return
  try {
    window.localStorage.setItem(SEEDS_KEY, JSON.stringify(bk))
  } catch {
    /* ignore */
  }
}

export function loadView(): boolean {
  if (!hasWindow()) return false
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'vet'
  } catch {
    return false
  }
}

export function saveView(vet: boolean): void {
  if (!hasWindow()) return
  try {
    window.localStorage.setItem(VIEW_KEY, vet ? 'vet' : 'first')
  } catch {
    /* ignore */
  }
}
