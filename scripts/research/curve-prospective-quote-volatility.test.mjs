import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PARTS,
  routesFromParts,
  sourceIdentity,
  STUDY,
  STUDY_V2,
} from './curve-prospective-quote.mjs'
import { analyze, calculate } from './curve-prospective-quote-volatility.mjs'

const sha = (v) => createHash('sha256').update(v).digest('hex')
const seal = (v) => ({ ...v, sha256: sha(JSON.stringify(v)) })
const source = sourceIdentity()
const start = 1_780_000_000
const iso = (s) => new Date(s * 1000).toISOString()
const codeIdentities = [
  source.vault,
  source.crvUsd,
  source.pools[0].coin0,
  source.pools[1].coin0,
  ...source.pools.map((p) => p.address),
].map((address) => ({ address, codeSha256: 'b'.repeat(64) }))

function fixture(
  number,
  timestamp,
  quoteUsd = 1_000_000,
  { legacy = false, captureDelay = 60, hashSuffix = '' } = {},
) {
  const parts = Array.from({ length: 2 }, () =>
    PARTS.map((p) => String(BigInt(p) * BigInt(quoteUsd))),
  )
  const gridLegs = [0, 0.25, 0.5, 0.75, 1].map((usdtShare) => {
    const usdt = 1_000_000 * usdtShare
    const usdc = 1_000_000 - usdt
    const leg = (i, n) => ({
      pool: source.pools[i].address,
      crvUsdInputRaw: String(BigInt(n) * 10n ** 18n),
      outputRaw: n ? parts[i][PARTS.indexOf(n)] : '0',
    })
    return { usdtShare, usdt: leg(0, usdt), usdc: leg(1, usdc) }
  })
  const checkpoint = seal({
    study: legacy ? STUDY : STUDY_V2,
    source,
    block: { number, hash: `0x${(number.toString(16) + hashSuffix).padStart(64, '0')}`, timestamp },
    captureStartUtc: iso(timestamp + captureDelay - 1),
    captureEndUtc: iso(timestamp + captureDelay),
    pinMode: 'hash',
    pinCaveat: null,
    ...(legacy
      ? {}
      : {
          quoteCaveat:
            'Nominal Curve get_dy only; not a scrvUSD holder withdrawal, executable fill, gas-adjusted result, or MEV bound.',
        }),
    raw: {
      vaultAssetsCrvUsd: '1000000000000000000',
      parts,
      ...(legacy
        ? {}
        : {
            poolStates: source.pools.map((pool) => ({
              address: pool.address,
              balancesRaw: ['1000000', '1000000000000000000'],
              feeRaw: '4000000',
              ARaw: '200',
            })),
            codeIdentities,
            gridLegs,
          }),
    },
    routes: routesFromParts(parts),
  })
  return checkpoint
}

function put(out, checkpoint) {
  const name = `${String(checkpoint.block.number).padStart(12, '0')}-${checkpoint.block.hash.slice(2)}.json`
  const path = join(out, name)
  writeFileSync(path, JSON.stringify(checkpoint) + '\n')
  return path
}

function corpus() {
  const out = mkdtempSync(join(tmpdir(), 'curve-quote-vol-'))
  put(out, fixture(100, start, 1_000_000))
  put(out, fixture(101, start + 10 * 3600, 990_000))
  put(out, fixture(102, start + 20 * 3600, 1_010_000))
  const opts = {
    out,
    asOfUtc: iso(start + 21 * 3600),
    computedAtUtc: iso(start + 21 * 3600),
    minCount: 3,
    minSpanSeconds: 18 * 3600,
    maxGapSeconds: 11 * 3600,
  }
  return { out, opts }
}

test('unannualized dimensionless quote variation retains all physical sources', () => {
  const { opts } = corpus()
  const result = analyze(opts)
  const expected = Math.sqrt(Math.log(0.99) ** 2 + Math.log(1.01 / 0.99) ** 2)
  assert.equal(result.status, 'research_candidate')
  assert.ok(Math.abs(result.realizedVariation - expected) < 1e-12)
  assert.equal(result.realizedVariationPercent, expected * 100)
  assert.equal(result.returnCount, 2)
  assert.equal(result.contributingSources.length, 3)
  assert.ok(result.contributingSources.every((p) => /^[0-9a-f]{64}$/.test(p.physicalSha256)))
  assert.equal(result.featureAvailableAtUtc, opts.computedAtUtc)
  assert.match(result.coverageMeaning, /not continuous 24h coverage/)
  assert.match(result.signalLimit, /not asset\/oracle volatility/)
})

test('future block is excluded; late capture and computation cannot be backdated', () => {
  const { out, opts } = corpus()
  put(out, fixture(103, start + 22 * 3600, 700_000))
  assert.equal(analyze(opts).contributingSources.length, 3)
  const tooLate = { ...opts, asOfUtc: iso(start + 20 * 3600 + 30) }
  assert.equal(analyze(tooLate).reason, 'computed_after_asof')
  assert.equal(analyze({ ...tooLate, computedAtUtc: tooLate.asOfUtc }).reason, 'late_checkpoint')
})

test('missing count, span, gap, legacy-v1 and zero quote fail closed', () => {
  const { out, opts } = corpus()
  assert.equal(analyze({ ...opts, minCount: 4 }).reason, 'insufficient_count')
  assert.equal(analyze({ ...opts, minSpanSeconds: 22 * 3600 }).reason, 'insufficient_span')
  assert.equal(analyze({ ...opts, maxGapSeconds: 4 * 3600 }).reason, 'observation_gap')
  put(out, fixture(104, start + 19 * 3600, 1_000_000, { legacy: true }))
  assert.equal(analyze(opts).reason, 'legacy_v1_checkpoint')
  const v2Only = corpus()
  const zero = fixture(105, start + 19 * 3600, 0)
  put(v2Only.out, zero)
  assert.equal(analyze(v2Only.opts).reason, 'invalid_or_zero_quote')
})

test('missing leading edge makes the frozen 24h window unavailable', () => {
  const out = mkdtempSync(join(tmpdir(), 'curve-quote-vol-leading-'))
  for (const [i, hour] of [10, 16, 22].entries()) put(out, fixture(200 + i, start + hour * 3600))
  const result = analyze({
    out,
    asOfUtc: iso(start + 23 * 3600),
    computedAtUtc: iso(start + 23 * 3600),
    minCount: 3,
    minSpanSeconds: 12 * 3600,
    maxGapSeconds: 7 * 3600,
  })
  assert.equal(result.reason, 'observation_gap')
  assert.equal(result.leadingGapSeconds, 11 * 3600)
  assert.equal(result.edgeGapSeconds, 3600)
})

test('physical tamper and duplicate height are rejected by the validated reader', () => {
  const { out, opts } = corpus()
  const path = join(
    out,
    `${String(101).padStart(12, '0')}-${fixture(101, start + 10 * 3600).block.hash.slice(2)}.json`,
  )
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, original.replace('990000', '980000'))
  assert.throws(() => analyze(opts), /SHA mismatch/)
  writeFileSync(path, original)
  put(out, fixture(101, start + 11 * 3600, 1_000_000, { hashSuffix: 'f' }))
  assert.throws(() => analyze(opts), /Duplicate block/)
})

test('pure seam cannot claim as-of computation from a later local clock', () => {
  const result = calculate([], { asOfUtc: iso(start), computedAtUtc: iso(start + 1) })
  assert.equal(result.reason, 'computed_after_asof')
  assert.equal(result.featureAvailableAtUtc, iso(start + 1))
})
