// Safe Transaction Service (public API) — the off-chain queue of a Safe = PROPOSED changes.
//
// Unauthenticated use is 2 requests/s and 5,000 requests per 30 days (measured 2026-10-05:
// x-ratelimit-limit 5000, reset ≈ 2.59M s). One request per Safe per run, spaced 700 ms; any
// non-200 (429 included) marks that Safe 'unavailable' — never "nothing pending". Only
// proposals submitted through the API are visible at all.

import { getAddress } from 'viem'
import { sleep } from './rpc.mjs'

export const SAFE_API = 'https://api.safe.global/tx-service/eth/api/v1'

export async function safeQueue(safe, onchainNonce, fetchImpl = fetch) {
  const url = `${SAFE_API}/safes/${getAddress(safe)}/multisig-transactions/?executed=false&nonce__gte=${onchainNonce}&limit=25`
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (res.status === 429)
      return { safe, status: 'unavailable', note: 'rate limited (HTTP 429)', rows: [] }
    if (!res.ok) return { safe, status: 'unavailable', note: `HTTP ${res.status}`, rows: [] }
    const j = await res.json()
    const rows = (j.results ?? []).map((t) => ({
      safe: safe.toLowerCase(),
      nonce: Number(t.nonce),
      to: String(t.to).toLowerCase(),
      value: String(t.value ?? '0'),
      data: t.data ?? null,
      confirmations: (t.confirmations ?? []).length,
      confirmationsRequired: Number(t.confirmationsRequired ?? 0),
      submissionDate: t.submissionDate,
      safeTxHash: t.safeTxHash,
      // 0 CALL, 1 DELEGATECALL — a delegatecall runs the target's code AS the Safe (review round
      // 6: the singleton-swap shape was dropped here)
      ...(t.operation === undefined || t.operation === null
        ? {}
        : { operation: Number(t.operation) }),
    }))
    return { safe, status: 'ok', rows }
  } catch (e) {
    return { safe, status: 'unavailable', note: String(e?.message ?? e).slice(0, 80), rows: [] }
  }
}

export async function safeQueues(safes, nonceOf, fetchImpl = fetch) {
  const out = []
  for (const s of safes) {
    out.push(await safeQueue(s, await nonceOf(s), fetchImpl))
    await sleep(700)
  }
  return out
}
