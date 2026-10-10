// Offline, fail-closed ledger for the frozen 14-day Core market-day experiment.
// This module has no RPC imports and its CLI deliberately has no scoring mode.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STUDY = 'aave-core-prospective-score-v1'
export const DATES = Object.freeze(
  Array.from({ length: 14 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10),
  ),
)
export const MARKETS = Object.freeze(['USDC', 'USDT'])
export const HORIZONS = Object.freeze(['24h', '7d'])
export const SOURCE_KINDS = Object.freeze(['witness', 'feature', 'peer', 'slope', 'outcomes'])
export const PEER_FLAG_BPS = 50
export const MIN_LEAD_SECONDS = 6 * 3600
export const MIN_INDEPENDENT_EVENTS = 20
export const MIN_INDEPENDENT_CONTROLS = 20
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
const SHA = /^[a-f0-9]{64}$/
const HASH = /^0x[a-f0-9]{64}$/i
const ADDRESS = /^0x[a-f0-9]{40}$/i
const EIP1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ELIGIBLE_PEER_STRATA = new Set(['ge50bp', 'le0bp', 'gt0lt50bp'])
const NONELIGIBLE_PEER_STRATA = new Set([
  'aave-ineligible',
  'paused',
  'missing',
  'implementation-unresolved',
])
const PEER_FAILURES = new Set([
  'proxy-code-read',
  'implementation-read',
  'baseToken-read',
  'utilization-read',
  'supply-rate-read',
  'pause-state-read',
])
const EARLY_PEER_FAILURES = new Set(['proxy-code-read', 'implementation-read', 'baseToken-read'])
const SECONDS_PER_YEAR = 31_536_000n
const RAY = 10n ** 27n
const COMET_RATE_SCALE = 10n ** 18n
const sha = (data) => createHash('sha256').update(data).digest('hex')
const payloadSha = (payload) => sha(JSON.stringify(payload))
const finiteMs = (n) => Number.isSafeInteger(n) && n > 0
const nonnegative = (v) => typeof v === 'string' && /^\d+$/.test(v)
const market = (rows, name, key = 'name') => {
  if (!Array.isArray(rows) || rows.length !== 2 || rows.some((r) => !MARKETS.includes(r?.[key])))
    throw new Error('Malformed two-market artifact')
  if (new Set(rows.map((r) => r[key])).size !== 2) throw new Error('Duplicate market')
  return rows.find((r) => r[key] === name)
}
const sameAddress = (a, b) =>
  ADDRESS.test(a || '') && ADDRESS.test(b || '') && a.toLowerCase() === b.toLowerCase()
function assertMarketIdentity(witness, other, label, peer = false) {
  if (
    !sameAddress(witness.underlying, peer ? other.base : other.underlying) ||
    (!peer && !sameAddress(witness.aToken, other.aToken))
  )
    throw new Error(`${label} market asset identity mismatch`)
}

export function dateSlot(date, name) {
  if (!DATES.includes(date) || !MARKETS.includes(name)) throw new Error('Outside frozen cohort')
  return { date, market: name, split: DATES.indexOf(date) < 7 ? 'exploratory' : 'sequestered' }
}

export function readSealedSource(spec) {
  if (!spec || typeof spec.path !== 'string' || !SHA.test(spec.sha256 || ''))
    throw new Error('Source needs explicit path and physical SHA-256')
  const path = resolve(spec.path)
  const size = statSync(path).size
  if (size < 2 || size > MAX_SOURCE_BYTES) throw new Error('Source size cap')
  const bytes = readFileSync(path)
  if (sha(bytes) !== spec.sha256) throw new Error('Source physical SHA mismatch')
  const saved = JSON.parse(bytes.toString('utf8'))
  if (!saved?.payload || saved.sha256 !== payloadSha(saved.payload))
    throw new Error('Source payload SHA mismatch')
  return { payload: saved.payload, physicalSha256: spec.sha256 }
}

function sourceFor(sources, date, kind) {
  const spec = sources?.[date]?.[kind]
  if (!spec) return { status: 'missing', reason: 'no-explicit-source' }
  try {
    return { status: 'present', ...readSealedSource(spec) }
  } catch (error) {
    return { status: 'invalid', reason: String(error.message).slice(0, 120) }
  }
}

