import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { readExitEvidenceAlerts, type ExitEvidenceFilter } from '@/lib/carry/exitEvidenceAlerts'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
export function parseExitEvidenceQuery(query: NextApiRequest['query']): ExitEvidenceFilter | null {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return null
  if (
    Object.keys(query).some(
      (key) =>
        !['routeKey', 'destinationAddress', 'owner', 'assetsRaw', 'limit', 'chainId'].includes(key),
    )
  )
    return null
  if (Object.values(query).some((value) => Array.isArray(value))) return null
  const { routeKey, destinationAddress, owner, assetsRaw, limit, chainId } = query
  if (chainId !== undefined && chainId !== '1') return null
  if ((routeKey === undefined) !== (destinationAddress === undefined)) return null
  if ((owner === undefined) !== (assetsRaw === undefined)) return null
  if (
    routeKey !== undefined &&
    (typeof routeKey !== 'string' ||
      !routeKey ||
      routeKey.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(routeKey) ||
      typeof destinationAddress !== 'string' ||
      !ADDRESS.test(destinationAddress))
  )
    return null
  if (
    owner !== undefined &&
    (typeof owner !== 'string' ||
      !ADDRESS.test(owner) ||
      typeof assetsRaw !== 'string' ||
      !RAW.test(assetsRaw) ||
      BigInt(assetsRaw) > MAX_UINT256)
  )
    return null
  if (
    limit !== undefined &&
    (typeof limit !== 'string' || !/^[1-9][0-9]?$/.test(limit) || Number(limit) > 20)
  )
    return null
  return {
    routeKey: routeKey as string | undefined,
    destination:
      typeof destinationAddress === 'string' ? destinationAddress.toLowerCase() : undefined,
    holder: typeof owner === 'string' ? owner.toLowerCase() : undefined,
    assetsRaw: assetsRaw as string | undefined,
    limit: limit ? Number(limit) : 10,
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if ((req.url?.length ?? 0) > 768) return res.status(413).json({ error: 'request_too_large' })
  const filter = parseExitEvidenceQuery(req.query)
  if (!filter) return res.status(400).json({ error: 'invalid_exit_evidence_request' })
  try {
    const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
    const rate = await checkRateLimit(`exit-evidence:${ipHash}`, 30, 60)
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds))
      return res
        .status(429)
        .json({ error: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds })
    }
    const feed = await readExitEvidenceAlerts(async (query) => {
      const result = await db.execute(sql.raw(query))
      return result.rows as Record<string, unknown>[]
    }, filter)
    return res.status(200).json(feed)
  } catch {
    return res.status(503).json({ error: 'exit_evidence_unavailable' })
  }
}
