// Config cards — review round 10: the confirmed bugs the two refuters found in the round-10 work
// (the token-vote ruling UQ-17 and the fail-closed items UQ-18..UQ-24). On-chain lens: O-1..O-4;
// rules lens: R-1..R-7 (O-1 = R-2, O-2 = R-3, O-3 is part of R-1). Each test failed on the code
// before the fix (controls are marked). Synthetic fixtures; the on-chain shapes they copy are cited.

import { describe, expect, it } from 'vitest'

import { type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  markStillInEffect,
  rejudgeRoleHoldersAtHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  classifyControllerChange,
  classifyRoleAdminChange,
  controllerRank,
  describeController,
  isEoaControlled,
  isRed,
  nodeReadGaps,
  rankHasReadGap,
  tokenVoteDecision,
} from '@/lib/oracleRegistry/config/rules'
import type { ConfigChange, ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { classify, enrichTokenVotes } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { crossCheckedLogs } from '@/scripts/oracle-registry/config/lib/rpc.mjs'
import {
  LIDO_QUORUM,
  LIDO_SUPPORT,
  holderAddr,
  tokenVote,
  voteData,
} from './oracleRegistryVoteFixtures'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const DAY = 86_400
const E18 = 10n ** 18n
const SAFE = A('6')
const EOA = A('e')
const TL = A('c')
const PROXY = A('1')
const HC = A('d')
const VOTING = A('4')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const safe = (a: string, t: number, n: number, o: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  ...o,
})
const SAFE_6_11 = safe(SAFE, 6, 11)
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const plain = (a: string): Controller => ({ kind: 'contract', address: a })
const tl = (
  delaySec: number,
  schedulers?: Controller[],
  o: Partial<Controller> = {},
): Controller => ({
  kind: 'oz_timelock',
  address: TL,
  delaySec,
  ...(schedulers ? { schedulers } : {}),
  ...o,
})
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
const SAFE_SINGLETON_WORD = '0x' + '0'.repeat(24) + '34cfac646f301356faa8b21e94227e3583fe3f5f'
const ZERO_WORD = '0x' + '0'.repeat(64)

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
const rawOf = (o: { admin?: Partial<RawSubject['admin']>; head?: number }): RawSubject => ({
  version: 1,
  subjectKey: 'z',
  head: { block: o.head ?? 30_000_000, ts: 2000 },
  scan: { from: 1, to: o.head ?? 30_000_000 },
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
const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
  chainId: 1,
  block: 100,
  logIndex: 0,
  tx: '0xt',
  emitter: HC,
  event: 'MemberAdded',
  args: {},
  ...o,
})

// =====================================================================================================
describe('O-1 / R-2: a holder whose classification FAILED is a read gap, never a plain contract', () => {
  it('ONE whale not classified: [2], a read gap, listed, no vote-time credit (was [2, 0, 0, 432000] and no gap)', () => {
    // the collector's classify(...).catch(() => undefined) leaves the holder without `ctl`
    const v = tokenVote(VOTING, { voting: voteData([60, 10], { ctls: { 0: undefined } }) })
    expect(controllerRank(v)).toEqual([2])
    expect(rankHasReadGap(v)).toBe(true)
    expect(nodeReadGaps(v).join(' ')).toMatch(/not classified/)
    // a plain contract → this vote is no upgrade (it read as one)
    expect(classifyControllerChange(plain(A('a9')), v).severity).not.toBe('upgrade')
  })
  it('the same in the few case: a k-of-k set with an unclassified member is a read gap', () => {
    const v = tokenVote(VOTING, {
      voteTimeSec: 3600,
      voting: voteData([20, 20, 20, 1], { ctls: { 1: undefined } }),
    })
    expect(controllerRank(v)).toEqual([2])
    expect(rankHasReadGap(v)).toBe(true)
  })
  it('control: every member classified — no gap', () => {
    const v = tokenVote(VOTING, { voteTimeSec: 3600, voting: voteData([20, 20, 20, 1]) })
    expect(controllerRank(v)).toEqual([4, 3, -3])
    expect(rankHasReadGap(v)).toBe(false)
  })
})

