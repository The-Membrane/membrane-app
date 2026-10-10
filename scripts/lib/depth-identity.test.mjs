import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { depthRouteIdentity } from './depth-identity.mjs'

const config = JSON.parse(
  readFileSync(new URL('../../tools/venue-recorder.config.json', import.meta.url), 'utf8'),
)
const venue = config.venues.find((v) => v.name === 'scrvUSD')
const market = venue.depthMarkets.find((m) => m.enabled)

test('configured route identity changes when a named pool or route leg changes', () => {
  const original = depthRouteIdentity(venue, market)
  assert.match(original, /^[0-9a-f]{64}$/)
  assert.notEqual(depthRouteIdentity(venue, { ...market, address: venue.address }), original)
  assert.notEqual(depthRouteIdentity(venue, { ...market, token0: venue.address }), original)
  assert.notEqual(depthRouteIdentity({ ...venue, underlying: venue.address }, market), original)
  assert.equal(
    depthRouteIdentity(venue, {
      ...market,
      address: market.address.toUpperCase().replace('0X', '0x'),
    }),
    original,
  )
  assert.throws(() => depthRouteIdentity(venue, { ...market, exitFrom: '' }))
})
