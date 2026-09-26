// A capacity move can be decomposed into recorded inventory changes. This is
// accounting, not attribution to transactions or an upstream signal.

export type ConfiguredMarket = {
  name: string
  kind: string
  address: string
  enabled?: boolean
  exitFrom?: string
  token0?: string
  token1?: string
  buffer?: string
  bufferToken?: string
}

export type VenueDriverConfig = {
  name: string
  kind: string
  depthMarkets?: ConfiguredMarket[]
}

export type DriverSnapshot = {
  id: string
  block: number
  observedAt: string
  instantUsd: number | string | null
  params: Record<string, unknown>
}

export type DriverEvent = {
  id: string
  kind: string
  prev: Record<string, unknown> | null
  next: Record<string, unknown> | null
}

export type CapacityDriver = {
  status: 'available'
  metric: 'instant_usd' | 'depth_usd'
  from: { snapshotId: string; block: number; at: string; usd: number }
  to: { snapshotId: string; block: number; at: string; usd: number }
  deltaUsd: number
  components: Array<{
    id: string
    name: string
    kind: string
    fromUsd: number
    toUsd: number
    deltaUsd: number
  }>
  aaveStocks: {
    cashDeltaUsd: number
    debtFromUsd: number
    debtToUsd: number
    debtDeltaUsd: number
  } | null
  eventId: string
  transactionEvidence?: TransactionClassEvidence | null
}

export type TransactionClass = 'swap' | 'lp_add' | 'lp_remove' | 'mixed' | 'direct_or_other'
export const TRANSACTION_CLASSES: TransactionClass[] = [
  'swap',
  'lp_add',
  'lp_remove',
  'mixed',
  'direct_or_other',
]

export type TransactionClassEvidence = {
  blockPinnedSnapshots: boolean
  byClassUsdProxy: Record<TransactionClass, number>
  transferNetUsdProxy: number
  residualUsdProxy: number
  maxResidualPctOfGrossMovement: number
  markets: Array<{ market: string; transferNetUsdProxy: number; residualUsdProxy: number }>
}

export type UnavailableDriver = {
  status: 'unavailable'
  reason:
    | 'no_event'
    | 'no_previous_snapshot'
    | 'invalid_event'
    | 'incomplete_read'
    | 'market_set_changed'
    | 'unreconciled'
  message: string
}

export type DriverResult = CapacityDriver | UnavailableDriver

const unavailable = (reason: UnavailableDriver['reason'], message: string): UnavailableDriver => ({
  status: 'unavailable',
  reason,
  message,
})

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const signedFinite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const same = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(0.02, Math.abs(a) * 1e-9, Math.abs(b) * 1e-9)

const addr = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '')
const marketId = (market: Record<string, unknown> | ConfiguredMarket): string =>
  [
    market.kind,
    addr(market.address),
    addr(market.exitFrom),
    addr(market.token0),
    addr(market.token1),
    addr(market.buffer),
    addr(market.bufferToken),
  ].join(':')

const marketValue = (market: Record<string, unknown>): number | null => {
  const reads = obj(market.reads)
  if (!reads || finite(market.priceAssumptionUsd) !== 1) return null
  if (market.kind === 'psm-buffer') {
    if (reads.buffer !== true || reads.decimals === false || market.bufferBalanceRaw == null)
      return null
  } else if (
    (market.kind !== 'curve-stableswap' && market.kind !== 'uniswap-v3') ||
    reads.reserve0 !== true ||
    reads.reserve1 !== true ||
    reads.decimals0 === false ||
    reads.decimals1 === false ||
    market.reserve0Raw == null ||
    market.reserve1Raw == null
  ) {
    return null
  }
  return finite(market.exitableUsd)
}

function checkedMarkets(snapshot: DriverSnapshot, config: VenueDriverConfig) {
  if (snapshot.params.depth_complete === false) {
    return unavailable(
      'incomplete_read',
      'At least one enabled market has an incomplete reserve read.',
    )
  }
  const expected = (config.depthMarkets ?? []).filter((market) => market.enabled === true)
  const recorded = snapshot.params.depthMarkets
  if (!Array.isArray(recorded) || expected.length === 0 || recorded.length !== expected.length) {
    return unavailable(
      'market_set_changed',
      'The enabled market set is missing or changed across this window.',
    )
  }
  const expectedIds = expected.map(marketId)
  if (new Set(expectedIds).size !== expectedIds.length) {
    return unavailable('market_set_changed', 'The configured market set is not unique.')
  }
  const entries = new Map<string, { name: string; kind: string; value: number }>()
  for (const raw of recorded) {
    const market = obj(raw)
    if (!market) return unavailable('incomplete_read', 'A market read is malformed.')
    const id = marketId(market)
    if (!expectedIds.includes(id) || entries.has(id)) {
      return unavailable(
        'market_set_changed',
        'The enabled market set is missing or changed across this window.',
      )
    }
    const value = marketValue(market)
    if (value === null) {
      return unavailable(
        'incomplete_read',
        'At least one enabled market has an incomplete reserve read.',
      )
    }
    entries.set(id, { name: String(market.name ?? market.kind), kind: String(market.kind), value })
  }
  return entries
}

