/** One bounded acquisition. Pacing and physical requests share the same lifetime. */
export function createMorphoHistoricalHolderEaCaptureControl({
  monotonicNow = () => performance.now(),
  wallNow = Date.now,
  pace = () => new Promise((resolve) => setTimeout(resolve, 250)),
} = {}) {
  const started = monotonicNow()
  const pending = new Set()
  const windows = new WeakMap()
  const events = []
  let stopped = false

  function openWindow() {
    if (stopped) throw new Error('capture_stopped')
    const token = Object.freeze({})
    windows.set(token, { until: monotonicNow() + 12_000, closed: false })
    return token
  }

  function closeWindow(token) {
    const window = windows.get(token)
    if (!window) throw new Error('unknown_read_window')
    window.closed = true
  }

  function request(host, wire, physical, token) {
    const window = token === undefined ? null : windows.get(token)
    if (token !== undefined && !window) return Promise.reject(new Error('unknown_read_window'))
    const remaining = () => {
      if (stopped || window?.closed || events.length >= 48) throw new Error('capture_budget')
      const at = monotonicNow()
      const budget = Math.min(started + 120_000 - at, window ? window.until - at : Infinity)
      if (budget <= 0) throw new Error('capture_budget')
      return budget
    }
    // Track before the first await, including an origin that times out while pacing.
    const work = Promise.resolve().then(async () => {
      remaining()
      await pace()
      const timeoutMs = Math.min(8_000, remaining())
      const attempt = {
        host,
        wire,
        status: 'pending',
        startedAtUtc: new Date(wallNow()).toISOString(),
      }
      events.push(attempt)
      let result
      try {
        result = await physical(wire, timeoutMs)
        Object.assign(attempt, {
          status: 'completed',
          result,
          completedAtUtc: new Date(wallNow()).toISOString(),
        })
      } catch {
        Object.assign(attempt, {
          status: 'failed',
          error: 'native_request_failed',
          completedAtUtc: new Date(wallNow()).toISOString(),
        })
        throw new Error('native_request_failed')
      }
      const completed = monotonicNow()
      if (completed > started + 120_000 || (window && completed > window.until)) {
        // Retain the actual completed response, while refusing a late capture.
        attempt.deadlineExceeded = true
        throw new Error('capture_deadline')
      }
      return result
    })
    pending.add(work)
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }

  async function finish() {
    stopped = true
    await Promise.allSettled([...pending])
    return events
  }

  return { openWindow, closeWindow, request, finish }
}