const safeFraction = (value, signed = false) => {
  if (!value || !/^-?\d+$/.test(String(value.numerator)) || !nonnegative(value.denominator))
    return null
  const n = BigInt(value.numerator)
  const d = BigInt(value.denominator)
  if (!d || (!signed && n < 0n)) return null
  return { numerator: n.toString(), denominator: d.toString() }
}

function gcd(a, b) {
  a = a < 0n ? -a : a
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}

function assertPeerCollectorState(pm, am) {
  if (
    !pm.aaveFlags ||
    typeof pm.aaveFlags.active !== 'boolean' ||
    typeof pm.aaveFlags.paused !== 'boolean' ||
    typeof pm.aaveFlags.frozen !== 'boolean' ||
    !Array.isArray(pm.failures) ||
    pm.failures.some((failure) => !PEER_FAILURES.has(failure)) ||
    new Set(pm.failures).size !== pm.failures.length ||
    (pm.withdrawPaused !== null && typeof pm.withdrawPaused !== 'boolean') ||
    (pm.proxyCodeHash !== null && !HASH.test(pm.proxyCodeHash || '')) ||
    !nonnegative(pm.aaveLiquidityRateRay) ||
    pm.aaveLiquidityRateRay !== am.liquidityRateRay ||
    !am.flags ||
    ['active', 'paused', 'frozen'].some((key) => pm.aaveFlags[key] !== am.flags[key]) ||
    (pm.compoundUtilizationRaw !== null && !nonnegative(pm.compoundUtilizationRaw))
  )
    throw new Error('Peer collector state malformed')
  const earlyFailure = pm.failures.find((failure) => EARLY_PEER_FAILURES.has(failure))
  if (
    (pm.implementation === null && !earlyFailure) ||
    (pm.implementation !== null &&
      (pm.implementation.slot !== EIP1967_SLOT ||
        (pm.implementation.address === null
          ? pm.implementation.codeHash !== null
          : !ADDRESS.test(pm.implementation.address || '') ||
            !HASH.test(pm.implementation.codeHash || ''))))
  )
    throw new Error('Peer implementation state malformed')
  if (earlyFailure) {
    if (
      pm.failures.length !== 1 ||
      pm.withdrawPaused !== null ||
      pm.spreadBps !== null ||
      pm.compoundUtilizationRaw !== null ||
      pm.compoundSupplyRatePerSecondRaw !== null ||
      (earlyFailure === 'proxy-code-read' &&
        (pm.proxyCodeHash !== null || pm.implementation !== null)) ||
      (earlyFailure === 'implementation-read' &&
        (!pm.proxyCodeHash || pm.implementation !== null)) ||
      (earlyFailure === 'baseToken-read' && (!pm.proxyCodeHash || !pm.implementation))
    )
      throw new Error('Early peer failure state mismatch')
    if (pm.stratum !== 'missing') throw new Error('Peer stratum/collector state mismatch')
    return
  }
  if (!pm.proxyCodeHash || !pm.implementation) throw new Error('Peer code identity missing')
  if (
    (pm.failures.includes('utilization-read') && pm.compoundUtilizationRaw !== null) ||
    (pm.compoundUtilizationRaw === null && !pm.failures.includes('utilization-read')) ||
    (pm.failures.includes('supply-rate-read') &&
      (pm.compoundUtilizationRaw === null || pm.compoundSupplyRatePerSecondRaw !== null)) ||
    (pm.failures.includes('pause-state-read') && pm.withdrawPaused !== null) ||
    (!pm.failures.includes('pause-state-read') && pm.withdrawPaused === null) ||
    (pm.compoundUtilizationRaw === null && pm.compoundSupplyRatePerSecondRaw !== null) ||
    (pm.compoundUtilizationRaw !== null &&
      !pm.failures.includes('supply-rate-read') &&
      pm.compoundSupplyRatePerSecondRaw === null)
  )
    throw new Error('Peer read failure/field mismatch')
  if (pm.compoundSupplyRatePerSecondRaw === null) {
    if (pm.spreadBps !== null) throw new Error('Peer spread without raw rate')
  } else {
    if (!nonnegative(pm.compoundSupplyRatePerSecondRaw))
      throw new Error('Peer raw supply rate malformed')
    const compound = BigInt(pm.compoundSupplyRatePerSecondRaw)
    if (compound > 2n ** 64n - 1n) throw new Error('Peer raw supply rate out of range')
    // Match the collector's reduced simple-APR spread exactly, not merely its band.
    const numerator =
      (compound * SECONDS_PER_YEAR * RAY - BigInt(pm.aaveLiquidityRateRay) * COMET_RATE_SCALE) *
      10_000n
    const denominator = RAY * COMET_RATE_SCALE
    const divisor = gcd(numerator, denominator)
    const observed = safeFraction(pm.spreadBps, true)
    if (
      !observed ||
      observed.numerator !== (numerator / divisor).toString() ||
      observed.denominator !== (denominator / divisor).toString()
    )
      throw new Error('Peer raw rate/spread mismatch')
  }
  const expected =
    !pm.aaveFlags.active || pm.aaveFlags.paused || pm.aaveFlags.frozen
      ? 'aave-ineligible'
      : pm.withdrawPaused === true
        ? 'paused'
        : pm.failures.length > 0
          ? 'missing'
          : pm.implementation.address === null
            ? 'implementation-unresolved'
            : null
  if (pm.stratum !== expected && (expected !== null || !ELIGIBLE_PEER_STRATA.has(pm.stratum)))
    throw new Error('Peer stratum/collector state mismatch')
  if (
    expected === null &&
    (pm.withdrawPaused !== false ||
      !nonnegative(pm.compoundUtilizationRaw) ||
      !nonnegative(pm.compoundSupplyRatePerSecondRaw))
  )
    throw new Error('Eligible peer raw state missing')
}

