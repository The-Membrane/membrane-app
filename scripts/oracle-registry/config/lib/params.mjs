// Mint/redeem getters on an archive grid, bisected to the exact block of every change.
//
// Several issuers change caps without an event (Ethena's setGlobalMaxRedeemPerBlock emits
// none), so the getters themselves are the history: a weekly grid over the look-back window,
// then bisection between the two grid points that differ (log2(50,400) ≈ 16 multicalls per
// change). A change between grid points that is reverted before the next point (A→B→A within a
// week) is invisible to this method — events are the only way to see those (documented gap).

import { fnAbi } from './abi.mjs'
import { isRevertError, pool, retry } from './rpc.mjs'

const norm = (v) => {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase()
  return v
}

/**
 * A Wormhole NTT TrimmedAmount (uint72 = amount (uint64) << 8 | decimals (uint8)) in base units
 * of a token with `tokenDecimals` decimals, as a decimal string: the NTT rate limits are stored
 * trimmed (wstETH → BNB: 768000000000008 = 3,000,000,000,000 at 8 decimals = 30,000 wstETH).
 * undefined when the input is not an integer or the decimals are not.
 */
export function decodeTrimmedAmount(raw, tokenDecimals) {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0) return undefined
  let x
  try {
    x = BigInt(raw)
  } catch {
    return undefined
  }
  if (x < 0n) return undefined
  const d = Number(x & 0xffn)
  const amount = x >> 8n
  return d <= tokenDecimals
    ? (amount * 10n ** BigInt(tokenDecimals - d)).toString()
    : (amount / 10n ** BigInt(d - tokenDecimals)).toString()
}

/**
 * Review round 9: subject-scoped param keys. Two subjects can declare the same key on DIFFERENT
 * contracts (weETH and wstETH both declare `oracleQuorum` / `oracleMembers`; WBTC and cbBTC both
 * `paused`). The collector reads every subject in one multicall pass, and `readParams` /
 * `paramTransitions` key their results by `key` alone, so the later subject's value overwrote
 * the earlier one's: weETH's EtherFiOracle quorum 3 / 3 members read as wstETH's HashConsensus
 * 5 / 9, and weETH's real quorum change 2 → 3 at 25,626,145 vanished. The collector reads under
 * `<subject>::<key>` and hands each subject its own slice with the plain keys.
 */
export const PARAM_SCOPE_SEP = '::'

export function scopedParamSpecs(subjects) {
  return subjects.flatMap((s) =>
    (s.params ?? []).map((p) => ({ ...p, key: `${s.key}${PARAM_SCOPE_SEP}${p.key}` })),
  )
}

/** One subject's slice of a scoped `paramTransitions` result, with its plain keys. */
export function paramsForSubject(params, subjectKey) {
  const pre = `${subjectKey}${PARAM_SCOPE_SEP}`
  const strip = (k) => k.slice(pre.length)
  return {
    head: Object.fromEntries(
      Object.entries(params.head ?? {})
        .filter(([k]) => k.startsWith(pre))
        .map(([k, v]) => [strip(k), v]),
    ),
    transitions: (params.transitions ?? [])
      .filter((t) => t.key.startsWith(pre))
      .map((t) => ({ ...t, key: strip(t.key) })),
    // fail-closed audit (PO-01..03): the reads that failed, and the window start
    unread: (params.unread ?? [])
      .filter((u) => u.key.startsWith(pre))
      .map((u) => ({ ...u, key: strip(u.key) })),
    ...(params.from !== undefined ? { from: params.from } : {}),
  }
}

/** "The getter is not there" (it reverts, or returns no / short data): a fact, not a failed read. */
const isAbsent = (e) => {
  if (!e) return true // a failure with no error (test fakes, old callers): absent
  if (isRevertError(e)) return true
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++)
    if (
      /ContractFunctionZeroDataError|AbiDecodingZeroDataError|AbiDecodingDataSizeTooSmallError|PositionOutOfBoundsError/.test(
        String(x.name ?? ''),
      )
    )
      return true
  return false
}

