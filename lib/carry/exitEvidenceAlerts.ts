/** Read-only, sampled holder-exit evidence. This is not a forecast or a venue alarm. */

const MAX_ROWS_PER_LEDGER = 200
const MAX_ALERTS = 20
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const CHECKSUM = /^[0-9a-f]{64}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n

export type ExitEvidenceFilter = {
  routeKey?: string
  destination?: string
  holder?: string
  assetsRaw?: string
  limit: number
}

type LedgerName = 'morpho' | 'direct' | 'susds' | 'usd3'
type Row = Record<string, unknown>

const ledgerSpecs = [
  {
    name: 'morpho',
    table: 'carry_morpho_exit',
    destination: 'vault',
    coverage: 'holder_claim_raw',
  },
  {
    name: 'direct',
    table: 'carry_direct_exit',
    destination: 'destination',
    coverage: 'holder_balance_raw',
  },
  { name: 'susds', table: 'carry_susds_exit', destination: 'vault', coverage: 'shares' },
  { name: 'usd3', table: 'carry_usd3_exit', destination: 'vault', coverage: 'shares' },
] as const

// Every identifier comes from the fixed list above. There is no input interpolation.
export const EXIT_EVIDENCE_QUERIES = ledgerSpecs.map(
  ({ name, table, destination, coverage }) => `
  SELECT '${name}' AS ledger, i.id AS issue_id, i.status AS issue_status,
    i.issue_simulation, i.route_key, i.${destination} AS destination,
    i.holder AS issue_holder, i.assets_raw::text AS issue_assets_raw,
    i.source_block::text AS baseline_block, i.source_hash AS baseline_hash,
    i.source_block_at AS baseline_block_at, i.source_observed_at AS baseline_observed_at,
    i.issued_at, i.target_at, i.caller_checksum_sha256 AS issue_checksum,
    o.status AS outcome_status, o.route_key AS outcome_route_key,
    o.${destination} AS outcome_destination, o.holder AS outcome_holder,
    o.assets_raw::text AS outcome_assets_raw,
    o.source_block::text AS outcome_block, o.source_hash AS outcome_hash,
    o.source_block_at AS outcome_block_at, o.source_observed_at AS outcome_observed_at,
    o.recorded_at AS outcome_recorded_at,
    o.caller_checksum_sha256 AS outcome_checksum,
    ${coverage === 'shares' ? 'o.holder_shares_raw::text AS holder_shares_raw, o.preview_shares_raw::text AS preview_shares_raw, o.shares_burned_raw::text AS shares_burned_raw,' : `o.${coverage}::text AS holder_coverage_raw,`}
    o.issue_id AS outcome_issue_id
  FROM ${table}_attempts i LEFT JOIN ${table}_outcomes o ON o.issue_id = i.id
  WHERE i.status = 'issued' AND i.issue_simulation = 'success'
  ORDER BY i.issued_at DESC, i.id DESC
  LIMIT ${MAX_ROWS_PER_LEDGER}
`,
)

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function address(value: unknown): string | null {
  const lower = typeof value === 'string' ? value.toLowerCase() : ''
  return ADDRESS.test(lower) ? lower : null
}

function block(value: unknown): string | null {
  const text = String(value)
  return /^[1-9][0-9]*$/.test(text) ? text : null
}

function raw(value: unknown): string | null {
  const text = String(value)
  return RAW.test(text) && BigInt(text) <= MAX_UINT256 ? text : null
}

type Point = { block: string; hash: string; blockTime: string; observedAt: string }
type Baseline = {
  ledger: LedgerName
  issueId: string
  routeKey: string
  destination: string
  holder: string
  assetsRaw: string
  baseline: Point
}
type Pair = Baseline & {
  outcome: Point
  outcomeStatus: 'success' | 'evm_revert'
}

