/**
 * WALLET EXPOSURE: which listed vaults and markets an address holds. Read-only.
 *
 * WHAT IT READS (Ethereum mainnet, all at one block, nothing else):
 *   1. eth_blockNumber, once. Every later read is pinned to that block.
 *   2. vault-shares  ERC-4626 balanceOf(user) on each vault in the targets; then, only for
 *                    the vaults where the user holds shares, convertToAssets(shares) and
 *                    totalAssets(). For each held MetaMorpho (V1) vault in
 *                    `targets.liveQueue`, the markets it supplies NOW: withdrawQueueLength()
 *                    and withdrawQueue(i), then Morpho Blue position(id, vault), kept where
 *                    supplyShares > 0, and market(id) to price that supply. A vault whose
 *                    live read is not made (a Vault V2, over the limit) or fails keeps no
 *                    `supplies`: its ties can only come from the exposure snapshot, which
 *                    callers must label with its date (relations.ts), never as live.
 *   3. morpho-blue   position(id, user) on the Morpho Blue singleton, for each market id
 *                    in the targets.
 * Every call is an eth_call batched through Multicall3 aggregate3 (viem multicall with
 * allowFailure). The reader has no signer and no write method. Nothing here asks the user
 * to sign.
 *
 * BOUNDS. At most LIMITS.maxVaults vaults and LIMITS.maxMarkets markets per read; the live
 * market lists for at most LIMITS.maxLiveVaults held V1 vaults, each queue at most
 * LIMITS.maxQueue long (MetaMorpho's MAX_QUEUE_LENGTH). Over a target limit, or with a
 * malformed address or id, it throws a named error before any call; a held V1 vault past
 * maxLiveVaults (the largest in USD are read first) is listed in `failed`
 * (ExposureLimitError) and keeps snapshot ties only.
 * Calls go out LIMITS.perMulticall to a multicall (LIMITS.perAssetMulticall for the
 * vault-asset reads, which loop over a vault's markets on chain). maxEthCalls() gives the
 * worst case: 56 eth_calls at the default limits.
 *
 * ERRORS ARE NAMED, NEVER SWALLOWED. A failed call is listed in `failed` with its error's
 * name. A resolver whose every call failed, or that threw, has status 'error' with the
 * name and message. A target whose read failed is not in `checked`: callers must treat it
 * as unchecked, never as "none".
 *
 * KEYS. Vault addresses and market ids are lowercase, the same keys as the curator feed's
 * exposure.json. The dependency-map lane extends RESOLVERS.
 */

import { isAddress, type Abi, type PublicClient } from 'viem'

import { toAssetsDown } from '@/lib/curatorFeed/exposure'

export type Address = `0x${string}`

/** The Morpho Blue singleton on Ethereum mainnet (morpho-org/morpho-blue deployments). */
export const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' as const
export const CHAIN_ID = 1

export const LIMITS = {
  maxVaults: 500,
  maxMarkets: 500,
  /** Held MetaMorpho vaults whose market list is read live. */
  maxLiveVaults: 25,
  /** MetaMorpho ConstantsLib.MAX_QUEUE_LENGTH: a longer queue is not a MetaMorpho queue. */
  maxQueue: 30,
  /** balanceOf, position(), withdrawQueue and market() calls per multicall. */
  perMulticall: 100,
  /** convertToAssets + totalAssets calls per multicall (two per held vault). */
  perAssetMulticall: 50,
} as const
export type Limits = { [K in keyof typeof LIMITS]: number }