export function explainCapacityMove(
  config: VenueDriverConfig,
  event: DriverEvent | null,
  previous: DriverSnapshot | null,
  current: DriverSnapshot | null,
): DriverResult {
  if (!event || !current)
    return unavailable('no_event', 'No recorded significant capacity shift has a usable snapshot.')
  if (!previous)
    return unavailable('no_previous_snapshot', 'The preceding observed snapshot is unavailable.')
  if (previous.id === current.id || previous.observedAt >= current.observedAt) {
    return unavailable('invalid_event', 'The recorded window is not ordered.')
  }

  const isAave = config.kind === 'atoken-liquidity'
  const metric = isAave ? 'instant_usd' : 'depth_usd'
  const oldUsd = finite(isAave ? previous.instantUsd : previous.params.depth_usd)
  const newUsd = finite(isAave ? current.instantUsd : current.params.depth_usd)
  const eventOld = finite(event.prev?.[metric])
  const eventNew = finite(event.next?.[metric])
  if (
    (isAave && event.kind !== 'instant_liquidity_shift') ||
    (!isAave && event.kind !== 'param_changed') ||
    oldUsd === null ||
    newUsd === null ||
    eventOld === null ||
    eventNew === null ||
    !same(oldUsd, eventOld) ||
    !same(newUsd, eventNew) ||
    oldUsd === 0 ||
    Math.abs(newUsd - oldUsd) / oldUsd <= 0.2
  ) {
    return unavailable(
      'invalid_event',
      'The recorded shift does not reconcile to its two observed snapshots.',
    )
  }

  let components: CapacityDriver['components'] = []
  let aaveStocks: CapacityDriver['aaveStocks'] = null
  if (isAave) {
    const oldReads = obj(previous.params.reads)
    const newReads = obj(current.params.reads)
    const oldDecimals = finite(previous.params.decimals)
    const newDecimals = finite(current.params.decimals)
    const oldCash = finite(previous.params.underlyingBalance)
    const newCash = finite(current.params.underlyingBalance)
    const oldDebt = finite(previous.params.variableDebt)
    const newDebt = finite(current.params.variableDebt)
    if (
      oldReads?.underlyingBalance !== true ||
      newReads?.underlyingBalance !== true ||
      oldReads?.variableDebt !== true ||
      newReads?.variableDebt !== true ||
      oldCash === null ||
      newCash === null ||
      oldDebt === null ||
      newDebt === null ||
      oldDecimals === null ||
      newDecimals === null ||
      oldDecimals !== newDecimals ||
      oldDecimals > 30 ||
      finite(previous.params.priceAssumptionUsd) !== 1 ||
      finite(current.params.priceAssumptionUsd) !== 1
    ) {
      return unavailable(
        'incomplete_read',
        'Aave cash or variable-debt stock was not read on both observations.',
      )
    }
    const divisor = 10 ** oldDecimals
    if (!same(oldCash / divisor, oldUsd) || !same(newCash / divisor, newUsd)) {
      return unavailable(
        'unreconciled',
        'Aave underlying balance does not reconcile to recorded instant liquidity.',
      )
    }
    aaveStocks = {
      cashDeltaUsd: newUsd - oldUsd,
      debtFromUsd: oldDebt / divisor,
      debtToUsd: newDebt / divisor,
      debtDeltaUsd: (newDebt - oldDebt) / divisor,
    }
  } else {
    const oldMarkets = checkedMarkets(previous, config)
    const newMarkets = checkedMarkets(current, config)
    if (!(oldMarkets instanceof Map)) return oldMarkets
    if (!(newMarkets instanceof Map)) return newMarkets
    if (
      oldMarkets.size !== newMarkets.size ||
      [...oldMarkets.keys()].some((id) => !newMarkets.has(id))
    ) {
      return unavailable('market_set_changed', 'The enabled market set changed across this window.')
    }
    const oldSum = [...oldMarkets.values()].reduce((sum, m) => sum + m.value, 0)
    const newSum = [...newMarkets.values()].reduce((sum, m) => sum + m.value, 0)
    if (!same(oldSum, oldUsd) || !same(newSum, newUsd)) {
      return unavailable(
        'unreconciled',
        'Market-side balances do not add up to the recorded total.',
      )
    }
    components = [...newMarkets].map(([id, m]) => ({
      id,
      name: m.name,
      kind: m.kind,
      fromUsd: oldMarkets.get(id)!.value,
      toUsd: m.value,
      deltaUsd: m.value - oldMarkets.get(id)!.value,
    }))
    components.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))
    if (
      !same(
        components.reduce((sum, m) => sum + m.deltaUsd, 0),
        newUsd - oldUsd,
      )
    ) {
      return unavailable(
        'unreconciled',
        'Market-side changes do not reconcile to the total change.',
      )
    }
  }

  return {
    status: 'available',
    metric,
    from: { snapshotId: previous.id, block: previous.block, at: previous.observedAt, usd: oldUsd },
    to: { snapshotId: current.id, block: current.block, at: current.observedAt, usd: newUsd },
    deltaUsd: newUsd - oldUsd,
    components,
    aaveStocks,
    eventId: event.id,
  }
}

