/**
 * S0 SOURCES — every fetch the scan makes, each with a schema check. All keyless.
 *
 *   yields.llama.fi/pools          universe, APY, TVL, count, apyMean30d, outlier, ilRisk
 *   yields.llama.fi/lendBorrow     borrow side, joined to /pools on `pool`
 *   api.llama.fi/protocols         category per project slug
 *   yields.llama.fi/chart/{pool}   stability, finalists only, paced ≤ 20/min
 *   blue-api.morpho.org/graphql    MetaMorpho / Vault V2 addresses; listed markets
 *   Merkl                          lib/netApy/incentives.ts fetchMerklOpportunities
 *
 * A failed fetch or a failed schema check throws `SourceError`; the scan turns that into a
 * hard failure (fail closed: the last good latest.json stays live).
 * /pools is ~11 MB and /protocols ~9 MB: parsed in memory, never written to disk.
 */

import type {
  ChartPoint,
  LlamaLendBorrow,
  LlamaPool,
  LlamaProtocol,
  MorphoMarketInfo,
  MorphoVaultInfo,
} from './types'

export const LLAMA_POOLS_URL = 'https://yields.llama.fi/pools'
export const LLAMA_LENDBORROW_URL = 'https://yields.llama.fi/lendBorrow'
export const LLAMA_PROTOCOLS_URL = 'https://api.llama.fi/protocols'
export const LLAMA_CHART_URL = 'https://yields.llama.fi/chart/'
export const MORPHO_GRAPHQL_URL = 'https://blue-api.morpho.org/graphql'

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`)
    this.name = 'SourceError'
  }
}

export type Sleep = (ms: number) => Promise<void>
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** GET/POST JSON with a timeout and backoff on 429/5xx. Throws SourceError. */
export async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  source: string,
  opts: {
    init?: RequestInit
    timeoutMs?: number
    retries?: number
    sleep?: Sleep
    backoffMs?: number
  } = {},
): Promise<unknown> {
  const retries = opts.retries ?? 3
  const sleep = opts.sleep ?? realSleep
  let lastErr = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 90_000)
    try {
      const r = await fetchImpl(url, {
        ...opts.init,
        signal: ac.signal,
        headers: { accept: 'application/json', ...(opts.init?.headers ?? {}) },
      })
      if (r.status === 429 || r.status >= 500) {
        lastErr = `HTTP ${r.status}`
        if (attempt < retries) {
          await sleep((opts.backoffMs ?? 10_000) * 2 ** attempt)
          continue
        }
        throw new SourceError(source, lastErr)
      }
      if (r.status !== 200) throw new SourceError(source, `HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      if (e instanceof SourceError) throw e
      lastErr = e instanceof Error ? e.message.split('\n')[0] : String(e)
      if (attempt < retries) {
        await sleep((opts.backoffMs ?? 10_000) * 2 ** attempt)
        continue
      }
      throw new SourceError(source, lastErr)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new SourceError(source, lastErr || 'unreachable')
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null

/** Fails the source when more than 1% of rows are malformed (a silent schema change). */
function checkShape<T>(
  source: string,
  raw: unknown[],
  parse: (x: Record<string, unknown>) => T | null,
  minRows: number,
): T[] {
  if (raw.length < minRows)
    throw new SourceError(source, `schema: ${raw.length} rows, expected at least ${minRows}`)
  const out: T[] = []
  let bad = 0
  for (const x of raw) {
    const r = x && typeof x === 'object' ? parse(x as Record<string, unknown>) : null
    if (r) out.push(r)
    else bad++
  }
  if (bad / raw.length > 0.01)
    throw new SourceError(source, `schema: ${bad} of ${raw.length} rows malformed`)
  return out
}

