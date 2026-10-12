// archiveRpc.mjs — keyless archive endpoints per chain, and small read helpers, for the
// research builders that read history on chain (build-position-alert-e2-offmorpho.mjs,
// build-governance-changes.mjs). Never reads .env files: every endpoint here is public.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const toHex = (n) => '0x' + BigInt(n).toString(16)

/** Keyless archive endpoints, tested 2026-10-11 at the Nov 2 2025 block. */
export const RPC = {
  // No relay RPCs: they can answer eth_getLogs with a false or short result (board R33, R34).
  // BlockPI: eth_getLogs up to 5,000 blocks. drpc's free plan refuses historical eth_getLogs
  // (tested 2026-10-12) but answers eth_call.
  1: [
    'https://mainnet.gateway.tenderly.co',
    'https://ethereum.public.blockpi.network/v1/rpc/public',
    'https://eth.drpc.org',
  ],
  42161: ['https://arbitrum.gateway.tenderly.co', 'https://arbitrum-one.public.blastapi.io'],
  43114: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.gateway.tenderly.co'],
  146: ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com'],
  9745: ['https://rpc.plasma.to'],
}

/** Largest eth_getLogs block span each chain's endpoints accepted. */
export const LOG_SPAN = { 1: 4_500, 42161: 400_000, 43114: 400_000, 146: 2_000_000, 9745: 9_000 }

/** Endpoints that accept a larger eth_getLogs span than their chain's default. */
export const LOG_SPAN_BY_URL = { 'https://mainnet.gateway.tenderly.co': 500_000 }

/** Sample times read at once per chain. Avalanche archive calls take ~6 s each on its public RPC. */
export const SAMPLE_CONCURRENCY = { 1: 2, 42161: 2, 43114: 8, 146: 2, 9745: 2 }

const cursor = {}

/** One JSON-RPC call, rotating endpoints on error with backoff. */
export async function rpc(chainId, method, params, tries = 10) {
  const urls = RPC[chainId]
  if (!urls) throw new Error(`no RPC for chain ${chainId}`)
  let last
  for (let i = 0; i < tries; i++) {
    const url = urls[((cursor[chainId] ?? 0) + i) % urls.length]
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(90_000),
      })
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200))
      return j.result
    } catch (e) {
      last = e
      cursor[chainId] = ((cursor[chainId] ?? 0) + 1) % urls.length
      await sleep(800 * (i + 1))
    }
  }
  throw new Error(`${chainId} ${method}: ${last?.message}`)
}

/**
 * eth_getLogs over [fromBlock, toBlock] in chunks of the chain's span. An endpoint can answer
 * a range with a false `[]` (board R33), so a chunk is never split or skipped silently: a
 * failing chunk throws after the retries.
 */
export async function logs(chainId, address, topics, fromBlock, toBlock, span = LOG_SPAN[chainId]) {
  const found = []
  for (let b = fromBlock; b <= toBlock; b += span) {
    const e = Math.min(toBlock, b + span - 1)
    found.push(
      ...(await rpc(chainId, 'eth_getLogs', [
        { address, topics, fromBlock: toHex(b), toBlock: toHex(e) },
      ])),
    )
    if (chainId === 9745 || chainId === 1) await sleep(120)
  }
  return found
}

const tsCache = {}
/** Timestamp of a block (cached). */
export async function blockTimestamp(chainId, block) {
  const k = `${chainId}:${block}`
  if (!(k in tsCache)) {
    const b = await rpc(chainId, 'eth_getBlockByNumber', [toHex(block), false])
    tsCache[k] = Number(b.timestamp)
  }
  return tsCache[k]
}

/** First block with timestamp >= ts (binary search). */
export async function blockAtTime(chainId, ts) {
  let hi = Number(await rpc(chainId, 'eth_blockNumber', []))
  let lo = 1
  if ((await blockTimestamp(chainId, hi)) < ts) return hi
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await blockTimestamp(chainId, mid)) >= ts) hi = mid
    else lo = mid + 1
  }
  return lo
}
