/**
 * WALLET EXPOSURE: which listed vaults and markets an address holds. Read-only.
 *
 * WHAT IT READS (Ethereum mainnet, all at one block, nothing else):
 *   1. eth_blockNumber, once. Every later read is pinned to that block.
 *   2. vault-shares  ERC-4626 balanceOf(user) on each vault in the targets; then, only for
 *                    the vaults where the user holds shares, convertToAssets(shares) and
 *                    totalAssets().
 *   3. morpho-blue   position(id, user) on the Morpho Blue singleton, for each market id
 *                    in the targets.
 * Every call is an eth_call batched through Multicall3 aggregate3 (viem multicall with
 * allowFailure). The reader has no signer and no write method. Nothing here asks the user
 * to sign.
 *
 * BOUNDS. At most LIMITS.maxVaults vaults and LIMITS.maxMarkets markets per read. Over a
 * limit, or with a malformed address or id, it throws a named error before any call. Calls
 * go out LIMITS.perMulticall to a multicall (LIMITS.perAssetMulticall for the vault-asset
 * reads, which loop over a vault's markets on chain). maxEthCalls() gives the worst case:
 * 31 eth_calls at the default limits.
 *
 * ERRORS ARE NAMED, NEVER SWALLOWED. A failed call is listed in `failed` with its error's
 * name. A resolver whose every call failed, or that threw, has status 'error' with the
 * name and message. A target whose read failed is not in `checked`: callers must treat it
 * as unchecked, never as "none".
 *
 * KEYS. Vault addresses and market ids are lowercase, the same keys as the curator feed's
 * exposure.json. The dependency-map lane extends RESOLVERS.
 */

import type { Abi, PublicClient } from 'viem'

export type Address = `0x${string}`

/** The Morpho Blue singleton on Ethereum mainnet (morpho-org/morpho-blue deployments). */
export const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' as const
export const CHAIN_ID = 1

export const LIMITS = {
  maxVaults: 500,
  maxMarkets: 500,
  /** balanceOf and position() calls per multicall. */
  perMulticall: 100,
  /** convertToAssets + totalAssets calls per multicall (two per held vault). */
  perAssetMulticall: 50,
} as const
export type Limits = { [K in keyof typeof LIMITS]: number }

/** The most eth_calls one resolveExposure() can make at these limits. */
export function maxEthCalls(l: Limits = LIMITS): number {
  const chunks = (n: number, per: number) => Math.ceil(n / per)
  return (
    1 +
    chunks(l.maxVaults, l.perMulticall) +
    chunks(2 * l.maxVaults, l.perAssetMulticall) +
    chunks(l.maxMarkets, l.perMulticall)
  )
}

export const ERC4626_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

export const MORPHO_POSITION_ABI = [
  {
    // A public mapping getter: the struct members come back as three values.
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
  },
] as const

// ── the reader ────────────────────────────────────────────────────────────────

export interface ReadCall {
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
}
export type ReadResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown }

/** The two reads the resolver makes. viemReader() wraps a viem PublicClient. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>
  multicall(p: { contracts: readonly ReadCall[]; blockNumber: bigint }): Promise<ReadResult[]>
}

type MulticallContracts = Parameters<PublicClient['multicall']>[0]['contracts']

/** A viem PublicClient as a ChainReader: no cache on the block number; viem's own
 *  chunking off (batchSize 0), so each multicall here is exactly one eth_call. */
export function viemReader(client: PublicClient): ChainReader {
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    multicall: ({ contracts, blockNumber }) =>
      client.multicall({
        // viem types each call against its literal ABI; the calls are built from the
        // literal ABIs above, so the widening here loses nothing that was checked.
        contracts: contracts as unknown as MulticallContracts,
        allowFailure: true,
        blockNumber,
        batchSize: 0,
      }) as Promise<ReadResult[]>,
  }
}

// ── results ───────────────────────────────────────────────────────────────────

export interface NamedError {
  name: string
  message: string
}

/** An error by its name (viem's are specific: HttpRequestError, TimeoutError, …). */
export function named(e: unknown): NamedError {
  if (e instanceof Error) {
    const short = (e as { shortMessage?: unknown }).shortMessage
    return { name: e.name, message: typeof short === 'string' ? short : e.message }
  }
  return { name: 'Error', message: String(e) }
}

export class ExposureInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExposureInputError'
  }
}
export class ExposureLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExposureLimitError'
  }
}

export type ResolverId = 'vault-shares' | 'morpho-blue'
export type ResolverStatus = 'ok' | 'empty' | 'error' | 'unchecked'
export type ReadName = 'balanceOf' | 'convertToAssets' | 'totalAssets' | 'position'

