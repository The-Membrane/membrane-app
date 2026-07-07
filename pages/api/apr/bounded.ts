// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from 'next'

type Data = {
  apr?: number
  error?: string
}

/**
 * Range-bound vault APR route.
 *
 * TODO(evm-migration): this route computed the bounded-vault APR from CosmWasm RPC reads
 * (services/cdp.ts getBasket/getCollateralInterest/getBasketPositions/getDebt + services/earn
 * getBoundedTVL against a Cosmos client). The range-bound vault has not been ported to EVM, so
 * the route returns 501 until an EVM earn/vault service exists. Kept as a compiling stub so the
 * endpoint and its callers resolve.
 */
export default async function handler(_req: NextApiRequest, res: NextApiResponse<Data>) {
  return res.status(501).json({ error: 'Not implemented: bounded-vault APR not ported to EVM.' })
}
