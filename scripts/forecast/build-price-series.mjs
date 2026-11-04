#!/usr/bin/env node
/**
 * Build the committed hourly price series the forecast engine reads (lane Q41):
 *   public/data/forecast/<SYMBOL>-1h.json
 *
 * Inputs (both free, public, no key):
 *  1. membrane-datasets binance-klines/<SYMBOL>-1h.json — the frozen Q26 development grid
 *     (sha256 checked against the D12 universe, live/d12_universe.json on the research branch).
 *  2. optional: the D12 live kline store <SYMBOL>.csv.gz (membrane-datasets
 *     forecasts/q26-touch-live/d12/klines/), every closed hourly kline after the grid ends.
 *     The store never overrides a grid hour (same rule as q26_live_d12.extend_grid).
 *
 * Encoding (exact, size-conscious): prices are integer cents (Binance ETHUSDT/BTCUSDT tick 0.01, checked).
 *   close[j]   = cents delta from the previous non-null close (first non-null: absolute), null = missing hour
 *   lowOff[j]  = close - low  (cents, >= 0)
 *   highOff[j] = high - close (cents, >= 0)
 * Decoding n / 100 gives the same double as parsing Binance's decimal text.
 *
 * Usage:
 *   node scripts/forecast/build-price-series.mjs --datasets /home/user/membrane-datasets \
 *        --store <dir with ETHUSDT.csv.gz> --symbols ETHUSDT,BTCUSDT --out public/data/forecast
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const SHA = {
  // live/d12_universe.json (membrane-app research/history-forecasts)
  ETHUSDT: 'd5c5532a9e32550066edaf0e40b3995d00b8ee54d8d0a64451bc4de0420442db',
  BTCUSDT: 'f01e2fbfd0b39939985106de3e53b94fd395893a90b823da626ae85a684f59bd',
}
const HOUR = 3600

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

function cents(v, what) {
  if (v === null || v === undefined) return null
  const n = Math.round(Number(v) * 100)
  if (Math.abs(n / 100 - Number(v)) > 1e-9) throw new Error(`${what}: ${v} is not on a 0.01 tick`)
  return n
}

function build(sym, datasets, store) {
  const p = path.join(datasets, 'binance-klines', `${sym}-1h.json`)
  const raw = fs.readFileSync(p)
  const sha = crypto.createHash('sha256').update(raw).digest('hex')
  if (SHA[sym] && sha !== SHA[sym]) throw new Error(`STOP: ${p} sha256 ${sha} != D12 universe ${SHA[sym]}`)
  const g = JSON.parse(raw.toString())
  const st = Number(g.startTs)
  const C = g.columns.close.map((v) => cents(v, `${sym} close`))
  const L = g.columns.low.map((v) => cents(v, `${sym} low`))
  const H = g.columns.high.map((v) => cents(v, `${sym} high`))
  const nDev = C.length
  let storeRows = 0
  let storeFile = null
  if (store) {
    const sp = path.join(store, `${sym}.csv.gz`)
    if (fs.existsSync(sp)) {
      storeFile = { file: `${sym}.csv.gz`, sha256: crypto.createHash('sha256').update(fs.readFileSync(sp)).digest('hex') }
      const lines = zlib.gunzipSync(fs.readFileSync(sp)).toString().trim().split('\n')
      for (const line of lines) {
        if (line.startsWith('openTime')) continue
        const [o, , hi, lo, cl] = line.split(',')
        const j = (Number(o) / 1000 - st) / HOUR
        if (!Number.isInteger(j)) throw new Error(`${sym}: store kline off the hour grid ${o}`)
        if (j < nDev) continue
        while (C.length < j) { C.push(null); L.push(null); H.push(null) }
        if (j === C.length) {
          C.push(cents(cl, `${sym} close`)); L.push(cents(lo, `${sym} low`)); H.push(cents(hi, `${sym} high`))
          storeRows++
        }
      }
    }
  }
  const close = []; const lowOff = []; const highOff = []
  let prev = null
  for (let j = 0; j < C.length; j++) {
    if (C[j] === null || L[j] === null || H[j] === null) { close.push(null); lowOff.push(null); highOff.push(null); continue }
    close.push(prev === null ? C[j] : C[j] - prev)
    prev = C[j]
    if (L[j] > C[j] || H[j] < C[j]) throw new Error(`${sym}: bar ${j} low/high not around close`)
    lowOff.push(C[j] - L[j]); highOff.push(H[j] - C[j])
  }
  const lastOpen = st + HOUR * (C.length - 1)
  return {
    schema: 'membrane-forecast-series/1',
    id: sym,
    source: 'binance:spot:1h',
    startTs: st,
    stepSeconds: HOUR,
    count: C.length,
    scale: 100,
    lastOpenIso: new Date(lastOpen * 1000).toISOString().replace('.000Z', 'Z'),
    provenance: {
      grid: { file: `membrane-datasets binance-klines/${sym}-1h.json`, sha256: sha, count: nDev, fetchedAt: g.fetchedAt },
      store: storeFile ? { ...storeFile, path: 'membrane-datasets forecasts/q26-touch-live/d12/klines/', rows: storeRows } : null,
      endpoint: 'https://data-api.binance.vision/api/v3/klines (free, public, no key)',
    },
    close, lowOff, highOff,
  }
}

const datasets = arg('datasets', '/home/user/membrane-datasets')
const store = arg('store', null)
const out = arg('out', 'public/data/forecast')
fs.mkdirSync(out, { recursive: true })
for (const sym of arg('symbols', 'ETHUSDT,BTCUSDT').split(',')) {
  const s = build(sym, datasets, store)
  const f = path.join(out, `${sym}-1h.json`)
  fs.writeFileSync(f, JSON.stringify(s) + '\n')
  const gz = zlib.gzipSync(fs.readFileSync(f)).length
  console.log(`${f}: ${s.count} hours to ${s.lastOpenIso}, ${fs.statSync(f).size} bytes (${gz} gzipped)`)
}