// =====================================================================================================
describe('R-1 / O-3: a token vote ranks as the WEAKEST holder set that can pass it alone', () => {
  it('k = 1: a Safe 4/7 at 8 % and an EOA at 6 % — the EOA passes alone: ranked [1] (was [4, 4, −7])', () => {
    const v = tokenVote(VOTING, {
      voting: voteData([80, 60, 10], { ctls: { 0: safe(A('a1'), 4, 7) } }),
    })
    expect(controllerRank(v)[0]).toBe(1)
    expect(isEoaControlled(v)).toBe(true)
    // Safe 3/5 → this vote read UPGRADE; it is RED
    expect(isRed(classifyControllerChange(safe(A('a2'), 3, 5), v))).toBe(true)
    const d = tokenVoteDecision(v)
    expect(d.kind === 'one' && d.holders.map((h) => h.address)).toEqual([
      holderAddr(0),
      holderAddr(1),
    ])
  })
  it('k = 1: a plain-contract pool at 7 % and an EOA at 6 % — [1] (was [2])', () => {
    const v = tokenVote(VOTING, { voting: voteData([70, 60, 10], { ctls: { 0: plain(A('a3')) } }) })
    expect(controllerRank(v)[0]).toBe(1)
  })
  it('k = 1: a Safe 4/7 at 8 % and a plain contract at 6 % — the plain contract, behind the vote time (was [4, 4, −7, …])', () => {
    const v = tokenVote(VOTING, {
      voting: voteData([80, 60, 10], { ctls: { 0: safe(A('a1'), 4, 7), 1: plain(A('a3')) } }),
    })
    // a read plain contract keeps the 5-day vote time as its delay credit (ruling #12), no gap
    expect(controllerRank(v)).toEqual([2, 0, 0, 432000])
    expect(rankHasReadGap(v)).toBe(false)
  })
  it('k = 2: a weaker pair also passes — {Safe, plain contract} caps the vote at [2] (was [4, 2, −2])', () => {
    // 1,000 supply, quorum > 50: 30 + 25 = 55 (the top two, both Safes); 30 + 24 = 54 also passes,
    // and 24 is a plain contract; 25 + 24 = 49 does not; 30 + 10 = 40 does not
    const v = tokenVote(VOTING, {
      voteTimeSec: 3600,
      voting: voteData([30, 25, 24, 10], {
        ctls: { 0: safe(A('a1'), 4, 7), 1: safe(A('a2'), 4, 7), 2: plain(A('a3')) },
      }),
    })
    expect(tokenVoteDecision(v)).toMatchObject({ kind: 'few', k: 2 })
    expect(controllerRank(v)).toEqual([2])
  })
  it('a list that ends on a holder that passes alone is not settled: a later one could too (fail closed)', () => {
    const v = tokenVote(VOTING, {
      voting: voteData([80, 60], { ctls: { 0: safe(A('a1'), 4, 7), 1: safe(A('a2'), 4, 7) } }),
    })
    expect(controllerRank(v)).toEqual([2])
    expect(rankHasReadGap(v)).toBe(true)
    // control: the next holder examined does not pass alone — settled, the Safe rank stands
    const ok = tokenVote(VOTING, {
      voting: voteData([80, 60, 10], {
        ctls: { 0: safe(A('a1'), 4, 7), 1: safe(A('a2'), 4, 7) },
      }),
    })
    expect(controllerRank(ok).slice(0, 3)).toEqual([4, 4, -7])
    expect(rankHasReadGap(ok)).toBe(false)
  })
  it('O-3: a precompile-range or zero holder cannot vote — never ranked as immutable (was [6, 0, 0, 432000])', () => {
    const base = voteData(Array.from({ length: 13 }, () => 4))
    for (const dead of [
      '0x0000000000000000000000000000000000000005',
      '0x0000000000000000000000000000000000000000',
    ]) {
      const v = tokenVote(VOTING, {
        voting: {
          ...base,
          holders: [
            {
              address: dead,
              balance: (100n * E18).toString(),
              ctl: {
                kind: /^0x0+$/.test(dead) ? 'zero' : 'precompile',
                address: dead,
              },
            },
            ...base.holders!,
          ],
        },
      })
      expect(controllerRank(v)[0]).toBe(5) // the other 13 holders: broadly held
    }
    // an 'immutable' holder that holds votes can only vote through its own code: a plain contract
    const imm = tokenVote(VOTING, {
      voting: voteData([60, 10], { ctls: { 0: { kind: 'immutable', address: A('a5') } } }),
    })
    expect(controllerRank(imm)[0]).toBe(2)
  })
})

