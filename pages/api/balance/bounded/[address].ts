// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from 'next'

type Data = {
  strategy?: string
  balance?: {
    amount: string
    usd: number
  }
  unclaimed_rewards?: {
    total_usd: number
  }
  error?: string
}

/**
 * Range-bound vault balance route (per-address).
 *
 * TODO(evm-migration): this route read the bounded-vault position from Cosmos RPC
 * (Osmosis bank balances + services/cdp getBasket + services/earn getBoundedUnderlyingCDT +
 * services/oracle getOraclePrices). The range-bound vault has not been ported to EVM, so the
 * route returns 501 until an EVM earn/vault + oracle service exists. Kept as a compiling stub.
 */
export default async function handler(_req: NextApiRequest, res: NextApiResponse<Data>) {
  return res.status(501).json({ error: 'Not implemented: bounded-vault balance not ported to EVM.' })
}
