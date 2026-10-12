import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { NET_APY_VENUES } from '@/lib/netApy/venues'

// Umbrella contract: ONE venue key per venue, and no lane mints its own IDs. The
// registry is tools/venue-recorder.config.json (`venues[].name`, exact case).
const registry: { name: string; kind: string; enabled?: boolean; address?: string }[] = JSON.parse(
  readFileSync(join(process.cwd(), 'tools/venue-recorder.config.json'), 'utf8'),
).venues

describe('net-APY venue keys are registry names', () => {
  const byName = new Map(registry.map((v) => [v.name, v]))

  it('registry names are unique', () => {
    expect(byName.size).toBe(registry.length)
  })

  it.each(NET_APY_VENUES.map((v) => v.venueKey))('%s is registered', (key) => {
    expect(byName.has(key)).toBe(true)
  })

  it('aave-v3-usde is the one venue the recorder already records', () => {
    expect(byName.get('aave-v3-usde')?.enabled).toBe(true)
  })

  it('a net-APY key without a verified recorder address stays disabled', () => {
    // File rule: never guess an address; leave it empty and enabled=false until verified.
    for (const v of NET_APY_VENUES) {
      const e = byName.get(v.venueKey)
      if (e && !e.address) expect(e.enabled, v.venueKey).toBe(false)
    }
  })
})