function extractDay(date, input) {
  const w = input.witness?.payload
  const f = input.feature?.payload
  if (w?.study !== 'aave-core-holder-witness-v1' || f?.study !== 'aave-core-anchor-features-v1')
    throw new Error('Witness/feature study identity mismatch')
  if (w.chainId !== 1 || f.chainId !== 1 || w.pool?.toLowerCase() !== f.pool?.toLowerCase())
    throw new Error('Witness/feature chain or Pool mismatch')
  if (
    !Array.isArray(w.baselines) ||
    w.baselines.length !== 1 ||
    !Array.isArray(f.rows) ||
    f.rows.length !== 1
  )
    throw new Error('Daily artifact requires one frozen anchor')
  const b = w.baselines[0]
  const a = f.rows[0]
  if (
    !Number.isSafeInteger(b.block) ||
    !HASH.test(b.blockHash || '') ||
    b.block !== a.block ||
    b.blockHash.toLowerCase() !== a.blockHash?.toLowerCase() ||
    b.blockTimestamp !== a.blockTimestamp ||
    a.sourcePhysicalSha256 !== input.witness.physicalSha256 ||
    a.baselineRowSha256 !== b.rowSha256 ||
    !finiteMs(b.observedAtMs) ||
    !finiteMs(a.observedAtMs) ||
    b.observedAtMs < b.blockTimestamp * 1000 ||
    a.observedAtMs < b.blockTimestamp * 1000 ||
    new Date(b.observedAtMs).toISOString().slice(0, 10) !== date ||
    new Date(a.observedAtMs).toISOString().slice(0, 10) !== date
  )
    throw new Error('Daily anchor/hash/local observation mismatch')
  const p = input.peer?.payload
  const s = input.slope?.payload
  for (const [kind, x, study] of [
    ['peer', p, 'aave-compound-peer-rate-v1'],
    ['slope', s, 'aave-core-cash-slope-v1'],
  ]) {
    if (!x) continue
    if (
      x.study !== study ||
      x.chainId !== 1 ||
      x.block !== b.block ||
      x.blockHash?.toLowerCase() !== b.blockHash.toLowerCase() ||
      x.sourcePhysicalSha256 !== input.feature.physicalSha256 ||
      !finiteMs(x.firstKnownAtMs) ||
      x.firstKnownAtMs < b.blockTimestamp * 1000 ||
      x.firstKnownAtMs < a.observedAtMs ||
      new Date(x.firstKnownAtMs).toISOString().slice(0, 10) !== date ||
      (kind === 'slope' && x.captureDate !== date)
    )
      throw new Error(`${kind} prospective source/anchor mismatch`)
  }
  return { b, a, p, s }
}

