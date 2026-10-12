// Holder concentration of a voting token (owner ruling 2026-10-08, UQ-17): a token vote ranks by
// how many of its token's largest holders can pass a vote alone. This module rebuilds the
// holder set at any number of blocks in ONE streaming pass over the token's Transfer logs, and
// keeps only the top holders of each requested block (disk is tight: no raw logs and no full
// balance map are ever written).
//
//   holderSnapshots(...) → Map(block → { supply, holderCount, top: [[address, balance], …] }
//                                     | { error })
//
// Fail closed, at every step:
//   - every empty log chunk is asked again on a second endpoint (`crossCheckedLogs`; the shared
//     ring can return false-empty chunks); a chunk that cannot be read is retried with backoff,
//     and if it still fails its RANGE is recorded as unread and the stream goes on (lane T,
//     2026-10-11: one failed chunk used to stop the whole ~15M-block LDO stream). Every snapshot
//     at or after the first unread range is an error that names the unread ranges (a read gap:
//     the vote ranks as a plain contract) — its balances depend on them;
//   - every snapshot is VERIFIED on chain at its block (archive eth_call): the rebuilt total
//     supply must equal totalSupply() and EVERY kept (top-50) rebuilt balance must equal
//     balanceOf() — a lost chunk changes them. A mismatch, or a read that fails, is an error.
// Only verified snapshots are cached (top-50 per token per block), written atomically; a cache
// file that cannot be parsed is rebuilt, not a stop (fail-closed audit TV-15: one torn write
// stopped every later run).
// Resume (lane T): the balances after the last chunk of the CONFIRMED PREFIX (every chunk from
// the start read, none unread before it, at least CHECKPOINT_MARGIN blocks below the last block
// asked) are checkpointed in the same cache, every CHECKPOINT_EVERY chunks and where the prefix
// ends (before the first chunk past it is applied: the saved balances are those AT its block). A
// later run whose blocks all lie after it streams from there — after the checkpoint itself is
// VERIFIED on chain like a snapshot (totalSupply() and the top-50 balanceOf() at its block); an
// unverified checkpoint is dropped and the stream starts over. Every snapshot built on it is
// verified as before, and a failed verification drops the checkpoint too.

import { existsSync, readFileSync } from 'fs'
import { keccak256, parseAbi, toHex } from 'viem'
import { writeJsonAtomic } from './files.mjs'
import { crossCheckedLogs, describeRpcError, retryRpc } from './rpc.mjs'

export const TOP_HOLDERS = 50
/** Tries of one chunk's whole cross-checked read (each getLogs inside retries on its own). */
export const HOLDER_CHUNK_TRIES = 3
/** The checkpoint stays this far below the last block asked (a lagging log node near head). */
export const CHECKPOINT_MARGIN = 64
/** Chunks between two checkpoint writes (a run cut short keeps its progress). */
export const CHECKPOINT_EVERY = 100
/**
 * After this many chunks in a row fail (an endpoint down or out of quota), the rest of the
 * stream is recorded as ONE unread range without asking (each failed chunk costs its full backoff;
 * a down host would otherwise hold the run for hours). Fail closed either way.
 */
export const HOLDER_MAX_CONSECUTIVE_FAILURES = 8
const CHECKPOINT_VERSION = 1
/**
 * Balances re-read on chain at each snapshot block (the cross-check of the rebuilt set).
 * Fail-closed audit (TV-16 / ST-09, 2026-10-10): every kept holder — the rules decide k and the
 * passing set from ranks up to 50, and only the ten largest were checked, so a lost transfer could
 * leave a wrong rank-11+ balance cached for good.
 */
export const VERIFY_TOP = TOP_HOLDERS
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'))
const ZERO = '0x0000000000000000000000000000000000000000'
const ERC20 = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

/** The `n` largest positive balances of a map, largest first (ties by address, for stability). */
export function topBalances(balances, n = TOP_HOLDERS) {
  const top = [] // ascending by balance; top[0] is the smallest kept
  for (const [a, b] of balances) {
    if (b <= 0n) continue
    if (top.length === n && b < top[0][1]) continue
    // insertion into a small sorted array
    let i = 0
    while (i < top.length && (top[i][1] < b || (top[i][1] === b && top[i][0] > a))) i++
    top.splice(i, 0, [a, b])
    if (top.length > n) top.shift()
  }
  return top.reverse()
}

