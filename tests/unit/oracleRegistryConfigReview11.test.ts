// Config cards — review round 11: the confirmed bugs the two refuters found in the UQ-25 work (a
// token vote judged against the trailing year's average opposition D). On-chain lens: O; rules
// lens: R. Each test failed on the code / data before the fix (controls are marked).
//   RV11-1 (O-1 = R-1): the stored wstETH card contradicted itself on screen. Holder labels are
//          rendered from the stored controller trees with the CURRENT rules; the trees were
//          collected before UQ-25 (no `voting.defense`), so all 98 Lido vote nodes rendered as
//          "trailing-year vote history UNREAD … ranked as a plain contract" while the same card's
//          stored read gaps were empty and its stored text said k = 1.
//   RV11-2 (R-2): nothing checked that D is plausible. A misread D (yea / nay or unit mix-up) larger
//          than the whole supply made a 60 % EOA whale read as a BROADLY HELD vote — the most
//          dangerous direction. Now an implausible or inconsistent D is a read gap (fail closed),
//          and the collector refuses a vote whose nays exceed its own voting power.
//   RV11-3 (O, cosmetic): the unread note said "trailing-year vote history" twice.

import { describe, expect, it } from 'vitest'

import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import { getConfigCard, loadConfigInputs } from '@/lib/oracleRegistry/config/server'
import { getConfigSubjects } from '@/lib/oracleRegistry/config/subjects'
import {
  controllerRank,
  controllerTree,
  describeController,
  nodeReadGaps,
  rankHasReadGap,
  tokenVoteDecision,
  treeReadGaps,
} from '@/lib/oracleRegistry/config/rules'
import type { ConfigSubject, Controller, VoteDefense } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import {
  buildConfigCard,
  buildConfigSummary,
  type ConfigInputs,
} from '@/lib/oracleRegistry/config/view'
import { voteDefense } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { FIXTURE_TS, defenseOf, tokenVote, voteData } from './oracleRegistryVoteFixtures'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const VOTING = A('4')
const E18 = 10n ** 18n
const DAY = 86_400
// A 60 % EOA whale, then 5 / 5 / 5 % (supply 1,000; Lido thresholds), the list complete.
const WHALE_60 = [600, 50, 50, 50]

