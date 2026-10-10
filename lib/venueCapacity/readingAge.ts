/** Display the recording age without hiding old evidence or implying a fresh quote. */
export const recordedAgeLabel = (observedAt: string, nowMs: number | null): string | null => {
  if (nowMs === null) return null
  const elapsed = nowMs - Date.parse(observedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'Recording time unavailable'
  const hours = Math.floor(elapsed / 3_600_000)
  if (hours >= 24) return `Stale · ${Math.floor(hours / 24)}d ${hours % 24}h old`
  if (hours >= 1) return `Recorded ${hours}h ago`
  return `Recorded ${Math.floor(elapsed / 60_000)}m ago`
}