/** Apply one Transfer log to the balance map; returns the supply delta (mint +, burn −). */
export function applyTransfer(balances, log) {
  if (!log.topics || log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER) return 0n
  const from = ('0x' + log.topics[1].slice(-40)).toLowerCase()
  const to = ('0x' + log.topics[2].slice(-40)).toLowerCase()
  const v = BigInt(log.data === '0x' ? 0 : log.data)
  if (v === 0n || from === to) return 0n
  let d = 0n
  if (from === ZERO) d += v
  else balances.set(from, (balances.get(from) ?? 0n) - v)
  if (to === ZERO) d -= v
  else balances.set(to, (balances.get(to) ?? 0n) + v)
  return d
}

/** A verification that could not be READ (not a mismatch). */
const readFailed = (why) => String(why).startsWith('verification read failed')

/**
 * Verify one rebuilt snapshot at its block: totalSupply() and the VERIFY_TOP largest balances.
 * Returns null when every value matches, else why not (fail closed: a failed read is a mismatch).
 */
export async function verifySnapshot(state, token, block, snap) {
  try {
    const top = snap.top.slice(0, VERIFY_TOP)
    // one eth_call each (not Multicall3: it does not exist before block 14,353,601, and a voting
    // token's history starts earlier — LDO in 2020)
    const read = (functionName, args = []) =>
      retryRpc(() =>
        state.readContract({
          address: token,
          abi: ERC20,
          functionName,
          args,
          blockNumber: BigInt(block),
        }),
      )
    const [supply, ...bals] = await Promise.all([
      read('totalSupply'),
      ...top.map(([a]) => read('balanceOf', [a])),
    ])
    if (BigInt(supply) !== BigInt(snap.supply))
      return `rebuilt supply ${snap.supply} ≠ totalSupply() ${supply}`
    for (const [i, [a, b]] of top.entries())
      if (BigInt(bals[i]) !== BigInt(b)) return `rebuilt balance of ${a} ≠ balanceOf() at the block`
    return null
  } catch (e) {
    return `verification read failed (${describeRpcError(e).slice(0, 80)})`
  }
}

/**
 * Snapshots of `token`'s holders at each of `blocks` (state AFTER the block), rebuilt from its
 * Transfer logs from `from` (its first block with code). Cached snapshots are reused; the stream
 * runs only when a block is missing, and covers every missing block in one pass.
 *   logClients  { primary, secondary }  two independent log endpoints (cross-checked chunks)
 *   state       an archive client (verification)
 */
