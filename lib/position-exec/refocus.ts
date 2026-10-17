/**
 * RE-READ ON REFOCUS (owner, Q27 round 5). A reader who sees "Balance short" tops up in
 * another tab or app and comes back: the slip reads again by itself, instead of the whole
 * page being refreshed. The page regaining focus (window `focus`) or becoming visible
 * again (document `visibilitychange` to "visible") schedules one re-read; a burst of both
 * events within `debounceMs` is one re-read, and none runs sooner than `minGapMs` after
 * the last. `enabled()` is asked when the timer fires: a slip with a transaction in flight
 * never re-reads under it.
 *
 * Pure apart from the timers and listeners it is handed, so the unit test drives it with
 * plain EventTargets and fake timers.
 */

export const REFOCUS_DEBOUNCE_MS = 600
export const REFOCUS_MIN_GAP_MS = 5_000

export interface RefocusDeps {
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
    visibilityState: string
  }
  onRefocus: (atMs: number) => void
  enabled: () => boolean
  now?: () => number
  debounceMs?: number
  minGapMs?: number
}

/** Starts watching; returns the stop function. */
export function watchRefocus(d: RefocusDeps): () => void {
  const now = d.now ?? Date.now
  const debounce = d.debounceMs ?? REFOCUS_DEBOUNCE_MS
  const gap = d.minGapMs ?? REFOCUS_MIN_GAP_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = -Infinity
  // Leaving the page is not a refocus: only coming back schedules a read.
  let away = d.doc.visibilityState === 'hidden'

  const fire = () => {
    timer = null
    const t = now()
    if (t - last < gap || !d.enabled()) return
    last = t
    d.onRefocus(t)
  }
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(fire, debounce)
  }
  const onVisibility = () => {
    if (d.doc.visibilityState === 'hidden') {
      away = true
      return
    }
    if (away) {
      away = false
      schedule()
    }
  }
  const onFocus = () => {
    if (!away) return
    away = false
    schedule()
  }
  const onBlur = () => {
    away = true
  }

  d.doc.addEventListener('visibilitychange', onVisibility)
  d.win.addEventListener('focus', onFocus)
  d.win.addEventListener('blur', onBlur)
  return () => {
    if (timer !== null) clearTimeout(timer)
    d.doc.removeEventListener('visibilitychange', onVisibility)
    d.win.removeEventListener('focus', onFocus)
    d.win.removeEventListener('blur', onBlur)
  }
}

/** "re-read at 14:02:09" in the reader's local time, 24-hour. */
export function rereadLine(atMs: number): string {
  const d = new Date(atMs)
  const two = (n: number) => String(n).padStart(2, '0')
  return `re-read at ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
