import { describe, expect, it, vi } from 'vitest'
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  ERC4626_ABI,
  ExposureInputError,
  ExposureLimitError,
  LIMITS,
  METAMORPHO_QUEUE_ABI,
  MORPHO_BLUE,
  MORPHO_POSITION_ABI,
  maxEthCalls,
  parseViewerAddress,
  resolveExposure,
  viemReader,
  type ChainReader,
  type ExposureReport,
  type Holding,
  type ReadCall,
  type ReadResult,
} from '@/lib/exposure'
import { MORPHO_BLUE_MAINNET } from '@/lib/position-sim/adapters/morphoBlue'

// lib/exposure against a mocked chain: no RPC is reached.

const USER = '0x00000000000000000000000000000000000000a1'
const vault = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const market = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
const BLOCK = 26_200_000n

class RevertError extends Error {
  constructor() {
    super('execution reverted')
    this.name = 'ContractFunctionRevertedError'
  }
}

/**
 * A chain: vault → shares held by USER (assets = 2 × shares, totalAssets 1M), the user's
 * Morpho positions by market id; for MetaMorpho vaults, their withdraw queues, their own
 * Morpho supply shares (`vaultSupply[market:vault]`) and market totals.
 */
function fakeChain(opts: {
  shares?: Record<string, bigint>
  positions?: Record<string, [bigint, bigint, bigint]>
  queues?: Record<string, string[]>
  queueLength?: Record<string, bigint>
  vaultSupply?: Record<string, bigint>
  totals?: Record<string, [bigint, bigint]>
  revert?: Set<string>
  blockError?: Error
  multicallError?: Error
}) {
  const multicalls: { contracts: readonly ReadCall[]; blockNumber: bigint }[] = []
  const reader: ChainReader = {
    getBlockNumber: vi.fn(async () => {
      if (opts.blockError) throw opts.blockError
      return BLOCK
    }),
    multicall: vi.fn(async (p: { contracts: readonly ReadCall[]; blockNumber: bigint }) => {
      multicalls.push(p)
      if (opts.multicallError) throw opts.multicallError
      return p.contracts.map((c): ReadResult => {
        const key = `${c.functionName}:${c.address}:${String(c.args[0])}`
        if (opts.revert?.has(key) || opts.revert?.has(`${c.functionName}:${c.address}`))
          return { status: 'failure', error: new RevertError() }
        switch (c.functionName) {
          case 'balanceOf':
            return { status: 'success', result: opts.shares?.[c.address] ?? 0n }
          case 'convertToAssets':
            return { status: 'success', result: (c.args[0] as bigint) * 2n }
          case 'totalAssets':
            return { status: 'success', result: 1_000_000n }
          case 'withdrawQueueLength':
            return {
              status: 'success',
              result:
                opts.queueLength?.[c.address] ?? BigInt(opts.queues?.[c.address]?.length ?? 0),
            }
          case 'withdrawQueue':
            return { status: 'success', result: opts.queues?.[c.address]?.[Number(c.args[0])] }
          case 'position': {
            const [id, who] = c.args as [string, string]
            if (who === USER)
              return { status: 'success', result: opts.positions?.[id] ?? [0n, 0n, 0n] }
            return { status: 'success', result: [opts.vaultSupply?.[`${id}:${who}`] ?? 0n, 0n, 0n] }
          }
          case 'market': {
            const t = opts.totals?.[c.args[0] as string] ?? [1_000_000n, 1_000_000n]
            return { status: 'success', result: [t[0], t[1], 0n, 0n, 0n, 0n] }
          }
          default:
            throw new Error(`unexpected ${c.functionName}`)
        }
      })
    }),
  }
  return { reader, multicalls }
}

const byId = (r: ExposureReport, id: string) => r.results.find((x) => x.id === id)!

