import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, fallback, http } from 'viem'
import { mainnet } from 'viem/chains'

import {
  HASTRA_STAKING_VAULT,
  PYUSD_STAKING_ROUTE,
  readPyusdStakingRouteIdentity,
} from '@/lib/carry/pyusdStakingRouteIdentity'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (
    Object.keys(req.query).some((key) => !['routeKey', 'destination'].includes(key)) ||
    req.query.routeKey !== PYUSD_STAKING_ROUTE ||
    typeof req.query.destination !== 'string' ||
    req.query.destination.toLowerCase() !== HASTRA_STAKING_VAULT
  )
    return res.status(400).json({ error: 'invalid_route' })
  try {
    const override = process.env.NEXT_PUBLIC_MAINNET_RPC_URL
    const urls = override ? [override, ...PUBLIC_MAINNET_RPCS] : [...PUBLIC_MAINNET_RPCS]
    const client = createPublicClient({
      chain: mainnet,
      transport: fallback(
        urls.slice(0, 6).map((url) => http(url, { timeout: 8_000, retryCount: 0 })),
        { rank: false, retryCount: 0 },
      ),
    })
    return res.status(200).json(await readPyusdStakingRouteIdentity(client))
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return res.status(503).json({
      error: message.startsWith('pyusd_staking_') ? message : 'pyusd_staking_read_failed',
    })
  }
}