// =====================================================================================================
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const PROXY = A('1')
const TL = A('c')
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
  powers: [{ power: 'upgrade', contract: PROXY, path: ['eip1967_admin'], label: 'Upgrade P' }],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
  ...o,
})
const rawOf = (holder: string, ctl: Controller): RawSubject => ({
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
    controllers: { [`${holder}@head`]: ctl },
    powers: [{ power: 'upgrade', label: 'Upgrade P', contract: PROXY, holders: [holder] }],
    timelockAdmins: [],
    implHistory: {},
    owners: {},
    delegates: {},
    minDelays: {},
  },
  params: { head: {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [] },
  ccip: { pools: [] },
  warnings: [],
})
const built = (holder: string, ctl: Controller) => {
  const s = subject()
  const out = buildSubject(s, rawOf(holder, ctl), {
    registry,
    eidName: () => 'x',
    roleName: (h) => h,
    endpoint: EP,
  })
  const inputs: ConfigInputs = {
    subject: s,
    state: out.state,
    changes: out.changes,
    queue: out.queue,
  }
  return { out, inputs }
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('RV11-1: a card never renders a read gap it does not count', () => {
  it('a stored tree from before UQ-25 (a vote without its history): the card counts the gap its label shows (was 0 read gaps)', () => {
    // as collected: the history read (k = 1, the EOA whale) — no read gap
    const { inputs } = built(
      VOTING,
      tokenVote(VOTING, { voting: voteData(WHALE_60, { truncated: false }) }),
    )
    expect(buildConfigCard(inputs).readGaps).toEqual([])
    // the same card stored by a collector that predates the rule: no `defense`, no listed gap
    const stale = clone(inputs)
    for (const p of stale.state!.powers)
      for (const h of p.holders.flatMap(controllerTree)) if (h.voting) delete h.voting.defense
    stale.state!.readGaps = undefined
    const card = buildConfigCard(stale)
    const labels = card.admin.powers.flatMap((p) => p.holders.map((h) => h.label)).join(' ')
    expect(labels).toMatch(/trailing-year vote history UNREAD/)
    expect((card.readGaps ?? []).join(' ')).toMatch(
      /Aragon Voting 0x4444…4444: trailing-year vote history not read/,
    )
    expect(card.counts.readGaps).toBe(1)
    expect(buildConfigSummary(stale).counts.readGaps).toBe(1)
  })
  it('a stored timelock from before UQ-24 (an unrestricted bypass without its holders): counted', () => {
    const lock: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 7 * DAY,
      schedulers: [{ kind: 'safe', address: A('6'), threshold: 6, signers: 11 }],
      bypass: { fn: 'bypasserExecuteBatch', scope: 'any' },
    } as Controller
    const stale = clone(built(TL, lock).inputs)
    stale.state!.readGaps = undefined
    expect((buildConfigCard(stale).readGaps ?? []).join(' ')).toMatch(
      /timelock 0xcccc…cccc: bypasserExecuteBatch bypassers not classified/,
    )
  })
  it('control: on a card the current engine just built, the guard adds nothing (same lines as the engine — no double count)', () => {
    const cases: [string, Controller][] = [
      // a vote whose history failed, one whose vote time was not read
      [
        VOTING,
        tokenVote(VOTING, {
          voting: { ...voteData(WHALE_60), defense: undefined, defenseUnread: 'getVote(3) failed' },
        }),
      ],
      [VOTING, { ...tokenVote(VOTING), voting: { ...voteData(WHALE_60), voteTimeSec: null } }],
      // a timelock whose proposers were not read, one with a Safe proposer whose modules were not
      [
        TL,
        {
          kind: 'oz_timelock',
          address: TL,
          delaySec: 7 * DAY,
          schedulersUnread: true,
        } as Controller,
      ],
      [
        TL,
        {
          kind: 'oz_timelock',
          address: TL,
          delaySec: 7 * DAY,
          schedulers: [
            { kind: 'safe', address: A('6'), threshold: 6, signers: 11, modulesUnread: true },
          ],
        } as Controller,
      ],
    ]
    for (const [h, c] of cases) {
      const { out, inputs } = built(h, c)
      expect(out.state.readGaps?.length).toBeGreaterThan(0)
      expect(buildConfigCard(inputs).readGaps).toEqual(out.state.readGaps)
    }
  })

  const subjects = getConfigSubjects().subjects
  for (const s of subjects) {
    it(`${s.key} (committed data): every read gap the current rules find in its stored controllers is on the card`, () => {
      const state = loadConfigInputs(s).state
      if (!state) return
      const card = getConfigCard(s.key)!
      const listed = new Set(card.readGaps)
      const found = treeReadGaps(state.powers.flatMap((p) => p.holders))
      expect(found.filter((g) => !listed.has(g))).toEqual([])
      expect(card.counts.readGaps).toBe((card.readGaps ?? []).length)
    })
  }

  it('wstETH (MEASURED, head 26,152,213): every Lido vote node carries D read at the head block — 13 votes, D = 279,135.7 LDO, k = 1 — and no vote-history gap', () => {
    const s = subjects.find((x) => x.key === 'wsteth')!
    const state = loadConfigInputs(s).state!
    const votes = state.powers
      .flatMap((p) => [...p.holders, ...(p.weakest ? [p.weakest] : [])])
      .flatMap(controllerTree)
      .filter((c) => c.kind === 'aragon_voting' && !c.selfRef && c.voting?.holders)
    expect(votes.length).toBe(98)
    for (const v of votes) {
      expect(v.voting!.defense).toMatchObject({
        toTs: state.asOf.ts,
        votes: 13,
        mean: '279135739468846875810502',
        firstId: 193,
        lastId: 205,
      })
      expect(tokenVoteDecision(v)).toMatchObject({ kind: 'one', k: 1, settled: true })
      expect(controllerRank(v)[0]).toBe(1)
    }
    const card = getConfigCard('wsteth')!
    const labels = card.admin.powers.flatMap((p) => p.holders.map((h) => h.label)).join('\n')
    expect(labels).not.toMatch(/UNREAD/)
    expect(card.readGaps).toEqual(state.readGaps ?? [])
    expect(labels).toMatch(
      /ONE holder of 0x5a98… can pass a vote alone \(k = 1\): EOA 0xf977…acec — ranked as it; against D = 0\.027 % of supply, the mean nay stake of the 13 votes started in the 365 days to 2026-10-09/,
    )
  })
})

// =====================================================================================================
const misread = (defense: VoteDefense) =>
  tokenVote(VOTING, { voting: voteData(WHALE_60, { defense, truncated: false }) })

