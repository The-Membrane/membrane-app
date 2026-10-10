// RPC plumbing for the config-card collector: Ethereum clients from RECORDER_RPC_URL, public
// clients for other chains (LayerZero metadata RPC lists), retry / pool / adaptive getLogs and a
// resumable chunk cache. Mirrors scripts/oracle-registry/collect.mjs (10k-block spans,
// concurrency 2, log scans only on the keyed Ankr endpoint with Infura as backup).
//
// URLs carry keys: nothing here ever prints one. Errors go through scrub().

import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createPublicClient, defineChain, fallback, http } from 'viem'
import { readEnv } from '../../../lib/venue-reads.mjs'
import { scrub } from '../../lib/readers.mjs'
import { EVENT_SIGS, decodeLog } from './abi.mjs'
import { writeJsonAtomic } from './files.mjs'

export { scrub }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function retry(fn, tries = 3, base = 400) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(base * 2 ** i)
    }
  }
  throw last
}

export async function pool(items, n, worker) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await worker(items[k], k)
      }
    }),
  )
  return out
}

const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}

const chainDef = (id, urls) =>
  defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  })

/** Ethereum clients: `state` (whole ring) and `logs` (keyed Ankr first, Infura backup). */
export function ethereumClients() {
  const urls = String(
    process.env.ORACLE_REGISTRY_RPC_URL || readEnv().get('RECORDER_RPC_URL') || '',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!urls.length) throw new Error('RECORDER_RPC_URL missing from .env.local')
  const logUrls = [
    ...urls.filter((u) => hostOf(u).includes('ankr')),
    ...urls.filter((u) => hostOf(u).includes('infura')),
  ]
  const mk = (list, timeout) =>
    createPublicClient({
      chain: chainDef(1, list),
      transport:
        list.length === 1
          ? http(list[0], { timeout, retryCount: 1 })
          : fallback(
              list.map((u) => http(u, { timeout, retryCount: 1 })),
              { rank: false },
            ),
      batch: { multicall: false },
    })
  // Archive reads go to the keyed endpoint first (the free tiers refuse old blocks).
  const ordered = [...logUrls, ...urls.filter((u) => !logUrls.includes(u))]
  // UQ-23: two INDEPENDENT log endpoints (no fallback between them), so an empty answer from
  // one can be asked again on the other (the shared ring can return false-empty chunks).
  // Fail-closed audit (EV-04): the pair is two DISTINCT HOSTS — `[...logUrls, ...urls]` could
  // pick one URL twice (one log URL that is also urls[0]), and an endpoint cross-checked against
  // itself confirms its own false-empty answer. No two distinct hosts: refused at startup.
  const pair = []
  for (const u of [...logUrls, ...urls])
    if (!pair.some((x) => hostOf(x) === hostOf(u))) pair.push(u)
  if (pair.length < 2)
    throw new Error(
      'RECORDER_RPC_URL needs two distinct log hosts (an empty getLogs answer is confirmed on the second; an endpoint never cross-checks itself)',
    )
  return {
    state: mk(ordered, 30_000),
    logs: mk(logUrls.length ? logUrls : urls, 45_000),
    logsPrimary: mk([pair[0]], 45_000),
    logsSecondary: mk([pair[1]], 45_000),
  }
}

/**
 * UQ-23 (2026-10-08): one getLogs range, CROSS-CHECKED. An empty answer is asked again on a
 * second, independent endpoint — the shared ring can return false-empty chunks, and a lost
 * chunk drops a log silently:
 *   primary non-empty                           → its logs
 *   primary empty or failed, secondary non-empty → the secondary's (a false-empty corrected)
 *   both answered empty                          → [] (confirmed)
 *   otherwise (a failure and no confirming empty) → throws: the caller marks the read UNREAD
 * `secondary` null: an empty primary answer cannot be confirmed — throws (fail closed).
 * Review round 10 (R-5): a primary that FAILS on the range (a result-size or range limit) is
 * split in halves, and each half is cross-checked on its own. Before, the split ran inside one
 * adaptive read and only the combined answer was checked: one false-empty half next to a
 * non-empty half was accepted, and its log lost.
 * Returns { logs, corrected } (`corrected`: a primary empty answer was false).
 * KG-6 (closed in review round 12): the second endpoint refuses any range over 10,000 blocks, so
 * it is asked in ≤ SECONDARY_LOG_SPAN pieces from the start (`secondaryLogs`). It was asked for
 * the whole range and halved through ~63 refused (and retried) requests per empty 500k chunk; one
 * failure in that cascade left the whole proposer set unread (the rsETH 0x49bd… and wstETH Linea
 * 0xd6b9… read gaps of round 12) and made a run take 47 minutes.
 */
