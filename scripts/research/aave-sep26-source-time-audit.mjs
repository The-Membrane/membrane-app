// Offline-only provenance audit for the frozen 2026-09-26 Core USDC/USDT B.
// Reads exactly six immutable local inputs. Does not read outcomes or RPC.
// Default: print JSON; --out /absolute/path.json writes once without overwrite.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dataDir = join(root, 'data/research/venue-signals')
export const FROZEN = {
  block: 26_059_633,
  hash: '0x0054f02057d2c8160e809def3ae50a2e5324dc118d94f2820f48e37f020c6168',
  timestamp: 1_790_401_643,
  quote: 1_000_000,
  quoteRaw: '1000000000000',
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
}
export const INPUTS = {
  forward: [
    'aave-core-forward-panel-v1.json',
    '8f20223ad6f2bc94651f7a0d3921346decdba118b806e0ba0a942aea8d5bb921',
  ],
  exposure: [
    'aave-core-holder-exposure-pilot-v1.json',
    '0e2814215115e5186f51df653939f3f6d2e36c311c1ea677181ecadefb4b8c7b',
  ],
  witness: [
    'aave-core-holder-witness-2026-09-26.json',
    '18f69bc26d932e2353cc0eb0bc7fca11b0240672946c59a624fcad3a2b2a6cfa',
  ],
  anchor: [
    'aave-core-anchor-features-2026-09-26.json',
    'df984f6bcabab38220b18a36627224bd14614ee868ef4dc1a51c7d9b32c2e708',
  ],
  peer: [
    'aave-compound-peer-rate-2026-09-26.json',
    '0ee681b5397da6a6481f5947cd6b6c0b3711c8236715beeb016b16ee80d4e2c3',
  ],
  slope: [
    'aave-core-cash-slope-2026-09-26.json',
    '10f7cd71ff3724c4cbe351e42319e08379e038a7c0ab9cfcf927643e11a259c9',
  ],
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

export function readPinnedInputs(directory = dataDir) {
  const loaded = {}
  for (const [key, [name, expected]] of Object.entries(INPUTS)) {
    const bytes = readFileSync(join(directory, name))
    if (hash(bytes) !== expected) throw new Error(`Physical SHA mismatch: ${key}`)
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed?.payload || typeof parsed.sha256 !== 'string')
      throw new Error(`Malformed sealed input: ${key}`)
    loaded[key] = parsed.payload
  }
  return loaded
}

function exactB(row, label) {
  if (
    row.block !== FROZEN.block ||
    !same(row.blockHash, FROZEN.hash) ||
    row.blockTimestamp !== FROZEN.timestamp
  )
    throw new Error(`Frozen B mismatch: ${label}`)
}
function marketMap(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error(`Expected two markets: ${label}`)
  const map = new Map(rows.map((row) => [row.name || row.market, row]))
  if (map.size !== 2 || !map.has('USDC') || !map.has('USDT'))
    throw new Error(`Wrong market set: ${label}`)
  return map
}
function marketIdentity(a, b, label) {
  const leftBase = a.underlying || a.base
  const rightBase = b.underlying || b.base
  if (
    !/^0x[a-fA-F0-9]{40}$/.test(leftBase) ||
    !/^0x[a-fA-F0-9]{40}$/.test(rightBase) ||
    !/^0x[a-fA-F0-9]{40}$/.test(a.aToken) ||
    !/^0x[a-fA-F0-9]{40}$/.test(b.aToken) ||
    !same(leftBase, rightBase) ||
    !same(a.aToken, b.aToken)
  )
    throw new Error(`Market identity mismatch: ${label}`)
}
export function classifySourceTime({ sourceBlock, sourceHash, sourceTimestamp, firstKnownAtMs }) {
  if (
    !Number.isSafeInteger(sourceBlock) ||
    !/^0x[a-fA-F0-9]{64}$/.test(sourceHash) ||
    !Number.isSafeInteger(sourceTimestamp) ||
    !Number.isSafeInteger(firstKnownAtMs) ||
    sourceTimestamp * 1000 > firstKnownAtMs
  )
    throw new Error('Incomplete source-time provenance')
  const bMs = FROZEN.timestamp * 1000
  const first24hTargetMs = bMs + 24 * 3_600_000
  return {
    sourceBlock,
    sourceHash,
    sourceTimestamp,
    firstKnownAtMs,
    strictlyBeforeB:
      sourceBlock < FROZEN.block && sourceTimestamp < FROZEN.timestamp && firstKnownAtMs < bMs,
    hoursFromFirstKnownToEarliest24hTarget: (first24hTargetMs - firstKnownAtMs) / 3_600_000,
    atLeast6hBeforeEarliest24hTarget: firstKnownAtMs <= first24hTargetMs - 6 * 3_600_000,
  }
}
function decimalRatio(parts) {
  if (
    !parts ||
    !/^-?\d+$/.test(parts.numerator) ||
    !/^\d+$/.test(parts.denominator) ||
    parts.denominator === '0'
  )
    return null
  return Number(parts.numerator) / Number(parts.denominator)
}
function sourceRow(market, feature, provenance, values, caveat = null) {
  return { market, feature, ...classifySourceTime(provenance), values, caveat }
}