function point(row: Row, prefix: 'baseline' | 'outcome'): Point | null {
  const number = block(row[`${prefix}_block`])
  const hash = String(row[`${prefix}_hash`] ?? '').toLowerCase()
  const blockTime = iso(row[`${prefix}_block_at`])
  const observedAt = iso(row[`${prefix}_observed_at`])
  if (!number || !HASH.test(hash) || !blockTime || !observedAt) return null
  if (Date.parse(observedAt) < Date.parse(blockTime)) return null
  return { block: number, hash, blockTime, observedAt }
}

export function verifiedBaseline(row: Row): Baseline | null {
  const ledger = row.ledger
  if (!ledgerSpecs.some((spec) => spec.name === ledger)) return null
  if (row.issue_status !== 'issued' || row.issue_simulation !== 'success') return null
  const routeKey = row.route_key
  const destination = address(row.destination)
  const holder = address(row.issue_holder)
  const assetsRaw = raw(row.issue_assets_raw)
  const baseline = point(row, 'baseline')
  const issueId = block(row.issue_id)
  const issueChecksum = String(row.issue_checksum ?? '')
  if (
    typeof routeKey !== 'string' ||
    !routeKey ||
    routeKey.length > 160 ||
    !destination ||
    !holder ||
    !assetsRaw ||
    !baseline ||
    !issueId ||
    !CHECKSUM.test(issueChecksum) ||
    !iso(row.issued_at) ||
    !iso(row.target_at)
  )
    return null
  const issueAt = Date.parse(iso(row.issued_at)!)
  const targetAt = Date.parse(iso(row.target_at)!)
  if (
    Date.parse(baseline.blockTime) > issueAt ||
    Date.parse(baseline.observedAt) > issueAt + 60_000 ||
    targetAt - (ledger === 'direct' ? Date.parse(baseline.blockTime) : issueAt) !== 3_600_000
  )
    return null

  return {
    ledger: ledger as LedgerName,
    issueId,
    routeKey,
    destination,
    holder,
    assetsRaw,
    baseline,
  }
}

export function verifiedExitPair(row: Row): Pair | null {
  const source = verifiedBaseline(row)
  if (!source || (row.outcome_status !== 'success' && row.outcome_status !== 'evm_revert'))
    return null
  const outcome = point(row, 'outcome')
  const outcomeChecksum = String(row.outcome_checksum ?? '')
  const targetAt = Date.parse(iso(row.target_at)!)
  const outcomeAt = iso(row.outcome_recorded_at)
  if (
    !outcome ||
    !CHECKSUM.test(outcomeChecksum) ||
    block(row.outcome_issue_id) !== source.issueId ||
    row.outcome_route_key !== source.routeKey ||
    address(row.outcome_destination) !== source.destination ||
    address(row.outcome_holder) !== source.holder ||
    raw(row.outcome_assets_raw) !== source.assetsRaw ||
    BigInt(outcome.block) <= BigInt(source.baseline.block) ||
    Date.parse(outcome.blockTime) <= Date.parse(source.baseline.blockTime) ||
    Date.parse(outcome.observedAt) <= Date.parse(source.baseline.observedAt) ||
    !outcomeAt ||
    Math.abs(Date.parse(outcome.blockTime) - targetAt) > 15 * 60_000 ||
    Date.parse(outcomeAt) < targetAt - 15 * 60_000 ||
    Date.parse(outcomeAt) > targetAt + 15 * 60_000
  )
    return null

  const q = BigInt(source.assetsRaw)
  if (source.ledger === 'susds' || source.ledger === 'usd3') {
    const shares = raw(row.holder_shares_raw)
    const preview = raw(row.preview_shares_raw)
    if (!shares || !preview) return null
    if (row.outcome_status === 'evm_revert' && BigInt(shares) < BigInt(preview)) return null
    if (row.outcome_status === 'success') {
      const burned = raw(row.shares_burned_raw)
      if (!burned || BigInt(burned) > BigInt(shares)) return null
    } else if (row.shares_burned_raw !== null && row.shares_burned_raw !== undefined) return null
  } else {
    const coverage = raw(row.holder_coverage_raw)
    if (!coverage || BigInt(coverage) < q) return null
  }
  return { ...source, outcome, outcomeStatus: row.outcome_status }
}

