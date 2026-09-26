import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NextApiRequest, NextApiResponse } from 'next'

type CapacityChange = {
  id: string
  protocol: string
  vault: string
  dimension: string
  direction: 'increase'
  allocationId: string
  proposedCapRaw: string
  capUnit: 'asset-base-units' | '1e18-fraction-of-vault-assets'
  lifecycle: 'queued' | 'executed' | 'canceled'
  sourceUrl: string
  submittedBlock: number
  firstObservedAt: string
  earliestExecutableAt: string
  statusTxUrl: string | null
  statusObservedAt: string
}

type Feed = {
  study: 'morpho-v2-cap-public-feed-v1'
  source: string
  scope: string
  checkedAt: string
  coveredThroughBlock: number
  items: CapacityChange[]
  limitation: string
  sha256: string
}

const MAX_SCAN_AGE_MS = 30 * 60 * 60 * 1000

export function observationStatus(checkedAt: string, now = Date.now()): 'recent' | 'paused' {
  const age = now - Date.parse(checkedAt)
  return age >= 0 && age <= MAX_SCAN_AGE_MS ? 'recent' : 'paused'
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  try {
    const path = resolve(
      process.cwd(),
      'data/research/venue-signals/morpho-v2-cap-public-feed.json',
    )
    const feed = JSON.parse(readFileSync(path, 'utf8')) as Feed
    const { sha256, ...payload } = feed
    if (
      payload.study !== 'morpho-v2-cap-public-feed-v1' ||
      !Array.isArray(payload.items) ||
      !Number.isSafeInteger(payload.coveredThroughBlock) ||
      !Number.isFinite(Date.parse(payload.checkedAt)) ||
      createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== sha256
    )
      throw new Error('Invalid capacity-change feed')

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      available: true,
      observationStatus: observationStatus(payload.checkedAt),
      ...payload,
    })
  } catch {
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      available: false,
      items: [],
      scope: 'Morpho Vault V2 onchain allocation cap requests',
      limitation: 'The verified local watcher has not been exported on this host.',
    })
  }
}
