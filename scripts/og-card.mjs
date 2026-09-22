// Renders public/og.png — the 1200x630 Open Graph card every indexable page
// references by default (components/Seo.tsx). Re-run after brand changes:
//   node scripts/og-card.mjs
// Uses the repo's Playwright chromium; Living Typeface palette (bone on
// near-black, phosphor accent, hairline frame). Georgia stands in for
// Redaction, which is not licensed for raster embedding here.
import { chromium } from '@playwright/test'

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{ margin:0; padding:0; }
  body{ width:1200px; height:630px; background:#09090a; overflow:hidden;
    font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace; color:#ece6d8; }
  .frame{ position:absolute; inset:28px; border:1px solid rgba(236,230,216,0.22); }
  .eyebrow{ position:absolute; left:96px; top:64px; font-size:18px; letter-spacing:0.32em;
    text-transform:uppercase; color:#8d877b; }
  .row{ position:absolute; left:96px; right:96px; top:120px; bottom:150px;
    display:flex; align-items:center; gap:64px; }
  .four{ font-family:Georgia,'Times New Roman',serif; font-size:260px; line-height:0.85;
    letter-spacing:-0.04em; color:#9bdc4f; flex:0 0 auto; }
  .text{ flex:1 1 auto; min-width:0; }
  h1{ font-family:Georgia,'Times New Roman',serif; font-weight:400; font-size:52px;
    line-height:1.08; letter-spacing:-0.015em; margin:0 0 22px; }
  h1 em{ font-style:italic; color:#9bdc4f; }
  .sub{ font-size:19px; line-height:1.55; color:#8d877b; }
  .rule{ position:absolute; left:96px; right:96px; bottom:92px; height:1px;
    background:rgba(236,230,216,0.10); }
  .foot{ position:absolute; left:96px; bottom:52px; font-size:15px;
    letter-spacing:0.24em; text-transform:uppercase; color:#645f55; }
  .dot{ position:absolute; right:96px; bottom:46px; width:14px; height:14px;
    background:#9bdc4f; }
</style></head><body>
  <div class="frame"></div>
  <div class="eyebrow">Membrane</div>
  <div class="row">
    <div class="four">4%.</div>
    <div class="text">
      <h1>Cross the line and <em>nothing is sold</em> while you stay within 4% of it.</h1>
      <div class="sub">8 hours to cure, by you or by the venue capital Membrane recalls first.
        Measured on 2,350 real Oct-10 liquidations: $67M of collateral kept.</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="foot">membrane &middot; carry that recalls debt instead of liquidating you</div>
  <div class="dot"></div>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.setContent(html, { waitUntil: 'networkidle' })
await page.screenshot({ path: 'public/og.png' })
await browser.close()
console.log('wrote public/og.png (1200x630)')