describe('resolveExposure: reads', () => {
  it('reads at one pinned block: balanceOf on every vault, assets only where shares are held, position on every market', async () => {
    const { reader, multicalls } = fakeChain({
      shares: { [vault(2)]: 1000n },
      positions: { [market(7)]: [5n, 0n, 0n] },
    })
    const r = await resolveExposure(reader, USER.toUpperCase().replace('0X', '0x'), {
      vaults: [vault(1), vault(2), vault(2).toUpperCase().replace('0X', '0x')],
      markets: [market(7), market(8)],
    })
    expect(reader.getBlockNumber).toHaveBeenCalledTimes(1)
    expect(r.block).toBe(BLOCK)
    expect(multicalls.every((m) => m.blockNumber === BLOCK)).toBe(true)
    const calls = multicalls.flatMap((m) => m.contracts)
    // Deduplicated and lowercase: two vaults, two markets.
    expect(calls.filter((c) => c.functionName === 'balanceOf').map((c) => c.address)).toEqual([
      vault(1),
      vault(2),
    ])
    expect(calls.filter((c) => c.functionName === 'convertToAssets')).toMatchObject([
      { address: vault(2), args: [1000n] },
    ])
    expect(calls.filter((c) => c.functionName === 'totalAssets')).toHaveLength(1)
    const pos = calls.filter((c) => c.functionName === 'position')
    expect(pos.map((c) => c.address)).toEqual([MORPHO_BLUE, MORPHO_BLUE])
    expect(pos.map((c) => c.args)).toEqual([
      [market(7), USER],
      [market(8), USER],
    ])
    expect(byId(r, 'vault-shares')).toMatchObject({
      status: 'ok',
      holdings: [
        { kind: 'vault', vault: vault(2), shares: 1000n, assets: 2000n, totalAssets: 1_000_000n },
      ],
      checked: [vault(1), vault(2)],
      failed: [],
    })
    expect(byId(r, 'morpho-blue')).toMatchObject({
      status: 'ok',
      holdings: [
        { kind: 'market', market: market(7), supplyShares: 5n, borrowShares: 0n, collateral: 0n },
      ],
      checked: [market(7), market(8)],
    })
    expect(r.ethCalls).toBe(1 + multicalls.length)
  })

  it('only view functions, nothing that signs or writes', async () => {
    const { reader, multicalls } = fakeChain({
      shares: { [vault(1)]: 1n },
      queues: { [vault(1)]: [market(1)] },
      vaultSupply: { [`${market(1)}:${vault(1)}`]: 5n },
    })
    await resolveExposure(reader, USER, {
      vaults: [vault(1)],
      markets: [market(1)],
      liveQueue: [vault(1)],
    })
    const fns = new Set(multicalls.flatMap((m) => m.contracts.map((c) => c.functionName)))
    expect([...fns].sort()).toEqual([
      'balanceOf',
      'convertToAssets',
      'market',
      'position',
      'totalAssets',
      'withdrawQueue',
      'withdrawQueueLength',
    ])
    for (const f of [...ERC4626_ABI, ...METAMORPHO_QUEUE_ABI, ...MORPHO_POSITION_ABI])
      expect(f.stateMutability).toBe('view')
    expect(Object.keys(reader).sort()).toEqual(['getBlockNumber', 'multicall'])
  })

  it('the Morpho Blue address is the one the position simulator reads', () => {
    expect(MORPHO_BLUE).toBe(MORPHO_BLUE_MAINNET.toLowerCase())
  })

  it('a nothing-held address is empty, not unchecked', async () => {
    const { reader } = fakeChain({})
    const r = await resolveExposure(reader, USER, { vaults: [vault(1)], markets: [market(1)] })
    expect(r.results.map((x) => x.status)).toEqual(['empty', 'empty'])
  })

  it('no target to read is unchecked, never empty', async () => {
    const { reader, multicalls } = fakeChain({})
    const r = await resolveExposure(reader, USER, { vaults: [], markets: [market(1)] })
    expect(byId(r, 'vault-shares').status).toBe('unchecked')
    expect(multicalls.flatMap((m) => m.contracts).every((c) => c.functionName === 'position')).toBe(
      true,
    )
  })
})

