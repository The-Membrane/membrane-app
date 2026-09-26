// Venue share cards — corpus state rendered as feed-ready 1200x675 PNGs.
// The share strategy is receipts: every card is dated, sourced from the
// recorder corpus, and styled in the brand (bone-on-black, mono numbers) so a
// screenshot is recognizable in-feed and self-documents its provenance.
//
//   node scripts/make-share-card.mjs --template weather  --venue sUSDS
//   node scripts/make-share-card.mjs --template turnover --venue sUSDS
//   node scripts/make-share-card.mjs --template turnover --venue sUSDe --days 90
//
// Templates:
//   weather   — the venue's headline exit stats as a stat grid.
//   turnover  — THE CONVEYOR. Gross inflow and gross outflow drawn as two
//               enormous opposing bars at true relative scale, with the net
//               (the only thing a TVL chart shows you) as the tiny gold tail
//               where they fail to cancel. Notches on the outflow bar mark one
//               whole vault-worth of capital each.
//
// Output: out/social/<venue>-<template>-<date>.png. Uses the repo's playwright
// chromium and the repo's real Redaction / JetBrains Mono woff2 files; no dev
// server needed. Brand spec: docs/BRAND_CHARTS.md (binding).

import { readEnv, loadConfig, ROOT } from './lib/venue-reads.mjs'
import {
  fmtUsd,
  sig2,
  computeTurnover,
  barWidths,
  vaultTicks,
  exitSemantics,
} from './lib/turnoverStats.mjs'
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
const windowDays = Number(arg('days', '90'))

const sql = neon(readEnv().get('DATABASE_URL'))
const today = new Date().toISOString().slice(0, 10)

// --- brand ------------------------------------------------------------------
const C = {
  bg: '#09090a',
  ink: '#ece6d8',
  inkDim: '#8d877b',
  inkFaint: '#56524a',
  phosphor: '#9bdc4f',
  teal: '#46d39a',
  gold: '#d8b24a',
  hairline: 'rgba(236,230,216,0.10)',
  hairlineStrong: 'rgba(236,230,216,0.22)',
}

// Real brand faces, inlined by absolute file:// path so the headless render is
// not silently falling back to Georgia/Menlo.
const FONT_FACES = `
@font-face { font-family:'Redaction'; src:url('file://${ROOT}/public/fonts/redaction/redaction-400.woff2') format('woff2'); font-weight:400; }
@font-face { font-family:'JetBrains Mono'; src:url('file://${ROOT}/public/fonts/jetbrains/jetbrains-400.woff2') format('woff2'); font-weight:400; }
@font-face { font-family:'JetBrains Mono'; src:url('file://${ROOT}/public/fonts/jetbrains/jetbrains-500.woff2') format('woff2'); font-weight:500; }
@font-face { font-family:'JetBrains Mono'; src:url('file://${ROOT}/public/fonts/jetbrains/jetbrains-700.woff2') format('woff2'); font-weight:700; }
:root { --bg:${C.bg}; --ink:${C.ink}; --ink-dim:${C.inkDim}; --ink-faint:${C.inkFaint};
        --phosphor:${C.phosphor}; --teal:${C.teal}; --gold:${C.gold};
        --hair:${C.hairline}; --hair-strong:${C.hairlineStrong}; }
* { margin:0; padding:0; box-sizing:border-box; border-radius:0; }
body { width:1200px; height:675px; background:var(--bg); color:var(--ink);
       font-family:'JetBrains Mono','SFMono-Regular',Menlo,monospace;
       font-variant-numeric:tabular-nums; }
.serif { font-family:'Redaction',Georgia,'Times New Roman',serif; }
.eyebrow { font-size:12px; letter-spacing:0.28em; color:var(--ink-dim); text-transform:uppercase; }
`

/** Escape for HTML text nodes — venue names and notes are interpolated raw. */
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  )

