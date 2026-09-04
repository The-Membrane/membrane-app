// Venue weather card — corpus state rendered as a feed-ready 1200x675 PNG.
// The share strategy is receipts: every card is dated, sourced from the
// recorder corpus, and styled in the brand (bone-on-black, mono numbers) so a
// screenshot is recognizable in-feed and self-documents its provenance.
//
//   node scripts/make-share-card.mjs --template weather --venue sUSDS
//   node scripts/make-share-card.mjs --template weather --venue sUSDe
//
// Output: out/social/<venue>-weather-<date>.png. Uses the repo's playwright
// chromium; no dev server needed.

import { readEnv } from './lib/venue-reads.mjs'
import { neon } from '@neondatabase/serverless'
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
const template = arg('template', 'weather')
const venue = arg('venue', 'sUSDS')

const sql = neon(readEnv().get('DATABASE_URL'))

const sig2 = (n) => {
  if (!isFinite(n) || n === 0) return 0
  const digits = Math.ceil(Math.log10(Math.abs(n)))
  const mag = Math.pow(10, 2 - digits)
  return Math.round(n * mag) / mag
}
const fmtUsd = (n) => {
  const a = Math.abs(n)
  if (a >= 1e9) return `$${sig2(n / 1e9)}B`
  if (a >= 1e6) return `$${sig2(n / 1e6)}M`
  if (a >= 1e3) return `$${sig2(n / 1e3)}k`
  return `$${sig2(n)}`
}

// --- gather the venue's weather from the corpus -----------------------------
const [flows] = await sql`
  SELECT round(sum(CASE WHEN direction='out' THEN assets_raw ELSE 0 END)/1e18) AS out_usd,
         round(sum(CASE WHEN direction='in'  THEN assets_raw ELSE 0 END)/1e18) AS in_usd,
         min(block_time)::date AS from_d, max(block_time)::date AS to_d
  FROM venue_flows WHERE venue = ${venue}`
const [worst] = await sql`
  SELECT block_time::date AS d, round(sum(assets_raw)/1e18) AS out_usd
  FROM venue_flows WHERE venue = ${venue} AND direction='out'
  GROUP BY 1 ORDER BY out_usd DESC LIMIT 1`
const [snap] = await sql`
  SELECT observed_at, instant_usd, (params->>'totalAssets')::numeric/1e18 AS tvl,
         (params->>'cooldownDuration')::int AS cooldown
  FROM venue_snapshots WHERE venue = ${venue} AND source='observed'
  ORDER BY observed_at DESC LIMIT 1`

if (!flows?.out_usd) {
  console.error(`no corpus rows for venue '${venue}'`)
  process.exit(1)
}

const today = new Date().toISOString().slice(0, 10)
const spanDays = Math.round((new Date(flows.to_d) - new Date(flows.from_d)) / 86_400_000)
const tvl = snap?.tvl ? Number(snap.tvl) : snap?.instant_usd ? Number(snap.instant_usd) : null
const gate =
  snap?.cooldown != null
    ? snap.cooldown === 0
      ? 'no cooldown'
      : `${snap.cooldown % 86400 === 0 ? snap.cooldown / 86400 + 'd' : Math.round(snap.cooldown / 3600) + 'h'} cooldown`
    : 'instant redemption'

const stats = [
  { label: `EXITS SERVED, ${spanDays}D`, value: fmtUsd(Number(flows.out_usd)) },
  { label: 'WORST SINGLE DAY', value: `${fmtUsd(Number(worst.out_usd))} · ${worst.d.toISOString().slice(0, 10)}` },
  ...(tvl ? [{ label: snap?.tvl ? 'VAULT HOLDS' : 'INSTANT LIQUIDITY', value: fmtUsd(tvl) }] : []),
  { label: 'EXIT GATE', value: gate },
]

const turnover = tvl ? (Number(flows.out_usd) / tvl).toFixed(1) : null
const headline = turnover && turnover > 1
  ? `${venue} served ${turnover}x its size in exits over ${spanDays} days.`
  : `${venue}: every exit served, on the record.`

// --- render -----------------------------------------------------------------
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1200px; height: 675px; background: #09090a; color: #ece6d8;
         font-family: 'JetBrains Mono', 'SFMono-Regular', Menlo, monospace; padding: 64px 72px;
         display: flex; flex-direction: column; justify-content: space-between; }
  .eyebrow { font-size: 15px; letter-spacing: 0.28em; color: #8d877b; text-transform: uppercase; }
  .headline { font-family: Georgia, 'Times New Roman', serif; font-size: 54px; line-height: 1.15;
              margin-top: 26px; max-width: 980px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px 60px; margin-top: 10px; }
  .label { font-size: 13px; letter-spacing: 0.22em; color: #56524a; text-transform: uppercase; }
  .value { font-size: 34px; margin-top: 6px; color: #9bdc4f; font-variant-numeric: tabular-nums; }
  .value.bone { color: #ece6d8; }
  .footer { display: flex; justify-content: space-between; border-top: 1px solid rgba(236,230,216,0.10);
            padding-top: 22px; font-size: 14px; color: #56524a; letter-spacing: 0.08em; }
</style></head><body>
  <div>
    <div class="eyebrow">Venue weather · on-chain record</div>
    <div class="headline">${headline}</div>
  </div>
  <div class="grid">
    ${stats.map((s, i) => `<div><div class="label">${s.label}</div><div class="value${i % 2 ? ' bone' : ''}">${s.value}</div></div>`).join('')}
  </div>
  <div class="footer">
    <span>membrane carry radar · recorded corpus</span>
    <span>${today}</span>
  </div>
</body></html>`

const outDir = join(process.cwd(), 'out', 'social')
mkdirSync(outDir, { recursive: true })
const tmp = join(outDir, `.tmp-card.html`)
writeFileSync(tmp, html)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 675 } })
await page.goto(`file://${tmp}`)
const outPath = join(outDir, `${venue}-weather-${today}.png`)
await page.screenshot({ path: outPath })
await browser.close()
rmSync(tmp)
console.log(`card written: ${outPath}`)
console.log(`headline: ${headline}`)
