// Route readings are collected daily. Keep the last good value visible even
// when a collection is late; the age describes the observation, not the API hit.
export const ROUTE_STALE_AFTER_MS = 36 * 60 * 60 * 1000

export function describeRouteReading(observedAt: string | Date, now = Date.now()) {
  const ageMs = Math.max(0, now - new Date(observedAt).getTime())
  return {
    ageSeconds: Math.floor(ageMs / 1000),
    stale: ageMs > ROUTE_STALE_AFTER_MS,
  }
}
