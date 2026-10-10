import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  read: vi.fn(),
}))

vi.mock('viem', () => ({
  http: (url: string) => url,
  createPublicClient: ({ transport }: { transport: string }) => ({
    host: new URL(transport).hostname,
    getChainId: async () => 1,
  }),
}))
vi.mock('@/lib/position-sim/rpc', () => ({
  PUBLIC_MAINNET_RPCS: [
    'https://first.example',
    'https://limited.example',
    'https://backup.example',
  ],
}))
vi.mock('@/lib/carry/stakedUsdatQueuePressure', () => ({
  readStakedUsdatQueuePressure: mock.read,
}))

type Response = {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  setHeader(name: string, value: string): Response
  status(code: number): Response
  json(value: unknown): Response
}

function response(): Response {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
      return this
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(value) {
      this.body = value
      return this
    },
  }
}

describe('Staked USDat queue pressure API', () => {
  beforeEach(() => {
    mock.read.mockReset()
    vi.stubEnv('RECORDER_RPC_URL', '')
    vi.stubEnv('NEXT_PUBLIC_MAINNET_RPC_URL', '')
  })

  it('retries with a second independent origin when finalized reads are rate limited', async () => {
    mock.read.mockImplementation(async (clients: Array<{ host: string }>) => {
      if (clients[1].host === 'limited.example') throw new Error('rate_limited')
      return { status: 'observed', source: { origins: 2 } }
    })
    const { default: handler } = await import('@/pages/api/carry/staked-usdat-queue-pressure')
    const res = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ status: 'observed', source: { origins: 2 } })
    expect(
      mock.read.mock.calls.map(([clients]) =>
        clients.map((client: { host: string }) => client.host),
      ),
    ).toEqual([
      ['first.example', 'limited.example'],
      ['first.example', 'backup.example'],
    ])
  })
})