/**
 * Read every spec at one block with Multicall3: { values: key → value, unread: key → reason }.
 * Fail-closed audit (PO-01, 2026-10-10): viem returns a REJECTED multicall chunk (a timeout, a
 * 429, an archive refusal) as a per-call failure and does not throw, so retry() never fired and
 * every value came back `undefined` — the same as a getter that reverts. A failure that is not
 * "the getter is not there" is retried (that subset, twice) and, still failing, is UNREAD.
 */
export async function readParamsDetailed(client, specs, block) {
  const live = specs.filter((s) => !s.eventsOnly && s.sig)
  const values = {}
  const unread = {}
  let todo = live
  for (let attempt = 0; attempt < 3 && todo.length; attempt++) {
    const res = await retry(() =>
      client.multicall({
        contracts: todo.map((s) => {
          const abi = fnAbi(s.sig)
          return { address: s.contract, abi, functionName: abi[0].name, args: s.args ?? [] }
        }),
        allowFailure: true,
        blockNumber: block === undefined ? undefined : BigInt(block),
      }),
    )
    const again = []
    todo.forEach((s, i) => {
      const r = res[i]
      if (r?.status !== 'success') {
        if (isAbsent(r?.error)) return
        again.push(s)
        unread[s.key] = String(r?.error?.shortMessage ?? r?.error?.message ?? 'read failed').slice(
          0,
          80,
        )
        return
      }
      delete unread[s.key]
      const v = Array.isArray(r.result) ? r.result[s.outputIndex ?? 0] : r.result
      if (s.count) {
        // `count`: a getter returning a list (HashConsensus getMembers()) is judged on its length
        // (a single-list output arrives as the list itself, several outputs as a tuple)
        const list = fnAbi(s.sig)[0].outputs.length > 1 ? v : r.result
        values[s.key] = Array.isArray(list) ? list.length : undefined
      } else if (s.decode === 'trimmed_amount') values[s.key] = decodeTrimmedAmount(v, s.decimals)
      else values[s.key] = norm(v)
    })
    todo = again
  }
  return { values, unread }
}

/** Read every spec at one block with Multicall3. Returns key → value (undefined on failure). */
export async function readParams(client, specs, block) {
  return (await readParamsDetailed(client, specs, block)).values
}

const same = (a, b) => (a === undefined || b === undefined ? true : String(a) === String(b))

/**
 * Every value change of a getter between two reads (`lo` reads `before`, `hi` reads `last`),
 * each bisected to its exact block and carrying the value read THERE — a pair of changes
 * between two grid points (A → B → C) stays two changes, never one merged A → C row.
 * `read(block)` returns the value (undefined when unreadable).
 *
 * Fail-closed audit (PO-02, 2026-10-10): an unread midpoint is NEVER "unchanged" — it moved the
 * bracket past the real change and merged A → B → C into one exact-looking A → C (B never
 * judged). The neighbours m − 1 / m + 1 are tried; all unread, the bracket is emitted UNRESOLVED
 * ({ unresolved: true }: the change is somewhere in (blockFrom, block], intermediate values not
 * read — judged fail closed) and the search goes on from its end.
 */
export async function bisectChanges(read, { lo, before, hi, last }) {
  const out = []
  let from = lo
  let prev = before
  let guard = 0
  while (!same(prev, last) && guard++ < 64) {
    let a = from
    let b = hi
    let atB = last
    let unresolved = false
    while (b - a > 1) {
      let m = Math.floor((a + b) / 2)
      let x = await read(m)
      if (x === undefined)
        for (const n of [m - 1, m + 1]) {
          if (n <= a || n >= b) continue
          const y = await read(n)
          if (y !== undefined) {
            m = n
            x = y
            break
          }
        }
      if (x === undefined) {
        unresolved = true
        break
      }
      if (same(x, prev)) a = m
      else {
        b = m
        atB = x
      }
    }
    out.push({
      block: b,
      blockFrom: a,
      before: prev,
      after: atB,
      ...(unresolved ? { unresolved: true } : {}),
    })
    from = b
    prev = atB
  }
  return out
}