// =====================================================================================================
describe('O-2 / R-3: a rank that rests on a read gap is never an UPGRADE, and never ends a red', () => {
  it('EOA → a timelock with an UNREAD proposer set, a Safe with an unread module list, a vote with unread holders: not upgrades (were)', () => {
    for (const next of [
      tl(7 * DAY, undefined),
      safe(A('a7'), 3, 5, { modulesUnread: true }),
      tokenVote(VOTING, {
        voting: { voteTimeSec: 432000, objectionPhaseSec: null, holdersUnread: 'logs lost' },
      }),
    ]) {
      const v = classifyControllerChange(eoa(EOA), next)
      expect(v.severity).not.toBe('upgrade')
      expect(v.tags).toContain('read_gap')
      expect(v.notes.join(' ')).toMatch(/read gap/)
    }
    // control: a READ Safe 2/3 is an upgrade
    expect(classifyControllerChange(eoa(EOA), safe(A('a8'), 2, 3)).severity).toBe('upgrade')
  })
  it('a role-admin move to holders with a read gap is no upgrade either', () => {
    const v = classifyRoleAdminChange(
      'MINTER_ROLE',
      { name: 'A', holders: [eoa(EOA)] },
      { name: 'B', holders: [tl(7 * DAY, undefined)] },
    )
    expect(v.severity).not.toBe('upgrade')
  })
  it('end to end: Safe 6/11 → EOA (red), then EOA → an unread-proposer timelock: the red stays IN EFFECT (was ended)', () => {
    const ev = (block: number, prev: string, next: string): AdminEventRow =>
      row({
        emitter: PROXY,
        event: 'OwnershipTransferred',
        block,
        tx: `0x${block.toString(16)}`,
        args: { previousOwner: prev, newOwner: next },
      })
    const raw = (later: Controller) =>
      rawOf({
        admin: {
          events: [ev(100, SAFE, EOA), ev(200, EOA, TL)],
          controllers: {
            [`${SAFE}@99`]: SAFE_6_11,
            [`${EOA}@100`]: eoa(EOA),
            [`${EOA}@199`]: eoa(EOA),
            [`${TL}@200`]: later,
          },
        },
      })
    const red = (out: ReturnType<typeof build>) =>
      out.changes.find((c) => c.key === `admin/owner/${PROXY}` && c.block === 100)!
    const gap = build(subject(), raw(tl(7 * DAY, undefined)))
    expect(red(gap).red).toBe(true)
    expect(red(gap).stillInEffect).toBe(true)
    // control: a READ strong timelock (proposed by the Safe, 7 days) ends it
    const ok = build(subject(), raw(tl(7 * DAY, [SAFE_6_11])))
    expect(red(ok).stillInEffect).toBeFalsy()
  })
  it('markStillInEffect: a read_gap change carries the red forward like a rotation', () => {
    const ch = (o: Partial<ConfigChange>): ConfigChange =>
      ({
        id: String(o.block),
        subject: 'z',
        dimension: 'admin',
        key: 'admin/owner/x',
        title: '',
        state: 'historical',
        stage: 'executed',
        severity: 'neutral',
        floorBreach: false,
        red: false,
        ruleIds: [],
        tags: [],
        unannounced: null,
        announcement: 'not_checked',
        chainId: 1,
        ...o,
      }) as ConfigChange
    const a = ch({ block: 1, before: SAFE, after: EOA, red: true, severity: 'downgrade' })
    const b = ch({ block: 2, before: EOA, after: TL, tags: ['read_gap'] })
    markStillInEffect([a, b])
    expect(a.stillInEffect).toBe(true)
  })
})