export interface ReadFailure {
  read: ReadName
  /** Lowercase vault address or market id. */
  target: string
  error: NamedError
}

export type Holding =
  | {
      kind: 'vault'
      vault: string
      shares: bigint
      /** convertToAssets(shares) and totalAssets(); undefined when that read failed. */
      assets?: bigint
      totalAssets?: bigint
    }
  | {
      kind: 'market'
      market: string
      supplyShares: bigint
      borrowShares: bigint
      collateral: bigint
    }

export interface ResolverResult {
  id: ResolverId
  label: string
  /** ok: something held · empty: every target read, nothing held · error: no target
   *  read · unchecked: no target to read. */
  status: ResolverStatus
  holdings: Holding[]
  /** Targets read without a failure (lowercase). A target not here is unchecked. */
  checked: string[]
  failed: ReadFailure[]
  error?: NamedError
}

export interface ExposureTargets {
  vaults: string[]
  markets: string[]
}

export interface ExposureReport {
  address: Address
  chainId: typeof CHAIN_ID
  /** The block every read was pinned to; undefined when eth_blockNumber failed. */
  block?: bigint
  results: ResolverResult[]
  /** eth_calls made (getBlockNumber + each multicall). */
  ethCalls: number
}

interface ReadContext {
  multicall: (calls: ReadCall[]) => Promise<ReadResult[]>
  user: Address
  limits: Limits
}

type ResolverRead = Pick<ResolverResult, 'holdings' | 'checked' | 'failed'>

/** One protocol's read, shaped like the position simulator's LendingAdapter. */
export interface ProtocolResolver {
  id: ResolverId
  label: string
  /** The targets it reads. */
  targetsOf(t: ExposureTargets): string[]
  read(ctx: ReadContext, targets: string[]): Promise<ResolverRead>
}

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Calls in multicalls of `per`, in order; one result per call. */
async function readAll(ctx: ReadContext, calls: ReadCall[], per: number): Promise<ReadResult[]> {
  const out: ReadResult[] = []
  for (const part of chunk(calls, per)) {
    const res = await ctx.multicall(part)
    if (res.length !== part.length)
      throw new Error(`multicall returned ${res.length} results for ${part.length} calls`)
    out.push(...res)
  }
  return out
}

const isUint = (x: unknown): x is bigint => typeof x === 'bigint' && x >= 0n

const vaultShares: ProtocolResolver = {
  id: 'vault-shares',
  label: 'Vault shares',
  targetsOf: (t) => t.vaults,
  async read(ctx, vaults) {
    const failed: ReadFailure[] = []
    const checked: string[] = []
    const held: { vault: string; shares: bigint }[] = []
    const bal = await readAll(
      ctx,
      vaults.map((v) => ({
        address: v as Address,
        abi: ERC4626_ABI,
        functionName: 'balanceOf',
        args: [ctx.user],
      })),
      ctx.limits.perMulticall,
    )
    bal.forEach((r, i) => {
      const vault = vaults[i]
      if (r.status === 'failure' || !isUint(r.result)) {
        failed.push({ read: 'balanceOf', target: vault, error: failure(r) })
        return
      }
      checked.push(vault)
      if (r.result > 0n) held.push({ vault, shares: r.result })
    })
    // Assets only where the user holds shares: two calls per held vault.
    const assetCalls: ReadCall[] = held.flatMap(({ vault, shares }) => [
      {
        address: vault as Address,
        abi: ERC4626_ABI,
        functionName: 'convertToAssets',
        args: [shares],
      },
      { address: vault as Address, abi: ERC4626_ABI, functionName: 'totalAssets', args: [] },
    ])
    const assets = await readAll(ctx, assetCalls, ctx.limits.perAssetMulticall)
    const holdings: Holding[] = held.map(({ vault, shares }, i) => {
      const value = (r: ReadResult, read: ReadName): bigint | undefined => {
        if (r.status === 'success' && isUint(r.result)) return r.result
        failed.push({ read, target: vault, error: failure(r) })
        return undefined
      }
      return {
        kind: 'vault',
        vault,
        shares,
        assets: value(assets[2 * i], 'convertToAssets'),
        totalAssets: value(assets[2 * i + 1], 'totalAssets'),
      }
    })
    return { holdings, checked, failed }
  },
}