export const SECONDARY_LOG_SPAN = 10_000
/**
 * Fail-closed audit (EV-04, 2026-10-10): the cross-check is SYMMETRIC per piece. The second
 * endpoint is read in ≤ SECONDARY_LOG_SPAN pieces; a piece it answers EMPTY is confirmed only
 * when the first endpoint answered that very range empty AND was not itself caught answering
 * false-empty on the range (some other piece non-empty) — otherwise the first endpoint is asked
 * for that piece again: [] confirms it, logs are taken, a failure throws. Before, any non-empty
 * total of the second endpoint was accepted whole: one false-empty piece next to a non-empty one
 * lost its log, with no error. A piece the second endpoint fails on throws (the range is unread).
 */
async function secondaryPieces(client, q) {
  const out = []
  const to = BigInt(q.toBlock)
  const span = BigInt(SECONDARY_LOG_SPAN)
  for (let a = BigInt(q.fromBlock); a <= to; a += span) {
    const b = a + span - 1n < to ? a + span - 1n : to
    out.push({
      fromBlock: a,
      toBlock: b,
      logs: await getLogsOnce(client, { ...q, fromBlock: a, toBlock: b }),
    })
  }
  return out
}
/** One log's identity (transaction, index); a log without them is keyed by its content. */
const logId = (l) =>
  l.transactionHash !== undefined && l.logIndex !== undefined
    ? `${String(l.transactionHash).toLowerCase()}|${BigInt(l.logIndex)}`
    : JSON.stringify(l)
const dedupeLogs = (logs) => {
  const seen = new Set()
  return logs.filter((l) => {
    const k = logId(l)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
export async function crossCheckedLogs(primary, secondary, q, depth = 0) {
  let a = null
  let aErr = null
  try {
    a = await getLogsOnce(primary, q)
  } catch (e) {
    aErr = e
  }
  if (a && a.length) return { logs: a, corrected: false }
  if (aErr) {
    const span = BigInt(q.toBlock) - BigInt(q.fromBlock)
    if (span >= 200n && depth <= 12) {
      const mid = BigInt(q.fromBlock) + span / 2n
      const x = await crossCheckedLogs(primary, secondary, { ...q, toBlock: mid }, depth + 1)
      const y = await crossCheckedLogs(primary, secondary, { ...q, fromBlock: mid + 1n }, depth + 1)
      return { logs: [...x.logs, ...y.logs], corrected: x.corrected || y.corrected }
    }
  }
  if (!secondary)
    throw aErr ?? new Error('empty getLogs answer not cross-checked (no second endpoint)')
  let pieces
  try {
    pieces = await secondaryPieces(secondary, q)
  } catch (e) {
    if (aErr) throw aErr
    throw e
  }
  // the first endpoint's empty answer is evidence for a piece only while it was not shown false
  const primaryEmptyHolds = !aErr && pieces.every((p) => !p.logs.length)
  const out = []
  let corrected = false
  for (const p of pieces) {
    if (p.logs.length) {
      out.push(...p.logs)
      if (!aErr) corrected = true
      continue
    }
    if (primaryEmptyHolds) continue // both endpoints answered this range empty
    // asked again on the first endpoint, for exactly this piece (throws when it fails)
    const again = await getLogsOnce(primary, { ...q, fromBlock: p.fromBlock, toBlock: p.toBlock })
    if (again.length) {
      out.push(...again)
      corrected = true
    }
  }
  return { logs: dedupeLogs(out), corrected }
}

/** A public client for another chain from a list of public RPC URLs (LZ metadata / chainlist). */
export function publicClient(chainId, urls) {
  return createPublicClient({
    chain: chainDef(chainId, urls),
    transport: fallback(
      urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 })),
      { rank: false },
    ),
  })
}