describe('resolveExposure: bounds', () => {
  it('chunks: balanceOf and position 100 per multicall, asset reads 50 per multicall', async () => {
    const vaults = Array.from({ length: 250 }, (_, i) => vault(i + 1))
    const markets = Array.from({ length: 120 }, (_, i) => market(i + 1))
    const shares = Object.fromEntries(vaults.slice(0, 30).map((v) => [v, 10n]))
    const { reader, multicalls } = fakeChain({ shares })
    const r = await resolveExposure(reader, USER, { vaults, markets })
    const sizes = multicalls.map((m) => [m.contracts[0].functionName, m.contracts.length])
    expect(sizes).toEqual([
      ['balanceOf', 100],
      ['balanceOf', 100],
      ['balanceOf', 50],
      ['convertToAssets', 50],
      ['convertToAssets', 10],
      ['position', 100],
      ['position', 20],
    ])
    expect(r.ethCalls).toBe(8)
  })

  it('the worst case at the default limits is 56 eth_calls, and it is reached, not exceeded', async () => {
    expect(maxEthCalls()).toBe(56)
    const vaults = Array.from({ length: LIMITS.maxVaults }, (_, i) => vault(i + 1))
    const markets = Array.from({ length: LIMITS.maxMarkets }, (_, i) => market(i + 1))
    // Every vault held and MetaMorpho; each live vault's full queue of distinct markets,
    // all supplied.
    const queues: Record<string, string[]> = {}
    const vaultSupply: Record<string, bigint> = {}
    vaults.slice(0, LIMITS.maxLiveVaults).forEach((v, k) => {
      queues[v] = Array.from({ length: LIMITS.maxQueue }, (_, j) => market(10_000 + k * 100 + j))
      for (const id of queues[v]) vaultSupply[`${id}:${v}`] = 1n
    })
    const { reader } = fakeChain({
      shares: Object.fromEntries(vaults.map((v) => [v, 1n])),
      queues,
      vaultSupply,
    })
    const r = await resolveExposure(reader, USER, { vaults, markets, liveQueue: vaults })
    expect(r.ethCalls).toBe(56)
    // Past the live limit: named, snapshot ties only.
    const vs = byId(r, 'vault-shares')
    const over = vs.failed.filter((f) => f.error.name === 'ExposureLimitError')
    expect(over).toHaveLength(LIMITS.maxVaults - LIMITS.maxLiveVaults)
    expect(over[0]).toMatchObject({
      read: 'withdrawQueueLength',
      target: vault(LIMITS.maxLiveVaults + 1),
    })
    const h = vs.holdings as Extract<Holding, { kind: 'vault' }>[]
    expect(h.filter((x) => x.supplies).length).toBe(LIMITS.maxLiveVaults)
    expect(h[LIMITS.maxLiveVaults].supplies).toBeUndefined()
  })

  it('over a limit, or malformed, throws by name before any call', async () => {
    const { reader } = fakeChain({})
    const many = Array.from({ length: LIMITS.maxVaults + 1 }, (_, i) => vault(i + 1))
    await expect(
      resolveExposure(reader, USER, { vaults: many, markets: [] }),
    ).rejects.toBeInstanceOf(ExposureLimitError)
    const tooMany = Array.from({ length: LIMITS.maxMarkets + 1 }, (_, i) => market(i + 1))
    await expect(resolveExposure(reader, USER, { vaults: [], markets: tooMany })).rejects.toThrow(
      /501 markets; the limit is 500/,
    )
    await expect(
      resolveExposure(reader, '0x123', { vaults: [], markets: [] }),
    ).rejects.toBeInstanceOf(ExposureInputError)
    await expect(
      resolveExposure(reader, USER, { vaults: ['0xnot'], markets: [] }),
    ).rejects.toMatchObject({ name: 'ExposureInputError' })
    await expect(
      resolveExposure(reader, USER, { vaults: [], markets: [vault(1)] }),
    ).rejects.toThrow(/not a Morpho market id/)
    expect(reader.getBlockNumber).not.toHaveBeenCalled()
    expect(reader.multicall).not.toHaveBeenCalled()
  })
})

