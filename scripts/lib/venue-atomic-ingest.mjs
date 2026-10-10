// Offline parity check for the database-derived atomic-v1 event rules.
// The commit path never supplies caller-computed events to the database.
// Compare ONLY consecutive atomic-v1 observations. The first marked row is
// a fresh baseline, even when legacy observed rows exist.

const META_KEYS = new Set([
  'kind',
  'reads',
  'instant_note',
  'depthMarkets',
  'depth_note',
  'depth_complete',
  'read_block_pinned',
  'read_block_finalized',
  'read_block_number',
  'read_block_hash',
  'read_block_time',
  'utilization_note',
  'variableDebtToken',
])
const CONTINUOUS_KEYS = new Set([
  'totalAssets',
  'totalSupply',
  'underlyingBalance',
  'depth_usd',
  'depth_skew_pct',
  'variableDebt',
  'utilization_pct',
])
const SHIFT = 0.2
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/

export function isAtomicFinalizedSource(row) {
  const params = row?.params
  return (
    params?.read_block_finalized === true &&
    params?.read_block_pinned === true &&
    BLOCK_HASH.test(params?.read_block_hash ?? '') &&
    Number.isInteger(params?.read_block_time) &&
    /^\d+$/.test(String(row.block ?? '')) &&
    String(row.block) === String(params.read_block_number)
  )
}

export function buildAtomicVenueEvents(previous, next) {
  if (!previous) return []
  if (previous.recorder_atomic_v1 !== true) {
    throw new Error('venue_atomic_legacy_predecessor')
  }
  if (!isAtomicFinalizedSource(previous) || !isAtomicFinalizedSource(next)) {
    throw new Error('venue_atomic_unsealed_comparison')
  }
  if (BigInt(next.block) <= BigInt(previous.block)) {
    throw new Error('venue_atomic_nonmonotonic_comparison')
  }

  const events = []
  const before = previous.params ?? {}
  const after = next.params ?? {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (META_KEYS.has(key)) continue
    const a = before[key]
    const b = after[key]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    if (a === undefined || a === null || b === undefined || b === null) continue
    if (CONTINUOUS_KEYS.has(key)) {
      const oldValue = Number(a)
      const newValue = Number(b)
      if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || oldValue === 0) continue
      if (Math.abs(newValue - oldValue) / Math.abs(oldValue) <= SHIFT) continue
    }
    events.push({
      kind: key === 'cooldownDuration' ? 'cooldown_duration_changed' : 'param_changed',
      prev: { [key]: a },
      next: { [key]: b },
      note: `${key}: ${a} -> ${b}`,
    })
  }
  const oldUsd =
    previous.instant_usd === null || previous.instant_usd === undefined
      ? null
      : Number(previous.instant_usd)
  const newUsd =
    next.instantUsd === null || next.instantUsd === undefined ? null : Number(next.instantUsd)
  if (
    oldUsd !== null &&
    newUsd !== null &&
    Number.isFinite(oldUsd) &&
    Number.isFinite(newUsd) &&
    oldUsd !== 0 &&
    Math.abs(newUsd - oldUsd) / Math.abs(oldUsd) > SHIFT
  ) {
    const pct = ((newUsd - oldUsd) / Math.abs(oldUsd)) * 100
    events.push({
      kind: 'instant_liquidity_shift',
      prev: { instant_usd: oldUsd },
      next: { instant_usd: newUsd },
      note: `instant_usd ${pct.toFixed(1)}%`,
    })
  }
  return events
}

// One Neon HTTP statement invokes one database-side transaction. The function
// returns conflict/stale/skipped instead of allowing an out-of-date caller to
// publish against a different predecessor. The database itself derives events
// under the venue lock. A future recorder must re-read after conflict; it must
// not replay the old predecessor ID. This helper does not switch the live recorder.
export async function commitAtomicVenueSnapshot(
  sql,
  { venue, chain = 'ethereum', next, previous },
) {
  if (!isAtomicFinalizedSource(next)) throw new Error('venue_atomic_unsealed_source')
  const [row] = await sql`
    SELECT ingest_venue_snapshot_atomic_v1(
      ${venue}, ${chain}, ${String(next.block)}, ${next.instantUsd ?? null},
      ${next.coolingUsd ?? null}, ${next.strandedUsd ?? null},
      ${JSON.stringify(next.params)}::jsonb,
      ${previous?.id ?? null}::uuid
    ) AS result`
  if (!row?.result || typeof row.result.status !== 'string') {
    throw new Error('venue_atomic_missing_commit_status')
  }
  return row.result
}