export function parsePools(body: unknown): LlamaPool[] {
  const b = body as { status?: unknown; data?: unknown }
  if (!b || b.status !== 'success' || !Array.isArray(b.data))
    throw new SourceError('defillama /pools', 'schema: expected {status:"success", data:[]}')
  return checkShape(
    'defillama /pools',
    b.data,
    (x) => {
      const pool = str(x.pool)
      const chain = str(x.chain)
      const project = str(x.project)
      const symbol = str(x.symbol)
      const tvlUsd = num(x.tvlUsd)
      if (
        !pool ||
        !chain ||
        !project ||
        symbol === null ||
        tvlUsd === null ||
        typeof x.stablecoin !== 'boolean'
      )
        return null
      return {
        pool,
        chain,
        project,
        symbol,
        tvlUsd,
        apy: num(x.apy),
        apyBase: num(x.apyBase),
        apyReward: num(x.apyReward),
        apyBase7d: num(x.apyBase7d),
        apyMean30d: num(x.apyMean30d),
        stablecoin: x.stablecoin,
        exposure: str(x.exposure) ?? '',
        ilRisk: str(x.ilRisk) ?? '',
        poolMeta: str(x.poolMeta),
        count: num(x.count),
        outlier: x.outlier === true,
        underlyingTokens: strArr(x.underlyingTokens),
      }
    },
    1000,
  )
}

export function parseLendBorrow(body: unknown): LlamaLendBorrow[] {
  if (!Array.isArray(body))
    throw new SourceError('defillama /lendBorrow', 'schema: expected an array')
  return checkShape(
    'defillama /lendBorrow',
    body,
    (x) => {
      const pool = str(x.pool)
      if (!pool) return null
      return {
        pool,
        apyBaseBorrow: num(x.apyBaseBorrow),
        apyRewardBorrow: num(x.apyRewardBorrow),
        totalSupplyUsd: num(x.totalSupplyUsd),
        totalBorrowUsd: num(x.totalBorrowUsd),
        mintedCoin: str(x.mintedCoin),
        ltv: num(x.ltv),
        underlyingTokens: strArr(x.underlyingTokens),
      }
    },
    500,
  )
}

export function parseProtocols(body: unknown): LlamaProtocol[] {
  if (!Array.isArray(body))
    throw new SourceError('defillama /protocols', 'schema: expected an array')
  return checkShape(
    'defillama /protocols',
    body,
    (x) => {
      const slug = str(x.slug)
      const name = str(x.name)
      if (!slug || !name) return null
      return { slug, name, category: str(x.category) }
    },
    1000,
  )
}

export function parseChart(body: unknown, uuid: string): ChartPoint[] {
  const b = body as { status?: unknown; data?: unknown }
  if (!b || b.status !== 'success' || !Array.isArray(b.data))
    throw new SourceError(
      `defillama /chart/${uuid}`,
      'schema: expected {status:"success", data:[]}',
    )
  return (b.data as Record<string, unknown>[]).map((p) => ({
    timestamp: String(p.timestamp ?? ''),
    apy: num(p.apy),
  }))
}

export async function fetchPools(f: typeof fetch, sleep?: Sleep): Promise<LlamaPool[]> {
  return parsePools(await getJson(f, LLAMA_POOLS_URL, 'defillama /pools', { sleep }))
}
export async function fetchLendBorrow(f: typeof fetch, sleep?: Sleep): Promise<LlamaLendBorrow[]> {
  return parseLendBorrow(await getJson(f, LLAMA_LENDBORROW_URL, 'defillama /lendBorrow', { sleep }))
}
export async function fetchProtocols(f: typeof fetch, sleep?: Sleep): Promise<LlamaProtocol[]> {
  return parseProtocols(await getJson(f, LLAMA_PROTOCOLS_URL, 'defillama /protocols', { sleep }))
}
export async function fetchChart(
  f: typeof fetch,
  uuid: string,
  sleep?: Sleep,
): Promise<ChartPoint[]> {
  if (!/^[0-9a-zA-Z-]{8,80}$/.test(uuid))
    throw new SourceError('defillama /chart', 'invalid pool id')
  return parseChart(
    await getJson(f, LLAMA_CHART_URL + uuid, `defillama /chart/${uuid}`, {
      sleep,
      timeoutMs: 30_000,
    }),
    uuid,
  )
}

