// Config cards — owner ruling 2026-10-09 UQ-25 (refines UQ-17): "can pass a vote alone" is judged
// AGAINST THE AVERAGE OPPOSITION OF THE TRAILING YEAR — not "nobody else votes", not "everyone
// else votes no". D = the mean nay stake of every vote STARTED in the 365 days before the
// classification block (a vote with no nays counts as 0). A holder set S passes alone iff
// stake(S) meets the quorum share of supply AND stake(S) / (stake(S) + D) meets the support
// threshold (Aragon `_isValuePct`: strictly greater). No vote in the window: D = 0 (fail closed,
// said on the card). Unread vote history: a read gap (plain contract, no credit). Every test
// failed on the code before the change except the controls, which are marked.

import { describe, expect, it } from 'vitest'
import { decodeFunctionResult, encodeAbiParameters, parseAbi } from 'viem'

import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import {
  classifyControllerChange,
  controllerRank,
  describeController,
  isEoaControlled,
  isRed,
  nodeReadGaps,
  rankHasReadGap,
  tokenVoteDecision,
  voteDefenseNote,
} from '@/lib/oracleRegistry/config/rules'
import type { ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import {
  DEFENSE_WINDOW_SEC,
  GET_VOTE_SIG,
  MULTICALL3_BLOCK,
  enrichTokenVotes,
  voteDefense,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import {
  FIXTURE_TS,
  LIDO_QUORUM,
  LIDO_SUPPORT,
  defenseOf,
  holderAddr,
  tokenVote,
  voteData,
} from './oracleRegistryVoteFixtures'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const DAY = 86_400
const E18 = 10n ** 18n
const VOTING = A('4')
const AGENT = A('3')
const EXEC = A('5')
const EPT = A('7')
const PROXY = A('1')
const TL = A('c')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const SAFE_6_11: Controller = { kind: 'safe', address: A('6'), threshold: 6, signers: 11 }
const tl = (delaySec: number, schedulers: Controller[]): Controller => ({
  kind: 'oz_timelock',
  address: TL,
  delaySec,
  schedulers,
})

const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const subject = (o: Partial<ConfigSubject> = {}): ConfigSubject => ({
  key: 'z',
  label: 'Z',
  oracleAssetKey: null,
  class: 'lrt',
  contracts: [
    { role: 'token', dimension: 'admin', chainId: 1, address: PROXY, label: 'p', deployBlock: 1 },
  ],
  lzOApps: [],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
  ...o,
})
const rawOf = (o: { admin?: Partial<RawSubject['admin']> }): RawSubject => ({
  version: 1,
  subjectKey: 'z',
  head: { block: 30_000_000, ts: 2000 },
  scan: { from: 1, to: 30_000_000 },
  lz: {
    events: [],
    headRoutes: [],
    headDefaults: {},
    remote: [],
    codeProbes: {},
    dvnSigner: [],
    dvnHead: {},
  },
  admin: {
    events: [],
    controllers: {},
    powers: [],
    timelockAdmins: [],
    implHistory: {},
    owners: {},
    delegates: {},
    minDelays: {},
    ...o.admin,
  },
  params: { head: {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [] },
  ccip: { pools: [] },
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const powerOn = (holder: string) => ({
  s: subject({
    powers: [{ power: 'upgrade', contract: PROXY, path: ['eip1967_admin'], label: 'Upgrade P' }],
  }),
  power: { power: 'upgrade' as const, label: 'Upgrade P', contract: PROXY, holders: [holder] },
})

// The synthetic case the ruling asks for: a 6 % EOA whale, then 3 %, 3 %, 2 % (supply 1,000;
// Lido thresholds — quorum 5 %, support 50 %). D = 65 tokens (6.5 % of supply): the mean of three
// votes, one with 195 nays and two with none (a vote with no nays counts as 0 in the mean).
//   6 % alone          60 / (60 + 65)  = 48.0 %  — fails support
//   6 + 3 %            63 / (63 + 65)  = 49.2 %  — fails
//   6 + 3 + 3 %        66 / (66 + 65)  = 50.4 %  — passes: k = 3
//   6 + 3 + 2 %        65 / (65 + 65)  = 50.0 %  — not above 50 %: the 2 % holder is in no
//                                                 passing set of 3 (the decision is settled)
const WHALE_SET = [60, 3, 3, 2]
const D65 = defenseOf([195, 0, 0])

// =====================================================================================================
describe('UQ-25: a token vote is judged against the trailing-year AVERAGE opposition D', () => {
  it('control (fixture): the mean counts a vote with no nays as 0: three votes, 195 / 0 / 0 nays → D = 65', () => {
    expect(D65).toMatchObject({ votes: 3, naySum: (195n * E18).toString() })
    expect(D65.mean).toBe((65n * E18).toString())
  })
  it('synthetic D: a 6 % holder no longer passes alone, a set of 3 does — a 3-of-3 multisig (was an EOA)', () => {
    // control: with no opposition (the round-10 literal reading) the 6 % whale passes alone
    const literal = tokenVote(VOTING, { voteTimeSec: 3600, voting: voteData(WHALE_SET) })
    expect(tokenVoteDecision(literal)).toMatchObject({ kind: 'one', k: 1 })
    expect(controllerRank(literal)).toEqual([1])
    // against D = 6.5 % of supply
    const v = tokenVote(VOTING, {
      voteTimeSec: 3600,
      voting: voteData(WHALE_SET, { defense: D65 }),
    })
    const d = tokenVoteDecision(v)
    expect(d).toMatchObject({ kind: 'few', k: 3, settled: true })
    expect(d.kind === 'few' && d.holders.map((h) => h.address)).toEqual([
      holderAddr(0),
      holderAddr(1),
      holderAddr(2),
    ])
    expect(controllerRank(v)).toEqual([4, 3, -3])
    expect(isEoaControlled(v)).toBe(false)
    // EOA → this vote is now an upgrade; Safe 6/11 → it is still red (3-of-3 < 6-of-11)
    expect(classifyControllerChange(eoa(A('e')), v).severity).toBe('upgrade')
    expect(isRed(classifyControllerChange(SAFE_6_11, v))).toBe(true)
  })
  it("the card's rank note shows D, the window, the vote count and k", () => {
    const v = tokenVote(VOTING, { voting: voteData(WHALE_SET, { defense: D65 }) })
    const s = describeController(v)
    expect(s).toMatch(
      /3 holders .* can pass a vote alone: ranked as a 3-of-3 multisig of them \(k = 3\)/,
    )
    expect(s).toMatch(
      /against D = 6\.500 % of supply, the mean nay stake of the 3 votes started in the 365 days to 2026-09-21/,
    )
    // k is named for one holder and for a broadly held vote too
    const one = tokenVote(VOTING, { voting: voteData([60, 10], { defense: defenseOf([1]) }) })
    expect(describeController(one)).toMatch(/ONE holder .* can pass a vote alone \(k = 1\)/)
    expect(describeController(one)).toMatch(/the mean nay stake of the 1 vote started/)
    const broad = tokenVote(VOTING, {
      voting: voteData(
        Array.from({ length: 14 }, () => 4),
        { defense: defenseOf([108, 0]) },
      ),
    })
    // D = 54: 13 × 4 = 52 meets the quorum but 52 / 106 = 49.1 % fails support; 14 × 4 = 56,
    // 56 / 110 = 50.9 % — k = 14 (13 with nobody else voting)
    expect(tokenVoteDecision(broad)).toMatchObject({ kind: 'broad', k: 14 })
    expect(describeController(broad)).toMatch(/broadly held: k = 14 of the largest holders/)
    expect(describeController(broad)).toMatch(/against D = 5\.400 % of supply/)
  })
  it('D also raises the bar for the support threshold alone: the same whale against D just below and at its stake', () => {
    // 60 / (60 + 59) = 50.4 % passes; 60 / (60 + 60) = 50 % does not (strictly greater)
    const below = tokenVote(VOTING, { voting: voteData([60, 10], { defense: defenseOf([59]) }) })
    expect(tokenVoteDecision(below)).toMatchObject({ kind: 'one', k: 1 })
    const at = tokenVote(VOTING, {
      voting: voteData([60, 10], { defense: defenseOf([60]), truncated: false }),
    })
    // 60 + 10 = 70 / 130 = 53.8 % passes: k = 2
    expect(tokenVoteDecision(at)).toMatchObject({ kind: 'few', k: 2 })
  })
  it('NO vote started in the trailing year: D = 0 (fail closed) — and the card says so', () => {
    const v = tokenVote(VOTING, { voting: voteData([60, 10], { defense: defenseOf([]) }) })
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'one', k: 1 })
    expect(controllerRank(v)[0]).toBe(1)
    expect(voteDefenseNote(v)).toBe(
      'no vote started in the 365 days to 2026-09-21: D = 0 (fail closed — no opposition assumed)',
    )
    expect(describeController(v)).toMatch(/no vote started in the 365 days to 2026-09-21: D = 0/)
  })
  it('UNREAD vote history is a READ GAP: plain contract, no delay credit, listed', () => {
    // the read failed
    const failed = tokenVote(VOTING, {
      voting: { ...voteData(WHALE_SET), defense: undefined, defenseUnread: 'getVote(204) failed' },
    })
    expect(tokenVoteDecision(failed)).toMatchObject({ kind: 'unread', history: true })
    expect(controllerRank(failed)).toEqual([2])
    expect(rankHasReadGap(failed)).toBe(true)
    expect(describeController(failed)).toMatch(/trailing-year vote history UNREAD/)
    expect(nodeReadGaps(failed).join(' ')).toMatch(
      /trailing-year vote history not read \(vote history not read: getVote\(204\) failed/,
    )
    // a classification from before UQ-25 (holders, no history): the same — never "no opposition"
    const old = tokenVote(VOTING, { voting: { ...voteData(WHALE_SET), defense: undefined } })
    expect(controllerRank(old)).toEqual([2])
    expect(rankHasReadGap(old)).toBe(true)
    expect(nodeReadGaps(old).join(' ')).toMatch(/trailing-year vote history not read/)
    // a broadly held holder set does not rescue it: [2], not [5] (was [5, 0, 0, 432000])
    const broad = tokenVote(VOTING, {
      voting: { ...voteData(Array.from({ length: 14 }, () => 4)), defense: undefined },
    })
    expect(controllerRank(broad)).toEqual([2])
    // a 7-day timelock proposed by it earns no credit on top (UQ-18)
    expect(controllerRank(tl(7 * DAY, [broad]))).toEqual([2])
    // the head state lists it as a read gap
    const { s, power } = powerOn(VOTING)
    const out = build(
      s,
      rawOf({ admin: { powers: [power], controllers: { [`${VOTING}@head`]: failed } } }),
    )
    expect(out.state.readGaps?.join(' ')).toMatch(/trailing-year vote history not read/)
  })
  it('the Agent back-reference is still left out under D (it votes only after a vote passed)', () => {
    const agent: Controller = {
      kind: 'contract',
      address: AGENT,
      version: 'Aragon Agent',
      ownedBy: {
        kind: 'contract',
        address: EXEC,
        ownedBy: {
          kind: 'aragon_dg',
          address: EPT,
          delaySec: 691200,
          schedulers: [{ kind: 'aragon_voting', address: VOTING, selfRef: true }],
          dg: {
            afterSubmitDelaySec: 259200,
            afterScheduleDelaySec: 86400,
            governance: null,
            adminExecutor: EXEC,
            emergencyGovernance: null,
            activationCommittee: null,
            executionCommittee: null,
            emergencyModeActive: false,
            emergencyProtectionEndsAfter: null,
          },
        },
      },
    }
    // the Agent's 12.1 % would pass against D = 6.5 %; left out, the next three decide (k = 3)
    const v = tokenVote(VOTING, {
      voteTimeSec: 3600,
      voting: voteData([121, ...WHALE_SET], { ctls: { 0: agent }, defense: D65 }),
    })
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'few', k: 3 })
    expect(controllerRank(v)).toEqual([4, 3, -3])
  })
  it('MEASURED: LDO at block 26,152,213 — D = 0.028 % of supply over 13 votes; the 6.078 % EOA still passes alone (k = 1)', () => {
    // read on chain at the block (getVote of votes 193–205, started 2025-10-16 → 2026-09-16, each
    // cross-checked with a raw eth_call): nays 1,396,044 (vote 193) + 2,229,704 (vote 200) + 3,240
    // across the other 11 = 3,628,764.6 LDO; D = 279,135.7 LDO. 0xf977…acec (an EOA) holds
    // 60,783,425.96 LDO: 6.078 % > the 5 % quorum, and 60.78M / (60.78M + 0.28M) = 99.5 % > 50 %.
    // D would have to exceed 60.78M LDO (218 × the measured mean) to stop it.
    const measured = tokenVote(VOTING, {
      voting: {
        voteTimeSec: 432000,
        objectionPhaseSec: 172800,
        token: '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
        supportRequiredPct: LIDO_SUPPORT,
        minAcceptQuorumPct: LIDO_QUORUM,
        supply: '1000000000000000000000000000',
        holderCount: 66485,
        defense: {
          windowSec: DEFENSE_WINDOW_SEC,
          fromTs: 1759981127,
          toTs: 1791517127,
          votes: 13,
          naySum: '3628764613095009385536538',
          mean: '279135739468846875810502',
          firstId: 193,
          lastId: 205,
        },
        truncated: true,
        holders: [
          {
            address: AGENT,
            balance: '121497545794599365251635349',
            ctl: { kind: 'aragon_voting', address: VOTING, selfRef: true },
          },
          {
            address: '0xf977814e90da44bfa03b6295a0616a897441acec',
            balance: '60783425960000000000000000',
            ctl: eoa('0xf977814e90da44bfa03b6295a0616a897441acec'),
          },
        ],
      },
    })
    expect(tokenVoteDecision(measured)).toMatchObject({ kind: 'one', k: 1, settled: true })
    expect(isEoaControlled(measured)).toBe(true)
    expect(describeController(measured)).toMatch(
      /against D = 0\.027 % of supply, the mean nay stake of the 13 votes started in the 365 days to 2026-10-09/,
    )
  })
})

// ---- the collector ---------------------------------------------------------------------------------
const BLOCK_TS = FIXTURE_TS
/** Votes 0..39; vote i started (39 − i) × 20 days + 1 h before the block: 21..39 are in the year. */
const startOf = (id: number) => BLOCK_TS - (39 - id) * 20 * DAY - 3600
const nayOf = (id: number) => (id === 30 ? 190n * E18 : 0n)
const voteTuple = (id: number) =>
  [id === 39, id !== 39, BigInt(startOf(id)), 1n, 0n, 0n, 0n, nayOf(id), 1000n * E18] as const
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
function votesClient(o: { failId?: number; count?: number } = {}) {
  const calls = { multicall: 0, getVote: 0, votesLength: 0 }
  const client = {
    readContract: async (q: { functionName: string; args?: unknown[] }) => {
      if (q.functionName === 'votesLength') {
        calls.votesLength++
        return BigInt(o.count ?? 40)
      }
      if (q.functionName === 'getVote') {
        calls.getVote++
        const id = Number(q.args![0])
        if (id === o.failId) throw new Error('fetch failed')
        return voteTuple(id)
      }
      throw revert()
    },
    multicall: async ({ contracts }: { contracts: { args: bigint[] }[] }) => {
      calls.multicall++
      return contracts.map((c) => {
        const id = Number(c.args[0])
        return id === o.failId
          ? { status: 'failure', error: new Error('x') }
          : { status: 'success', result: voteTuple(id) }
      })
    },
  }
  return { client, calls }
}

describe('UQ-25 collector: voteDefense reads the trailing year at the block', () => {
  it('newest first, stops at the window; D = the mean, a vote with no nays (or still open) counts as 0', async () => {
    const { client, calls } = votesClient()
    const d = await voteDefense(client, VOTING, 20_000_000, BLOCK_TS)
    expect(d).toEqual({
      windowSec: 365 * DAY,
      fromTs: BLOCK_TS - 365 * DAY,
      toTs: BLOCK_TS,
      votes: 19,
      naySum: (190n * E18).toString(),
      mean: (10n * E18).toString(),
      firstId: 21,
      lastId: 39,
    })
    // one batch of 25 (votes 39..15) reaches a vote older than the window: no second batch
    expect(calls.multicall).toBe(1)
    expect(calls.getVote).toBe(0)
  })
  it('before Multicall3: one eth_call per vote (review round 10, R-7), same answer', async () => {
    const { client, calls } = votesClient()
    const d = await voteDefense(client, VOTING, MULTICALL3_BLOCK - 1, BLOCK_TS)
    expect(d).toMatchObject({ votes: 19, mean: (10n * E18).toString() })
    expect(calls.multicall).toBe(0)
    expect(calls.getVote).toBe(25)
  })
  it('no vote in the window, or no vote at all: votes 0, D = 0', async () => {
    expect(
      await voteDefense(votesClient({ count: 0 }).client, VOTING, 20_000_000, BLOCK_TS),
    ).toMatchObject({
      votes: 0,
      naySum: '0',
      mean: '0',
    })
    // only votes 0..15 exist: the newest started 24 × 20 days before the block
    const d = await voteDefense(votesClient({ count: 16 }).client, VOTING, 20_000_000, BLOCK_TS)
    expect(d).toMatchObject({ votes: 0, mean: '0' })
    expect(d.firstId).toBeUndefined()
  })
  it('a failed read THROWS (the caller records the history as unread): a vote, the count, the timestamp', async () => {
    await expect(
      voteDefense(votesClient({ failId: 30 }).client, VOTING, 20_000_000, BLOCK_TS),
    ).rejects.toThrow(/getVote\(30\) failed/)
    await expect(
      voteDefense(votesClient({ failId: 30 }).client, VOTING, MULTICALL3_BLOCK - 1, BLOCK_TS),
    ).rejects.toThrow()
    const noCount = {
      readContract: async () => {
        throw revert()
      },
    }
    await expect(voteDefense(noCount, VOTING, 20_000_000, BLOCK_TS)).rejects.toThrow(
      /votesLength not read/,
    )
    await expect(voteDefense(votesClient().client, VOTING, 20_000_000, NaN)).rejects.toThrow(
      /timestamp/,
    )
  })
  it("control: Lido's getVote (an extra `phase` word after the script) decodes with the same ABI", () => {
    const data = encodeAbiParameters(
      [
        { type: 'bool' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'uint8' },
      ],
      [false, true, 1760000000n, 1n, 2n, 3n, 4n, 1396044n * E18, 5n, '0xdeadbeef', 2],
    )
    const r = decodeFunctionResult({ abi: parseAbi([GET_VOTE_SIG]), functionName: 'getVote', data })
    expect(r[2]).toBe(1760000000n)
    expect(r[7]).toBe(1396044n * E18)
  })
})

describe('UQ-25 collector: enrichTokenVotes reads the history before the holders', () => {
  const snap = {
    supply: (1000n * E18).toString(),
    holderCount: 5000,
    top: WHALE_SET.map((b, i) => [holderAddr(i), (BigInt(b) * E18).toString()]),
  }
  const vote = (): Controller => ({
    kind: 'aragon_voting',
    address: VOTING,
    delaySec: 432000,
    voting: {
      voteTimeSec: 432000,
      objectionPhaseSec: null,
      token: A('70'),
      supportRequiredPct: LIDO_SUPPORT,
      minAcceptQuorumPct: LIDO_QUORUM,
    },
  })
  const counting = () => {
    const n = { getCode: 0 }
    return {
      n,
      client: {
        getCode: async () => {
          n.getCode++
          return '0x'
        },
      },
    }
  }
  const base = {
    head: 20_000_000,
    decide: tokenVoteDecision,
    snapshotsFor: async (_t: string, b: number[]) => new Map(b.map((x) => [x, snap])),
  }
  it('D applied at the block: the 6 % whale is not enough, k = 3', async () => {
    const { client } = counting()
    const v = vote()
    const seen: [string, number][] = []
    await enrichTokenVotes(
      client,
      { [`${VOTING}@19000000`]: v },
      {
        ...base,
        defenseFor: async (app: string, b: number) => {
          seen.push([app, b])
          return D65
        },
      },
    )
    expect(seen).toEqual([[VOTING, 19_000_000]])
    expect(v.voting?.defense).toEqual(D65)
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'few', k: 3, settled: true })
    expect(v.voting?.holders).toHaveLength(4)
  })
  it('a history read that fails: defenseUnread, NO holder classified, a read gap (fail closed)', async () => {
    const { client, n } = counting()
    const v = vote()
    await enrichTokenVotes(
      client,
      { [`${VOTING}@19000000`]: v },
      {
        ...base,
        defenseFor: async () => {
          throw new Error('getVote(204) failed')
        },
      },
    )
    expect(v.voting?.defenseUnread).toMatch(/getVote\(204\) failed/)
    expect(v.voting?.holders).toBeUndefined()
    expect(n.getCode).toBe(0)
    expect(controllerRank(v)).toEqual([2])
    expect(rankHasReadGap(v)).toBe(true)
    // without a history reader at all: the same
    const w = vote()
    await enrichTokenVotes(client, { [`${VOTING}@19000000`]: w }, base)
    expect(w.voting?.defenseUnread).toBe('no vote-history reader')
    expect(rankHasReadGap(w)).toBe(true)
  })
  it('a cached node from before UQ-25 is read again; the holders it had classified at that block are reused', async () => {
    const { client, n } = counting()
    const v = vote()
    v.voting = {
      ...v.voting!,
      supply: snap.supply,
      holderCount: 5000,
      truncated: true,
      // round 10 stopped at the whale (k = 1 with nobody else voting) — classified then
      holders: [{ address: holderAddr(0), balance: snap.top[0][1], ctl: eoa(holderAddr(0)) }],
    }
    expect(rankHasReadGap(v)).toBe(true) // no history: a gap until it is read
    const jobs = await enrichTokenVotes(
      client,
      { [`${VOTING}@19000000`]: v },
      { ...base, defenseFor: async () => D65 },
    )
    expect(jobs).toBe(1)
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'few', k: 3, settled: true })
    expect(v.voting?.holders?.[0].ctl).toEqual(eoa(holderAddr(0)))
    // the whale was not classified again; the three smaller holders were
    expect(n.getCode).toBe(3)
    // a node that already carries its history and a settled decision is left as it is
    expect(
      await enrichTokenVotes(
        client,
        { [`${VOTING}@19000000`]: v },
        { ...base, defenseFor: async () => D65 },
      ),
    ).toBe(0)
  })
})
