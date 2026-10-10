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
import { FLOW_STUDY, joinAsOf, STUDY as PEG_STUDY } from './curve-peg-imbalance-asof.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const source = sourceIdentity()
const block = { number: 26_000_001, hash: `0x${'a'.repeat(64)}`, timestamp: 1_780_000_000 }
const iso = (delta) => new Date(block.timestamp * 1000 + delta).toISOString()
const filename = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const shares = [0, 0.25, 0.5, 0.75, 1]
const parts = [
  PARTS.map((p) => String(BigInt(p) * 10n ** 6n)),
  PARTS.map((p) => String(BigInt(p) * 10n ** 6n)),
]
const codeIdentities = [
  source.vault,
  source.crvUsd,
  source.pools[0].coin0,
  source.pools[1].coin0,
  ...source.pools.map((p) => p.address),
].map((address) => ({ address, codeSha256: 'b'.repeat(64) }))

function fixture(legacy = false) {
  const out = mkdtempSync(join(tmpdir(), 'curve-peg-asof-'))
  const gridLegs = shares.map((usdtShare) => {
    const n = 1_000_000 * usdtShare
    const leg = (i, input) => ({
      pool: source.pools[i].address,
      crvUsdInputRaw: String(BigInt(input) * 10n ** 18n),
      outputRaw: String(input ? BigInt(input) * 10n ** 6n : 0n),
    })
    return { usdtShare, usdt: leg(0, n), usdc: leg(1, 1_000_000 - n) }
  })
  const quote = seal({
    study: legacy ? STUDY : STUDY_V2,
    source,
    block,
    captureStartUtc: iso(1_000),
    captureEndUtc: iso(5_000),
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
  const bytes = JSON.stringify(quote)
  writeFileSync(join(out, filename), bytes)
  return { out, quote, physicalSha256: sha(readFileSync(join(out, filename))), filename }
}

function peg(fx, overrides = {}) {
  const receipt = {
    study: PEG_STUDY,
    chainId: 1,
    block,
    quote: {
      filename: fx.filename,
      logicalSha256: fx.quote.sha256,
      physicalSha256: fx.physicalSha256,
      identitySha256: source.identitySha256,
    },
    pinMode: 'hash',
    captureStartUtc: iso(6_000),
    captureEndUtc: iso(9_000),
    sealedAtUtc: iso(9_000),
    pools: source.pools.map((pool) => ({
      address: pool.address,
      codeSha256: 'b'.repeat(64),
      selectorVariant: 'no-arg',
      getPRaw: '1000000000000000000',
      priceOracleRaw: '1000000000000000000',
    })),
    ...overrides,
  }
  return seal(receipt)
}

function flow(fx, overrides = {}) {
  return seal({
    study: FLOW_STUDY,
    block,
    issuedAtUtc: iso(10_000),
    source: {
      quoteFilename: fx.filename,
      quoteCheckpointSha256: fx.quote.sha256,
      quotePhysicalSha256: fx.physicalSha256,
    },
    features: { trailingCompleteWindow: {} },
    ...overrides,
  })
}

const run = (fx, receipt = null, issue = null, decisionAtUtc = iso(15_000)) =>
  joinAsOf({
    quoteOut: fx.out,
    checkpointFilename: fx.filename,
    pegReceipt: receipt,
    flowIssue: issue,
    decisionAtUtc,
  })

test('exact v2 quote, pegged pool/code receipts and known flow issue join as research context', () => {
  const fx = fixture()
  const result = run(fx, peg(fx), flow(fx))
  assert.equal(result.status, 'research_candidate_unverified')
  assert.equal(result.pegStatus, 'reported_available_asof')
  assert.equal(result.flowStatus, 'known_asof_logical_only')
  assert.equal(result.pegAndImbalance.length, 2)
  assert.equal(result.pegAndImbalance[0].atParityImbalanceBps, '0')
  assert.equal(result.source.quotePhysicalSha256, fx.physicalSha256)
})

test('missing peg is unavailable; an already known flow cannot substitute', () => {
  const fx = fixture()
  const result = run(fx, null, flow(fx))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.pegStatus, 'missing')
  assert.equal(result.pegAndImbalance, null)
})

test('late peg and late flow do not leak into the past', () => {
  const fx = fixture()
  const result = run(
    fx,
    peg(fx, { captureEndUtc: iso(20_000), sealedAtUtc: iso(20_000) }),
    flow(fx, { issuedAtUtc: iso(20_000) }),
  )
  assert.equal(result.pegStatus, 'late')
  assert.equal(result.flowStatus, 'late_or_future')
  assert.equal(result.status, 'unavailable')
  assert.equal(run(fx, peg(fx, { sealedAtUtc: iso(20_000) })).pegStatus, 'late')
  assert.equal(run(fx, peg(fx, { sealedAtUtc: iso(4_000) })).pegStatus, 'invalid_clock')
})

test('exact block/hash, quote bytes, pool code and selector variant are mandatory', () => {
  const fx = fixture()
  for (const bad of [
    { block: { ...block, hash: `0x${'c'.repeat(64)}` } },
    {
      quote: {
        filename: fx.filename,
        logicalSha256: fx.quote.sha256,
        physicalSha256: 'c'.repeat(64),
        identitySha256: source.identitySha256,
      },
    },
    { pools: peg(fx).pools.map((p, i) => (i ? p : { ...p, codeSha256: 'c'.repeat(64) })) },
    { pools: peg(fx).pools.map((p, i) => (i ? p : { ...p, selectorVariant: 'indexed' })) },
    { pinMode: 'number-hash-checked' },
  ]) {
    const result = run(fx, peg(fx, bad))
    assert.equal(result.status, 'unavailable')
  }
})

test('tampered logical seals and invalid/future decision clocks fail closed', () => {
  const fx = fixture()
  assert.equal(run(fx, { ...peg(fx), captureEndUtc: iso(8_000) }).pegStatus, 'invalid_receipt')
  assert.throws(() => run(fx, peg(fx), null, 'not a date'), /Invalid decision clock/)
  assert.equal(run(fx, peg(fx), null, iso(4_000)).pegStatus, 'late')
})

test('raw oracle values must be strings so JSON number coercion cannot lose precision', () => {
  const fx = fixture()
  for (const field of ['getPRaw', 'priceOracleRaw']) {
    const pools = peg(fx).pools.map((pool, i) =>
      i === 0 ? { ...pool, [field]: 1_000_000_000_000_000_000 } : pool,
    )
    assert.equal(run(fx, peg(fx, { pools })).pegStatus, 'invalid_receipt')
  }
})

test('a resealed backdated in-memory receipt stays explicitly unverified', () => {
  const fx = fixture()
  const backdated = peg(fx, {
    captureStartUtc: iso(1_000),
    captureEndUtc: iso(2_000),
    sealedAtUtc: iso(5_000),
  })
  const result = run(fx, backdated)
  assert.equal(result.status, 'research_candidate_unverified')
  assert.equal(result.pegStatus, 'reported_available_asof')
  assert.match(result.caveat, /backdate and reseal/)
})

test('legacy v1 quote cannot become a peg/imbalance signal, even with a receipt', () => {
  const fx = fixture(true)
  assert.equal(run(fx, peg(fx)).status, 'legacy_quote_unavailable')
})

test('missing quote filename does not fall back to a newer or older block', () => {
  const fx = fixture()
  assert.equal(
    joinAsOf({
      quoteOut: fx.out,
      checkpointFilename: 'wrong.json',
      pegReceipt: peg(fx),
      decisionAtUtc: iso(15_000),
    }).status,
    'missing_quote',
  )
})
