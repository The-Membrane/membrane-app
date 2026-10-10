import { beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { assembleRadar, readCorpus, type VenueConfig } from '@/pages/api/_lib/radarReads'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

const venue: VenueConfig = {
  name: 'aave-v3-usde',
  kind: 'atoken-liquidity',
  address: '0x0000000000000000000000000000000000000001',
  enabled: true,
}

describe('uncertified legacy flow rows', () => {
  beforeEach(() => vi.mocked(db.execute).mockReset())

  it('keeps row provenance but excludes flow capacity from Radar and comparator verdicts', async () => {
    const execute = vi.mocked(db.execute)
    execute
      .mockResolvedValueOnce({
        rows: [{ venue: venue.name, instant_usd: '1000000', observed_at: '2026-09-27T12:00:00Z' }],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { venue: venue.name, rows: '10000', span_start: '2026-01-01', span_end: '2026-09-27' },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ venue: venue.name, rows: '10', observed: '10', backfilled: '0' }],
      } as never)

    const corpus = await readCorpus([venue])
    expect(execute).toHaveBeenCalledTimes(3)
    expect(corpus.perVenueProvenance[0].flow_rows).toBe(10000)
    expect(corpus.byVenue.get(venue.name)?.flow).toBeNull()

    const radar = assembleRadar(
      '0x0000000000000000000000000000000000000002',
      new Map([[venue.name, 100_000]]),
      [venue],
      corpus,
      new Date('2026-09-27T12:00:00Z'),
    )
    expect(radar.positions[0].stress).toMatchObject({ flow: null })
    expect(radar.comparator[0].stress).toMatchObject({ flow: null })
    expect(radar.positions[0].reason).not.toMatch(/flow|outflow/i)
    expect(radar.provenance.recorded.note).toMatch(/lack certified range coverage/)
  })
})