function outcomeRow(outcomes, anchor, horizon) {
  if (!outcomes) return null
  if (
    outcomes.study !== 'aave-core-holder-outcomes-v1' ||
    outcomes.chainId !== 1 ||
    !Array.isArray(outcomes.outcomes) ||
    outcomes.outcomes.length > 84
  )
    throw new Error('Outcome study identity mismatch')
  const matches = outcomes.outcomes.filter(
    (row) => row.baselineBlock === anchor.block && row.horizon === horizon,
  )
  if (matches.length > 1) throw new Error('Duplicate outcome horizon')
  const row = matches[0]
  if (!row) return null
  const seconds = horizon === '24h' ? 86400 : 604800
  if (
    row.baselineBlockHash?.toLowerCase() !== anchor.blockHash.toLowerCase() ||
    row.baselineSha256 !== anchor.rowSha256 ||
    row.targetTimestamp !== anchor.blockTimestamp + seconds ||
    !Number.isSafeInteger(row.blockTimestamp) ||
    row.blockTimestamp < row.targetTimestamp ||
    !HASH.test(row.blockHash || '') ||
    !finiteMs(row.observedAtMs) ||
    row.observedAtMs < row.blockTimestamp * 1000
  )
    throw new Error('Outcome target/finality identity mismatch')
  return row
}

function classifyWitnesses(baselineMarket, outcomeMarket) {
  const holders = baselineMarket.qualifyingHolders
  if (
    !Array.isArray(holders) ||
    holders.length > 100 ||
    holders.some((h) => !ADDRESS.test(h)) ||
    new Set(holders.map((h) => h.toLowerCase())).size !== holders.length
  )
    throw new Error('Malformed frozen holders')
  if (!outcomeMarket)
    return { status: 'missing-outcome', holders: holders.map((h) => h.toLowerCase()) }
  if (
    outcomeMarket.quoteRaw !== baselineMarket.quoteRaw ||
    !Array.isArray(outcomeMarket.witnesses) ||
    outcomeMarket.witnesses.length !== holders.length
  )
    throw new Error('Outcome holder/quote mismatch')
  let revert = false
  let censored = false
  outcomeMarket.witnesses.forEach((row, i) => {
    if (row.holder?.toLowerCase() !== holders[i].toLowerCase())
      throw new Error('Outcome holder drift')
    if (
      row.deterioration === 'baseline-success-to-unattributed-revert' &&
      row.call === 'revert' &&
      Array.isArray(row.censoring) &&
      row.censoring.length === 0
    )
      revert = true
    else if (
      row.deterioration === 'no-observed-revert' &&
      row.call === 'success' &&
      Array.isArray(row.censoring) &&
      row.censoring.length === 0
    ) {
      /* clean control */
    } else censored = true
  })
  return {
    status: !holders.length
      ? 'no-fixed-holder'
      : censored
        ? 'censored'
        : revert
          ? 'event'
          : 'control',
    holders: holders.map((h) => h.toLowerCase()),
  }
}