/**
 * Transitions of every spec over [from, head] on a `step`-block grid, each bisected to the
 * first block that reads the new value. Fail-closed audit (PO-03): a grid point (or the head)
 * that was NOT READ is reported in `unread` ({ key, block, reason }) — a change between the
 * points around it cannot be ruled out (it was skipped silently: an excursion there vanished).
 */
export async function paramTransitions(
  client,
  specs,
  { from, head, step = 50_400, log = () => {} },
) {
  const grid = []
  for (let b = from; b < head; b += step) grid.push(b)
  grid.push(head)
  const reads = await pool(grid, 3, (b) => readParamsDetailed(client, specs, b))
  log(`  params: ${grid.length} grid reads`)
  const out = []
  const unread = []
  for (const s of specs.filter((x) => !x.eventsOnly && x.sig)) {
    let lastIdx = -1
    for (let i = 0; i < grid.length; i++) {
      if (reads[i].unread[s.key] !== undefined) {
        unread.push({ key: s.key, block: grid[i], reason: reads[i].unread[s.key] })
        continue
      }
      const v = reads[i].values[s.key]
      if (v === undefined) continue
      if (lastIdx >= 0 && !same(reads[lastIdx].values[s.key], v)) {
        const steps = await bisectChanges(
          async (m) => {
            const r = await readParamsDetailed(client, [s], m)
            return r.values[s.key]
          },
          {
            lo: grid[lastIdx],
            before: reads[lastIdx].values[s.key],
            hi: grid[i],
            last: v,
          },
        )
        for (const t of steps) {
          out.push({ key: s.key, contract: s.contract, ...t })
          if (t.unresolved)
            unread.push({
              key: s.key,
              from: t.blockFrom,
              to: t.block,
              reason: 'a bisection read failed: intermediate values not read',
            })
        }
      }
      lastIdx = i
    }
  }
  return { transitions: out, head: reads[reads.length - 1].values, unread, from }
}

/**
 * The transaction at `block` that set `contract`'s getter to `value`: among the transactions
 * whose logs from the contract name the value (an address topic / word, or the number), the
 * only one; else the only transaction that touched the contract; else none (never a guess —
 * the FIRST log of the block can be an unrelated change of another getter).
 */
export function pickTx(logs, value) {
  const txs = [...new Set(logs.map((l) => l.transactionHash))]
  if (value !== undefined && value !== null) {
    const v = String(value).toLowerCase()
    const word = /^0x[0-9a-f]{40}$/.test(v)
      ? v.slice(2).padStart(64, '0')
      : /^\d+$/.test(v)
        ? BigInt(v).toString(16).padStart(64, '0')
        : null
    if (word) {
      const hit = [
        ...new Set(
          logs
            .filter((l) =>
              [
                ...(l.topics ?? []).slice(1),
                ...(String(l.data ?? '')
                  .slice(2)
                  .match(/.{64}/g) ?? []),
              ]
                .map((x) => String(x).toLowerCase().replace(/^0x/, ''))
                .includes(word),
            )
            .map((l) => l.transactionHash),
        ),
      ]
      if (hit.length === 1) return hit[0]
      if (hit.length > 1) return null
    }
  }
  return txs.length === 1 ? txs[0] : null
}

export async function txAtBlock(client, contract, block, value) {
  const hx = '0x' + block.toString(16)
  const logs = await retry(() =>
    client.request({
      method: 'eth_getLogs',
      params: [{ address: contract, fromBlock: hx, toBlock: hx }],
    }),
  )
  return pickTx(logs ?? [], value)
}