// =====================================================================================================
describe('R-4: in the head re-judge, a comparison holder not read never ends a red', () => {
  const MINTING = A('2')
  const S = A('b3')
  const MC = A('b2')
  const ROLE = '0x' + 'ab'.repeat(32)
  const events: AdminEventRow[] = [
    row({
      emitter: MINTING,
      event: 'RoleGranted',
      block: 50,
      tx: '0x32',
      args: { role: ROLE, roleName: 'PROPOSER_ROLE', account: S },
    }),
    row({
      emitter: MINTING,
      event: 'RoleGranted',
      block: 100,
      tx: '0x64',
      args: { role: ROLE, roleName: 'PROPOSER_ROLE', account: MC },
    }),
  ]
  const redRow = (): ConfigChange =>
    ({
      id: '1:0x64:0',
      subject: 'z',
      dimension: 'admin',
      key: `admin/role/${MINTING}/PROPOSER_ROLE`,
      title: '',
      state: 'historical',
      stage: 'executed',
      severity: 'downgrade',
      floorBreach: false,
      red: true,
      ruleIds: ['AD-4'],
      tags: [],
      unannounced: null,
      announcement: 'not_checked',
      chainId: 1,
      block: 100,
      stillInEffect: true,
      notes: [],
    }) as unknown as ConfigChange
  const run = (sAt100: Controller | null) => {
    const r = redRow()
    rejudgeRoleHoldersAtHead([r], events, {
      ctlAt: (a, b) => (a === MC && b === 100 ? tl(10 * DAY, [eoa(EOA)], { address: MC }) : null),
      ctlRanked: (a) => (a === S ? sAt100 : null),
      ctlHead: (a) => (a === MC ? tl(10 * DAY, [safe(A('a2'), 2, 3)], { address: MC }) : null),
      administers: () => false,
      head: 1000,
      subject: 'z',
      announcement: 'not_checked',
    })
    return r
  }
  it('the holder it was ranked against was NOT read: still in effect (was "NO LONGER IN EFFECT")', () => {
    const r = run(null)
    expect(r.stillInEffect).toBe(true)
    expect(r.notes?.join(' ')).not.toMatch(/NO LONGER IN EFFECT/)
    expect(r.notes?.join(' ')).toMatch(/not read/)
  })
  it('the holder it was ranked against rests on a read gap: still in effect', () => {
    expect(run(tl(7 * DAY, undefined, { address: S })).stillInEffect).toBe(true)
  })
  it('control: a READ comparison holder the grantee now matches ends it', () => {
    expect(run(eoa(S)).stillInEffect).toBe(false)
  })
})

// =====================================================================================================
describe('R-5: getLogs cross-checks every sub-range of an adaptive split (UQ-23)', () => {
  it('the primary refuses > 1,000 blocks, then answers one half false-empty: both logs found (was 1)', async () => {
    const log = (b: number) => ({ blockNumber: '0x' + b.toString(16), logIndex: '0x0' })
    const all = [log(100), log(1500)]
    const inRange = (p: { fromBlock: string; toBlock: string }) =>
      all.filter(
        (l) =>
          Number(l.blockNumber) >= Number(p.fromBlock) &&
          Number(l.blockNumber) <= Number(p.toBlock),
      )
    const primary = {
      request: async ({ params }: { params: { fromBlock: string; toBlock: string }[] }) => {
        const p = params[0]
        if (Number(p.toBlock) - Number(p.fromBlock) > 1000) throw new Error('range too large')
        // the half holding block 100 comes back false-empty
        if (Number(p.fromBlock) <= 100 && Number(p.toBlock) >= 100) return []
        return inRange(p)
      },
    }
    const secondary = {
      request: async ({ params }: { params: { fromBlock: string; toBlock: string }[] }) =>
        inRange(params[0]),
    }
    const r = await crossCheckedLogs(primary, secondary, {
      address: A('a6'),
      topics0: ['0x01'],
      fromBlock: 0,
      toBlock: 2000,
    })
    expect(r.logs).toHaveLength(2)
    expect(r.corrected).toBe(true)
  })
})

