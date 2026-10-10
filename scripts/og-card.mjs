// Renders the default 1200x630 social card in public/og.png.
// Run with `node --import tsx scripts/og-card.mjs` so the stat is imported from
// the SAME source as the landing proof, including its partial-corpus fallback.
// Georgia stands in for Redaction, which is not licensed for raster embedding.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const totalsModule = await import('../lib/position-sim/oct10Totals.ts')
const { CORPUS_SCALE_LINE, OCT10_SCALE_LINE } = totalsModule.default ?? totalsModule
const scale = CORPUS_SCALE_LINE.partial ? OCT10_SCALE_LINE : CORPUS_SCALE_LINE
const isPartial = CORPUS_SCALE_LINE.partial
const figure = scale.figure
const period = isPartial
  ? '10 OCT 2025 · AAVE V3'
  : `${CORPUS_SCALE_LINE.years} YEARS · AAVE V3 MAINNET`
const claim = isPartial
  ? 'of debt protected from forced closure in the measured day.'
  : 'of collateral Membrane would have kept.'
const disclosure = isPartial
  ? 'Modeled against observed liquidations on 10 Oct 2025.'
  : 'Modeled against priced Aave V3 liquidation episodes; unpriced episodes excluded.'

if (!/^\$[\d.]+[BMk]?$/.test(figure)) {
  throw new Error(`Invalid landing-scale figure: ${figure}`)
}

const wordmark = await readFile(path.join(root, 'public/images/membrane-wordmark.svg'))
const corpusBytes = await readFile(path.join(root, 'public/data/liquidation-corpus.json'))
const wordmarkUrl = `data:image/svg+xml;base64,${wordmark.toString('base64')}`
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{ margin:0; padding:0; }
  body{ width:1200px; height:630px; background:#09090a; overflow:hidden;
    font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace; color:#ece6d8; }
  .frame{ position:absolute; inset:28px; border:1px solid rgba(236,230,216,0.22); }
  .wordmark{ position:absolute; left:88px; top:65px; width:330px; height:auto; }
  .eyebrow{ position:absolute; right:89px; top:82px; font-size:16px; letter-spacing:0.24em;
    text-transform:uppercase; color:#aaa296; }
  .rule-top{ position:absolute; left:88px; right:88px; top:171px; height:1px;
    background:rgba(236,230,216,0.18); }
  .figure{ position:absolute; left:84px; top:191px; font-family:Georgia,'Times New Roman',serif;
    font-size:205px; line-height:1; letter-spacing:-0.055em; color:#d8b24a;
    font-variant-numeric:lining-nums tabular-nums; }
  .claim{ position:absolute; left:92px; right:90px; top:408px;
    font-family:Georgia,'Times New Roman',serif; font-size:47px; line-height:1.12;
    letter-spacing:-0.012em; }
  .foot{ position:absolute; left:90px; right:90px; bottom:51px; display:flex;
    align-items:center; justify-content:space-between; gap:24px; }
  .period{ color:#d8b24a; font-size:17px; letter-spacing:0.16em; white-space:nowrap; }
  .disclosure{ color:#aaa296; font-size:14px; line-height:1.35; text-align:right; max-width:510px; }
</style></head><body>
  <div class="frame"></div>
  <img class="wordmark" src="${wordmarkUrl}" alt="Membrane" />
  <div class="eyebrow">The 4% window</div>
  <div class="rule-top"></div>
  <div class="figure">${figure}</div>
  <div class="claim">${claim}</div>
  <div class="foot"><div class="period">${period}</div><div class="disclosure">${disclosure}</div></div>
</body></html>`

// Use the installed Chrome channel; the disposable Playwright browser cache is
// intentionally absent on this disk-constrained host.
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  })
  await page.setContent(html, { waitUntil: 'load' })
  await page.locator('.wordmark').evaluate((image) => image.decode())
  await page.screenshot({ path: path.join(root, 'public/og.png') })
} finally {
  await browser.close()
}
const png = await readFile(path.join(root, 'public/og.png'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
await writeFile(
  path.join(root, 'public/og.meta.json'),
  `${JSON.stringify({ figure, corpusSha256: sha256(corpusBytes), pngSha256: sha256(png) }, null, 2)}\n`,
)
console.log(`wrote public/og.png (1200x630, ${figure})`)
