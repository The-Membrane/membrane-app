import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  auditPayloads,
  classifySourceTime,
  FROZEN,
  readPinnedInputs,
} from './aave-sep26-source-time-audit.mjs'

test('strict pre-B requires source state and local knowledge both before frozen B', () => {
  const common = {
    sourceBlock: FROZEN.block - 1,
    sourceHash: FROZEN.hash,
    sourceTimestamp: FROZEN.timestamp - 1,
  }
  assert.equal(
    classifySourceTime({ ...common, firstKnownAtMs: FROZEN.timestamp * 1000 - 1 }).strictlyBeforeB,
    true,
  )
  assert.equal(
    classifySourceTime({ ...common, firstKnownAtMs: FROZEN.timestamp * 1000 }).strictlyBeforeB,
    false,
  )
  assert.equal(
    classifySourceTime({
      ...common,
      sourceBlock: FROZEN.block,
      firstKnownAtMs: FROZEN.timestamp * 1000 - 1,
    }).strictlyBeforeB,
    false,
  )
})

test('six-hour lead uses local first-known time, not source block timestamp', () => {
  const common = {
    sourceBlock: FROZEN.block - 1,
    sourceHash: FROZEN.hash,
    sourceTimestamp: FROZEN.timestamp - 3600,
  }
  const cutoff = (FROZEN.timestamp + 18 * 3600) * 1000
  assert.equal(
    classifySourceTime({ ...common, firstKnownAtMs: cutoff }).atLeast6hBeforeEarliest24hTarget,
    true,
  )
  assert.equal(
    classifySourceTime({ ...common, firstKnownAtMs: cutoff + 1 }).atLeast6hBeforeEarliest24hTarget,
    false,
  )
})

test('six pinned artifacts produce market rows without any outcome', () => {
  const result = auditPayloads(readPinnedInputs())
  assert.equal(result.rows.length, 16)
  assert.deepEqual(
    result.rows
      .map((row) => row.market)
      .reduce((acc, market) => ({ ...acc, [market]: (acc[market] || 0) + 1 }), {}),
    { USDC: 8, USDT: 8 },
  )
  assert.equal(result.summary.strictlyBeforeB, 8)
  assert.equal(result.summary.sixHourLeadToEarliest24hTarget, 16)
  assert.equal(result.summary.outcomesRead, 0)
  assert.equal(result.summary.thresholdFitted, false)
  assert.ok(
    result.rows.find((row) => row.market === 'USDT' && row.feature === 'compound-minus-aave-apr')
      .values.spreadBpsApprox < 0,
  )
  assert.ok(
    result.rows.find((row) => row.market === 'USDT' && row.feature === 'prior-24h-cash-slope')
      .values.signedSlopeApprox < 0,
  )
  for (const row of result.rows) {
    assert.ok(row.firstKnownAtMs > 0)
    assert.match(row.sourceHash, /^0x[a-f0-9]{64}$/)
    assert.equal('outcome' in row, false)
  }
  assert.ok(
    result.rows
      .filter(
        (row) =>
          row.feature.startsWith('forward-panel') ||
          row.feature === 'sampled-holder-exposure' ||
          row.feature === 'strict-pre-b-cash-change',
      )
      .every((row) => row.strictlyBeforeB),
  )
  assert.ok(
    result.rows
      .filter(
        (row) =>
          !row.feature.startsWith('forward-panel') &&
          row.feature !== 'sampled-holder-exposure' &&
          row.feature !== 'strict-pre-b-cash-change',
      )
      .every((row) => !row.strictlyBeforeB),
  )
  assert.deepEqual(
    result.rows.slice(-2).map((row) => row.feature),
    ['strict-pre-b-cash-change', 'strict-pre-b-cash-change'],
  )
})

test('derived cash change uses only the two pre-B raw balances and clocks', () => {
  const inputs = readPinnedInputs()
  const result = auditPayloads(inputs)
  for (const row of result.rows.slice(-2)) {
    const market = row.market
    const earlier = inputs.forward.samples[1]
    const earlyCash = earlier.markets.find((item) => item.name === market).cashRaw
    const laterCash = inputs.exposure.markets.find((item) => item.name === market).cashRaw
    assert.equal(row.values.earlierCashRaw, earlyCash)
    assert.equal(row.values.laterCashRaw, laterCash)
    assert.equal(row.values.signedChangeRaw, (BigInt(laterCash) - BigInt(earlyCash)).toString())
    assert.deepEqual(row.values.signedChangeFractionExact, {
      numerator: row.values.signedChangeRaw,
      denominator: earlyCash,
    })
    assert.equal(
      row.values.elapsedSourceSeconds,
      inputs.exposure.blockTimestamp - earlier.blockTimestamp,
    )
    assert.equal(
      row.values.elapsedKnowledgeMs,
      inputs.exposure.firstKnownAtMs - earlier.observedAtMs,
    )
    assert.equal(row.values.censoredReason, null)
    assert.equal(row.strictlyBeforeB, true)
  }
})

test('zero earlier cash is censored and post-B knowledge is refused', () => {
  const inputs = readPinnedInputs()
  const zero = structuredClone(inputs)
  zero.forward.samples[1].markets[0].cashRaw = '0'
  const row = auditPayloads(zero).rows.find(
    (item) => item.market === 'USDC' && item.feature === 'strict-pre-b-cash-change',
  )
  assert.equal(row.values.censoredReason, 'invalid-or-zero-earlier-cash')
  assert.equal(row.values.signedChangeFractionExact, null)
  assert.equal(row.values.signedChangeFractionApprox, null)
  const late = structuredClone(inputs)
  late.exposure.firstKnownAtMs = FROZEN.timestamp * 1000 + 1
  assert.throws(() => auditPayloads(late), /not ordered strictly before B/)
})

test('source-link and identity mismatch refuse the audit', () => {
  const input = readPinnedInputs()
  const badLink = structuredClone(input)
  badLink.peer.sourcePhysicalSha256 = '0'.repeat(64)
  assert.throws(() => auditPayloads(badLink), /not linked/)
  const badMarket = structuredClone(input)
  badMarket.exposure.markets[0].base = '0x1111111111111111111111111111111111111111'
  assert.throws(() => auditPayloads(badMarket), /Market identity mismatch/)
  const badChain = structuredClone(input)
  badChain.peer.chainId = 10
  assert.throws(() => auditPayloads(badChain), /Chain or Pool mismatch/)
  const badQuote = structuredClone(input)
  badQuote.witness.baselines[0].markets[0].quoteRaw = '1'
  assert.throws(() => auditPayloads(badQuote), /Frozen quote mismatch/)
})