const morphoBlue: ProtocolResolver = {
  id: 'morpho-blue',
  label: 'Morpho Blue positions',
  targetsOf: (t) => t.markets,
  async read(ctx, markets) {
    const failed: ReadFailure[] = []
    const checked: string[] = []
    const holdings: Holding[] = []
    const res = await readAll(
      ctx,
      markets.map((id) => ({
        address: MORPHO_BLUE,
        abi: MORPHO_POSITION_ABI,
        functionName: 'position',
        args: [id, ctx.user],
      })),
      ctx.limits.perMulticall,
    )
    res.forEach((r, i) => {
      const market = markets[i]
      const p = r.status === 'success' ? r.result : undefined
      if (!Array.isArray(p) || p.length !== 3 || !p.every(isUint)) {
        failed.push({ read: 'position', target: market, error: failure(r) })
        return
      }
      checked.push(market)
      const [supplyShares, borrowShares, collateral] = p as bigint[]
      if (supplyShares > 0n || borrowShares > 0n || collateral > 0n)
        holdings.push({ kind: 'market', market, supplyShares, borrowShares, collateral })
    })
    return { holdings, checked, failed }
  },
}

/** A failed leg's error; a success with an unexpected shape is named as such. */
function failure(r: ReadResult | undefined): NamedError {
  if (!r) return { name: 'MissingResultError', message: 'no result for this call' }
  if (r.status === 'failure') return named(r.error)
  return { name: 'UnexpectedResultError', message: `unexpected result ${String(r.result)}` }
}

export const RESOLVERS: readonly ProtocolResolver[] = [vaultShares, morphoBlue]

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const MARKET_RE = /^0x[0-9a-f]{64}$/

/** Lowercase, deduplicated, validated targets. Throws ExposureInputError. */
export function normalizeTargets(t: ExposureTargets): ExposureTargets {
  const clean = (xs: string[], re: RegExp, what: string) => {
    const out = [...new Set(xs.map((x) => x.toLowerCase()))]
    const bad = out.find((x) => !re.test(x))
    if (bad !== undefined) throw new ExposureInputError(`not a ${what}: ${bad}`)
    return out
  }
  return {
    vaults: clean(t.vaults, ADDRESS_RE, 'vault address'),
    markets: clean(t.markets, MARKET_RE, 'Morpho market id'),
  }
}

/**
 * Reads every resolver for `user` over `targets`, at one block. Throws (before any call)
 * ExposureInputError for a malformed address or id and ExposureLimitError over a limit.
 * Every other failure is returned by name in the report.
 */
export async function resolveExposure(
  reader: ChainReader,
  user: string,
  targets: ExposureTargets,
  opts: { resolvers?: readonly ProtocolResolver[]; limits?: Limits } = {},
): Promise<ExposureReport> {
  const address = user.toLowerCase() as Address
  if (!ADDRESS_RE.test(address)) throw new ExposureInputError(`not an address: ${user}`)
  const limits = opts.limits ?? LIMITS
  const t = normalizeTargets(targets)
  if (t.vaults.length > limits.maxVaults)
    throw new ExposureLimitError(`${t.vaults.length} vaults; the limit is ${limits.maxVaults}`)
  if (t.markets.length > limits.maxMarkets)
    throw new ExposureLimitError(`${t.markets.length} markets; the limit is ${limits.maxMarkets}`)
  const resolvers = opts.resolvers ?? RESOLVERS
  let ethCalls = 1
  let block: bigint
  try {
    block = await reader.getBlockNumber()
  } catch (e) {
    const error = named(e)
    return {
      address,
      chainId: CHAIN_ID,
      results: resolvers.map((r) => ({
        id: r.id,
        label: r.label,
        status: 'error',
        holdings: [],
        checked: [],
        failed: [],
        error,
      })),
      ethCalls,
    }
  }
  const ctx: ReadContext = {
    user: address,
    limits,
    multicall: (contracts) => {
      ethCalls++
      return reader.multicall({ contracts, blockNumber: block })
    },
  }
  const results: ResolverResult[] = []
  for (const r of resolvers) {
    const ts = r.targetsOf(t)
    const base = { id: r.id, label: r.label }
    if (!ts.length) {
      results.push({ ...base, status: 'unchecked', holdings: [], checked: [], failed: [] })
      continue
    }
    try {
      const out = await r.read(ctx, ts)
      const status: ResolverStatus = !out.checked.length
        ? 'error'
        : out.holdings.length
          ? 'ok'
          : 'empty'
      results.push({
        ...base,
        ...out,
        status,
        ...(status === 'error' ? { error: out.failed[0]?.error } : {}),
      })
    } catch (e) {
      results.push({
        ...base,
        status: 'error',
        holdings: [],
        checked: [],
        failed: [],
        error: named(e),
      })
    }
  }
  return { address, chainId: CHAIN_ID, block, results, ethCalls }
}
