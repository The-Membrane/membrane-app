import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DATES,
  buildLedger,
  dryPlan,
  exploratorySummary,
  readSealedSource,
} from './aave-core-prospective-score.mjs'

const sha = (x) => createHash('sha256').update(x).digest('hex')
const HASH = `0x${'a'.repeat(64)}`
const HOLDER = `0x${'1'.repeat(40)}`
const POOL = `0x${'2'.repeat(40)}`
const IMPLEMENTATION = `0x${'7'.repeat(40)}`
const EIP1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ASSETS = {
  USDC: { underlying: `0x${'3'.repeat(40)}`, aToken: `0x${'4'.repeat(40)}` },
  USDT: { underlying: `0x${'5'.repeat(40)}`, aToken: `0x${'6'.repeat(40)}` },
}
const asTime = (day, h, m = 0) =>
  Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`)
const raw = (payload) => JSON.stringify({ payload, sha256: sha(JSON.stringify(payload)) })

function fixture(
  t,
  {
    date = DATES[0],
    outcome = 'revert',
    peerKnownHour = 6,
    peerKnownMinute = 20,
    peerBps = 60,
    aaveFlags = { active: true, paused: false, frozen: false },
    wrongHolder = false,
    badBaselineSha = false,
    outcomeDelaySeconds = 0,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'aave-score-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const blockTimestamp = asTime(date, 5, 47) / 1000
  const quoteRaw = '1000000000000'
  const compoundRate = 1_000_000_000n
  const liquidityRateRay = (
    compoundRate * 31_536_000n * 1_000_000_000n -
    BigInt(peerBps) * 10n ** 23n
  ).toString()
  const names = ['USDC', 'USDT']
  const bm = names.map((name) => ({
    name,
    ...ASSETS[name],
    quoteRaw,
    qualifyingHolders: name === 'USDC' ? [HOLDER] : [],
  }))
  const baseline = {
    block: 100,
    blockHash: HASH,
    blockTimestamp,
    observedAtMs: asTime(date, 6, 0),
    rowSha256: 'b'.repeat(64),
    markets: bm,
  }
  const witness = {
    study: 'aave-core-holder-witness-v1',
    chainId: 1,
    pool: POOL,
    baselines: [baseline],
  }
  const feature = {
    study: 'aave-core-anchor-features-v1',
    chainId: 1,
    pool: POOL,
    rows: [
      {
        block: 100,
        blockHash: HASH,
        blockTimestamp,
        observedAtMs: asTime(date, 6, 1),
        markets: names.map((name) => ({
          name,
          ...ASSETS[name],
          liquidityRateRay,
          flags: aaveFlags,
          rawCashProxy: {
            cashRaw: '10000000000000',
            cashPerQuote: { numerator: '10000000000000', denominator: quoteRaw },
          },
        })),
      },
    ],
  }
  const sources = { [date]: {} }
  const save = (kind, payload) => {
    const bytes = raw(payload)
    const path = join(dir, `${kind}.json`)
    writeFileSync(path, bytes)
    sources[date][kind] = { path, sha256: sha(bytes) }
  }
  save('witness', witness)
  feature.rows[0].sourcePhysicalSha256 = sources[date].witness.sha256
  feature.rows[0].baselineRowSha256 = baseline.rowSha256
  save('feature', feature)
  const peer = {
    study: 'aave-compound-peer-rate-v1',
    chainId: 1,
    block: 100,
    blockHash: HASH,
    blockTimestamp,
    firstKnownAtMs: asTime(date, peerKnownHour, peerKnownMinute),
    sourcePhysicalSha256: sources[date].feature.sha256,
    markets: names.map((market) => ({
      market,
      base: ASSETS[market].underlying,
      proxyCodeHash: HASH,
      implementation: { slot: EIP1967_SLOT, address: IMPLEMENTATION, codeHash: HASH },
      aaveLiquidityRateRay: liquidityRateRay,
      aaveFlags: { ...aaveFlags },
      compoundUtilizationRaw: '1',
      compoundSupplyRatePerSecondRaw: compoundRate.toString(),
      withdrawPaused: false,
      stratum: peerBps >= 50 ? 'ge50bp' : peerBps <= 0 ? 'le0bp' : 'gt0lt50bp',
      spreadBps: { numerator: String(peerBps), denominator: '1' },
      failures: [],
    })),
  }
  save('peer', peer)
  const slope = {
    study: 'aave-core-cash-slope-v1',
    chainId: 1,
    block: 100,
    blockHash: HASH,
    captureDate: date,
    firstKnownAtMs: asTime(date, 6, 30),
    sourcePhysicalSha256: sources[date].feature.sha256,
    markets: names.map((market) => ({
      market,
      ...ASSETS[market],
      status: 'eligible',
      cashBRaw: '10000000000000',
      cashPriorRaw: '11000000000000',
      signedSlopeFraction: { numerator: '-1000000000000', denominator: '11000000000000' },
    })),
  }
  save('slope', slope)
  if (outcome) {
    const rows = ['24h', '7d'].map((horizon) => {
      const seconds = horizon === '24h' ? 86400 : 604800
      return {
        baselineBlock: 100,
        baselineBlockHash: HASH,
        baselineSha256: badBaselineSha ? 'c'.repeat(64) : baseline.rowSha256,
        horizon,
        targetTimestamp: blockTimestamp + seconds,
        block: 200,
        blockHash: HASH,
        blockTimestamp: blockTimestamp + seconds + outcomeDelaySeconds,
        observedAtMs: (blockTimestamp + seconds + outcomeDelaySeconds) * 1000 + 1000,
        markets: names.map((name) => ({
          name,
          ...ASSETS[name],
          quoteRaw,
          witnesses:
            name === 'USDC'
              ? [
                  {
                    holder: wrongHolder ? POOL : HOLDER,
                    call:
                      outcome === 'revert'
                        ? 'revert'
                        : outcome === 'censored'
                          ? 'rpc-error'
                          : 'success',
                    censoring: outcome === 'censored' ? ['holder-attrition'] : [],
                    deterioration:
                      outcome === 'revert'
                        ? 'baseline-success-to-unattributed-revert'
                        : outcome === 'censored'
                          ? 'censored'
                          : 'no-observed-revert',
                  },
                ]
              : [],
        })),
      }
    })
    save('outcomes', { study: 'aave-core-holder-outcomes-v1', chainId: 1, outcomes: rows })
  }
  return sources
}

function resealSource(sources, date, kind, change) {
  const spec = sources[date][kind]
  const payload = structuredClone(readSealedSource(spec).payload)
  change(payload)
  const bytes = raw(payload)
  writeFileSync(spec.path, bytes)
  spec.sha256 = sha(bytes)
}

test('frozen denominator retains all 28 market-days when nothing captured', () => {
  const ledger = buildLedger()
  assert.equal(ledger.rows.length, 28)
  assert.equal(ledger.rows.filter((r) => r.split === 'sequestered').length, 14)
  assert.equal(
    ledger.rows.every((r) => r.status === 'missing-capture'),
    true,
  )
  assert.equal(dryPlan().missing.length, 28)
})

test('physical and payload SHA failures do not become observations', (t) => {
  const sources = fixture(t)
  assert.equal(
    readSealedSource(sources[DATES[0]].feature).payload.study,
    'aave-core-anchor-features-v1',
  )
  sources[DATES[0]].feature.sha256 = '0'.repeat(64)
  assert.equal(buildLedger(sources).rows[0].status, 'invalid')
})

test('synthetic fixed-holder same-q event is scored in development only', (t) => {
  const ledger = buildLedger(fixture(t))
  const usdc = ledger.rows[0]
  assert.equal(usdc.status, 'captured')
  assert.equal(usdc.features.peerFlag, true)
  assert.equal(usdc.outcomes['24h'].status, 'event')
  assert.equal(usdc.outcomes['7d'].status, 'event')
  assert.equal(usdc.outcomes['24h'].scoreEligible, true)
  assert.equal(ledger.rows[1].outcomes['24h'].status, 'no-fixed-holder')
  const summary = exploratorySummary(ledger)
  assert.equal(summary.exploratory.eventMarketDays, 1)
  assert.equal(summary.exploratory.controlMarketDays, 0)
  assert.equal(summary.sequestered.scored, false)
  assert.equal(summary.gate.pass, false)
})

test('recorded noneligible peer strata stay explicit and do not score raw spreads', (t) => {
  const date = DATES[0]
  for (const stratum of ['aave-ineligible', 'paused', 'missing', 'implementation-unresolved']) {
    const sources = fixture(t, {
      outcome: 'success',
      aaveFlags:
        stratum === 'aave-ineligible'
          ? { active: true, paused: true, frozen: false }
          : { active: true, paused: false, frozen: false },
    })
    resealSource(sources, date, 'peer', (x) => {
      x.markets[0].stratum = stratum
      // A raw rate is available even though the control is not eligible.
      x.markets[0].spreadBps = { numerator: '60', denominator: '1' }
      if (stratum === 'paused') x.markets[0].withdrawPaused = true
      if (stratum === 'missing') {
        x.markets[0].withdrawPaused = null
        x.markets[0].failures = ['pause-state-read']
      }
      if (stratum === 'implementation-unresolved') {
        x.markets[0].implementation.address = null
        x.markets[0].implementation.codeHash = null
      }
    })
    const row = buildLedger(sources).rows[0]
    assert.equal(row.status, 'captured', stratum)
    assert.equal(row.features.peerStratum, stratum)
    assert.equal(row.features.peerSpreadBps, null)
    assert.equal(row.features.peerFlag, null)
    assert.equal(row.features.peerObservedAtMs, null)
    assert.equal(row.outcomes['24h'].status, 'control')
    assert.equal(row.outcomes['24h'].scoreEligible, false)
  }
})

test('negative peer spread is a valid le0bp control stratum', (t) => {
  const row = buildLedger(fixture(t, { peerBps: -12, outcome: 'success' })).rows[0]
  assert.equal(row.status, 'captured')
  assert.equal(row.features.peerStratum, 'le0bp')
  assert.equal(row.features.peerSpreadBps, -12)
  assert.equal(row.features.peerFlag, false)
  assert.equal(row.outcomes['24h'].scoreEligible, true)
})

test('peer spread must be the exact reduced fraction derived from its raw rates', (t) => {
  const date = DATES[0]
  for (const mutate of [
    (x) => (x.spreadBps = { numerator: '61', denominator: '1' }),
    (x) => (x.compoundSupplyRatePerSecondRaw = '1000000001'),
  ]) {
    const sources = fixture(t)
    resealSource(sources, date, 'peer', (x) => mutate(x.markets[0]))
    const row = buildLedger(sources).rows[0]
    assert.equal(row.status, 'invalid')
    assert.match(row.reason, /raw rate\/spread mismatch/i)
  }
})

test('unknown and mismatched eligible peer strata fail closed', (t) => {
  const date = DATES[0]
  for (const stratum of ['ineligible', 'future-status', 'gt0lt50bp']) {
    const sources = fixture(t)
    resealSource(sources, date, 'peer', (x) => {
      x.markets[0].stratum = stratum
    })
    const row = buildLedger(sources).rows[0]
    assert.equal(row.status, 'invalid', stratum)
    assert.match(row.reason, /peer stratum/i)
  }
})

test('eligible peer label cannot override adverse collector state', (t) => {
  const date = DATES[0]
  const contradictions = [
    ['Aave paused', (x) => (x.aaveFlags.paused = true)],
    ['Aave inactive', (x) => (x.aaveFlags.active = false)],
    ['Compound paused', (x) => (x.withdrawPaused = true)],
    [
      'implementation unresolved',
      (x) => {
        x.implementation.address = null
        x.implementation.codeHash = null
      },
    ],
    ['read failure', (x) => (x.failures = ['pause-state-read'])],
  ]
  for (const [label, mutate] of contradictions) {
    const sources = fixture(t)
    resealSource(sources, date, 'peer', (x) => mutate(x.markets[0]))
    const row = buildLedger(sources).rows[0]
    assert.equal(row.status, 'invalid', label)
    assert.match(row.reason, /peer .* mismatch|peer collector state malformed/i)
  }
})

test('noneligible labels require their exact collector cause and precedence', (t) => {
  const date = DATES[0]
  for (const stratum of ['aave-ineligible', 'paused', 'missing', 'implementation-unresolved']) {
    const sources = fixture(t)
    resealSource(sources, date, 'peer', (x) => {
      x.markets[0].stratum = stratum
    })
    const row = buildLedger(sources).rows[0]
    assert.equal(row.status, 'invalid', stratum)
    assert.match(row.reason, /peer stratum\/collector state mismatch/i)
  }
  const early = fixture(t)
  resealSource(early, date, 'peer', (x) => {
    x.markets[0].stratum = 'aave-ineligible'
    x.markets[0].aaveFlags.paused = true
    x.markets[0].proxyCodeHash = null
    x.markets[0].implementation = null
    x.markets[0].compoundUtilizationRaw = null
    x.markets[0].compoundSupplyRatePerSecondRaw = null
    x.markets[0].withdrawPaused = null
    x.markets[0].spreadBps = null
    x.markets[0].failures = ['proxy-code-read']
  })
  assert.equal(buildLedger(early).rows[0].status, 'invalid')
})

test('early proxy failure remains missing even when Aave is paused', (t) => {
  const sources = fixture(t, {
    aaveFlags: { active: true, paused: true, frozen: false },
  })
  resealSource(sources, DATES[0], 'peer', (x) => {
    const peer = x.markets[0]
    peer.stratum = 'missing'
    peer.aaveFlags.paused = true
    peer.proxyCodeHash = null
    peer.implementation = null
    peer.compoundUtilizationRaw = null
    peer.compoundSupplyRatePerSecondRaw = null
    peer.withdrawPaused = null
    peer.spreadBps = null
    peer.failures = ['proxy-code-read']
  })
  const row = buildLedger(sources).rows[0]
  assert.equal(row.status, 'captured')
  assert.equal(row.features.peerStratum, 'missing')
  assert.equal(row.features.peerSpreadBps, null)
  assert.equal(row.outcomes['24h'].scoreEligible, false)
})

test('peer read failures cannot retain fields the collector would not have read', (t) => {
  const date = DATES[0]
  const cases = [
    (peer) => {
      peer.stratum = 'missing'
      peer.failures = ['pause-state-read']
      // A failed pause read cannot also return false.
    },
    (peer) => {
      peer.stratum = 'missing'
      peer.failures = ['utilization-read']
      peer.compoundUtilizationRaw = null
      // An absent utilization cannot produce a supply-rate reading.
    },
    (peer) => {
      peer.stratum = 'missing'
      peer.failures = ['pause-state-read']
      peer.withdrawPaused = null
      peer.compoundUtilizationRaw = null
      peer.compoundSupplyRatePerSecondRaw = null
      peer.spreadBps = null
      // A missing utilization must record its own read failure.
    },
    (peer) => {
      peer.stratum = 'missing'
      peer.failures = ['pause-state-read', 'pause-state-read']
      peer.withdrawPaused = null
      // A collector attempts the pause read once, so failure codes are unique.
    },
    (peer) => {
      peer.stratum = 'missing'
      peer.failures = ['proxy-code-read']
      peer.proxyCodeHash = null
      peer.implementation = null
      peer.withdrawPaused = null
      peer.spreadBps = null
      // Early exit cannot contain downstream utilization/rate reads.
    },
  ]
  for (const mutate of cases) {
    const sources = fixture(t)
    resealSource(sources, date, 'peer', (x) => mutate(x.markets[0]))
    assert.equal(buildLedger(sources).rows[0].status, 'invalid')
  }
})

test('missing outcomes and censored calls cannot become safe controls', (t) => {
  assert.equal(
    buildLedger(fixture(t, { outcome: null })).rows[0].outcomes['24h'].status,
    'missing-outcome',
  )
  assert.equal(
    buildLedger(fixture(t, { outcome: 'censored' })).rows[0].outcomes['24h'].status,
    'censored',
  )
})

test('local observation lead, not pinned block age, governs eligibility', (t) => {
  const ledger = buildLedger(
    fixture(t, {
      peerKnownHour: 23,
      peerKnownMinute: 50,
      outcome: 'success',
      outcomeDelaySeconds: 1800,
    }),
  )
  assert.equal(ledger.rows[0].outcomes['24h'].status, 'control')
  assert.equal(ledger.rows[0].outcomes['24h'].scoreEligible, false)
})

test('source links, observation clocks, assets, and cash arithmetic fail closed', (t) => {
  const date = DATES[0]
  const link = fixture(t)
  resealSource(link, date, 'feature', (x) => {
    x.rows[0].sourcePhysicalSha256 = '0'.repeat(64)
  })
  assert.equal(buildLedger(link).rows[0].status, 'invalid')

  const clock = fixture(t)
  resealSource(clock, date, 'peer', (x) => {
    x.firstKnownAtMs = x.blockTimestamp * 1000
  })
  assert.equal(buildLedger(clock).rows[0].status, 'invalid')

  const asset = fixture(t)
  resealSource(asset, date, 'outcomes', (x) => {
    x.outcomes[0].markets[0].underlying = POOL
  })
  assert.equal(buildLedger(asset).rows[0].status, 'invalid')

  const cash = fixture(t)
  resealSource(cash, date, 'feature', (x) => {
    x.rows[0].markets[0].rawCashProxy.cashPerQuote.numerator = '1'
  })
  delete cash[date].peer
  delete cash[date].slope
  assert.equal(buildLedger(cash).rows[0].status, 'invalid')
})

test('holder drift and bad outcome baseline source fail closed', (t) => {
  assert.equal(buildLedger(fixture(t, { wrongHolder: true })).rows[0].status, 'invalid')
  assert.equal(buildLedger(fixture(t, { badBaselineSha: true })).rows[0].status, 'invalid')
})

test('sequestered day is retained but never evaluated in exploratory summary', (t) => {
  const ledger = buildLedger(fixture(t, { date: DATES[7] }))
  assert.equal(ledger.rows[14].outcomes['24h'].status, 'event')
  assert.equal(exploratorySummary(ledger).exploratory.eventMarketDays, 0)
  assert.equal(exploratorySummary(ledger).sequestered.scored, false)
})

test('repeated holder market-days form one dependent group', (t) => {
  const one = fixture(t, { date: DATES[0], outcome: 'revert' })
  const two = fixture(t, { date: DATES[1], outcome: 'success' })
  const summary = exploratorySummary(buildLedger({ ...one, ...two })).exploratory
  assert.equal(summary.eventMarketDays, 1)
  assert.equal(summary.controlMarketDays, 1)
  assert.equal(summary.independentHolderMarketGroups, 1)
  assert.equal(summary.independentEventGroups, 1)
  assert.equal(summary.independentControlOnlyGroups, 0)
})