describe('resolveExposure: errors are named, never swallowed', () => {
  it('a failed leg is listed by name and its target is not checked', async () => {
    const { reader } = fakeChain({
      shares: { [vault(2)]: 5n },
      revert: new Set([
        `balanceOf:${vault(1)}`,
        `totalAssets:${vault(2)}`,
        `position:${MORPHO_BLUE}:${market(2)}`,
      ]),
    })
    const r = await resolveExposure(reader, USER, {
      vaults: [vault(1), vault(2)],
      markets: [market(1), market(2)],
    })
    const vs = byId(r, 'vault-shares')
    expect(vs.status).toBe('ok')
    expect(vs.checked).toEqual([vault(2)])
    expect(vs.failed).toEqual([
      {
        read: 'balanceOf',
        target: vault(1),
        error: { name: 'ContractFunctionRevertedError', message: 'execution reverted' },
      },
      {
        read: 'totalAssets',
        target: vault(2),
        error: { name: 'ContractFunctionRevertedError', message: 'execution reverted' },
      },
    ])
    expect(vs.holdings[0]).toMatchObject({ assets: 10n, totalAssets: undefined })
    const mb = byId(r, 'morpho-blue')
    expect(mb.status).toBe('empty')
    expect(mb.checked).toEqual([market(1)])
    expect(mb.failed.map((f) => [f.read, f.target, f.error.name])).toEqual([
      ['position', market(2), 'ContractFunctionRevertedError'],
    ])
  })

  it('every leg failed: status error with the name', async () => {
    const { reader } = fakeChain({ revert: new Set([`position:${MORPHO_BLUE}`]) })
    const r = await resolveExposure(reader, USER, { vaults: [], markets: [market(1)] })
    expect(byId(r, 'morpho-blue')).toMatchObject({
      status: 'error',
      checked: [],
      error: { name: 'ContractFunctionRevertedError' },
    })
  })

  it('a thrown multicall (RPC down) is an error by name on each resolver', async () => {
    const err = Object.assign(new Error('HTTP request failed. Status: 503'), {
      name: 'HttpRequestError',
      shortMessage: 'HTTP request failed.',
    })
    const { reader } = fakeChain({ multicallError: err })
    const r = await resolveExposure(reader, USER, { vaults: [vault(1)], markets: [market(1)] })
    expect(r.results.map((x) => [x.status, x.error])).toEqual([
      ['error', { name: 'HttpRequestError', message: 'HTTP request failed.' }],
      ['error', { name: 'HttpRequestError', message: 'HTTP request failed.' }],
    ])
  })

  it('a failed block read: no block, every resolver error, one call made', async () => {
    const err = Object.assign(new Error('took too long'), { name: 'TimeoutError' })
    const { reader } = fakeChain({ blockError: err })
    const r = await resolveExposure(reader, USER, { vaults: [vault(1)], markets: [market(1)] })
    expect(r.block).toBeUndefined()
    expect(r.ethCalls).toBe(1)
    expect(r.results.every((x) => x.status === 'error' && x.error?.name === 'TimeoutError')).toBe(
      true,
    )
    expect(reader.multicall).not.toHaveBeenCalled()
  })

  it('a malformed position result is named, not read as zero', async () => {
    const reader: ChainReader = {
      getBlockNumber: async () => BLOCK,
      multicall: async (p) => p.contracts.map(() => ({ status: 'success', result: [1n] })),
    }
    const r = await resolveExposure(reader, USER, { vaults: [], markets: [market(1)] })
    expect(byId(r, 'morpho-blue')).toMatchObject({
      status: 'error',
      error: { name: 'UnexpectedResultError' },
    })
  })
})