/** One raw eth_getLogs request (retried, never split). */
async function getLogsOnce(client, { address, topics0, fromBlock, toBlock }) {
  const hx = (n) => '0x' + BigInt(n).toString(16)
  return retry(async () => {
    const r = await client.request({
      method: 'eth_getLogs',
      params: [{ address, topics: [topics0], fromBlock: hx(fromBlock), toBlock: hx(toBlock) }],
    })
    // fail-closed audit (EV-03): null / {} is a FAILED read, never an empty answer
    if (!Array.isArray(r)) throw new Error('non-array eth_getLogs answer')
    return r
  }, 2)
}

/**
 * Raw eth_getLogs with a topic0 OR-list. (viem's getLogs has no raw `topics` parameter: passing
 * one is silently ignored and the node returns EVERY log of the addresses — measured
 * 2026-10-06, 9,372 unrelated logs for one 10k-block span of ReceiveUln302.) Splits the range
 * in half on any error (result-size limits) down to 200 blocks.
 */
export async function getLogsAdaptive(client, { address, topics0, fromBlock, toBlock }, depth = 0) {
  try {
    return await getLogsOnce(client, { address, topics0, fromBlock, toBlock })
  } catch (e) {
    const span = BigInt(toBlock) - BigInt(fromBlock)
    if (span < 200n || depth > 12) throw e
    const mid = BigInt(fromBlock) + span / 2n
    const a = await getLogsAdaptive(
      client,
      { address, topics0, fromBlock, toBlock: mid },
      depth + 1,
    )
    const b = await getLogsAdaptive(
      client,
      { address, topics0, fromBlock: mid + 1n, toBlock },
      depth + 1,
    )
    return [...a, ...b]
  }
}

/**
 * Scan [from, to] for `topics0` on `addresses` in `span`-block chunks, decode, filter with
 * `keep(row)`, and cache every CONFIRMED chunk in `cacheDir` (resumable). Returns decoded rows
 * { chainId, block, logIndex, tx, emitter, event, args }.
 *
 * Fail-closed audit (EV-01 / EV-02 / ST-03 / KG-7, 2026-10-10). Before, every chunk was one
 * `getLogsAdaptive` on one client: an empty answer was final, it was cached, and every later run
 * skipped it — a lost RoleGranted, CallScheduled, PeerSet or OwnershipTransferred left no trace.
 *   - every address group goes through `crossCheckedLogs(primary, secondary)`: non-empty, or
 *     empty on BOTH endpoints (`client` alone: an empty answer cannot be confirmed);
 *   - a requested log that does not decode is not dropped: the chunk is unconfirmed;
 *   - only confirmed chunks are cached ({ v: 2, confirmed: true }); older lines are re-read once;
 *     the key hashes the event ABIs too, so a new variant re-decodes; a chunk ending within
 *     HEAD_MARGIN blocks of `head` is never cached (a lagging log node);
 *   - an unconfirmed chunk is pushed to `gaps` ({ scan, from, to, addresses, error }) — the
 *     collector lists it as a read gap and the engine carries what it could hide — and THROWS
 *     when no `gaps` list is given (the run stops: it never reads as "no event").
 */