function sameSubject(a: Baseline, b: Baseline) {
  return (
    a.ledger === b.ledger &&
    a.routeKey === b.routeKey &&
    a.destination === b.destination &&
    a.holder === b.holder &&
    a.assetsRaw === b.assetsRaw
  )
}

export async function readExitEvidenceAlerts(
  fetchRows: (query: string) => Promise<Row[]>,
  filter: ExitEvidenceFilter = { limit: 10 },
) {
  const batches = await Promise.all(EXIT_EVIDENCE_QUERIES.map(fetchRows))
  if (batches.some((batch) => !Array.isArray(batch) || batch.length > MAX_ROWS_PER_LEDGER)) {
    throw new Error('exit_evidence_query_shape_invalid')
  }
  const scopedRows = batches.flatMap((batch, index) =>
    batch.filter((row) => row.ledger === ledgerSpecs[index].name),
  )
  const baselines = scopedRows
    .map(verifiedBaseline)
    .filter((item): item is Baseline => item !== null)
  const pairs = scopedRows.map(verifiedExitPair).filter((pair): pair is Pair => pair !== null)
  const losses = pairs.filter(
    (pair) =>
      pair.outcomeStatus === 'evm_revert' &&
      (filter.routeKey === undefined || pair.routeKey === filter.routeKey) &&
      (filter.destination === undefined || pair.destination === filter.destination) &&
      (filter.holder === undefined || pair.holder === filter.holder) &&
      (filter.assetsRaw === undefined || pair.assetsRaw === filter.assetsRaw),
  )
  losses.sort((a, b) => Date.parse(b.outcome.observedAt) - Date.parse(a.outcome.observedAt))
  const alerts = losses.slice(0, Math.min(MAX_ALERTS, filter.limit)).map((loss) => {
    const later = (point: Point) =>
      BigInt(point.block) > BigInt(loss.outcome.block) &&
      Date.parse(point.blockTime) > Date.parse(loss.outcome.blockTime)
    const cleanPoints = [
      ...baselines
        .filter((item) => sameSubject(loss, item) && later(item.baseline))
        .map((item) => ({
          issueId: item.issueId,
          observation: 'baseline' as const,
          point: item.baseline,
        })),
      ...pairs
        .filter(
          (item) =>
            item.outcomeStatus === 'success' && sameSubject(loss, item) && later(item.outcome),
        )
        .map((item) => ({
          issueId: item.issueId,
          observation: 'followup' as const,
          point: item.outcome,
        })),
    ]
    const recovery = cleanPoints.sort((a, b) => {
      const byTime = Date.parse(a.point.blockTime) - Date.parse(b.point.blockTime)
      if (byTime) return byTime
      return BigInt(a.point.block) < BigInt(b.point.block) ? -1 : 1
    })[0]
    return {
      kind: 'sampled_exit_loss' as const,
      scope: 'one_sampled_holder_and_amount' as const,
      ledger: loss.ledger,
      issueId: loss.issueId,
      routeKey: loss.routeKey,
      destination: loss.destination,
      holder: loss.holder,
      assetsRaw: loss.assetsRaw,
      baseline: loss.baseline,
      lossObserved: loss.outcome,
      outcome: 'holder_covered_evm_revert' as const,
      recovery: recovery
        ? {
            status: 'later_same_holder_amount_success' as const,
            issueId: recovery.issueId,
            observation: recovery.observation,
            point: recovery.point,
            observedRecoveryWindow: {
              afterLossAt: loss.outcome.blockTime,
              bySuccessAt: recovery.point.blockTime,
            },
          }
        : null,
      duration: recovery ? ('interval_censored' as const) : ('unavailable' as const),
    }
  })
  return {
    status: 'bounded_sampled_exit_evidence' as const,
    scope: { maxRecentIssuedBaselinesPerLedger: MAX_ROWS_PER_LEDGER, completeHistory: false },
    alerts,
    prospectiveValidated: false as const,
    futureExitForecast: false as const,
    likelyDuration: 'unavailable' as const,
  }
}