describe('RV11-2: an implausible or inconsistent D is a read gap, never a broadly held vote', () => {
  it('control: with a plausible D (the measured 0.028 % share) the 60 % EOA passes alone — an EOA', () => {
    const v = misread(defenseOf([0, 0, 1]))
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'one', k: 1 })
    expect(controllerRank(v)[0]).toBe(1)
  })
  it('D larger than the whole supply (a yea / nay or unit mix-up): unread history, ranked as a plain contract (was broadly held [5])', () => {
    const v = misread(defenseOf([2000, 2000]))
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'unread', history: true })
    expect(controllerRank(v)).toEqual([2])
    expect(rankHasReadGap(v)).toBe(true)
    expect(nodeReadGaps(v).join(' ')).toMatch(
      /trailing-year vote history not read .*exceeds the supply/,
    )
  })
  it('a D record whose mean is not its sum over its count: unread (a mean above every nay summed)', () => {
    const d = { ...defenseOf([1, 1]), mean: (900n * E18).toString() }
    expect(tokenVoteDecision(misread(d))).toMatchObject({ kind: 'unread', history: true })
  })
  it('a D record with no vote but a non-zero mean or sum: unread', () => {
    expect(
      tokenVoteDecision(misread({ ...defenseOf([]), mean: (900n * E18).toString() })),
    ).toMatchObject({ kind: 'unread', history: true })
    expect(
      tokenVoteDecision(misread({ ...defenseOf([]), naySum: (900n * E18).toString() })),
    ).toMatchObject({ kind: 'unread', history: true })
  })
  it('a malformed D (not an integer): unread history, not "holder concentration not read"', () => {
    const d = misread({ ...defenseOf([1]), mean: 'x' })
    expect(tokenVoteDecision(d)).toMatchObject({ kind: 'unread', history: true })
  })
  it('control: D equal to the supply is still read (each vote can at most be all-nay)', () => {
    const v = misread(defenseOf([1000]))
    expect(tokenVoteDecision(v).kind).not.toBe('unread')
  })
})

// ---- the collector: a vote whose nays (or yea + nay) exceed its own voting power THROWS -------------
const BLOCK_TS = FIXTURE_TS
const startOf = (id: number) => BLOCK_TS - (9 - id) * 20 * DAY - 3600
function powerClient(bad: { id: number; yea: bigint; nay: bigint }) {
  const tuple = (id: number) =>
    [
      false,
      true,
      BigInt(startOf(id)),
      1n,
      0n,
      0n,
      id === bad.id ? bad.yea : 0n,
      id === bad.id ? bad.nay : 0n,
      1000n * E18,
    ] as const
  return {
    readContract: async (q: { functionName: string; args?: unknown[] }) => {
      if (q.functionName === 'votesLength') return 10n
      if (q.functionName === 'getVote') return tuple(Number(q.args![0]))
      throw new Error('execution reverted')
    },
    multicall: async ({ contracts }: { contracts: { args: bigint[] }[] }) =>
      contracts.map((c) => ({ status: 'success', result: tuple(Number(c.args[0])) })),
  }
}

describe('RV11-2 collector: voteDefense refuses a vote whose stake exceeds its voting power', () => {
  it("nays above the vote's voting power: THROWS (the caller records the history as unread)", async () => {
    const c = powerClient({ id: 8, yea: 0n, nay: 2000n * E18 })
    await expect(voteDefense(c, VOTING, 20_000_000, BLOCK_TS)).rejects.toThrow(/voting power/)
    await expect(voteDefense(c, VOTING, 1_000, BLOCK_TS)).rejects.toThrow(/voting power/)
  })
  it('yea + nay above the voting power: THROWS', async () => {
    const c = powerClient({ id: 8, yea: 600n * E18, nay: 600n * E18 })
    await expect(voteDefense(c, VOTING, 20_000_000, BLOCK_TS)).rejects.toThrow(/voting power/)
  })
  it('control: stakes within the voting power are read as before', async () => {
    const c = powerClient({ id: 8, yea: 400n * E18, nay: 600n * E18 })
    expect(await voteDefense(c, VOTING, 20_000_000, BLOCK_TS)).toMatchObject({
      votes: 10,
      naySum: (600n * E18).toString(),
      mean: (60n * E18).toString(),
    })
  })
})

// =====================================================================================================
describe('RV11-3 (cosmetic): the unread note names the history once', () => {
  it('a classification from before UQ-25 (no `defense`): no repeated "trailing-year vote history"', () => {
    const old: Controller = tokenVote(VOTING, {
      voting: { ...voteData(WHALE_60), defense: undefined },
    })
    const note = describeController(old)
    expect(note).toMatch(/trailing-year vote history UNREAD/)
    expect(note.match(/trailing-year vote history/g)).toHaveLength(1)
    expect(
      nodeReadGaps(old)
        .join(' ')
        .match(/trailing-year vote history/g),
    ).toHaveLength(1)
  })
})
