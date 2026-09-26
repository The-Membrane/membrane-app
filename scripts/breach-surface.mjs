#!/usr/bin/env node
// Recomputes the breach-probability surface and writes public/data/breach-surface.json.
//
// Run by .github/workflows/breach-surface.yml on a daily schedule. The app never runs
// this at request time: pages read the committed JSON and interpolate by the user's
// current LTV, so the displayed number is never stale with respect to price — only
// with respect to volatility, which this job refreshes.
//
// Breach definition (matches LiquidationEngine timer mechanics):
//   immediate:  LTV >= line * (1 + window)  at any step
//   timed:      LTV >= line continuously for the full delay
//
// Model: zero-drift GBM on 4-hour BTC returns. Zero drift is deliberate — a drift
// estimate would smuggle a price prediction into a risk number.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'breach-surface.json')

// Position parameters. Governance-controlled; a change here must trigger a manual
// re-run (workflow_dispatch) — the daily cron covers volatility drift only.
const LINE = 0.73
const WINDOW = 0.04          // max_threshold_to_delay
const DELAY_H = 8            // liquidationDelay
const HORIZON_DAYS = 365

const STEP_H = 4
const PATHS = 6000           // antithetic pairs => 12,000 effective
const LTV_GRID = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]
const VOL_GRID = [0.30, 0.40, 0.50, 0.60, 0.70]

// Deterministic RNG so a re-run on unchanged inputs produces an unchanged file and
// the workflow's "commit only if changed" step stays quiet.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(rng) {
  // Box-Muller, one draw per call
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function breachProbability(ltv0, sigma, seed) {
  const rng = mulberry32(seed)
  const nStep = Math.round((HORIZON_DAYS * 24) / STEP_H)
  const dt = STEP_H / (24 * 365)
  const drift = -0.5 * sigma * sigma * dt
  const sd = sigma * Math.sqrt(dt)
  const imm = LINE * (1 + WINDOW)
  const timedSteps = Math.ceil(DELAY_H / STEP_H)

  let breached = 0
  for (let p = 0; p < PATHS; p++) {
    // antithetic pair: the same normals with both signs halves the variance free
    const zs = new Float64Array(nStep)
    for (let i = 0; i < nStep; i++) zs[i] = gauss(rng)
    for (const sign of [1, -1]) {
      let logP = 0, cons = 0, hit = false
      for (let i = 0; i < nStep; i++) {
        logP += drift + sd * sign * zs[i]
        const ltv = ltv0 / Math.exp(logP)   // debt flat over the horizon: conservative
        if (ltv >= imm) { hit = true; break }
        cons = ltv >= LINE ? cons + 1 : 0
        if (cons >= timedSteps) { hit = true; break }
      }
      if (hit) breached++
    }
  }
  return breached / (PATHS * 2)
}

// Realized volatility from CoinGecko's free endpoint. On any failure the surface is
// still produced over the full vol grid — the app then has no "current vol" pointer
// and must show the whole band, which is the honest degraded mode.
async function realizedVol() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90&interval=daily',
      { headers: { accept: 'application/json' } },
    )
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const prices = (await r.json()).prices.map((x) => x[1])
    const rets = []
    for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]))
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const varsum = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)
    return { vol: Math.sqrt(varsum * 365), source: 'coingecko:90d-daily', points: prices.length }
  } catch (e) {
    return { vol: null, source: `unavailable (${e.message})`, points: 0 }
  }
}

const t0 = Date.now()
const rv = await realizedVol()
const grid = []
for (const ltv of LTV_GRID) {
  for (const vol of VOL_GRID) {
    const seed = Math.round(ltv * 1000) * 1000 + Math.round(vol * 100)
    grid.push({ ltv, vol, p: +breachProbability(ltv, vol, seed).toFixed(4) })
  }
}

const out = {
  version: 1,
  measured_at: new Date().toISOString(),
  params: { line: LINE, window: WINDOW, delay_h: DELAY_H, horizon_days: HORIZON_DAYS },
  model: { kind: 'gbm-zero-drift', step_h: STEP_H, paths: PATHS * 2, antithetic: true },
  realized_vol: rv,
  grid,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
console.log(
  `breach surface: ${grid.length} cells in ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
  `realized vol ${rv.vol ? (rv.vol * 100).toFixed(1) + '%' : rv.source} -> ${OUT}`,
)
