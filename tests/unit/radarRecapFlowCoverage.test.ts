import { beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { composeRecap } from '@/components/Radar/recapLogic'
import handler from '@/pages/api/radar/recap/[address]'
import { fetchVenueLogEntries } from '@/pages/api/_lib/venueLogQuery'
import { getRadarPayload, makeClient } from '@/pages/api/_lib/radarReads'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/components/Radar/recapLogic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Radar/recapLogic')>()
  return { ...actual, composeRecap: vi.fn(actual.composeRecap) }
})
vi.mock('@/pages/api/_lib/venueLogQuery', () => ({ fetchVenueLogEntries: vi.fn() }))
vi.mock('@/pages/api/_lib/radarReads', () => ({
  LABELS: { sUSDS: 'sUSDS' },
  loadVenues: () => [
    {
      name: 'sUSDS',
      kind: 'erc4626-cooldown',
      address: '0x0000000000000000000000000000000000000001',
    },
  ],
  makeClient: vi.fn(),
  getRadarPayload: vi.fn(),
}))

const address = '0x0000000000000000000000000000000000000002'

function response() {
  const state: { status: number; body: Record<string, any> | null } = { status: 0, body: null }
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((status: number) => {
      state.status = status
      return res
    }),
    json: vi.fn((body: Record<string, any>) => {
      state.body = body
      return res
    }),
  }
  return { state, res }
}

describe('recap flow coverage', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset()
    vi.mocked(getRadarPayload).mockReset()
    vi.mocked(makeClient).mockReset()
    vi.mocked(fetchVenueLogEntries).mockReset()
    vi.mocked(composeRecap).mockClear()
  })

  it('keeps the address withdrawal while withholding uncertified venue day totals and ranks', async () => {
    const execute = vi.mocked(db.execute)
    execute
      .mockResolvedValueOnce({ rows: [] } as never) // watch
      .mockResolvedValueOnce({ rows: [] } as never) // recorded cooldown
    vi.mocked(getRadarPayload).mockResolvedValue({ total_usd: 0 } as never)
    vi.mocked(fetchVenueLogEntries).mockResolvedValue([])

    const latest = 26_000_000n
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(latest),
      getLogs: vi.fn().mockImplementation(async ({ fromBlock, toBlock }) => {
        if (fromBlock <= latest && toBlock >= latest) {
          return [
            {
              eventName: 'Withdraw',
              args: { owner: address, assets: 1_000_000_000_000_000_000n },
              blockNumber: latest,
              transactionHash: `0x${'a'.repeat(64)}`,
            },
          ]
        }
        return []
      }),
      getBlock: vi.fn().mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    }
    vi.mocked(makeClient).mockReturnValue(client as never)

    const { state, res } = response()
    await handler({ method: 'GET', query: { address, lookbackDays: '1' } } as never, res as never)

    expect(state.status).toBe(200)
    const exit = state.body?.beats.find((beat: { kind: string }) => beat.kind === 'exit_landed')
    expect(exit).toBeDefined()
    expect(exit.text).toContain('sUSDS')
    expect(exit.text).not.toMatch(/biggest exit day|left the venue/)
    expect(vi.mocked(composeRecap).mock.calls[0][0].flows).toMatchObject([
      {
        direction: 'withdraw',
        usd: 1,
        dayOutflowUsd: null,
        dayRank: null,
        dayRankTotal: null,
      },
    ])
    expect(state.body?.provenance.recorded).toMatch(
      /unavailable without certified complete-day flow coverage/,
    )
    expect(execute).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(execute.mock.calls)).not.toMatch(/venue_flows/)
  })
})
