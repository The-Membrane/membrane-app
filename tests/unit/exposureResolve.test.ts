import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'

import {
  ERC4626_ABI,
  ExposureInputError,
  ExposureLimitError,
  LIMITS,
  MORPHO_BLUE,
  MORPHO_POSITION_ABI,
  exposureTargets,
  maxEthCalls,
  relationTag,
  relationsOf,
  resolveExposure,
  uncheckedMarkets,
  viemReader,
  type ChainReader,
  type ExposureReport,
  type ReadCall,
  type ReadResult,
  type RelationMarket,
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

/** A chain: vault → shares held by USER, assets per share, positions by market id. */
function fakeChain(opts: {
  shares?: Record<string, bigint>
  positions?: Record<string, [bigint, bigint, bigint]>
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
          case 'position':
            return {
              status: 'success',
              result: opts.positions?.[c.args[0] as string] ?? [0n, 0n, 0n],
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
    const { reader, multicalls } = fakeChain({ shares: { [vault(1)]: 1n } })
    await resolveExposure(reader, USER, { vaults: [vault(1)], markets: [market(1)] })
    const fns = new Set(multicalls.flatMap((m) => m.contracts.map((c) => c.functionName)))
    expect([...fns].sort()).toEqual(['balanceOf', 'convertToAssets', 'position', 'totalAssets'])
    for (const f of [...ERC4626_ABI, ...MORPHO_POSITION_ABI]) expect(f.stateMutability).toBe('view')
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

  it('the worst case at the default limits is 31 eth_calls, and it is reached, not exceeded', async () => {
    expect(maxEthCalls()).toBe(31)
    const vaults = Array.from({ length: LIMITS.maxVaults }, (_, i) => vault(i + 1))
    const markets = Array.from({ length: LIMITS.maxMarkets }, (_, i) => market(i + 1))
    const { reader } = fakeChain({ shares: Object.fromEntries(vaults.map((v) => [v, 1n])) })
    const r = await resolveExposure(reader, USER, { vaults, markets })
    expect(r.ethCalls).toBe(31)
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

// ── relations ────────────────────────────────────────────────────────────────

const M: RelationMarket[] = [
  {
    market: market(1),
    locked: false,
    vaults: [
      { vault: vault(1), vaultName: 'Alpha USDC', curatorName: 'Gauntlet', usd: 10_000_000 },
      { vault: vault(2), vaultName: 'Beta USDC', curatorName: 'Steakhouse', usd: 4_000_000 },
    ],
  },
  {
    market: market(2),
    locked: true,
    vaults: [
      { vault: vault(2), vaultName: 'Beta USDC', curatorName: 'Steakhouse', usd: 2_000_000 },
    ],
  },
  { market: market(3), locked: false, vaults: [] },
  {
    market: market(4),
    locked: false,
    vaults: [
      {
        vault: vault(3),
        vaultName: 'Gamma',
        curatorName: '0x12393ccf9553eb402ffeb43678565ea5727cecf6',
        usd: 1_000_000,
      },
    ],
  },
]

const report = (
  over: Partial<Record<'vault-shares' | 'morpho-blue', object>> = {},
): ExposureReport => ({
  address: USER,
  chainId: 1,
  block: BLOCK,
  ethCalls: 3,
  results: [
    {
      id: 'vault-shares',
      label: 'Vault shares',
      status: 'ok',
      holdings: [
        { kind: 'vault', vault: vault(2), shares: 1n, assets: 250_000n, totalAssets: 1_000_000n },
      ],
      checked: [vault(1), vault(2), vault(3)],
      failed: [],
      ...over['vault-shares'],
    },
    {
      id: 'morpho-blue',
      label: 'Morpho Blue positions',
      status: 'ok',
      holdings: [
        { kind: 'market', market: market(3), supplyShares: 9n, borrowShares: 0n, collateral: 0n },
      ],
      checked: [market(1), market(2), market(3), market(4)],
      failed: [],
      ...over['morpho-blue'],
    },
  ],
})

describe('relations', () => {
  it('targets: every listed vault and market, lowercase, once', () => {
    expect(exposureTargets(M)).toEqual({
      vaults: [vault(1), vault(2), vault(3)],
      markets: [market(1), market(2), market(3), market(4)],
    })
  })

  it('via a vault: pro rata of the allocation at the exposure read; book value is flagged', () => {
    const r = relationsOf(M, report(), undefined)
    expect(r.get(market(1))).toEqual({
      kind: 'via-vault',
      roles: ['vault'],
      path: [vault(2)],
      vaultNames: ['Beta USDC'],
      usd: 1_000_000, // 25 % of the vault × $4M
      book: false,
    })
    expect(r.get(market(2))).toMatchObject({ kind: 'via-vault', usd: 500_000, book: true })
    expect(relationTag(r.get(market(1))!)).toBe('your vault Beta USDC')
  })

  it('direct: a Morpho Blue position, no $ (no live loan price here)', () => {
    const r = relationsOf(M, report(), undefined)
    expect(r.get(market(3))).toEqual({
      kind: 'direct',
      roles: ['supply'],
      path: ['morpho-blue'],
      vaultNames: [],
      book: false,
    })
    expect(relationTag(r.get(market(3))!)).toBe('you supply')
    expect(r.has(market(4))).toBe(false)
  })

  it('a failed asset read leaves the $ undefined, never a partial sum', () => {
    const r = relationsOf(
      M,
      report({
        'vault-shares': {
          holdings: [
            { kind: 'vault', vault: vault(2), shares: 1n, assets: undefined, totalAssets: 1n },
          ],
        },
      }),
      undefined,
    )
    expect(r.get(market(1))).toMatchObject({ kind: 'via-vault' })
    expect(r.get(market(1))!.usd).toBeUndefined()
  })

  it('curator: the curator’s vaults and their allocations; the strongest kind wins', () => {
    const r = relationsOf(M, undefined, 'Gauntlet')
    expect([...r.keys()]).toEqual([market(1)])
    expect(r.get(market(1))).toMatchObject({
      kind: 'same-curator',
      roles: ['curator'],
      path: [vault(1)],
      curatorName: 'Gauntlet',
      usd: 10_000_000,
    })
    expect(relationTag(r.get(market(1))!)).toBe('curated by Gauntlet')
    const both = relationsOf(M, report(), 'Steakhouse').get(market(1))!
    expect(both).toMatchObject({ kind: 'via-vault', roles: ['vault', 'curator'], usd: 1_000_000 })
    expect(relationTag(both)).toBe('your vault Beta USDC · curated by Steakhouse')
    const anon = relationsOf(M, undefined, '0x12393ccf9553eb402ffeb43678565ea5727cecf6').get(
      market(4),
    )!
    expect(relationTag(anon)).toBe('curated by 0x1239…ecf6')
  })

  it('borrow and collateral roles read as such', () => {
    const r = relationsOf(
      M,
      report({
        'morpho-blue': {
          holdings: [
            {
              kind: 'market',
              market: market(4),
              supplyShares: 0n,
              borrowShares: 3n,
              collateral: 7n,
            },
            {
              kind: 'market',
              market: market(3),
              supplyShares: 0n,
              borrowShares: 0n,
              collateral: 7n,
            },
          ],
        },
      }),
      undefined,
    )
    expect(relationTag(r.get(market(4))!)).toBe('you borrow')
    expect(relationTag(r.get(market(3))!)).toBe('your collateral')
  })

  it('unchecked: a failed read or a failed resolver is unknown, never "none"', () => {
    expect(uncheckedMarkets(M, report())).toEqual([])
    expect(uncheckedMarkets(M, undefined)).toEqual([])
    expect(
      uncheckedMarkets(M, report({ 'vault-shares': { checked: [vault(1), vault(3)] } })),
    ).toEqual([market(1), market(2)])
    expect(
      uncheckedMarkets(
        M,
        report({ 'morpho-blue': { checked: [market(1), market(2), market(4)] } }),
      ),
    ).toEqual([market(3)])
    expect(
      uncheckedMarkets(M, report({ 'morpho-blue': { status: 'error', checked: [] } })),
    ).toEqual([market(1), market(2), market(3), market(4)])
  })
})
