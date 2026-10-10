// Identity of the configured venue and exact downstream route. A market name
// alone is not stable: a pool can be replaced while retaining its display name.
import { createHash } from 'node:crypto'

const address = (value, field) => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error(`depth identity missing ${field}`)
  return value.toLowerCase()
}

export function depthRouteIdentity(venue, market) {
  const base = {
    venue: venue.name,
    venueKind: venue.kind,
    vault: address(venue.address, 'venue.address'),
    underlying: address(venue.underlying, 'venue.underlying'),
    venueDecimals: venue.decimals,
    market: market.name,
    marketKind: market.kind,
    marketAddress: address(market.address, 'market.address'),
    exitFrom: address(market.exitFrom, 'market.exitFrom'),
  }
  const route =
    market.kind === 'curve-stableswap'
      ? {
          token0: address(market.token0, 'market.token0'),
          token1: address(market.token1, 'market.token1'),
        }
      : market.kind === 'psm-buffer'
        ? {
            buffer: address(market.buffer, 'market.buffer'),
            bufferToken: address(market.bufferToken, 'market.bufferToken'),
          }
        : (() => {
            throw new Error(`unsupported depth market kind ${market.kind}`)
          })()
  return createHash('sha256')
    .update(JSON.stringify({ ...base, route }))
    .digest('hex')
}