const MORPHO_QUERY = `{
  v1: vaults(first: 1000, where: { chainId_in: [1], listed: true }) { items { address symbol name asset { address } state { netApy fee totalAssetsUsd } } }
  v2: vaultV2s(first: 1000, where: { chainId_in: [1], listed: true }) { items { address symbol name asset { address } netApy performanceFee totalAssetsUsd } }
  markets(first: 1000, where: { chainId_in: [1], listed: true }) { items { marketId lltv loanAsset { address symbol } collateralAsset { address symbol } state { borrowAssetsUsd } } }
}`

export async function fetchMorpho(
  f: typeof fetch,
  sleep?: Sleep,
): Promise<{ vaults: MorphoVaultInfo[]; markets: MorphoMarketInfo[] }> {
  const body = (await getJson(f, MORPHO_GRAPHQL_URL, 'morpho graphql', {
    sleep,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: MORPHO_QUERY }),
    },
  })) as {
    data?: Record<string, { items?: Record<string, unknown>[] }>
    errors?: { message?: string }[]
  }
  if (body.errors?.length)
    throw new SourceError(
      'morpho graphql',
      `errors: ${String(body.errors[0]?.message ?? '').slice(0, 200)}`,
    )
  const v1 = body.data?.v1?.items
  const v2 = body.data?.v2?.items
  const mk = body.data?.markets?.items
  if (!Array.isArray(v1) || !Array.isArray(v2) || !Array.isArray(mk))
    throw new SourceError('morpho graphql', 'schema: missing vaults/vaultV2s/markets')
  const vaults: MorphoVaultInfo[] = []
  for (const [version, items] of [
    ['v1', v1],
    ['v2', v2],
  ] as const) {
    for (const x of items) {
      const asset = x.asset as { address?: unknown } | null
      const state = (x.state ?? {}) as Record<string, unknown>
      const address = str(x.address)
      const assetAddress = str(asset?.address)
      if (!address || !assetAddress) continue
      vaults.push({
        address,
        symbol: str(x.symbol) ?? '',
        name: str(x.name) ?? '',
        assetAddress,
        version,
        netApy: version === 'v1' ? num(state.netApy) : num(x.netApy),
        fee: version === 'v1' ? num(state.fee) : num(x.performanceFee),
        totalAssetsUsd: version === 'v1' ? num(state.totalAssetsUsd) : num(x.totalAssetsUsd),
      })
    }
  }
  const markets: MorphoMarketInfo[] = []
  for (const x of mk) {
    const loan = x.loanAsset as { address?: unknown; symbol?: unknown } | null
    const coll = x.collateralAsset as { address?: unknown; symbol?: unknown } | null
    const marketId = str(x.marketId)
    const lltv =
      typeof x.lltv === 'string' || typeof x.lltv === 'number' ? Number(x.lltv) / 1e18 : NaN
    if (!marketId || !loan || !Number.isFinite(lltv)) continue
    markets.push({
      marketId,
      lltv,
      loanSymbol: str(loan.symbol) ?? '',
      loanAddress: str(loan.address) ?? '',
      collateralSymbol: str(coll?.symbol),
      collateralAddress: str(coll?.address),
      borrowAssetsUsd: num((x.state as Record<string, unknown> | null)?.borrowAssetsUsd),
    })
  }
  if (vaults.length < 10 || markets.length < 10)
    throw new SourceError(
      'morpho graphql',
      `schema: ${vaults.length} vaults / ${markets.length} markets, expected at least 10 each`,
    )
  return { vaults, markets }
}

/** Spaces calls to at most `perMinute` a minute. */
export function pacer(
  perMinute: number,
  sleep: Sleep = realSleep,
  now: () => number = Date.now,
): () => Promise<void> {
  const gap = 60_000 / perMinute
  let next = 0
  return async () => {
    const t = now()
    const wait = Math.max(0, next - t)
    next = Math.max(t, next) + gap
    if (wait > 0) await sleep(wait)
  }
}