async function shoot(html, outPath) {
  const outDir = join(ROOT, 'out', 'social')
  mkdirSync(outDir, { recursive: true })
  const tmp = join(outDir, `.tmp-card-${process.pid}.html`)
  writeFileSync(tmp, html)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } })
  await page.goto(`file://${tmp}`)
  await page.evaluate(() => document.fonts.ready) // never screenshot a fallback face
  await page.screenshot({ path: outPath })
  await browser.close()
  rmSync(tmp)
  return outPath
}

// ============================================================================
// shared corpus reads
// ============================================================================

/** The venue's decimals from the recorder config — never assumed. */
function venueDecimals(name) {
  try {
    return loadConfig().find((v) => v.name === name)?.decimals ?? 18
  } catch {
    return 18
  }
}

/**
 * Latest observed capacity read. ERC4626 vaults leave instant_usd NULL by
 * design (venue-reads.mjs) and carry the balance in params.totalAssets; the
 * aToken venue is the reverse. Try both, in that order.
 */
async function latestSnapshot(name, dec) {
  const [s] = await sql`
    SELECT observed_at, instant_usd,
           (params->>'totalAssets')::numeric  AS total_assets,
           (params->>'cooldownDuration')::numeric AS cooldown
    FROM venue_snapshots WHERE venue = ${name} AND source='observed'
    ORDER BY observed_at DESC LIMIT 1`
  if (!s) return null
  const scale = Math.pow(10, dec)
  const tvl = s.total_assets != null ? Number(s.total_assets) / scale
    : s.instant_usd != null ? Number(s.instant_usd)
    : null
  return {
    at: s.observed_at,
    tvl,
    tvlBasis: s.total_assets != null ? 'totalAssets' : 'instant liquidity',
    cooldown: s.cooldown != null ? Number(s.cooldown) : null,
  }
}

// ============================================================================
// template: weather (unchanged behaviour)
// ============================================================================

