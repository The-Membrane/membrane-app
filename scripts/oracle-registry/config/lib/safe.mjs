// Safe Transaction Service (public API) — the off-chain queue of a Safe = PROPOSED changes.
//
// Unauthenticated use is 2 requests/s and 5,000 requests per 30 days (measured 2026-10-05:
// x-ratelimit-limit 5000, reset ≈ 2.59M s). One request per Safe per run, spaced 700 ms; any
// non-200 (429 included) marks that Safe 'unavailable' — never "nothing pending". Only
// proposals submitted through the API are visible at all.

import { getAddress } from 'viem'
import { sleep } from './rpc.mjs'

export const SAFE_API = 'https://api.safe.global/tx-service/eth/api/v1'

/** Pages of the Safe Tx Service followed per Safe (25 proposals each) before "truncated". */
export const SAFE_MAX_PAGES = 8
const PAGE = 25

/**
 * One API row as a SafeProposal, or null when it is malformed (fail-closed audit SQ-03: a missing
 * `operation` was judged as a CALL — a DELEGATECALL then dropped; missing confirmations read 0, so
 * a fully signed proposal was not ARMED; a missing nonce made colliding ids).
 */
function rowOf(safe, t) {
  const nonce = Number(t?.nonce)
  const op = Number(t?.operation)
  if (
    !t ||
    !Number.isInteger(nonce) ||
    typeof t.to !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(t.to) ||
    typeof t.safeTxHash !== 'string' ||
    !(t.operation === 0 || t.operation === 1 || op === 0 || op === 1) ||
    t.operation === null ||
    t.operation === undefined ||
    !Array.isArray(t.confirmations) ||
    !Number.isInteger(Number(t.confirmationsRequired)) ||
    t.confirmationsRequired === null ||
    t.confirmationsRequired === undefined
  )
    return null
  return {
    safe: safe.toLowerCase(),
    nonce,
    to: String(t.to).toLowerCase(),
    value: String(t.value ?? '0'),
    data: t.data ?? null,
    confirmations: t.confirmations.length,
    confirmationsRequired: Number(t.confirmationsRequired),
    submissionDate: t.submissionDate,
    safeTxHash: t.safeTxHash,
    // 0 CALL, 1 DELEGATECALL — a delegatecall runs the target's code AS the Safe (review round 6)
    operation: op,
  }
}

/**
 * The unexecuted proposals of a Safe from its on-chain nonce on. Fail-closed audit (SQ-03 /
 * SQ-04, 2026-10-10): the answer is VALIDATED (a `results` list, an integer `count`, every row
 * whole) and FOLLOWED page by page (offset URLs on the API host, 700 ms apart, at most
 * SAFE_MAX_PAGES) until it holds `count` rows. Anything else is 'unavailable' — the card lists it
 * and carries the Safe's last rows — never "ok" over a maintenance page or a truncated list (the
 * API orders by nonce DESCENDING, so a cut page dropped the next-executable proposals).
 */
export async function safeQueue(safe, onchainNonce, fetchImpl = fetch) {
  const base = `${SAFE_API}/safes/${getAddress(safe)}/multisig-transactions/?executed=false&nonce__gte=${onchainNonce}&limit=${PAGE}`
  const unavailable = (note) => ({ safe, status: 'unavailable', note, rows: [] })
  try {
    const rows = []
    let count = null
    for (let page = 0; ; page++) {
      if (page >= SAFE_MAX_PAGES)
        return unavailable(`truncated: ${rows.length} of ${count} proposals read`)
      if (page) await sleep(700)
      const url = page ? `${base}&offset=${page * PAGE}` : base
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
      if (res.status === 429) return unavailable('rate limited (HTTP 429)')
      if (!res.ok) return unavailable(`HTTP ${res.status}`)
      const j = await res.json()
      if (!j || !Array.isArray(j.results) || !Number.isInteger(j.count))
        return unavailable('malformed Safe API response (no results / count)')
      if (count === null) count = j.count
      else if (j.count !== count) return unavailable('the proposal count changed while paging')
      for (const t of j.results) {
        const r = rowOf(safe, t)
        if (!r) return unavailable('malformed Safe API response (a proposal row is incomplete)')
        rows.push(r)
      }
      if (rows.length >= count || !j.results.length) break
    }
    if (rows.length !== count)
      return unavailable(`truncated: ${rows.length} of ${count} proposals read`)
    return { safe, status: 'ok', rows }
  } catch (e) {
    return unavailable(String(e?.message ?? e).slice(0, 80))
  }
}

/**
 * Every Safe's queue. `nonceOf(safe)` → the on-chain nonce, or null when it could not be read —
 * fail-closed audit (SQ-05): that Safe is 'unavailable' (the API is not asked); it read from
 * nonce 0, turning ~40 stale proposals into "pending" with no read gap.
 */
export async function safeQueues(safes, nonceOf, fetchImpl = fetch) {
  const out = []
  for (const s of safes) {
    const n = await nonceOf(s)
    if (n === null || n === undefined || !Number.isInteger(Number(n))) {
      out.push({ safe: s, status: 'unavailable', note: 'Safe nonce() not read', rows: [] })
      continue
    }
    out.push(await safeQueue(s, Number(n), fetchImpl))
    await sleep(700)
  }
  return out
}
