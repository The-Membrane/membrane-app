import { chromium } from '@playwright/test'
const [,, url, out, y, h, scheme='dark'] = process.argv
const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1440,height:900}, colorScheme: scheme })
await p.goto(url, { waitUntil:'load', timeout:60000 }); await p.waitForTimeout(6000)
await p.screenshot({ path: out, fullPage: true, clip:{ x:0, y:+y, width:1440, height:+h } })
await b.close()
