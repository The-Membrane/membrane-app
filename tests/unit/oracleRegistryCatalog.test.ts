// Gate for the oracle registry catalog (data/oracle-registry/catalog.json).
//
// The catalog's addresses are proven on-chain by scripts/oracle-registry/verify-catalog.mjs
// (network-bound, run by hand). This test pins what can be checked offline and would
// silently rot otherwise: enums and cross-references parse, every entry was stamped
// `verified`, the consensus roles obey the policy (one member per provider family; exchange-
// rate / capped / fixed prices are never members or alternates, so they are never painted as
// outliers naively), every MVP asset can form a consensus, and every lending-market claim in
// `usedBy` that says "direct" carries an on-chain check the verifier can re-run.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'

import {
  catalogAssets,
  consensusMembers,
  entriesForAsset,
  getOracleCatalog,
  governanceEvents,
  parseCatalog,
  type OracleCatalog,
} from '@/lib/oracleRegistry/catalog'
import {
  AGE_ONLY_MAX_AGE_SECONDS,
  graceSeconds,
  PULL_MAX_AGE_SECONDS,
} from '@/lib/oracleRegistry/normalize'

const catalog = getOracleCatalog()

describe('oracle registry catalog', () => {
  it('parses and every entry has been verified on-chain', () => {
    expect(catalog.entries.length).toBeGreaterThan(50)
    const unverified = catalog.entries
      .filter((e) => e.status !== 'verified')
      .map((e) => `${e.id}: ${e.statusReason}`)
    expect(unverified).toEqual([])
    for (const e of catalog.entries) expect(e.verifiedBlock, e.id).toBeGreaterThan(0)
  })

  it('stores checksummed addresses (entries, components, checks)', () => {
    for (const e of catalog.entries) {
      expect(getAddress(e.address), e.id).toBe(e.address)
      for (const c of e.mechanism.components)
        expect(getAddress(c.address), `${e.id}/${c.role}`).toBe(c.address)
    }
  })

  it('covers every MVP asset with at least two consensus members (the PT has its one market TWAP)', () => {
    for (const a of catalogAssets('mvp')) {
      const members = consensusMembers(a.key)
      expect(members.length, a.key).toBeGreaterThanOrEqual(a.key.startsWith('PT-') ? 1 : 2)
    }
    expect(consensusMembers('BTC').length).toBeGreaterThanOrEqual(3)
  })

  it('has at most one consensus member per provider per asset', () => {
    for (const a of catalog.assets) {
      const providers = consensusMembers(a.key).map((e) => e.provider)
      expect(new Set(providers).size, a.key).toBe(providers.length)
    }
  })

  it('never lets an exchange-rate, capped or fixed price act as a market reading', () => {
    for (const e of catalog.entries) {
      if (e.class === 'capped_exchange_rate' || e.class === 'fixed')
        expect(e.consensus.role, e.id).toBe('basis')
      if (e.class === 'exchange_rate') expect(['basis', 'member'], e.id).toContain(e.consensus.role)
    }
    // The only exchange-rate member is the atomic-redemption case (sUSDS ↔ USDS).
    const rateMembers = catalog.entries.filter(
      (e) => e.class === 'exchange_rate' && e.consensus.role === 'member',
    )
    expect(rateMembers.map((e) => e.asset)).toEqual(rateMembers.map(() => 'sUSDS'))
  })

  it('backs every direct lending-market claim with an on-chain check', () => {
    for (const e of catalog.entries) {
      for (const u of e.usedBy) {
        if (u.kind !== 'direct') continue
        expect(u.check, `${e.id} → ${u.market}`).toBeDefined()
        if (u.check?.type === 'morpho_market') expect(u.check.marketId).toMatch(/^0x[0-9a-f]{64}$/)
      }
    }
    const markets = catalog.entries.flatMap((e) =>
      e.usedBy.filter((u) => u.kind === 'direct').map((u) => u.protocol),
    )
    for (const p of ['Aave V3', 'Spark', 'Morpho Blue', 'Liquity V2'])
      expect(markets, p).toContain(p)
  })

  it('pins history sources to what each provider actually exposes', () => {
    for (const e of catalog.entries) {
      if (e.provider === 'chainlink') expect(e.historySource, e.id).toBe('chainlink_rounds')
      if (e.provider === 'pyth') expect(e.historySource, e.id).toBe('none_public')
      if (e.provider === 'chronicle' || e.provider === 'redstone')
        expect(e.historySource, e.id).toBe('events')
      if (e.mechanism.updateModel === 'pull')
        expect(e.mechanism.offchainLatestUrl, e.id).toBeTruthy()
    }
  })

  it('keeps the same contract under two assets only with different roles or classes', () => {
    const btcSvr = entriesForAsset('BTC').find((e) => e.id === 'btc.chainlink.btc-usd-svr')
    const asCbbtc = entriesForAsset('cbBTC').find(
      (e) => e.id === 'cbbtc.chainlink.btc-usd-svr-as-cbbtc',
    )
    expect(btcSvr?.address).toBe(asCbbtc?.address)
    expect(asCbbtc?.consensus.role).toBe('basis')
    expect(asCbbtc?.mechanism.pegAssumption).toMatch(/cbBTC = 1 BTC/)
  })

  it('lists governance events for config-change alerts, attributing source swaps to the market oracle', () => {
    const events = governanceEvents()
    const capo = events.filter((g) => g.entryId === 'wsteth.aave.capo')
    expect(capo.map((g) => g.event)).toContain(
      'CapParametersUpdated(uint256,uint256,uint256,uint16)',
    )
    const swaps = capo.filter((g) => g.event.startsWith('AssetSourceUpdated'))
    expect(swaps.map((g) => g.emitter).sort()).toEqual(
      [
        '0x54586bE62E3c3580375aE3723C145253060Ca0C2',
        '0xE3C061981870C0C7b1f3C4F4bB36B95f1F260BE6',
      ].sort(),
    )
    expect(events.some((g) => g.event.startsWith('DiscountRatePerYearUpdated'))).toBe(true)
  })

  it('refs every leg that is itself a catalog entry, so it is aged by that entry', () => {
    const byAddr = new Map<string, string[]>()
    for (const e of catalog.entries) {
      const k = e.address.toLowerCase()
      byAddr.set(k, [...(byAddr.get(k) ?? []), e.id])
    }
    const byId = new Map(catalog.entries.map((e) => [e.id, e]))
    const missing: string[] = []
    for (const e of catalog.entries) {
      for (const k of e.mechanism.components) {
        const a = k.address.toLowerCase()
        if (k.ref) expect(byId.get(k.ref)?.address.toLowerCase(), `${e.id}/${k.role}`).toBe(a)
        else if (a !== e.address.toLowerCase() && byAddr.has(a)) missing.push(`${e.id}/${k.role}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('gives every clocked leg a limit of its own: a ref, a declared heartbeat, or "read time"', () => {
    const LATEST = join(process.cwd(), 'data', 'oracle-registry', 'snapshots', 'latest.json')
    if (!existsSync(LATEST)) return
    const snap = JSON.parse(readFileSync(LATEST, 'utf8')) as {
      entries: { id: string; components?: { address: string; updatedAt: number }[] }[]
    }
    const unbounded: string[] = []
    for (const r of snap.entries) {
      const e = catalog.entries.find((x) => x.id === r.id)
      for (const c of r.components ?? []) {
        const k = e?.mechanism.components.find(
          (x) => x.address.toLowerCase() === c.address.toLowerCase(),
        )
        if (!k?.ref && k?.heartbeatSeconds == null && !k?.timestampIsReadTime)
          unbounded.push(`${r.id}/${k?.role ?? c.address}`)
      }
    }
    expect(unbounded).toEqual([])
  })

  it('reaches the clocked feed behind a clockless input through a `via` leg', () => {
    const pt = catalog.entries.find((e) => e.id === 'pt-srusde-22oct2026.aave.linear-discount')
    expect(pt?.mechanism.components.find((k) => k.via === 'ASSET_TO_USD_AGGREGATOR')).toMatchObject(
      { address: '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', heartbeatSeconds: 86_400 },
    )
    const meta = catalog.entries.find((e) => e.id === 'cbbtc.morpho.cbbtc-usdt-meta')
    expect(meta?.mechanism.components.find((k) => k.via === 'primaryOracle')).toMatchObject({
      address: '0x91D32e6f01d6473b596f54c6E304e06d774f86b2',
      getter: 'BASE_FEED_1()',
      ref: 'btc.chainlink.btc-usd-shared-svr',
    })
    for (const id of ['eth.spark.eth-usd-median', 'cbbtc.spark.btc-usd-median'])
      expect(catalog.entries.find((e) => e.id === id)?.mechanism.timestampIsReadTime, id).toBe(true)
  })

  it('keeps deviation for update triggers only (not challenge or redemption thresholds)', () => {
    for (const id of ['cbbtc.morpho.cbbtc-usdt-meta', 'wsteth.liquity.wsteth-pricefeed']) {
      const e = catalog.entries.find((x) => x.id === id)
      expect(e?.mechanism.deviationThresholdBps, id).toBeNull()
    }
    const liq = catalog.entries.find((x) => x.id === 'wsteth.liquity.wsteth-pricefeed')
    expect(liq?.mechanism.fallback).toContain('min(lastGoodPrice, ETH/USD × rate)')
  })

  it('does not claim free off-chain Pyth prices (Hermes needs an API key since 2026-08-26)', () => {
    for (const e of catalog.entries.filter((x) => x.provider === 'pyth')) {
      expect(e.historyNote ?? '', e.id).not.toMatch(/free \(Hermes latest\)|current price is free/)
      expect(e.mechanism.access ?? '', e.id).toMatch(/API key/)
    }
  })

  it('does not credit the Aave Lido market with a weETH reserve', () => {
    const svr = catalog.entries.find((x) => x.id === 'eth.chainlink.eth-usd-svr')
    const capoBase = svr?.usedBy.find((u) => u.kind === 'component')
    expect(capoBase?.market).toMatch(/Lido — wstETH CAPO base/)
    expect(capoBase?.market).not.toMatch(/Lido[^;]*weETH/)
  })

  it('rejects a catalog with an unknown class or a dangling component ref', () => {
    const clone = (): OracleCatalog => JSON.parse(JSON.stringify(catalog))
    const badClass = clone()
    ;(badClass.entries[0] as { class: string }).class = 'vibes'
    expect(() => parseCatalog(badClass)).toThrow(/class/)
    const badRef = clone()
    const withRef = badRef.entries.find((e) => e.mechanism.components.some((c) => c.ref))!
    withRef.mechanism.components.find((c) => c.ref)!.ref = 'no.such.entry'
    expect(() => parseCatalog(badRef)).toThrow(/references unknown/)
    const badVia = clone()
    const withVia = badVia.entries.find((e) => e.mechanism.components.some((c) => c.via))!
    withVia.mechanism.components.find((c) => c.via)!.via = 'NO_SUCH_ROLE'
    expect(() => parseCatalog(badVia)).toThrow(/via unknown/)
  })

  it('states the staleness rules the engine applies (lib/oracleRegistry/normalize.ts)', () => {
    const p = catalog.stalenessPolicy
    const s = (n: number) => `${n.toLocaleString('en-US')} s`
    // Chronicle has no heartbeat but IS aged: stale past the age-only bound, not "age only".
    expect(p).not.toMatch(/age only\b/)
    expect(p).toContain(`(Chronicle) is stale when older than ${s(AGE_ONLY_MAX_AGE_SECONDS)}`)
    expect(p).toContain(`older than ${s(PULL_MAX_AGE_SECONDS)}`)
    expect(graceSeconds(3600)).toBe(600)
    expect(graceSeconds(86_400)).toBe(8640)
    expect(p).toContain('grace = max(600 s, 10% of heartbeat)')
    // A leg without a declared heartbeat falls back to its entry's (assessFreshness step 2).
    expect(p).toContain('when it declares none, against its entry’s heartbeat + grace')
  })
})
