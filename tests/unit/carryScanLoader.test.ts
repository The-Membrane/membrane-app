import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { bannerFor, isCarryScanFile, leanView, loadCarryScan } from '@/lib/carryScan/load'
import { stripOf } from '@/lib/carryScan/strip'
import type { CarryScanFile, CarryScanStatus } from '@/lib/carryScan/types'

const fallback = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'public', 'data', 'carry-scan-fallback.json'), 'utf8'),
) as CarryScanFile
const live: CarryScanFile = { ...fallback, week: '2026-W42', asOf: fallback.asOf + 7 * 86_400 }
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
      fetchImpl: fetchOf({ 'latest.json': () => json({ ...live, schemaVersion: 2 }) }),
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

  it('the committed snapshot itself passes the schema check and feeds the /carry strip', () => {
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
    for (const [s, t] of Object.entries(lean.file.benchmarks)) {
      expect(t.candidates).toEqual([])
      expect(t.bySize).toEqual(fallback.benchmarks[s].bySize)
    }
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(fallback).length)
  })
})
