import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchVenueLogEntries, uncoveredByVenue, footerFor } = vi.hoisted(() => ({
  fetchVenueLogEntries: vi.fn(),
  uncoveredByVenue: vi.fn(),
  footerFor: vi.fn(),
}))
vi.mock('@/pages/api/_lib/venueLogQuery', () => ({ fetchVenueLogEntries }))
vi.mock('@/pages/api/_lib/uncovered', () => ({ uncoveredByVenue, footerFor }))

import handler from '@/pages/api/venues/log'

const response = () => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  }
  return res
}

describe('/api/venues/log venue filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchVenueLogEntries.mockResolvedValue([])
    uncoveredByVenue.mockResolvedValue({})
    footerFor.mockReturnValue('')
  })

  it('accepts an existing mixed-case venue and scopes the bounded log query', async () => {
    const res = response()
    await handler({ method: 'GET', query: { venue: 'scrvUSD' } } as never, res as never)
    expect(fetchVenueLogEntries).toHaveBeenCalledWith({ venue: 'scrvUSD' })
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('rejects repeated or malformed venue parameters before querying', async () => {
    for (const venue of [['scrvUSD', 'sUSDe'], 'aave/v3']) {
      const res = response()
      await handler({ method: 'GET', query: { venue } } as never, res as never)
      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(fetchVenueLogEntries).not.toHaveBeenCalled()
  })
})