export const SCAN_HEAD_MARGIN = 64
const SCAN_CACHE_VERSION = 2
const ABI_HASH = createHash('sha1').update(JSON.stringify(EVENT_SIGS)).digest('hex').slice(0, 8)
export async function scanLogs({
  client,
  primary,
  secondary,
  chainId,
  addresses,
  topics0,
  from,
  to,
  head,
  span = 100_000,
  concurrency = 2,
  cacheDir,
  cacheKey,
  keep = () => true,
  onProgress,
  gaps,
  scan = 'event scan',
}) {
  const p = primary ?? client
  const sec = primary ? (secondary ?? null) : null
  const key = createHash('sha1')
    .update(
      JSON.stringify([
        chainId,
        [...addresses].map((a) => a.toLowerCase()).sort(),
        [...topics0].sort(),
        cacheKey ?? '',
        ABI_HASH,
      ]),
    )
    .digest('hex')
    .slice(0, 12)
  mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, `scan-${chainId}-${key}.jsonl`)
  const done = new Map()
  if (existsSync(file))
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const c = JSON.parse(line)
        // a chunk cached before the cross-check (no confirmed mark) is read again
        if (c.v === SCAN_CACHE_VERSION && c.confirmed === true && Array.isArray(c.rows))
          done.set(`${c.from}-${c.to}`, c.rows)
      } catch {
        /* a torn last line from a killed run: that chunk is re-scanned */
      }
    }
  const cacheBelow = Number(head ?? to) - SCAN_HEAD_MARGIN
  const chunks = []
  for (let a = from; a <= to; a += span) chunks.push([a, Math.min(to, a + span - 1)])
  const todo = chunks.filter(([a, b]) => !done.has(`${a}-${b}`))
  const wanted = new Set(topics0.map((t) => String(t).toLowerCase()))
  const unconfirmed = []
  let n = 0
  await pool(todo, concurrency, async ([a, b]) => {
    // Ankr caps the block range at 10k once a filter is too wide — addresses × topics (measured
    // 2026-10-06: 24 addresses × 43 topics × 250k blocks fine, 47 → "range exceeds limit of
    // 10000"; 2026-10-07: 20 × 72 fails, 10 × 72 and 20 × 43 pass), so wide address lists go out
    // in groups that keep addresses × topics under ~1,000.
    const per = Math.max(1, Math.min(20, Math.floor(1000 / Math.max(1, topics0.length))))
    const raw = []
    let error = null
    for (let g = 0; g < addresses.length; g += per) {
      try {
        const r = await crossCheckedLogs(p, sec, {
          address: addresses.slice(g, g + per),
          topics0,
          fromBlock: a,
          toBlock: b,
        })
        raw.push(...r.logs)
      } catch (e) {
        error = scrub(e?.shortMessage || e?.message || e)
      }
    }
    const rows = []
    let undecodable = 0
    for (const l of raw) {
      if (l.removed) continue
      const d = decodeLog(l)
      if (!d) {
        // a log of an event this scan asked for that no declared ABI shape decodes: never dropped
        if (wanted.has(String(l.topics?.[0] ?? '').toLowerCase())) undecodable++
        continue
      }
      const row = {
        chainId,
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        tx: l.transactionHash,
        emitter: l.address.toLowerCase(),
        event: d.event,
        args: d.args,
      }
      if (keep(row)) rows.push(row)
    }
    if (undecodable)
      error = [error, `${undecodable} requested log(s) not decodable`].filter(Boolean).join('; ')
    if (error) {
      unconfirmed.push({ scan, from: a, to: b, addresses: [...addresses], error })
      done.set(`${a}-${b}`, rows) // what WAS read is used this run — never cached
    } else {
      if (b <= cacheBelow)
        appendFileSync(
          file,
          JSON.stringify({ v: SCAN_CACHE_VERSION, confirmed: true, from: a, to: b, rows }) + '\n',
        )
      done.set(`${a}-${b}`, rows)
    }
    if (onProgress && ++n % 50 === 0) onProgress(n, todo.length)
  })
  if (unconfirmed.length) {
    if (!gaps)
      throw new Error(
        `${scan}: ${unconfirmed.length} chunk(s) not confirmed (${unconfirmed[0].from}–${unconfirmed[0].to}: ${unconfirmed[0].error})`,
      )
    gaps.push(...unconfirmed)
  }
  return chunks
    .flatMap(([a, b]) => done.get(`${a}-${b}`) ?? [])
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
}