function preBCashChange(market, earlier, later, earlierCashRaw, laterCashRaw) {
  const first = classifySourceTime(earlier)
  const last = classifySourceTime(later)
  if (
    !first.strictlyBeforeB ||
    !last.strictlyBeforeB ||
    first.sourceBlock >= last.sourceBlock ||
    first.sourceTimestamp >= last.sourceTimestamp ||
    first.firstKnownAtMs >= last.firstKnownAtMs
  )
    throw new Error(`Cash-change inputs are not ordered strictly before B: ${market}`)
  let numerator = null
  let denominator = null
  let censoredReason = null
  if (
    typeof earlierCashRaw !== 'string' ||
    !/^\d+$/.test(earlierCashRaw) ||
    BigInt(earlierCashRaw) === 0n
  )
    censoredReason = 'invalid-or-zero-earlier-cash'
  else if (typeof laterCashRaw !== 'string' || !/^\d+$/.test(laterCashRaw))
    censoredReason = 'invalid-later-cash'
  else {
    denominator = earlierCashRaw
    numerator = (BigInt(laterCashRaw) - BigInt(earlierCashRaw)).toString()
  }
  return sourceRow(
    market,
    'strict-pre-b-cash-change',
    later,
    {
      earlierSourceBlock: first.sourceBlock,
      earlierSourceHash: first.sourceHash,
      earlierSourceTimestamp: first.sourceTimestamp,
      earlierFirstKnownAtMs: first.firstKnownAtMs,
      laterCashRaw,
      earlierCashRaw,
      signedChangeRaw: numerator,
      signedChangeFractionExact: numerator === null ? null : { numerator, denominator },
      signedChangeFractionApprox:
        numerator === null ? null : decimalRatio({ numerator, denominator }),
      elapsedSourceSeconds: last.sourceTimestamp - first.sourceTimestamp,
      elapsedKnowledgeMs: last.firstKnownAtMs - first.firstKnownAtMs,
      censoredReason,
    },
    'Continuous cash change across two locally known pre-B states; no threshold or exit-intent claim.',
  )
}