/** The most eth_calls one resolveExposure() can make at these limits. */
export function maxEthCalls(l: Limits = LIMITS): number {
  const chunks = (n: number, per: number) => Math.ceil(n / per)
  const live = Math.min(l.maxLiveVaults, l.maxVaults)
  return (
    1 +
    chunks(l.maxVaults, l.perMulticall) +
    chunks(2 * l.maxVaults, l.perAssetMulticall) +
    chunks(live, l.perMulticall) + // withdrawQueueLength
    3 * chunks(live * l.maxQueue, l.perMulticall) + // withdrawQueue, position(id, vault), market
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

/** MetaMorpho (morpho-org/metamorpho IMetaMorpho): the withdraw queue lists every market
 *  the vault can hold supply in (a market with supply cannot leave it). */
export const METAMORPHO_QUEUE_ABI = [
  {
    type: 'function',
    name: 'withdrawQueueLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawQueue',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
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
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
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
export type ReadName =
  | 'balanceOf'
  | 'convertToAssets'
  | 'totalAssets'
  | 'withdrawQueueLength'
  | 'withdrawQueue'
  | 'vaultPosition'
  | 'market'
  | 'position'

export interface ReadFailure {
  read: ReadName
  /** Lowercase vault address or market id. */
  target: string
  error: NamedError
}

/** A market a vault supplies at the block (supplyShares > 0), read on chain. */
export interface VaultSupply {
  market: string
  supplyShares: bigint
  /** toAssetsDown on market()'s stored totals; undefined when market() failed. */
  supplyAssets?: bigint
}

export type Holding =
  | {
      kind: 'vault'
      vault: string
      shares: bigint
      /** convertToAssets(shares) and totalAssets(); undefined when that read failed. */
      assets?: bigint
      totalAssets?: bigint
      /** The markets the vault supplies at the block, read live (MetaMorpho only).
       *  Undefined: not read live; any tie is the exposure snapshot's. */
      supplies?: VaultSupply[]
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
  /** Of `vaults`, the MetaMorpho (V1) vaults whose market list is read live. */
  liveQueue?: string[]
  /** USD per base unit of each vault's asset: past maxLiveVaults held MetaMorpho vaults,
   *  the largest by convertToAssets × this are read live (a vault without one ranks last). */
  usdPerAsset?: Record<string, number>
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
  liveQueue: ReadonlySet<string>
  usdPerAsset: Readonly<Record<string, number>>
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
const isId = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x)
const isUintTuple = (x: unknown, n: number): x is bigint[] =>
  Array.isArray(x) && x.length === n && x.every(isUint)

/**
 * The markets each held MetaMorpho vault supplies at the block. A vault whose read fails
 * at any step gets no `supplies` (snapshot ties only) and its failure is listed.
 */
async function readLiveSupplies(
  ctx: ReadContext,
  vaults: string[],
  failed: ReadFailure[],
): Promise<Map<string, VaultSupply[]>> {
  const per = ctx.limits.perMulticall
  const broken = new Set<string>()
  const fail = (read: ReadName, vault: string, r: ReadResult | undefined) => {
    failed.push({ read, target: vault, error: failure(r) })
    broken.add(vault)
  }
  const lens = await readAll(
    ctx,
    vaults.map((v) => ({
      address: v as Address,
      abi: METAMORPHO_QUEUE_ABI,
      functionName: 'withdrawQueueLength',
      args: [],
    })),
    per,
  )
  const slots: { vault: string; i: bigint }[] = []
  vaults.forEach((vault, k) => {
    const r = lens[k]
    if (r.status !== 'success' || !isUint(r.result) || r.result > BigInt(ctx.limits.maxQueue))
      return fail('withdrawQueueLength', vault, r)
    for (let i = 0n; i < r.result; i++) slots.push({ vault, i })
  })
  const ids = await readAll(
    ctx,
    slots.map(({ vault, i }) => ({
      address: vault as Address,
      abi: METAMORPHO_QUEUE_ABI,
      functionName: 'withdrawQueue',
      args: [i],
    })),
    per,
  )
  const pairs: { vault: string; market: string }[] = []
  slots.forEach(({ vault }, k) => {
    const r = ids[k]
    if (r.status !== 'success' || !isId(r.result)) return fail('withdrawQueue', vault, r)
    pairs.push({ vault, market: r.result.toLowerCase() })
  })
  const live = pairs.filter((p) => !broken.has(p.vault))
  const pos = await readAll(
    ctx,
    live.map(({ vault, market }) => ({
      address: MORPHO_BLUE,
      abi: MORPHO_POSITION_ABI,
      functionName: 'position',
      args: [market, vault],
    })),
    per,
  )
  const supplied: { vault: string; market: string; supplyShares: bigint }[] = []
  live.forEach(({ vault }, k) => {
    const r = pos[k]
    const p = r.status === 'success' ? r.result : undefined
    if (!isUintTuple(p, 3)) return fail('vaultPosition', vault, r)
    if (p[0] > 0n) supplied.push({ vault, market: live[k].market, supplyShares: p[0] })
  })
  const markets = [...new Set(supplied.filter((s) => !broken.has(s.vault)).map((s) => s.market))]
  const mk = await readAll(
    ctx,
    markets.map((id) => ({
      address: MORPHO_BLUE,
      abi: MORPHO_POSITION_ABI,
      functionName: 'market',
      args: [id],
    })),
    per,
  )
  const totals = new Map<string, [bigint, bigint]>()
  markets.forEach((id, k) => {
    const r = mk[k]
    const m = r.status === 'success' ? r.result : undefined
    // A failed market() only leaves the supply unpriced; the tie itself was read.
    if (!isUintTuple(m, 6)) failed.push({ read: 'market', target: id, error: failure(r) })
    else totals.set(id, [m[0], m[1]])
  })
  const out = new Map<string, VaultSupply[]>()
  for (const v of vaults) if (!broken.has(v)) out.set(v, [])
  for (const s of supplied) {
    const list = out.get(s.vault)
    if (!list) continue
    const t = totals.get(s.market)
    list.push({
      market: s.market,
      supplyShares: s.supplyShares,
      ...(t ? { supplyAssets: toAssetsDown(s.supplyShares, t[0], t[1]) } : {}),
    })
  }
  return out
}

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
    // The live market list, for the held MetaMorpho vaults, up to the limit: the largest
    // in USD first (convertToAssets × the vault's USD per asset), then by address.
    const usdOf = (i: number): number => {
      const r = assets[2 * i]
      const px = ctx.usdPerAsset[held[i].vault]
      return r?.status === 'success' && isUint(r.result) && px !== undefined
        ? Number(r.result) * px
        : -1
    }
    const v1 = held
      .map((h, i) => ({ vault: h.vault, usd: usdOf(i) }))
      .filter((x) => ctx.liveQueue.has(x.vault))
      .sort((a, b) => b.usd - a.usd || (a.vault < b.vault ? -1 : 1))
      .map((x) => x.vault)
    for (const v of v1.slice(ctx.limits.maxLiveVaults))
      failed.push({
        read: 'withdrawQueueLength',
        target: v,
        error: named(
          new ExposureLimitError(
            `over ${ctx.limits.maxLiveVaults} held MetaMorpho vaults: this one's markets are the exposure snapshot's`,
          ),
        ),
      })
    const supplies = await readLiveSupplies(ctx, v1.slice(0, ctx.limits.maxLiveVaults), failed)
    const holdings: Holding[] = held.map(({ vault, shares }, i) => {
      const value = (r: ReadResult, read: ReadName): bigint | undefined => {
        if (r.status === 'success' && isUint(r.result)) return r.result
        failed.push({ read, target: vault, error: failure(r) })
        return undefined
      }
      const s = supplies.get(vault)
      return {
        kind: 'vault',
        vault,
        shares,
        assets: value(assets[2 * i], 'convertToAssets'),
        totalAssets: value(assets[2 * i + 1], 'totalAssets'),
        ...(s ? { supplies: s } : {}),
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
      if (!isUintTuple(p, 3)) {
        failed.push({ read: 'position', target: market, error: failure(r) })
        return
      }
      checked.push(market)
      const [supplyShares, borrowShares, collateral] = p
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

/**
 * A pasted address, lowercase, or null. Mixed case must carry a valid EIP-55 checksum
 * (viem isAddress, strict); all-lowercase has none to check.
 */
export function parseViewerAddress(input: string): Address | null {
  const s = input.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(s) || !isAddress(s, { strict: true })) return null
  return s.toLowerCase() as Address
}

/** Lowercase, deduplicated, validated targets. Throws ExposureInputError. */
export function normalizeTargets(t: ExposureTargets): Required<ExposureTargets> {
  const usdPerAsset: Record<string, number> = {}
  for (const [v, px] of Object.entries(t.usdPerAsset ?? {})) {
    if (!(Number.isFinite(px) && px >= 0))
      throw new ExposureInputError(`not a USD price: ${v} ${px}`)
    usdPerAsset[v.toLowerCase()] = px
  }
  const clean = (xs: string[], re: RegExp, what: string) => {
    const out = [...new Set(xs.map((x) => x.toLowerCase()))]
    const bad = out.find((x) => !re.test(x))
    if (bad !== undefined) throw new ExposureInputError(`not a ${what}: ${bad}`)
    return out
  }
  const vaults = clean(t.vaults, ADDRESS_RE, 'vault address')
  const liveQueue = clean(t.liveQueue ?? [], ADDRESS_RE, 'vault address')
  const outside = liveQueue.find((v) => !vaults.includes(v))
  if (outside !== undefined)
    throw new ExposureInputError(`live-queue vault not among the vaults: ${outside}`)
  return {
    vaults,
    markets: clean(t.markets, MARKET_RE, 'Morpho market id'),
    liveQueue,
    usdPerAsset,
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
    liveQueue: new Set(t.liveQueue),
    usdPerAsset: t.usdPerAsset,
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
