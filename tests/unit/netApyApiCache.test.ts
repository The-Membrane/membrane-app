import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type { NextApiRequest, NextApiResponse } from 'next'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import type { MerklOpportunity } from '@/lib/netApy/incentives'
import type { SnapshotSet } from '@/lib/netApy/read'
import type { BlockAnchor, VenueSnapshot } from '@/lib/netApy/types'

// The API's live-read cache: 120 s of WALL CLOCK from the read's asOf. The anchor is the
// finalized block, ~15 min old when read, so judging by its time would re-read every
// request. Chain, RPC and Merkl are mocked; the store is a temp dir.

const mocks = vi.hoisted(() => ({ readAllVenues: vi.fn(), fetchMerkl: vi.fn() }))

vi.mock('@/lib/netApy/read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/netApy/read')>()),
  readAllVenues: mocks.readAllVenues,
}))
vi.mock('@/lib/netApy/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/netApy/rpc')>()),
  netApyClient: () => ({ client: {}, label: 'env:test' }),
}))
vi.mock('@/lib/netApy/incentives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/netApy/incentives')>()),
  fetchMerklOpportunities: mocks.fetchMerkl,
}))

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'),
  bigintReviver,
) as { anchor: BlockAnchor; rpc: string; snapshots: VenueSnapshot[] }
const merkl = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'merkl-opportunities-2026-10-05.json'), 'utf8'),
) as { opportunities: MerklOpportunity[] }

/** The wall clock at the first read: the finalized fixture block is 15 min old. */
const T = Number(fx.anchor.blockTimestamp) + 900
const setNow = (s: number) => vi.setSystemTime(new Date(s * 1000))

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>

async function get(handler: Handler, query: Record<string, string>) {
  let status = 0
  const res = {
    setHeader: () => res,
    status: (s: number) => {
      status = s
      return res
    },
    json: () => res,
  }
  await handler(
    { method: 'GET', query } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  )
  return status
}

let tmp = ''
let handler: Handler
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  tmp = mkdtempSync(join(tmpdir(), 'net-apy-api-'))
  mocks.readAllVenues.mockReset()
  mocks.readAllVenues.mockImplementation(
    async (): Promise<SnapshotSet> => ({
      anchor: fx.anchor,
      asOf: Math.floor(Date.now() / 1000),
      rpc: 'env:test',
      snapshots: fx.snapshots,
      errors: [],
    }),
  )
  mocks.fetchMerkl.mockReset()
  mocks.fetchMerkl.mockImplementation(async () => merkl.opportunities)
  // A fresh module: the in-memory cache starts empty in every test.
  vi.resetModules()
  handler = (await import('@/pages/api/net-apy')).default as Handler
})
afterEach(() => {
  vi.useRealTimers()
  delete process.env.NET_APY_STORE_DIR
  rmSync(tmp, { recursive: true, force: true })
})

const STORES = {
  // A serverless deploy: every store write fails, so only the in-memory cache can hold.
  'read-only store': () => {
    writeFileSync(join(tmp, 'file'), '')
    return join(tmp, 'file', 'store')
  },
  'writable store': () => tmp,
}

describe.each(Object.entries(STORES))('live reads are cached 120 s from asOf (%s)', (_, dir) => {
  beforeEach(() => {
    process.env.NET_APY_STORE_DIR = dir()
  })

  it('two un-pinned requests within 120 s of asOf read the chain once', async () => {
    setNow(T)
    expect(await get(handler, { size: '100000' })).toBe(200)
    setNow(T + 60)
    expect(await get(handler, { size: '100000' })).toBe(200)
    setNow(T + 120)
    expect(await get(handler, { venue: 'aave-v3-usdc', size: '5000' })).toBe(200)
    expect(mocks.readAllVenues).toHaveBeenCalledTimes(1)
    expect(mocks.fetchMerkl).toHaveBeenCalledTimes(1)
  })

  it('a request more than 120 s after asOf reads again', async () => {
    setNow(T)
    expect(await get(handler, { size: '100000' })).toBe(200)
    setNow(T + 121)
    expect(await get(handler, { size: '100000' })).toBe(200)
    expect(mocks.readAllVenues).toHaveBeenCalledTimes(2)
  })
})