describe('viemReader', () => {
  it('passes allowFailure, the pinned block and no viem-side chunking', async () => {
    const multicall = vi.fn(async () => [{ status: 'success', result: 0n }])
    const getBlockNumber = vi.fn(async () => BLOCK)
    const reader = viemReader({ multicall, getBlockNumber } as unknown as PublicClient)
    await reader.getBlockNumber()
    expect(getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 })
    const contracts: ReadCall[] = [
      {
        address: vault(1) as `0x${string}`,
        abi: ERC4626_ABI,
        functionName: 'balanceOf',
        args: [USER],
      },
    ]
    await reader.multicall({ contracts, blockNumber: BLOCK })
    expect(multicall).toHaveBeenCalledWith({
      contracts,
      allowFailure: true,
      blockNumber: BLOCK,
      batchSize: 0,
    })
  })
})

// ── a MetaMorpho vault's markets, read live ──────────────────────────────────

const vaultOf = (r: ExposureReport, v: string) =>
  (byId(r, 'vault-shares').holdings as Extract<Holding, { kind: 'vault' }>[]).find(
    (h) => h.vault === v,
  )

describe('resolveExposure: a held MetaMorpho vault’s markets now', () => {
  it('withdrawQueue ∩ supplyShares > 0, at the pinned block, with the supply priced by market()', async () => {
    const V = vault(9)
    const { reader, multicalls } = fakeChain({
      shares: { [V]: 10n, [vault(8)]: 4n },
      queues: { [V]: [market(1), market(2), market(3)] },
      vaultSupply: { [`${market(1)}:${V}`]: 2_000_000n, [`${market(3)}:${V}`]: 1n },
      totals: { [market(1)]: [500n, 1_000_000n] },
    })
    const r = await resolveExposure(reader, USER, {
      vaults: [V, vault(8)],
      markets: [market(1)],
      liveQueue: [V],
    })
    // market(2) has no supply from the vault now: no tie, whatever a snapshot said.
    expect(vaultOf(r, V)!.supplies).toEqual([
      // toAssetsDown(2e6, 500, 1e6) = 2e6 × 501 / 2e6 = 501
      { market: market(1), supplyShares: 2_000_000n, supplyAssets: 501n },
      { market: market(3), supplyShares: 1n, supplyAssets: 0n },
    ])
    // A vault not in liveQueue (a Vault V2) is not read live.
    expect(vaultOf(r, vault(8))!.supplies).toBeUndefined()
    const calls = multicalls.flatMap((m) => m.contracts)
    expect(
      calls.filter((c) => c.functionName === 'withdrawQueueLength').map((c) => c.address),
    ).toEqual([V])
    expect(calls.filter((c) => c.functionName === 'withdrawQueue').map((c) => c.args)).toEqual([
      [0n],
      [1n],
      [2n],
    ])
    expect(
      calls.filter((c) => c.functionName === 'position' && c.args[1] === V).map((c) => c.args[0]),
    ).toEqual([market(1), market(2), market(3)])
    expect(calls.filter((c) => c.functionName === 'market').map((c) => c.args[0])).toEqual([
      market(1),
      market(3),
    ])
    expect(multicalls.every((m) => m.blockNumber === BLOCK)).toBe(true)
  })

  it('an empty queue is a live read of no markets, not a snapshot fallback', async () => {
    const { reader } = fakeChain({ shares: { [vault(1)]: 1n }, queues: { [vault(1)]: [] } })
    const r = await resolveExposure(reader, USER, {
      vaults: [vault(1)],
      markets: [],
      liveQueue: [vault(1)],
    })
    expect(vaultOf(r, vault(1))!.supplies).toEqual([])
  })

  it('a failed step leaves that vault without a live list, named; the others stand', async () => {
    const [A, B, C, D] = [vault(1), vault(2), vault(3), vault(4)]
    const { reader } = fakeChain({
      shares: { [A]: 1n, [B]: 1n, [C]: 1n, [D]: 1n },
      queues: { [A]: [market(1)], [B]: [market(1), market(2)], [C]: [market(1)], [D]: [market(5)] },
      vaultSupply: { [`${market(1)}:${C}`]: 1n, [`${market(5)}:${D}`]: 1n },
      revert: new Set([
        `withdrawQueueLength:${A}`,
        `withdrawQueue:${B}:1`,
        `market:${MORPHO_BLUE}:${market(5)}`,
      ]),
    })
    const r = await resolveExposure(reader, USER, {
      vaults: [A, B, C, D],
      markets: [],
      liveQueue: [A, B, C, D],
    })
    expect(vaultOf(r, A)!.supplies).toBeUndefined()
    expect(vaultOf(r, B)!.supplies).toBeUndefined()
    // toAssetsDown(1, 1e6, 1e6) rounds down to 0: the tie stands, at 0 assets.
    expect(vaultOf(r, C)!.supplies).toEqual([
      { market: market(1), supplyShares: 1n, supplyAssets: 0n },
    ])
    // market() failed: the tie stands, unpriced.
    expect(vaultOf(r, D)!.supplies).toEqual([{ market: market(5), supplyShares: 1n }])
    expect(byId(r, 'vault-shares').failed.map((f) => [f.read, f.target, f.error.name])).toEqual([
      ['withdrawQueueLength', A, 'ContractFunctionRevertedError'],
      ['withdrawQueue', B, 'ContractFunctionRevertedError'],
      ['market', market(5), 'ContractFunctionRevertedError'],
    ])
  })

  it('a queue longer than MetaMorpho allows is not trusted', async () => {
    const { reader } = fakeChain({
      shares: { [vault(1)]: 1n },
      queueLength: { [vault(1)]: BigInt(LIMITS.maxQueue + 1) },
    })
    const r = await resolveExposure(reader, USER, {
      vaults: [vault(1)],
      markets: [],
      liveQueue: [vault(1)],
    })
    expect(vaultOf(r, vault(1))!.supplies).toBeUndefined()
    expect(byId(r, 'vault-shares').failed[0]).toMatchObject({
      read: 'withdrawQueueLength',
      error: { name: 'UnexpectedResultError' },
    })
  })

  it('a live-queue vault outside the vaults is an input error', async () => {
    const { reader } = fakeChain({})
    await expect(
      resolveExposure(reader, USER, { vaults: [vault(1)], markets: [], liveQueue: [vault(2)] }),
    ).rejects.toMatchObject({ name: 'ExposureInputError' })
  })
})