export function auditPayloads(input) {
  for (const [name, payload] of Object.entries(input)) {
    if (payload.chainId !== 1 || (payload.pool != null && !same(payload.pool, FROZEN.pool)))
      throw new Error(`Chain or Pool mismatch: ${name}`)
  }
  const baseline = input.witness.baselines?.[0]
  exactB(baseline, 'witness')
  const witnessMarkets = marketMap(baseline.markets, 'witness')
  const anchor = input.anchor.rows?.[0]
  exactB(anchor, 'anchor')
  if (
    anchor.sourcePhysicalSha256 !== INPUTS.witness[1] ||
    anchor.baselineRowSha256 !== baseline.rowSha256
  )
    throw new Error('Anchor is not linked to frozen witness')
  const anchorMarkets = marketMap(anchor.markets, 'anchor')
  for (const label of ['peer', 'slope']) {
    exactB(input[label], label)
    if (input[label].sourcePhysicalSha256 !== INPUTS.anchor[1])
      throw new Error(`${label} is not linked to frozen anchor features`)
  }
  const peerMarkets = marketMap(input.peer.markets, 'peer')
  const slopeMarkets = marketMap(input.slope.markets, 'slope')
  const exposureMarkets = marketMap(input.exposure.markets, 'exposure')
  const forward = input.forward.samples
  if (!Array.isArray(forward) || forward.length !== 2)
    throw new Error('Expected two forward samples')
  if (!Number.isSafeInteger(input.exposure.firstKnownAtMs))
    throw new Error('Exposure lacks first-known time')
  const rows = []
  const derivedRows = []
  for (const market of ['USDC', 'USDT']) {
    const w = witnessMarkets.get(market)
    if (w.quoteRaw !== FROZEN.quoteRaw) throw new Error(`Frozen quote mismatch: ${market}`)
    const a = anchorMarkets.get(market)
    const p = peerMarkets.get(market)
    const s = slopeMarkets.get(market)
    const e = exposureMarkets.get(market)
    for (const [label, item] of [
      ['anchor', a],
      ['peer', p],
      ['slope', s],
      ['exposure', e],
    ]) {
      if (label === 'peer') {
        if (!same(w.underlying, p.base)) throw new Error(`Peer base mismatch: ${market}`)
      } else marketIdentity(w, item, `${label}/${market}`)
    }
    for (let i = 0; i < forward.length; i++) {
      const sample = forward[i]
      const fm = marketMap(sample.markets, `forward-${i}`).get(market)
      marketIdentity(w, fm, `forward-${i}/${market}`)
      if (sample.block >= FROZEN.block || sample.blockTimestamp >= FROZEN.timestamp)
        throw new Error('Forward sample is not earlier than B')
      rows.push(
        sourceRow(
          market,
          `forward-panel-${i + 1}`,
          {
            sourceBlock: sample.block,
            sourceHash: sample.blockHash,
            sourceTimestamp: sample.blockTimestamp,
            firstKnownAtMs: sample.observedAtMs,
          },
          {
            cashRaw: fm.cashRaw,
            aTokenSupplyRaw: fm.aTokenSupplyRaw,
            variableDebtSupplyRaw: fm.variableDebtSupplyRaw,
            liquidityRateRay: fm.liquidityRateRay,
            optimalUsageRatioBps: fm.strategyBps?.optimalUsageRatio ?? null,
          },
          'D/(D+C) from this panel is not Aave strategy-model utilization.',
        ),
      )
    }
    rows.push(
      sourceRow(
        market,
        'sampled-holder-exposure',
        {
          sourceBlock: input.exposure.block,
          sourceHash: input.exposure.blockHash,
          sourceTimestamp: input.exposure.blockTimestamp,
          firstKnownAtMs: input.exposure.firstKnownAtMs,
        },
        {
          cashRaw: e.cashRaw,
          largestSampledClaimRaw: e.largestSampledClaimRaw,
          largestSampledClaimOverCashPpm: e.largestSampledClaimOverCashPpm,
          largestSampledClaimOverCash: Number(e.largestSampledClaimOverCashPpm) / 1_000_000,
          hypothetical50mCashFractionPpm:
            e.hypotheticalCashShocks?.find(
              (v) => v.amountRaw === String(50_000_000 * 10 ** e.decimals),
            )?.amountOverCashPpm ?? null,
        },
        'Current-only first-page holder sample; exposure is not exit intent or a full census.',
      ),
    )
    const priorForward = forward[1]
    const priorForwardMarket = marketMap(priorForward.markets, 'forward-1').get(market)
    derivedRows.push(
      preBCashChange(
        market,
        {
          sourceBlock: priorForward.block,
          sourceHash: priorForward.blockHash,
          sourceTimestamp: priorForward.blockTimestamp,
          firstKnownAtMs: priorForward.observedAtMs,
        },
        {
          sourceBlock: input.exposure.block,
          sourceHash: input.exposure.blockHash,
          sourceTimestamp: input.exposure.blockTimestamp,
          firstKnownAtMs: input.exposure.firstKnownAtMs,
        },
        priorForwardMarket.cashRaw,
        e.cashRaw,
      ),
    )
    rows.push(
      sourceRow(
        market,
        'frozen-holder-baseline',
        {
          sourceBlock: baseline.block,
          sourceHash: baseline.blockHash,
          sourceTimestamp: baseline.blockTimestamp,
          firstKnownAtMs: baseline.observedAtMs,
        },
        { fixedQuoteRaw: w.quoteRaw, qualifyingHolderCount: w.qualifyingHolders?.length ?? null },
        'Selected feasibility witnesses, not a population risk denominator.',
      ),
    )
    rows.push(
      sourceRow(
        market,
        'strategy-kink-gap',
        {
          sourceBlock: anchor.block,
          sourceHash: anchor.blockHash,
          sourceTimestamp: anchor.blockTimestamp,
          firstKnownAtMs: anchor.observedAtMs,
        },
        {
          signedGapPercentagePoints: decimalRatio(
            a.strategyBorrowUsageModel?.signedGapPercentagePoints,
          ),
          signedGapExact: a.strategyBorrowUsageModel?.signedGapPercentagePoints ?? null,
          cashPerQuote: decimalRatio(a.rawCashProxy?.cashPerQuote),
        },
        'Same-anchor model gap remains conditional on deployed implementation equivalence.',
      ),
    )
    rows.push(
      sourceRow(
        market,
        'compound-minus-aave-apr',
        {
          sourceBlock: input.peer.block,
          sourceHash: input.peer.blockHash,
          sourceTimestamp: input.peer.blockTimestamp,
          firstKnownAtMs: input.peer.firstKnownAtMs,
        },
        {
          spreadBps: p.spreadBps,
          spreadBpsApprox: decimalRatio(p.spreadBps),
          stratum: p.stratum,
          failures: p.failures,
        },
        'Base APR only; no incentive/gas/risk adjustment.',
      ),
    )
    rows.push(
      sourceRow(
        market,
        'prior-24h-cash-slope',
        {
          sourceBlock: input.slope.block,
          sourceHash: input.slope.blockHash,
          sourceTimestamp: input.slope.blockTimestamp,
          firstKnownAtMs: input.slope.firstKnownAtMs,
        },
        {
          priorBlock: input.slope.priorBlock,
          priorBlockHash: input.slope.priorBlockHash,
          cashPriorRaw: s.cashPriorRaw,
          cashBRaw: s.cashBRaw,
          signedSlopeFraction: s.signedSlopeFraction,
          signedSlopeApprox: decimalRatio(s.signedSlopeFraction),
          status: s.status,
        },
        'Contains B cash and was first known after B; historical lookback does not make this pre-B.',
      ),
    )
  }
  rows.push(...derivedRows)
  return {
    study: 'Sep26 Core B source-time eligibility audit; no outcomes',
    frozenB: { ...FROZEN, earliest24hTargetTimestamp: FROZEN.timestamp + 24 * 3600 },
    inputPhysicalSha256: Object.fromEntries(
      Object.entries(INPUTS).map(([key, [, sha]]) => [key, sha]),
    ),
    rows,
    summary: {
      rows: rows.length,
      strictlyBeforeB: rows.filter((row) => row.strictlyBeforeB).length,
      sixHourLeadToEarliest24hTarget: rows.filter((row) => row.atLeast6hBeforeEarliest24hTarget)
        .length,
      outcomesRead: 0,
      thresholdFitted: false,
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out'))
    throw new Error('Usage: node aave-sep26-source-time-audit.mjs [--out /absolute/path.json]')
  if (args.length === 2 && (!isAbsolute(args[1]) || !args[1].endsWith('.json')))
    throw new Error('--out requires one absolute .json path')
  const result = auditPayloads(readPinnedInputs())
  const json = JSON.stringify(result, null, 2) + '\n'
  if (args.length === 2) writeFileSync(args[1], json, { flag: 'wx', mode: 0o600 })
  else process.stdout.write(json)
}