export function buildLedger(sources = {}) {
  const rows = []
  for (const date of DATES) {
    const input = Object.fromEntries(
      SOURCE_KINDS.map((kind) => [kind, sourceFor(sources, date, kind)]),
    )
    let day = null
    let invalidReason = SOURCE_KINDS.some((kind) => input[kind].status === 'invalid')
      ? 'At least one explicitly supplied source is invalid'
      : null
    if (
      !invalidReason &&
      input.witness.status === 'present' &&
      input.feature.status === 'present'
    ) {
      try {
        day = extractDay(
          date,
          Object.fromEntries(
            SOURCE_KINDS.map((kind) => [
              kind,
              input[kind].status === 'present' ? input[kind] : null,
            ]),
          ),
        )
      } catch (error) {
        invalidReason = String(error.message).slice(0, 120)
      }
    }
    for (const name of MARKETS) {
      const slot = dateSlot(date, name)
      const row = {
        ...slot,
        scheduledStartUtc: `${date}T06:00:00.000Z`,
        sourceStatus: Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, input[kind].status])),
        sourceSha256: Object.fromEntries(
          SOURCE_KINDS.map((kind) => [kind, input[kind].physicalSha256 || null]),
        ),
        anchor: null,
        features: null,
        outcomes: {},
        status: invalidReason ? 'invalid' : 'missing-capture',
        reason: invalidReason,
      }
      if (day && !invalidReason) {
        try {
          const bm = market(day.b.markets, name)
          const am = market(day.a.markets, name)
          const pm = day.p ? market(day.p.markets, name, 'market') : null
          const sm = day.s ? market(day.s.markets, name, 'market') : null
          assertMarketIdentity(bm, am, 'feature')
          if (pm) assertMarketIdentity(bm, pm, 'peer', true)
          if (sm) assertMarketIdentity(bm, sm, 'slope')
          if (
            !nonnegative(bm.quoteRaw) ||
            !safeFraction(am.rawCashProxy?.cashPerQuote) ||
            am.rawCashProxy.cashPerQuote.denominator !== bm.quoteRaw ||
            am.rawCashProxy.cashPerQuote.numerator !== am.rawCashProxy.cashRaw
          )
            throw new Error('Cash/q or frozen quote malformed')
          if (sm?.status === 'eligible') {
            const slope = safeFraction(sm.signedSlopeFraction, true)
            if (
              !slope ||
              !nonnegative(sm.cashBRaw) ||
              !nonnegative(sm.cashPriorRaw) ||
              sm.cashBRaw !== am.rawCashProxy.cashRaw ||
              BigInt(sm.cashPriorRaw) === 0n ||
              BigInt(slope.numerator) !== BigInt(sm.cashBRaw) - BigInt(sm.cashPriorRaw) ||
              BigInt(slope.denominator) !== BigInt(sm.cashPriorRaw)
            )
              throw new Error('Exact prior-24h cash slope/source mismatch')
          }
          row.anchor = {
            block: day.b.block,
            blockHash: day.b.blockHash,
            blockTimestamp: day.b.blockTimestamp,
            witnessObservedAtMs: day.b.observedAtMs,
            featureObservedAtMs: day.a.observedAtMs,
          }
          if (pm && !Array.isArray(pm.failures)) throw new Error('Peer failure state missing')
          if (
            pm &&
            !ELIGIBLE_PEER_STRATA.has(pm.stratum) &&
            !NONELIGIBLE_PEER_STRATA.has(pm.stratum)
          )
            throw new Error('Unknown peer stratum')
          if (pm) assertPeerCollectorState(pm, am)
          const peerEligible = pm && ELIGIBLE_PEER_STRATA.has(pm.stratum)
          const peer = peerEligible && !pm.failures.length && safeFraction(pm.spreadBps, true)
          if (peerEligible && !pm.failures.length && !peer)
            throw new Error('Eligible peer spread missing')
          const peerFlag = peer ? BigInt(peer.numerator) >= BigInt(peer.denominator) * 50n : null
          const expectedStratum = peer
            ? peerFlag
              ? 'ge50bp'
              : BigInt(peer.numerator) <= 0n
                ? 'le0bp'
                : 'gt0lt50bp'
            : null
          if (peer && pm.stratum !== expectedStratum)
            throw new Error('Peer stratum/spread mismatch')
          const spread = peer
            ? Number(BigInt(peer.numerator)) / Number(BigInt(peer.denominator))
            : null
          row.features = {
            cashPerQuote: safeFraction(am.rawCashProxy.cashPerQuote),
            cashObservedAtMs: day.a.observedAtMs,
            peerSpreadBps: Number.isFinite(spread) ? spread : null,
            peerFlag: Number.isFinite(spread) ? peerFlag : null,
            peerStratum: pm?.stratum ?? null,
            peerObservedAtMs: Number.isFinite(spread) ? day.p.firstKnownAtMs : null,
            prior24hCashSlope:
              sm?.status === 'eligible' ? safeFraction(sm.signedSlopeFraction, true) : null,
            slopeObservedAtMs: sm?.status === 'eligible' ? day.s.firstKnownAtMs : null,
          }
          const outcomePayload = input.outcomes.status === 'present' ? input.outcomes.payload : null
          for (const horizon of HORIZONS) {
            const o = outcomeRow(outcomePayload, day.b, horizon)
            const om = o ? market(o.markets, name) : null
            if (om) assertMarketIdentity(bm, om, 'outcome')
            const c = classifyWitnesses(bm, om)
            const peerLead =
              o && row.features.peerObservedAtMs !== null
                ? (o.targetTimestamp * 1000 - row.features.peerObservedAtMs) / 1000
                : null
            row.outcomes[horizon] = {
              status: c.status,
              holders: c.holders,
              outcomeBlock: o?.block || null,
              outcomeObservedAtMs: o?.observedAtMs || null,
              peerLeadSeconds: peerLead,
              scoreEligible:
                ['event', 'control'].includes(c.status) && peerLead >= MIN_LEAD_SECONDS,
            }
          }
          row.status = 'captured'
          row.reason = null
        } catch (error) {
          row.status = 'invalid'
          row.reason = String(error.message).slice(0, 120)
          row.features = null
          row.outcomes = {}
        }
      }
      rows.push(row)
    }
  }
  if (rows.length !== 28) throw new Error('Frozen market-day denominator changed')
  return {
    study: STUDY,
    cohortDates: [DATES[0], DATES.at(-1)],
    unit: 'market-day',
    rule: {
      peerFlagBps: PEER_FLAG_BPS,
      comparators: ['continuous-cash-per-q', 'exact-prior-24h-cash-slope'],
      minRealLeadSeconds: MIN_LEAD_SECONDS,
      minIndependentEvents: MIN_INDEPENDENT_EVENTS,
      minIndependentControls: MIN_INDEPENDENT_CONTROLS,
      exploratoryDates: DATES.slice(0, 7),
      sequesteredDates: DATES.slice(7),
    },
    rows,
  }
}