async function renderWeather() {
  const [flows] = await sql`
    SELECT round(sum(CASE WHEN direction='out' THEN assets_raw ELSE 0 END)/1e18) AS out_usd,
           round(sum(CASE WHEN direction='in'  THEN assets_raw ELSE 0 END)/1e18) AS in_usd,
           min(block_time)::date AS from_d, max(block_time)::date AS to_d
    FROM venue_flows WHERE venue = ${venue}`
  const [worst] = await sql`
    SELECT block_time::date AS d, round(sum(assets_raw)/1e18) AS out_usd
    FROM venue_flows WHERE venue = ${venue} AND direction='out'
    GROUP BY 1 ORDER BY out_usd DESC LIMIT 1`
  const snap = await latestSnapshot(venue, venueDecimals(venue))

  if (!flows?.out_usd) {
    console.error(`no corpus rows for venue '${venue}'`)
    process.exit(1)
  }

  const spanDays = Math.round((new Date(flows.to_d) - new Date(flows.from_d)) / 86_400_000)
  const tvl = snap?.tvl ?? null
  const gate =
    snap?.cooldown != null
      ? snap.cooldown === 0
        ? 'no cooldown'
        : `${snap.cooldown % 86400 === 0 ? snap.cooldown / 86400 + 'd' : Math.round(snap.cooldown / 3600) + 'h'} cooldown`
      : 'instant redemption'

  const stats = [
    { label: `EXITS SERVED, ${spanDays}D`, value: fmtUsd(Number(flows.out_usd)) },
    {
      label: 'WORST SINGLE DAY',
      value: `${fmtUsd(Number(worst.out_usd))} · ${worst.d.toISOString().slice(0, 10)}`,
    },
    ...(tvl
      ? [{ label: snap?.tvlBasis === 'totalAssets' ? 'VAULT HOLDS' : 'INSTANT LIQUIDITY', value: fmtUsd(tvl) }]
      : []),
    { label: 'EXIT GATE', value: gate },
  ]

  const turnover = tvl ? (Number(flows.out_usd) / tvl).toFixed(1) : null
  const headline =
    turnover && turnover > 1
      ? `${venue} served ${turnover}x its size in exits over ${spanDays} days.`
      : `${venue}: every exit served, on the record.`

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_FACES}
    body { padding:64px 72px; display:flex; flex-direction:column; justify-content:space-between; }
    .eyebrow { font-size:15px; }
    .headline { font-size:54px; line-height:1.15; margin-top:26px; max-width:980px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:26px 60px; margin-top:10px; }
    .label { font-size:13px; letter-spacing:0.22em; color:var(--ink-faint); text-transform:uppercase; }
    .value { font-size:34px; margin-top:6px; color:var(--phosphor); }
    .value.bone { color:var(--ink); }
    .footer { display:flex; justify-content:space-between; border-top:1px solid var(--hair);
              padding-top:22px; font-size:14px; color:var(--ink-faint); letter-spacing:0.08em; }
  </style></head><body>
    <div>
      <div class="eyebrow">Venue weather · on-chain record</div>
      <div class="headline serif">${esc(headline)}</div>
    </div>
    <div class="grid">
      ${stats.map((s, i) => `<div><div class="label">${esc(s.label)}</div><div class="value${i % 2 ? ' bone' : ''}">${esc(s.value)}</div></div>`).join('')}
    </div>
    <div class="footer">
      <span>membrane carry radar · recorded corpus</span>
      <span>${today}</span>
    </div>
  </body></html>`

  const out = await shoot(html, join(ROOT, 'out', 'social', `${venue}-weather-${today}.png`))
  console.log(`card written: ${out}`)
  console.log(`headline: ${headline}`)
}

// ============================================================================
// template: turnover — THE CONVEYOR
// ============================================================================

async function renderTurnover() {
  const dec = venueDecimals(venue)
  const scale = Math.pow(10, dec)

  // Trailing window, anchored to the venue's own last recorded event so the
  // card is reproducible rather than clock-dependent.
  const [bounds] = await sql`
    SELECT max(block_time) AS to_t FROM venue_flows WHERE venue = ${venue}`
  if (!bounds?.to_t) {
    console.error(`no corpus rows for venue '${venue}'`)
    process.exit(1)
  }
  const toT = new Date(bounds.to_t)
  const fromT = new Date(toT.getTime() - windowDays * 86_400_000)

  const rows = await sql`
    SELECT block_time::date AS d, direction, sum(assets_raw) AS raw, count(*)::int AS n
    FROM venue_flows
    WHERE venue = ${venue} AND block_time > ${fromT.toISOString()} AND block_time <= ${toT.toISOString()}
    GROUP BY 1, 2 ORDER BY 1`

  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))
  const dailyOut = rows.filter((r) => r.direction === 'out').map((r) => ({ d: iso(r.d), usd: Number(r.raw) / scale }))
  const dailyIn = rows.filter((r) => r.direction === 'in').map((r) => ({ d: iso(r.d), usd: Number(r.raw) / scale }))
  const events = rows.reduce((t, r) => t + r.n, 0)

  const snap = await latestSnapshot(venue, dec)
  const t = computeTurnover({ dailyOut, dailyIn, tvl: snap?.tvl ?? null, windowDays })
  const sem = exitSemantics(snap?.cooldown)

  if (!t.grossOut) {
    console.error(`no outflow rows for venue '${venue}' in the trailing ${windowDays}d`)
    process.exit(1)
  }

  // --- geometry -------------------------------------------------------------
  // ONE shared scale for all four bars. The card's whole argument is a length
  // comparison, so nothing here gets its own axis and the net is never floored
  // to a "visible" minimum.
  const BAR_MAX = 1064 // inner width at 68px side padding
  const w = barWidths(t, BAR_MAX)
  const ticks = vaultTicks(t.grossOut, t.tvl)

  // --- copy (every number two significant figures) --------------------------
  const turns = t.turnoverMultiple
  const days = t.daysPerVaultTurn
  const headline =
    turns && turns >= 1
      ? sem.gated
        ? `A whole vault's worth of exits queues every ${Math.round(days)} days.`
        : `The whole vault walks out every ${Math.round(days)} days.`
      : sem.gated
        ? `${venue} queued ${sig2(turns)}× its balance for the door.`
        : `${venue} put ${sig2(turns)}× its own balance through the door.`
  // The card is a fixed 1200x675 — a wrapped headline pushes the provenance
  // footer off the bottom edge, so long copy steps the display size down.
  const headlinePx = headline.length > 50 ? 36 : 42

  // Rows 1-2 are what MOVED; rows 3-4 are what a TVL chart lets you SEE. The
  // vault bar is exactly one notch long, which is what makes the notches on the
  // outflow bar legible without a caption.
  const bars = [
    { key: 'in', label: 'GROSS IN', usd: t.grossIn, px: w.inPx, color: C.teal, note: '' },
    {
      key: 'out',
      label: sem.gated ? 'GROSS OUT · QUEUED' : 'GROSS OUT · SERVED',
      usd: t.grossOut,
      px: w.outPx,
      color: C.phosphor,
      // Only claim the notches when there ARE notches — a venue that never
      // turned over its balance in the window gets none.
      note: ticks.length ? 'notched once per whole vault' : '',
    },
    {
      key: 'tvl',
      label: 'THE VAULT HOLDS',
      usd: t.tvl,
      px: w.tvlPx,
      color: C.ink,
      note: ticks.length ? 'one notch' : '',
      rule: true,
    },
    {
      key: 'net',
      label: `NET, ${windowDays} DAYS`,
      usd: t.net,
      px: w.netPx,
      color: C.gold,
      note: 'the only part a TVL chart shows you',
    },
  ]

  const barHtml = (b) => `
    ${b.rule ? '<div class="split"></div>' : ''}
    <div class="barrow">
      <div class="barhead">
        <span><span class="eyebrow">${esc(b.label)}</span>${b.note ? `<span class="note">${esc(b.note)}</span>` : ''}</span>
        <span class="barval" style="color:${b.color}">${b.key === 'net' && t.net < 0 ? '−' : ''}${fmtUsd(Math.abs(b.usd))}</span>
      </div>
      <div class="bar" style="width:${b.px.toFixed(2)}px;background:${b.color}">
        ${b.key === 'out' ? ticks.map((f) => `<i class="notch" style="left:${(f * b.px).toFixed(2)}px"></i>`).join('') : ''}
      </div>
    </div>`

  // Daily gross outflow — the torrent's texture, and where the worst day lives.
  const peakDay = t.worstOutDay
  const dayMax = Math.max(...dailyOut.map((r) => r.usd), 1)
  const stripHtml = dailyOut
    .map((r) => {
      const isPeak = peakDay && r.d === peakDay.d
      return `<i class="dbar${isPeak ? ' peak' : ''}" style="height:${Math.max(1, (r.usd / dayMax) * 100).toFixed(1)}%"></i>`
    })
    .join('')

  const peakLabel = peakDay
    ? `${fmtUsd(peakDay.usd)} on ${new Date(peakDay.d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).toUpperCase()}`
    : ''
  // Position the gold callout over the peak bar, clamped inside the card.
  const peakIdx = peakDay ? dailyOut.findIndex((r) => r.d === peakDay.d) : -1
  const rawPct = peakIdx >= 0 ? ((peakIdx + 0.5) / dailyOut.length) * 100 : 50
  const peakPct = Math.min(88, Math.max(12, rawPct)) // keep the callout on the card

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_FACES}
    body { padding:34px 68px 26px; display:flex; flex-direction:column; }

    .headline { line-height:1.06; letter-spacing:-0.01em; }
    .sub { font-size:13.5px; color:var(--ink-dim); margin-top:9px; letter-spacing:0.02em; }

    .conveyor { margin-top:16px; }
    .barrow { margin-bottom:10px; }
    .barhead { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px; }
    .note { font-size:11.5px; color:var(--ink-faint); letter-spacing:0.04em; margin-left:14px;
            text-transform:none; }
    .barval { font-size:23px; font-weight:500; }
    .bar { position:relative; height:36px; }
    .notch { position:absolute; top:0; width:3px; height:36px; background:var(--bg); }
    .split { border-top:1px solid var(--hair); margin:1px 0 10px; }

    .strip { margin-top:12px; position:relative; }
    .striphead { display:flex; justify-content:space-between; margin-bottom:6px; }
    .bars { height:48px; display:flex; align-items:flex-end; gap:1.5px;
            border-bottom:1px solid var(--hair); }
    .dbar { flex:1; background:var(--phosphor); opacity:0.55; }
    .dbar.peak { background:var(--gold); opacity:1; }
    .peakcall { position:absolute; top:-1px; font-size:11.5px; color:var(--gold); white-space:nowrap;
                transform:translateX(-50%); letter-spacing:0.04em; }

    .honesty { margin-top:auto; padding-top:15px; font-size:11px; color:var(--ink-faint); letter-spacing:0.03em;
               line-height:1.55; padding-bottom:10px; max-width:1010px; }
    .footer { padding-top:11px; border-top:1px solid var(--hair);
              display:flex; justify-content:space-between; align-items:baseline;
              font-size:11px; color:var(--ink-faint); letter-spacing:0.06em; }
  </style></head><body>

    <div class="eyebrow">Gross vs net · ${esc(venue)} · ${windowDays}-day recorded flow</div>
    <div class="headline serif" style="margin-top:12px;font-size:${headlinePx}px">${esc(headline)}</div>
    <div class="sub">“Sticky TVL” is netting doing your thinking for you.</div>

    <div class="conveyor">${bars.map(barHtml).join('')}</div>

    <div class="strip">
      <div class="striphead">
        <span class="eyebrow">Daily gross outflow</span>
        <span class="eyebrow">${turns ? sig2(turns) + '× the vault in ' + windowDays + ' days' : ''}</span>
      </div>
      <div class="peakcall" style="left:${peakPct.toFixed(2)}%">${esc(peakLabel)} ↓</div>
      <div class="bars">${stripHtml}</div>
    </div>

    <div class="honesty">${esc(sem.note)}</div>
    <div class="footer">
      <span>membrane carry radar · recorded corpus · ${today}</span>
      <span>${esc(iso(fromT))} → ${esc(iso(toT))} · ${events.toLocaleString('en-US')} events</span>
    </div>
  </body></html>`

  const out = await shoot(html, join(ROOT, 'out', 'social', `${venue}-turnover-${today}.png`))
  console.log(`card written: ${out}`)
  console.log(`headline: ${headline}`)
  console.log(
    `window ${iso(fromT)} → ${iso(toT)} (${windowDays}d) · events ${events}\n` +
      `gross out $${(t.grossOut / 1e9).toFixed(3)}B · gross in $${(t.grossIn / 1e9).toFixed(3)}B · net $${(t.net / 1e9).toFixed(3)}B\n` +
      `tvl $${(t.tvl / 1e9).toFixed(3)}B (${snap.tvlBasis}) · turnover ${turns?.toFixed(3)}x · days/vault-turn ${days?.toFixed(2)}\n` +
      `worst out day ${t.worstOutDay.d} $${(t.worstOutDay.usd / 1e6).toFixed(1)}M · notches ${ticks.length} · net share of gross ${(t.netShareOfGross * 100).toFixed(2)}%\n` +
      `exit semantics: ${sem.verb} — ${sem.note}`,
  )
}

// ============================================================================
const TEMPLATES = { weather: renderWeather, turnover: renderTurnover }
const run = TEMPLATES[template]
if (!run) {
  console.error(`unknown --template '${template}'. known: ${Object.keys(TEMPLATES).join(', ')}`)
  process.exit(1)
}
await run()