// A DB row is not itself permission to make a transaction-class claim. Only a
// fully reconciled row for THIS event and THESE recorded market components can
// be shown. This is transfer/event classification, never trader motivation.
export function validatedTransactionEvidence(
  driver: CapacityDriver,
  venue: string,
  row: unknown,
): TransactionClassEvidence | null {
  const record = obj(row)
  const evidence = obj(record?.evidence)
  const window = obj(evidence?.window)
  if (
    !record ||
    record.status !== 'reconciled' ||
    String(record.event_id) !== driver.eventId ||
    String(record.venue) !== venue ||
    !evidence ||
    String(evidence.eventId) !== driver.eventId ||
    String(evidence.venue) !== venue ||
    window?.fromBlock !== driver.from.block ||
    window?.toBlock !== driver.to.block ||
    typeof evidence.blockPinnedSnapshots !== 'boolean' ||
    !Array.isArray(evidence.results) ||
    driver.components.length === 0 ||
    driver.components.some((component) => component.kind !== 'curve-stableswap') ||
    evidence.results.length !== driver.components.length
  ) {
    return null
  }

  const components = new Map(driver.components.map((component) => [component.name, component]))
  if (components.size !== driver.components.length) return null
  const seen = new Set<string>()
  const byClassUsdProxy = Object.fromEntries(TRANSACTION_CLASSES.map((key) => [key, 0])) as Record<
    TransactionClass,
    number
  >
  const markets: TransactionClassEvidence['markets'] = []
  let transferNetUsdProxy = 0
  let residualUsdProxy = 0
  let maxResidualPctOfGrossMovement = 0
  for (const raw of evidence.results) {
    const market = obj(raw)
    const name = typeof market?.market === 'string' ? market.market : ''
    const component = components.get(name)
    const classes = obj(market?.byTransactionClassUsdProxy)
    const recordedDelta = signedFinite(market?.recordedReserveDeltaUsdProxy)
    const transferNet = signedFinite(market?.transferNetUsdProxy)
    const residual = signedFinite(market?.residualVsRecordedUsdProxy)
    const residualPct = finite(market?.residualPctOfGrossMovement)
    if (
      !market ||
      !component ||
      seen.has(name) ||
      market.attributionGate95Pct !== true ||
      !classes ||
      recordedDelta === null ||
      transferNet === null ||
      residual === null ||
      residualPct === null ||
      residualPct > 5 ||
      !same(recordedDelta, component.deltaUsd) ||
      !same(recordedDelta, transferNet + residual)
    ) {
      return null
    }
    let classTotal = 0
    for (const key of TRANSACTION_CLASSES) {
      const value = signedFinite(classes[key])
      if (value === null) return null
      byClassUsdProxy[key] += value
      classTotal += value
    }
    if (!same(classTotal, transferNet)) return null
    seen.add(name)
    transferNetUsdProxy += transferNet
    residualUsdProxy += residual
    maxResidualPctOfGrossMovement = Math.max(maxResidualPctOfGrossMovement, residualPct)
    markets.push({ market: name, transferNetUsdProxy: transferNet, residualUsdProxy: residual })
  }
  if (
    seen.size !== components.size ||
    !same(transferNetUsdProxy + residualUsdProxy, driver.deltaUsd)
  ) {
    return null
  }
  return {
    blockPinnedSnapshots: evidence.blockPinnedSnapshots,
    byClassUsdProxy,
    transferNetUsdProxy,
    residualUsdProxy,
    maxResidualPctOfGrossMovement,
    markets,
  }
}