export function exploratorySummary(ledger, horizon = '24h') {
  if (ledger.study !== STUDY || ledger.rows?.length !== 28 || !HORIZONS.includes(horizon))
    throw new Error('Ledger identity mismatch')
  const dev = ledger.rows.filter((r) => r.split === 'exploratory')
  const holdout = ledger.rows.filter((r) => r.split === 'sequestered')
  const eligible = dev.filter(
    (r) => r.outcomes[horizon]?.scoreEligible && r.features?.peerFlag !== null,
  )
  // One market-day is one unit. Repeated holders are reported as a dependence warning,
  // never inflated into independent events by treating their repeated calls as new units.
  const holderDays = new Map()
  for (const r of eligible)
    for (const holder of r.outcomes[horizon].holders) {
      const key = `${r.market}:${holder}`
      holderDays.set(key, (holderDays.get(key) || 0) + 1)
    }
  const events = eligible.filter((r) => r.outcomes[horizon].status === 'event')
  const controls = eligible.filter((r) => r.outcomes[horizon].status === 'control')
  const parent = eligible.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const holderOwner = new Map()
  eligible.forEach((r, i) => {
    for (const holder of r.outcomes[horizon].holders) {
      const key = `${r.market}:${holder}`
      if (holderOwner.has(key)) parent[find(i)] = find(holderOwner.get(key))
      else holderOwner.set(key, i)
    }
  })
  const groups = new Map()
  eligible.forEach((r, i) => {
    const root = find(i)
    const group = groups.get(root) || { event: false, control: false }
    group[r.outcomes[horizon].status] = true
    groups.set(root, group)
  })
  const flagged = eligible.filter((r) => r.features.peerFlag)
  const tp = flagged.filter((r) => r.outcomes[horizon].status === 'event').length
  const base = eligible.length ? events.length / eligible.length : null
  const precision = flagged.length ? tp / flagged.length : null
  return {
    horizon,
    exploratory: {
      marketDays: dev.length,
      eligibleMarketDays: eligible.length,
      eventMarketDays: events.length,
      controlMarketDays: controls.length,
      independentHolderMarketGroups: groups.size,
      independentEventGroups: [...groups.values()].filter((g) => g.event).length,
      independentControlOnlyGroups: [...groups.values()].filter((g) => g.control && !g.event)
        .length,
      repeatedHolderKeys: [...holderDays.values()].filter((n) => n > 1).length,
      flaggedMarketDays: flagged.length,
      precision,
      baseEventRate: base,
      observedLift: precision === null || base === null || base === 0 ? null : precision / base,
    },
    sequestered: { marketDays: holdout.length, scored: false },
    verdict: 'insufficient-independent-events-and-controls',
    gate: {
      pass: false,
      reason:
        'The entire frozen 14-day, two-market cohort has 28 market-days, fewer than the ' +
        '40 disjoint days required for 20 events plus 20 controls; the first-seven-day ' +
        'development split has only 14. Incremental lift over cash/slope is not computed.',
    },
  }
}

export function dryPlan(sources = {}) {
  const ledger = buildLedger(sources)
  return {
    study: STUDY,
    mode: 'dry-offline-only',
    marketDays: ledger.rows.length,
    missing: ledger.rows
      .filter((r) => r.status !== 'captured')
      .map((r) => ({
        date: r.date,
        market: r.market,
        status: r.status,
        sourceStatus: r.sourceStatus,
        reason: r.reason,
      })),
    note: 'No RPC, no outcome collection, no live scoring, no writes. Supply explicit physical SHA-pinned sources in code/test only.',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No CLI arguments or live scoring mode')
  process.stdout.write(`${JSON.stringify(dryPlan(), null, 2)}\n`)
}