describe('parseViewerAddress', () => {
  it('lowercase or a valid EIP-55 checksum; a bad checksum is rejected', () => {
    const good = '0x1eB1994C6de521686f5B97B017fF6AFAB81FF2bb'
    expect(parseViewerAddress(good)).toBe(good.toLowerCase())
    expect(parseViewerAddress(` ${good.toLowerCase()} `)).toBe(good.toLowerCase())
    // One letter's case flipped: a mistyped mixed-case address.
    expect(parseViewerAddress('0x1eb1994C6de521686f5B97B017fF6AFAB81FF2bb')).toBeNull()
    expect(parseViewerAddress('0x1234')).toBeNull()
    expect(parseViewerAddress('')).toBeNull()
  })
})

// ── through a real viem client ──────────────────────────────────────────────

const ABI = [...ERC4626_ABI, ...METAMORPHO_QUEUE_ABI, ...MORPHO_POSITION_ABI] as const
const REVERT = encodeErrorResult({
  abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
  errorName: 'Error',
  args: ['no'],
})

/**
 * A viem PublicClient over a JSON-RPC transport that answers eth_blockNumber and
 * Multicall3 aggregate3 eth_calls, decoding each inner call with the real ABIs. `answer`
 * returns a call's result, or 'revert' for success = false.
 */
