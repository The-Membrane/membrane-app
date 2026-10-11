import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  bannerFor,
  isCarryScanFile,
  isReadableCarryScanFile,
  leanView,
  LEGACY_VENUE_APY_RULE,
  loadCarryScan,
  upgradeFile,
} from '@/lib/carryScan/load'
import { stripOf } from '@/lib/carryScan/strip'
import type { CarryScanFile, CarryScanStatus } from '@/lib/carryScan/types'

const fallbackRaw = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
// The snapshot may predate schema 2: the app reads it through the loader's upgrade, so do the tests.
const fallback = upgradeFile(fallbackRaw)
const live: CarryScanFile = { ...fallback, week: '2026-W42', asOf: fallback.asOf + 7 * 86_400 }
/** The same file as a version-1 scan wrote it: no venueApy, alsoBehindRoutes or venueApyRule. */
const toV1 = (f: CarryScanFile): unknown => {
  const { venueApyRule: _rule, ...rest } = f
  return {
    ...rest,
    schemaVersion: 1,
    rows: f.rows.map(({ venueApy: _v, alsoBehindRoutes: _a, ...r }) => r),
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fetchOf = (routes: Record<string, () => Response>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = String(url)
    const hit = Object.entries(routes).find(([k]) => u.endsWith(k))
    if (!hit) throw new Error('offline')
    return hit[1]()
  }) as typeof fetch
const nowMs = (live.asOf + 3600) * 1000

describe('the app-side loader', () => {
  it('serves the data branch when latest.json passes the schema check', async () => {
    const ok: CarryScanStatus = {
      lastAttempt: live.asOf,
      week: live.week,
      ok: true,
      reason: null,
      lastGoodWeek: live.week,
    }
    const v = await loadCarryScan({
      fetchImpl: fetchOf({ 'latest.json': () => json(live), 'status.json': () => json(ok) }),
      fallback: () => fallback,
      nowMs,
    })
    expect(v.source).toBe('live')
    expect(v.file.week).toBe('2026-W42')
    expect(v.banner).toBeNull()
  })

  it('a schemaVersion mismatch falls back to the committed snapshot, labelled as such', async () => {
    const v = await loadCarryScan({
      fetchImpl: fetchOf({ 'latest.json': () => json({ ...live, schemaVersion: 99 }) }),
      fallback: () => fallback,
      nowMs,
    })
    expect(v.source).toBe('fallback')
    expect(v.file.week).toBe(fallback.week)
    expect(v.banner).toContain(`fallback snapshot, ${fallback.week}`)
  })

  it('a network or HTTP failure also falls back', async () => {
    const v = await loadCarryScan({
      fetchImpl: fetchOf({ 'latest.json': () => json({}, 404) }),
      fallback: () => fallback,
      nowMs,
    })
    expect(v.source).toBe('fallback')
  })

  it('banners a failed or held scan and data older than 8 days', () => {
    const failed: CarryScanStatus = {
      lastAttempt: live.asOf,
      week: '2026-W43',
      ok: false,
      reason: 'gate 2: no eligible borrow benchmark for DAI',
      lastGoodWeek: live.week,
    }
    expect(bannerFor(live, 'live', failed, nowMs).banner).toMatch(
      /^Last scan failed \d{4}-\d{2}-\d{2}: gate 2: no eligible borrow benchmark for DAI; showing 2026-W42/,
    )
    expect(bannerFor(live, 'live', { ...failed, held: true }, nowMs).banner).toMatch(
      /^Last scan held for review/,
    )
    const old = bannerFor(live, 'live', null, (live.asOf + 9 * 86_400) * 1000)
    expect(old.stale).toBe(true)
    expect(old.banner).toMatch(/9 days old/)
  })

  // Schema 2 (2026-10-11) adds the averaged venue APY. The data branch holds version-1 files
  // until the first version-2 scan, so the loader must keep serving them.
  it('a version-1 latest.json is still served live, upgraded: DeFiLlama figures, said so', async () => {
    const v1 = toV1(live)
    expect(isCarryScanFile(v1)).toBe(false)
    expect(isReadableCarryScanFile(v1)).toBe(true)
    const v = await loadCarryScan({
      fetchImpl: fetchOf({ 'latest.json': () => json(v1) }),
      fallback: () => fallback,
      nowMs,
    })
    expect(v.source).toBe('live')
    expect(v.file.schemaVersion).toBe(2)
    expect(v.file.venueApyRule).toBe(LEGACY_VENUE_APY_RULE)
    for (const r of v.file.rows) {
      expect(r.venueApy.method).toBe('defillama')
      expect(r.venueApy.withRewards).toBe(r.apy)
      expect(r.alsoBehindRoutes).toEqual([])
      const used = r.venueApy.sources.filter((x) => x.averaged)
      expect(used.every((x) => x.source === 'defillama')).toBe(true)
      // An on-chain 7-day figure the v1 file holds is listed, not averaged in.
      const t = r.verification?.trailing7dApy
      if (typeof t === 'number')
        expect(r.venueApy.sources.find((x) => x.source === 'onchain-7d')).toMatchObject({
          value: t,
          averaged: false,
        })
    }
  })

  it('a version-1 fallback snapshot is also upgraded rather than rejected', async () => {
    const v = await loadCarryScan({
      fetchImpl: fetchOf({}),
      fallback: () => toV1(fallback),
      nowMs,
    })
    expect(v.source).toBe('fallback')
    expect(v.file.rows.length).toBe(fallback.rows.length)
    expect(v.file.rows.every((r) => r.venueApy && Array.isArray(r.venueApy.sources))).toBe(true)
  })

  it('a version-2 file passes through the upgrade unchanged', () => {
    expect(upgradeFile(fallback)).toBe(fallback)
  })

  it('the committed snapshot itself passes the schema check and feeds the /carry strip', () => {
    expect(isReadableCarryScanFile(fallbackRaw)).toBe(true)
    expect(isCarryScanFile(fallback)).toBe(true)
    const s = stripOf({
      file: fallback,
      source: 'fallback',
      status: null,
      stale: false,
      banner: null,
    })
    expect(s.rows.length).toBeLessThanOrEqual(3)
    expect(s.rows.length).toBeGreaterThan(0)
    for (const r of s.rows) {
      expect(r.status).toBe('NEW')
      // The strip tags its (a) and (b) figures, so each needs a label class.
      expect(r.carryA?.labelClass).toBeTruthy()
      expect(r.carryB.base.labelClass).toBeTruthy()
    }
  })

  it('page props drop the benchmark candidate lists but keep every row and the chosen benchmarks', () => {
    const lean = leanView({
      file: fallback,
      source: 'fallback',
      status: null,
      stale: false,
      banner: null,
    })
    expect(lean.file.rows).toBe(fallback.rows)
    for (const r of lean.file.rows) expect(r.venueApy.sources.length).toBeGreaterThan(0)
    for (const [s, t] of Object.entries(lean.file.benchmarks)) {
      expect(t.candidates).toEqual([])
      expect(t.bySize).toEqual(fallback.benchmarks[s].bySize)
    }
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(fallback).length)
  })
})