/** Block timestamps for a set of blocks (cached in a JSON map under cacheDir). */
export async function blockTimestamps(client, blocks, cacheFile) {
  let cache = {}
  // fail-closed audit (ST-09): a cache that cannot be parsed is rebuilt (one torn write stopped
  // every later run), and it is written atomically
  if (cacheFile && existsSync(cacheFile))
    try {
      cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch {
      cache = {}
    }
  const missing = [...new Set(blocks)].filter((b) => cache[b] === undefined)
  await pool(missing, 4, async (b) => {
    const blk = await retry(() => client.getBlock({ blockNumber: BigInt(b) }))
    const t = Number(blk?.timestamp)
    if (!Number.isFinite(t) || t <= 0) throw new Error(`block ${b}: no timestamp in the answer`)
    cache[b] = t
  })
  if (cacheFile && missing.length) writeJsonAtomic(cacheFile, cache)
  return cache
}

/**
 * True when a viem error is the CALL reverting (the contract answered "no"), false when the
 * read itself failed (transport, timeout, rate limit) — a failed read must never be taken as
 * a revert (fail closed: "not read", not "reverted").
 *
 * Fail-closed audit (RPC-REVERT, 2026-10-10): viem's getContractError turns ANY JSON-RPC error
 * with code -32603 ("Internal error", "upstream request timeout") into a
 * ContractFunctionRevertedError, and its node-error matcher builds an ExecutionRevertedError for
 * "gas required exceeds allowance". Both read as reverts: a route closed, a library "absent", a
 * simulation "stale". A revert is now: code 3, non-empty revert data, or an "execution reverted"
 * error that is NOT an internal error without data; a gas-cap / out-of-gas answer never is.
 */
export function isRevertError(e) {
  let named = false
  let internal = false
  let data = null
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    const name = String(x.name ?? '')
    const text = `${x.details ?? ''}\n${x.shortMessage ?? ''}\n${x.message ?? ''}`
    if (/gas required exceeds allowance|out of gas/i.test(text)) return false
    if (/HttpRequestError|TimeoutError|WebSocketRequestError|LimitExceeded/.test(name)) return false
    const d = revertDataOf(x)
    if (d) data = d
    if (x.code === -32603 || /InternalRpcError/.test(name)) internal = true
    else if (x.code === 3) named = true
    if (/ContractFunctionRevertedError|ExecutionRevertedError|RawContractError/.test(name))
      named = true
    if (/execution reverted/i.test(String(x.details ?? x.shortMessage ?? ''))) named = true
  }
  if (data) return true
  if (internal) return false
  return named
}

/** Non-empty revert data (0x + at least a selector) carried by one error of a viem chain. */
function revertDataOf(x) {
  for (const v of [x.raw, x.data, x.data?.data])
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v.toLowerCase()
  return null
}

/** The 4-byte selector of the revert data in a viem error chain (null = none carried). */
export function revertSelectorOf(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    const d = revertDataOf(x)
    if (d) return d.slice(0, 10)
  }
  return null
}

/**
 * eth_call helper that never throws: { ok, value } | { ok: false, error, reverted, revertSelector }.
 * `revertSelector` (fail-closed audit LZ-05 / LZ-07): the custom error a revert carried, so a
 * caller can accept a revert as a FACT only when it is the error it expects.
 */
export async function tryRead(client, address, abi, functionName, args = [], blockNumber) {
  try {
    const value = await retry(
      () =>
        client.readContract({
          address,
          abi,
          functionName,
          args,
          blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
        }),
      2,
      300,
    )
    return { ok: true, value }
  } catch (e) {
    const reverted = isRevertError(e)
    return {
      ok: false,
      error: scrub(e?.shortMessage || e?.message || e),
      reverted,
      ...(reverted ? { revertSelector: revertSelectorOf(e) } : {}),
    }
  }
}

/**
 * Code at an address (null = no code). Fail-closed audit (CL-01): viem maps "0x" to undefined but
 * passes a JSON-RPC `null` through — a node that cannot serve the block. That is a FAILED read
 * (it throws), never "no code": a false EOA turned a downgrade into an upgrade, lowered the
 * weakest-holder bar and moved code bisections.
 */
export async function codeAt(client, address, blockNumber) {
  const c = await retry(
    async () => {
      const x = await client.getCode({
        address,
        blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
      })
      if (x === null) throw new Error(`eth_getCode of ${address} answered null (not served)`)
      if (x !== undefined && typeof x !== 'string')
        throw new Error(`eth_getCode of ${address} answered a non-string`)
      return x
    },
    3,
    300,
  )
  return c && c !== '0x' ? c : null
}
