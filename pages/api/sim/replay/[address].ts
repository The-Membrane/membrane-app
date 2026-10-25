import fs from 'node:fs'
import path from 'node:path'
import type { NextApiRequest, NextApiResponse } from 'next'

import {
  demoBorrowerDetection,
  demoBorrowerPosition,
  detectVenues,
  parseAddress,
  runAdapters,
  DEMO_BORROWER_ADDRESS,
  type Oct10Manifest,
  type Oct10Series,
} from '@/lib/position-sim'
import { setMorphoMarketListLoader } from '@/lib/position-sim/adapters/morphoBlue'
import { largestPosition, runReplay, type MeasuredLiquidations } from '@/lib/landing/replay'
import { scenarioById } from '@/lib/landing/scenarios'
import { closedTotals, verdictSentence } from '@/lib/landing/verdict'

/**
 * THE SHARE CARD'S NUMBERS, COMPUTED HERE. `GET /api/sim/replay/0x…?s=oct10-2025`
 *
 * The OG card (pages/api/og/[kind].tsx, kind=replay) fetches this on its own origin, so
 * the image is built from the address and the scenario alone and no figure rides in the
 * query string: a card cannot be forged into saying anything the replay did not say.
 * Same engine, same defaults as the page (lib/landing/replay.ts).
 *
 * The demo address returns the demo fixture (the measured position at the window open),
 * exactly as the page shows it. Any other address is read live, read-only.
 */

export interface ReplaySummary {
  address: string
  scenarioId: string
  isDemo: boolean
  label: string
  debtUsd: number
  venueClosedUsd: number
  membraneClosedUsd: number
  lessUsd: number
  verdict: string
  error?: string
}

const DATA = path.join(process.cwd(), 'public/data/oct10-2025')
let cache: { series: Oct10Series; manifest: Oct10Manifest; protocols: { measuredLiquidations?: MeasuredLiquidations } } | null = null
function load() {
  if (cache) return cache
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))
  cache = { series: read('prices-1m.json'), manifest: read('manifest.json'), protocols: read('protocols.json') }
  return cache
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ReplaySummary | { error: string }>) {
  const raw = Array.isArray(req.query.address) ? req.query.address[0] : req.query.address
  const address = parseAddress(raw ?? '')
  if (!address) return res.status(400).json({ error: 'not an address' })
  const scenario = scenarioById(Array.isArray(req.query.s) ? req.query.s[0] : req.query.s)

  try {
    const d = load()
    setMorphoMarketListLoader(async () => d.protocols)
    const isDemo = address.toLowerCase() === DEMO_BORROWER_ADDRESS.toLowerCase()
    let position = isDemo ? demoBorrowerPosition() : null
    let detection = isDemo ? demoBorrowerDetection() : null
    if (!isDemo) {
      const [results, det] = await Promise.all([runAdapters(address), detectVenues(address)])
      position = largestPosition(results.flatMap((r) => r.positions))
      detection = det
    }
    if (!position) {
      res.setHeader('Cache-Control', 'public, s-maxage=300')
      return res.status(200).json({
        address, scenarioId: scenario.id, isDemo, label: '', debtUsd: 0, venueClosedUsd: 0, membraneClosedUsd: 0, lessUsd: 0,
        verdict: '', error: 'no open borrow found',
      })
    }
    const cmp = runReplay(position, detection, { series: d.series, manifest: d.manifest, measured: d.protocols.measuredLiquidations ?? null })
    const t = closedTotals(cmp)
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600')
    return res.status(200).json({
      address,
      scenarioId: scenario.id,
      isDemo,
      label: position.label,
      debtUsd: position.totalDebtUsd,
      venueClosedUsd: t.venueClosedUsd,
      membraneClosedUsd: t.membraneClosedUsd,
      lessUsd: t.lessUsd,
      verdict: verdictSentence(cmp, isDemo ? 'this' : 'your'),
    })
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message })
  }
}