// =====================================================================================================
// a mock chain for `classify`: contracts with an owner() each, a Safe, EOAs elsewhere
const world = (o: {
  owners?: Record<string, string>
  safes?: Record<string, { t: number; owners: string[] }>
  /** Multicall3 is not deployed before this block: every multicall entry fails. */
  mc3From?: number
  /** Direct eth_calls fail with a transport error (not a revert). */
  transportDown?: boolean
}) => {
  const owners = o.owners ?? {}
  const safes = o.safes ?? {}
  const view = (a: string, fn: string): { ok: boolean; v?: unknown } => {
    if (fn === 'owner' && owners[a]) return { ok: true, v: owners[a] }
    if (safes[a] && fn === 'getThreshold') return { ok: true, v: BigInt(safes[a].t) }
    if (safes[a] && fn === 'getOwners') return { ok: true, v: safes[a].owners }
    if (safes[a] && fn === 'VERSION') return { ok: true, v: '1.1.1' }
    return { ok: false }
  }
  return {
    getCode: async ({ address }: { address: string }) =>
      owners[address.toLowerCase()] || safes[address.toLowerCase()] ? '0x60806040' : '0x',
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: { address: string; functionName: string }[]
      blockNumber?: bigint
    }) =>
      contracts.map((c) => {
        if (o.mc3From !== undefined && blockNumber !== undefined && blockNumber < BigInt(o.mc3From))
          return { status: 'failure' }
        const r = view(c.address.toLowerCase(), c.functionName)
        return r.ok ? { status: 'success', result: r.v } : { status: 'failure' }
      }),
    getStorageAt: async ({ address, slot }: { address: string; slot: string }) =>
      safes[address.toLowerCase()] && BigInt(slot) === 0n ? SAFE_SINGLETON_WORD : ZERO_WORD,
    readContract: async (q: { address: string; functionName: string }) => {
      if (o.transportDown)
        throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' })
      const a = q.address.toLowerCase()
      if (safes[a] && q.functionName === 'getModulesPaginated')
        return [[], '0x0000000000000000000000000000000000000001']
      const r = view(a, q.functionName)
      if (r.ok) return r.v
      throw revert()
    },
  }
}

describe('R-6: an owner chain cut at the hop limit is a read gap', () => {
  const C1 = A('c1')
  const C2 = A('c2')
  const C3 = A('c3')
  it('contract → contract → contract → EOA: the third owner is not followed — a read gap, not a silent [2]', async () => {
    const c = await classify(world({ owners: { [C1]: C2, [C2]: C3, [C3]: EOA } }), C1, 20_000_000)
    expect(controllerRank(c)).toEqual([2])
    expect(rankHasReadGap(c)).toBe(true)
    // it shows on the card
    const lines = [c, c.ownedBy!, c.ownedBy!.ownedBy!].flatMap(nodeReadGaps)
    expect(lines.join(' ')).toMatch(/owner .* not followed/)
    // Safe 2/3 → it: red (it is no read stronger than a key)
    expect(isRed(classifyControllerChange(safe(A('a8'), 2, 3), c))).toBe(true)
    expect(describeController(c)).toMatch(/not followed/)
  })
  it('control: contract → contract → EOA is followed to the EOA ([1], no gap)', async () => {
    const c = await classify(world({ owners: { [C1]: C2, [C2]: EOA } }), C1, 20_000_000)
    expect(controllerRank(c)).toEqual([1])
    expect(rankHasReadGap(c)).toBe(false)
  })
})

describe('R-7 / O-10: before Multicall3 (block 14,353,601) classify reads each view directly', () => {
  const S = A('15') // shape of 0x1597d1…: a Safe 2-of-3 at block 11,473,299
  const owners3 = [A('f1'), A('f2'), A('f3')]
  it('a Safe 2-of-3 at block 11,473,299 is a Safe (was a plain contract with no marker)', async () => {
    const c = await classify(
      world({ safes: { [S]: { t: 2, owners: owners3 } }, mc3From: 14_353_601 }),
      S,
      11_473_299,
    )
    expect(c).toMatchObject({ kind: 'safe', threshold: 2, signers: 3 })
  })
  it('a direct read that fails on transport (not a revert) fails the classification (fail closed)', async () => {
    await expect(
      classify(
        world({
          safes: { [S]: { t: 2, owners: owners3 } },
          mc3From: 14_353_601,
          transportDown: true,
        }),
        S,
        11_473_299,
      ),
    ).rejects.toThrow()
  })
  it('control: after Multicall3 the batched read is used as before', async () => {
    const c = await classify(
      world({ safes: { [S]: { t: 2, owners: owners3 } }, mc3From: 14_353_601 }),
      S,
      20_000_000,
    )
    expect(c).toMatchObject({ kind: 'safe', threshold: 2, signers: 3 })
  })
})

