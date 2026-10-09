// Token-vote fixtures for the config-card tests (owner ruling 2026-10-08, UQ-17): an Aragon Voting
// ranks by HOLDER CONCENTRATION, so a fixture vote carries its holder data. Not a test file.

import type { Controller, VoteHolder } from '@/lib/oracleRegistry/config/types'

const E18 = 10n ** 18n
/** Lido's thresholds: support 50 %, minimum acceptance quorum 5 % (1e18 = 100 %). */
export const LIDO_SUPPORT = (E18 / 2n).toString()
export const LIDO_QUORUM = (E18 / 20n).toString()

/** A holder address from an index (distinct from the single-letter fixture addresses). */
export const holderAddr = (i: number) => '0x' + (0xabc000 + i).toString(16).padStart(40, '0')
const eoaHolder = (i: number, balance: bigint): VoteHolder => ({
  address: holderAddr(i),
  balance: balance.toString(),
  ctl: { kind: 'eoa', address: holderAddr(i) },
})

/**
 * Holder data for a vote over a 1,000-token supply: `balances` (whole tokens, largest first) are
 * EOA holders unless `ctls` gives one; `truncated`: more, smaller holders exist.
 */
export function voteData(
  balances: number[],
  o: {
    supply?: number
    quorum?: string
    support?: string
    ctls?: Record<number, Controller | undefined>
    truncated?: boolean
  } = {},
): NonNullable<Controller['voting']> {
  return {
    voteTimeSec: null,
    objectionPhaseSec: null,
    token: '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
    supportRequiredPct: o.support ?? LIDO_SUPPORT,
    minAcceptQuorumPct: o.quorum ?? LIDO_QUORUM,
    supply: (BigInt(o.supply ?? 1000) * E18).toString(),
    holderCount: 10_000,
    truncated: o.truncated ?? true,
    holders: balances.map((b, i) =>
      o.ctls && i in o.ctls
        ? { address: holderAddr(i), balance: (BigInt(b) * E18).toString(), ctl: o.ctls[i] }
        : eoaHolder(i, BigInt(b) * E18),
    ),
  }
}

/**
 * An Aragon Voting app (a 5-day vote by default). Default holders: 13 EOAs of 4 tokens each over
 * 1,000 — 5 % quorum needs > 50, so k = 13: BROADLY HELD (base 5, above every multisig).
 */
export function tokenVote(
  address: string,
  o: { voteTimeSec?: number; voting?: NonNullable<Controller['voting']> } = {},
): Controller {
  const sec = o.voteTimeSec ?? 432_000
  const v = o.voting ?? voteData(Array.from({ length: 13 }, () => 4))
  return {
    kind: 'aragon_voting',
    address,
    delaySec: sec,
    voting: { ...v, voteTimeSec: sec, objectionPhaseSec: v.objectionPhaseSec ?? null },
  }
}

/**
 * What the collector's enrichment step does (`enrichTokenVotes`): every Aragon Voting node in a
 * classified tree gets holder data. Default: the broadly held 13 × 4 / 1,000 set.
 */
export function withVoteHolders(
  c: Controller,
  v: NonNullable<Controller['voting']> = voteData(Array.from({ length: 13 }, () => 4)),
  seen = new Set<Controller>(),
): Controller {
  if (seen.has(c)) return c
  seen.add(c)
  if (c.kind === 'aragon_voting' && !c.selfRef)
    c.voting = {
      ...v,
      voteTimeSec: c.voting?.voteTimeSec ?? c.delaySec ?? null,
      objectionPhaseSec: c.voting?.objectionPhaseSec ?? null,
    }
  for (const x of [c.ownedBy, ...(c.executors ?? []), ...(c.schedulers ?? [])])
    if (x) withVoteHolders(x, v, seen)
  return c
}
