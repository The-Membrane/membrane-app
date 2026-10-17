/**
 * THE SETTLED TOAST'S CLOCK (owner, Q27 round 5): it fades out after about 6 s, the clock
 * stops while the pointer is over it or it holds focus, and it can be dismissed at once.
 * Pure apart from the setTimeout it is handed, so a unit test runs it on fake timers.
 */

export const TOAST_MS = 6_000

export interface PausableTimer {
  pause: () => void
  resume: () => void
  stop: () => void
  /** Milliseconds left, as of now. */
  left: () => number
}

export function pausableTimer(
  ms: number,
  onDone: () => void,
  now: () => number = Date.now,
): PausableTimer {
  let left = ms
  let started: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let done = false

  const run = () => {
    if (done || timer !== null) return
    started = now()
    timer = setTimeout(() => {
      timer = null
      done = true
      onDone()
    }, left)
  }
  const pause = () => {
    if (done || timer === null || started === null) return
    clearTimeout(timer)
    timer = null
    left = Math.max(0, left - (now() - started))
    started = null
  }
  run()
  return {
    pause,
    resume: run,
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      done = true
    },
    left: () => (done ? 0 : started === null ? left : Math.max(0, left - (now() - started))),
  }
}