function viemChain(answer: (to: string, fn: string, args: readonly unknown[]) => unknown) {
  const calls: { method: string; params: unknown }[] = []
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown }) {
      calls.push({ method, params })
      if (method === 'eth_blockNumber') return `0x${BLOCK.toString(16)}`
      if (method === 'eth_chainId') return '0x1'
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      const [{ data }] = params as [{ to: Hex; data: Hex }, Hex]
      const { args } = decodeFunctionData({ abi: multicall3Abi, data })
      const inner = (args as unknown as [{ target: Hex; callData: Hex }[]])[0]
      const results = inner.map(({ target, callData }) => {
        const d = decodeFunctionData({ abi: ABI, data: callData })
        const out = answer(target.toLowerCase(), d.functionName, d.args ?? [])
        if (out === 'revert') return { success: false, returnData: REVERT }
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: ABI,
            functionName: d.functionName,
            result: out as never,
          }),
        }
      })
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: results,
      })
    },
  })
  const client = createPublicClient({ chain: mainnet, transport }) as PublicClient
  return { client, calls }
}

describe('resolveExposure through viem', () => {
  it('decodes real ABI results at the pinned block; a per-call failure (allowFailure) is named', async () => {
    const V = vault(9)
    const { client, calls } = viemChain((to, fn, args) => {
      if (fn === 'balanceOf') return to === V ? 10n : to === vault(7) ? 'revert' : 0n
      if (fn === 'convertToAssets') return 20n
      if (fn === 'totalAssets') return 1000n
      if (fn === 'withdrawQueueLength') return 2n
      if (fn === 'withdrawQueue') return args[0] === 0n ? market(1) : market(2)
      if (fn === 'position')
        // viem decodes addresses checksummed.
        return String(args[1]).toLowerCase() === USER
          ? args[0] === market(2)
            ? 'revert'
            : [0n, 3n, 9n]
          : [args[0] === market(1) ? 7n : 0n, 0n, 0n]
      if (fn === 'market') return [100n, 1_000_000n, 0n, 0n, 0n, 0n]
      throw new Error(fn)
    })
    const r = await resolveExposure(viemReader(client), USER, {
      vaults: [V, vault(7)],
      markets: [market(1), market(2)],
      liveQueue: [V],
    })
    // Every eth_call at the pinned block.
    const blocks = calls
      .filter((c) => c.method === 'eth_call')
      .map((c) => (c.params as unknown[])[1])
    expect(new Set(blocks)).toEqual(new Set([`0x${BLOCK.toString(16)}`]))
    expect(vaultOf(r, V)).toEqual({
      kind: 'vault',
      vault: V,
      shares: 10n,
      assets: 20n,
      totalAssets: 1000n,
      supplies: [{ market: market(1), supplyShares: 7n, supplyAssets: 0n }],
    })
    // viem's allowFailure shape ({ status: 'failure', error, result: undefined }), per call.
    const vs = byId(r, 'vault-shares')
    expect(vs.failed).toHaveLength(1)
    expect(vs.failed[0]).toMatchObject({ read: 'balanceOf', target: vault(7) })
    expect(vs.failed[0].error.name).toBe('ContractFunctionExecutionError')
    expect(vs.checked).toEqual([V])
    const mb = byId(r, 'morpho-blue')
    expect(mb.holdings).toEqual([
      { kind: 'market', market: market(1), supplyShares: 0n, borrowShares: 3n, collateral: 9n },
    ])
    expect(mb.failed.map((f) => [f.read, f.target, f.error.name])).toEqual([
      ['position', market(2), 'ContractFunctionExecutionError'],
    ])
    expect(mb.checked).toEqual([market(1)])
  })

  it('an RPC that fails every eth_call: each call a named failure, each resolver error', async () => {
    const transport = custom({
      async request({ method }: { method: string }) {
        if (method === 'eth_blockNumber') return `0x${BLOCK.toString(16)}`
        throw Object.assign(new Error('upstream down'), { code: -32603 })
      },
    })
    const client = createPublicClient({ chain: mainnet, transport }) as PublicClient
    const r = await resolveExposure(viemReader(client), USER, {
      vaults: [vault(1)],
      markets: [market(1)],
    })
    expect(r.results.map((x) => x.status)).toEqual(['error', 'error'])
    expect(r.results.every((x) => x.error?.name && x.error.name !== 'Error')).toBe(true)
    expect(r.results.every((x) => x.checked.length === 0)).toBe(true)
  })
})