export async function holderSnapshots({
  logClients,
  state,
  token,
  from,
  blocks,
  cacheFile = null,
  span = 20_000,
  concurrency = 4,
  log = () => {},
}) {
  const t = token.toLowerCase()
  let cache = {}
  if (cacheFile && existsSync(cacheFile))
    try {
      cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch (e) {
      log(`  holder cache unreadable (${String(e?.message ?? e).slice(0, 60)}): rebuilt`)
      cache = {}
    }
  const out = new Map()
  const want = [...new Set(blocks.map(Number))].sort((a, b) => a - b)
  for (const b of want) {
    const c = cache[`${t}@${b}`]
    if (!c) continue
    // a snapshot cached under a shallower check (VERIFY_TOP was 10) is verified again
    if ((c.verifiedTop ?? 0) >= Math.min(VERIFY_TOP, c.top?.length ?? 0)) out.set(b, c)
    else if (state && !(await verifySnapshot(state, t, b, c))) {
      const v = { ...c, verifiedTop: Math.min(VERIFY_TOP, c.top?.length ?? 0) }
      cache[`${t}@${b}`] = v
      out.set(b, v)
    } else delete cache[`${t}@${b}`]
  }
  const todo = want.filter((b) => !out.has(b))
  if (!todo.length) return out
  const last = todo.at(-1)
  const balances = new Map()
  let supply = 0n
  // lane T: resume from a verified checkpoint when every block asked lies after it
  let start = from
  const ckKey = `${t}@checkpoint`
  const ck = cache[ckKey]
  if (ck) {
    const usable =
      ck.v === CHECKPOINT_VERSION &&
      ck.from === from &&
      Number.isInteger(ck.block) &&
      ck.block >= from &&
      ck.block < todo[0] &&
      Array.isArray(ck.balances) &&
      typeof ck.supply === 'string'
    let bad = usable ? null : 'not usable for these blocks'
    let m = null
    if (usable)
      try {
        m = new Map(ck.balances.map(([a, v]) => [String(a), BigInt(v)]))
        const top = topBalances(m).map(([a, v]) => [a, v.toString()])
        bad = state
          ? await verifySnapshot(state, t, ck.block, { supply: ck.supply, top })
          : 'not verified (no archive client)'
      } catch (e) {
        bad = `unreadable (${String(e?.message ?? e).slice(0, 60)})`
      }
    if (!bad) {
      for (const [a, v] of m) balances.set(a, v)
      supply = BigInt(ck.supply)
      start = ck.block + 1
      log(`  holders of ${t.slice(0, 10)}…: resumed from the checkpoint at block ${ck.block}`)
    } else if ((usable && !readFailed(bad)) || ck.from !== from || ck.v !== CHECKPOINT_VERSION) {
      // a checkpoint that does NOT MATCH the chain (or of another stream start) is dropped; one
      // whose verification read failed, or that is merely later than a block asked now, is not
      // used this run and kept for the next
      delete cache[ckKey]
      log(`  holders of ${t.slice(0, 10)}…: checkpoint at ${ck.block} dropped (${bad})`)
    }
  }
  const chunks = []
  for (let a = start; a <= last; a += span) chunks.push([a, Math.min(last, a + span - 1)])
  let next = 0 // index into todo
  let corrected = 0
  // lane T: one chunk's cross-checked read, retried with the same backoff as every RPC read
  const fetchChunk = ([a, b]) =>
    retryRpc(
      () =>
        crossCheckedLogs(logClients.primary, logClients.secondary, {
          address: t,
          topics0: [TRANSFER],
          fromBlock: a,
          toBlock: b,
        }),
      { tries: HOLDER_CHUNK_TRIES },
    )
  const snapshotUpTo = (block) => {
    while (next < todo.length && todo[next] <= block) {
      const top = topBalances(balances)
      let holderCount = 0
      for (const v of balances.values()) if (v > 0n) holderCount++
      out.set(todo[next], {
        supply: supply.toString(),
        holderCount,
        top: top.map(([a, v]) => [a, v.toString()]),
      })
      next++
    }
  }
  // the confirmed prefix: balances after chunk end `ckAt` (no unread chunk at or before it)
  let ckAt = null
  let ckDirty = false
  // the block through which `balances` / `supply` have been applied (review of lane T: the
  // checkpoint used to be saved after the loop with the balances of the WHOLE stream — the tail
  // chunk above the margin, every chunk after an unread one — labelled `ckAt`; a resume then
  // applied those transfers twice). A checkpoint is written only while the two agree: once, just
  // before the first chunk that does not extend the prefix changes anything.
  let appliedTo = start - 1
  const ckLimit = last - CHECKPOINT_MARGIN
  const saveCheckpoint = () => {
    if (ckAt === null || !ckDirty || appliedTo !== ckAt) return
    const bal = []
    for (const [a, v] of balances) if (v !== 0n) bal.push([a, v.toString()])
    cache[ckKey] = {
      v: CHECKPOINT_VERSION,
      from,
      block: ckAt,
      supply: supply.toString(),
      balances: bal,
    }
    ckDirty = false
    if (cacheFile) writeJsonAtomic(cacheFile, cache)
  }
  const t0 = Date.now()
  const inflight = new Map()
  const unread = [] // { from, to, error } in block order
  let failedInRow = 0
  for (let i = 0; i < chunks.length; i++) {
    if (failedInRow >= HOLDER_MAX_CONSECUTIVE_FAILURES) {
      // the rest of the stream: one unread range, not asked (fail closed)
      unread.push({
        from: chunks[i][0],
        to: last,
        error: `not asked: ${failedInRow} chunks in a row failed (last: ${unread.at(-1).error})`,
      })
      snapshotUpTo(last)
      break
    }
    for (let j = i; j < Math.min(chunks.length, i + concurrency); j++)
      if (!inflight.has(j))
        inflight.set(
          j,
          fetchChunk(chunks[j]).catch((e) => ({ error: e })),
        )
    const r = await inflight.get(i)
    inflight.delete(i)
    const [a, b] = chunks[i]
    // a chunk that will not extend the confirmed prefix (unread, after an unread one, or above
    // the margin): the prefix ends here — checkpoint it BEFORE this chunk changes the balances
    const extendsPrefix = !r.error && !unread.length && b <= ckLimit
    if (!extendsPrefix) saveCheckpoint()
    if (r.error) {
      // lane T: the range is UNREAD (every snapshot at or after it fails closed below); the
      // stream goes on, so later ranges are read and only this one is missing
      unread.push({ from: a, to: b, error: describeRpcError(r.error) })
      failedInRow++
      snapshotUpTo(b)
      continue
    }
    failedInRow = 0
    if (r.corrected) corrected++
    const logs = r.logs
      .filter((l) => !l.removed)
      .sort(
        (x, y) =>
          Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) ||
          Number(BigInt(x.logIndex) - BigInt(y.logIndex)),
      )
    // snapshots strictly before this chunk's first log block
    snapshotUpTo(a - 1)
    for (const l of logs) {
      const lb = Number(BigInt(l.blockNumber))
      snapshotUpTo(lb - 1)
      supply += applyTransfer(balances, l)
    }
    appliedTo = b
    snapshotUpTo(b)
    if (extendsPrefix) {
      ckAt = b
      ckDirty = true
      if (i % CHECKPOINT_EVERY === CHECKPOINT_EVERY - 1) saveCheckpoint()
    }
    if (i % 100 === 99)
      log(
        `  holders of ${t.slice(0, 10)}…: ${i + 1}/${chunks.length} chunks, ${balances.size} accounts, ${Math.round((Date.now() - t0) / 1000)} s`,
      )
  }
  // drain (nothing should be left in flight)
  await Promise.allSettled([...inflight.values()])
  if (corrected) log(`  holders of ${t.slice(0, 10)}…: ${corrected} false-empty chunk(s) corrected`)
  if (unread.length)
    log(
      `  holders of ${t.slice(0, 10)}…: ${unread.length} of ${chunks.length} chunk(s) unread (${unread[0].from}–${unread[0].to}: ${unread[0].error})`,
    )
  saveCheckpoint()
  let ckFailed = false
  for (const b of todo) {
    const before = unread.filter((g) => g.from <= b)
    if (before.length) {
      const shown = before
        .slice(0, 3)
        .map((g) => `${g.from}–${g.to}`)
        .join(', ')
      const more = before.length > 3 ? ` and ${before.length - 3} more` : ''
      out.set(b, {
        error: `Transfer logs not read from block ${before[0].from} (unread: ${shown}${more}; ${before[0].error})`,
        unread: before,
      })
      continue
    }
    const snap = out.get(b)
    if (!snap) {
      out.set(b, { error: 'snapshot not rebuilt' })
      continue
    }
    const bad = state ? await verifySnapshot(state, t, b, snap) : 'not verified (no archive client)'
    if (bad) {
      out.set(b, { error: `holder set not verified at block ${b}: ${bad}` })
      // a snapshot that does not MATCH the chain: a transfer was lost somewhere before it, maybe
      // inside the checkpointed prefix — the checkpoint is dropped (the next run starts over)
      if (!readFailed(bad)) ckFailed = true
    } else cache[`${t}@${b}`] = { ...snap, verifiedTop: Math.min(VERIFY_TOP, snap.top.length) }
  }
  if (ckFailed) delete cache[ckKey]
  if (cacheFile) writeJsonAtomic(cacheFile, cache)
  return out
}