// =====================================================================================================
describe('O-4: a past-block classification that FAILED never falls back to the head one', () => {
  const TX = ('0x2aac8dd0' + '0'.repeat(56)) as Hx
  const events = [
    row({
      tx: TX,
      logIndex: 1,
      event: 'MemberAdded',
      args: { addr: A('f1'), newTotalMembers: '3', newQuorum: '2' },
    }),
    row({
      tx: TX,
      logIndex: 2,
      event: 'CallExecuted',
      emitter: TL,
      args: { target: HC, data: '0x' + A('f1').slice(2) },
    }),
  ]
  const s = subject({
    timelocks: [TL],
    contracts: [
      { role: 'token', dimension: 'admin', chainId: 1, address: PROXY, label: 'p', deployBlock: 1 },
      {
        role: 'oracle',
        dimension: 'oracle',
        chainId: 1,
        address: HC,
        label: 'hc',
        deployBlock: 10,
      },
    ],
  })
  const raw = (failed: string[]) =>
    rawOf({
      admin: {
        events,
        controllers: { [`${TL}@head`]: tl(7 * DAY, [SAFE_6_11]) },
        txTo: { [TX]: TL },
        classifyFailed: failed,
      },
    })
  const committeeRow = (out: ReturnType<typeof build>) =>
    out.changes.find((c) => c.key === `oracle/committee/${HC}`)!
  it('the path timelock could not be classified at block − 1: RED, "could not be classified" (was judged on its head read)', () => {
    const r = committeeRow(build(s, raw([`${TL}@99`])))
    expect(r.red).toBe(true)
    expect(r.notes?.join(' ')).toMatch(/could not be classified/)
  })
  it('control: a key never requested at the block still uses the head read (neutral)', () => {
    expect(committeeRow(build(s, raw([]))).red).toBe(false)
  })
})

// =====================================================================================================
describe('collector: enrichTokenVotes examines holders until the weakest passing set is settled', () => {
  const W = holderAddr(0) // a Safe 4/7 at 8 %
  const snap = {
    supply: (1000n * E18).toString(),
    holderCount: 5000,
    top: [
      [W, (80n * E18).toString()],
      [holderAddr(1), (60n * E18).toString()],
      [holderAddr(2), (10n * E18).toString()],
      [holderAddr(3), (5n * E18).toString()],
    ],
  }
  const client = world({
    safes: {
      [W]: { t: 4, owners: [A('f1'), A('f2'), A('f3'), A('f4'), A('f5'), A('f6'), A('f7')] },
    },
  })
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
  const opts = {
    head: 20_000_000,
    decide: tokenVoteDecision,
    snapshotsFor: async (_t: string, blocks: number[]) => new Map(blocks.map((b) => [b, snap])),
  }
  it('a Safe whale first: the EOA that also passes alone is examined — ranked [1] (was [4, 4, −7])', async () => {
    const v = vote()
    await enrichTokenVotes(client, { [`${VOTING}@19000000`]: v }, opts)
    expect(v.voting?.holders?.map((h) => h.address)).toEqual([W, holderAddr(1)])
    expect(controllerRank(v)[0]).toBe(1)
  })
  it('a cached node enriched under the old rule (stopped at the Safe) is read again', async () => {
    const v = vote()
    v.voting = {
      ...v.voting!,
      supply: snap.supply,
      holderCount: 5000,
      truncated: true,
      holders: [{ address: W, balance: snap.top[0][1], ctl: safe(W, 4, 7) }],
    }
    const n = await enrichTokenVotes(client, { [`${VOTING}@19000000`]: v }, opts)
    expect(n).toBe(1)
    expect(controllerRank(v)[0]).toBe(1)
  })
  it('a holder whose classification failed is a read gap now, and is read again next run', async () => {
    const v = vote()
    const broken = { ...client, getCode: async () => Promise.reject(new Error('fetch failed')) }
    const solo = { ...snap, top: [snap.top[0], snap.top[2]] }
    const o2 = {
      ...opts,
      snapshotsFor: async (_t: string, b: number[]) => new Map(b.map((x) => [x, solo])),
    }
    await enrichTokenVotes(broken, { [`${VOTING}@19000000`]: v }, o2)
    expect(v.voting?.holders?.[0].ctl).toBeUndefined()
    expect(rankHasReadGap(v)).toBe(true)
    const n = await enrichTokenVotes(client, { [`${VOTING}@19000000`]: v }, o2)
    expect(n).toBe(1)
    expect(v.voting?.holders?.[0].ctl?.kind).toBe('safe')
    expect(rankHasReadGap(v)).toBe(false)
  }, 20_000)
})
