// Config cards — owner rulings 2026-10-08: #12 (a timelock ranks as its WEAKEST PROPOSER, its
// delay adding strength only at ≥ 24 h), #13 (oracle committee members replayed and judged by the
// path that changed them — closes KG-1), #14 (a floor breach whose value at risk is unread sorts
// first, labelled "value unread"), and KG-2 (the red banner counts floor-breach ROUTES).
// Each test failed on the code before the change (controls are marked). Synthetic fixtures.

import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256, pad, toHex } from 'viem'

import { breachBannerTitle } from '@/components/OracleRegistry/configViewModel'
import { kelpFraming } from '@/lib/oracleRegistry/config/backtest'
import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  markStillInEffect,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  classifyControllerChange,
  classifyRoleGrant,
  compareRank,
  controllerRank,
  describeController,
  isRed,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  StateItem,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { compareValueAtRisk, valueAtRiskLabel } from '@/lib/oracleRegistry/config/value'
import { breachesOf } from '@/lib/oracleRegistry/config/view'
import {
  ADMIN_TOPICS,
  TOPIC,
  decodeLog,
  roleHash,
} from '@/scripts/oracle-registry/config/lib/abi.mjs'
import { classify, timelockSchedulers } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { tokenVote } from './oracleRegistryVoteFixtures'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const SAFE = A('6')
const EOA = A('e')
const TL = A('c')
const PROXY = A('1')
const HC = A('d') // a HashConsensus-like committee
const EPT = A('7') // Dual Governance timelock
const VOTING = A('4')
const EXEC = A('5')
const AGENT = A('3')
const OTHER_TL = A('9')
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'

const safe = (a: string, t: number, n: number): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
})
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
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
// UQ-17: a token vote ranks by holder concentration — the fixture is broadly held (k = 13)
const voting = (sec = 432000): Controller => tokenVote(VOTING, { voteTimeSec: sec })
const dg = (schedulers: Controller[] | undefined): Controller => ({
  kind: 'aragon_dg',
  address: EPT,
  delaySec: 691200,
  ...(schedulers ? { schedulers } : {}),
  dg: {
    proposers: [VOTING],
    proposerVoteSec: 432000,
    afterSubmitDelaySec: 259200,
    afterScheduleDelaySec: 86400,
    governance: A('8'),
    adminExecutor: EXEC,
    emergencyGovernance: null,
    activationCommittee: null,
    executionCommittee: null,
    emergencyModeActive: false,
    emergencyProtectionEndsAfter: null,
  },
})
const SAFE_6_11 = safe(SAFE, 6, 11)
const DAY = 86_400

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
// UQ-19: the path controllers a committee test executes through, ranked (a Dual Governance
// timelock proposed by the broadly held vote; the vote itself)
const pathCtl = (a: string): Controller | null =>
  a === EPT ? dg([voting()]) : a === VOTING ? voting() : a === TL ? tl(2 * DAY, [SAFE_6_11]) : null
const actx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
  subject: 'z',
  ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? pathCtl(a),
  ctlExact: (a: string, b: number) => m[`${a}@${b}`] ?? null,
  upgradeTimelocks: {},
  deployBlocks: { [HC]: 10 },
  tokens: [],
  announcement: 'not_checked' as const,
  ...o,
})

// =====================================================================================================
describe('ruling #12: a timelock ranks as its weakest proposer; its delay adds strength only at ≥ 24 h', () => {
  it('Safe 6/11 → a 60 s timelock proposed by the same Safe is NEUTRAL', () => {
    const v = classifyControllerChange(SAFE_6_11, tl(60, [SAFE_6_11]))
    expect(v.severity).toBe('neutral')
    expect(isRed(v)).toBe(false)
  })
  it('Safe 6/11 → a 60 s timelock proposed by an EOA is RED (AD-3)', () => {
    const v = classifyControllerChange(SAFE_6_11, tl(60, [eoa(EOA)]))
    expect(isRed(v)).toBe(true)
    expect(v.ruleIds).toContain('AD-3')
  })
  // control (also an upgrade before the ruling, when every timelock outranked every Safe)
  it('Safe 6/11 → a 7-day timelock proposed by the same Safe is an UPGRADE', () => {
    expect(classifyControllerChange(SAFE_6_11, tl(7 * DAY, [SAFE_6_11])).severity).toBe('upgrade')
  })
  it('Safe 6/11 → a 10-day timelock proposed by an EOA is RED: a delay never rescues a weak proposer', () => {
    const v = classifyControllerChange(SAFE_6_11, tl(10 * DAY, [eoa(EOA)]))
    expect(isRed(v)).toBe(true)
    expect(v.ruleIds).toContain('AD-3')
  })
  it('a PROPOSER grant to an EOA on an existing timelock is RED, and the timelock drops in rank', () => {
    // the grant itself (AD-4)
    const g = classifyRoleGrant('PROPOSER_ROLE', eoa(EOA), [SAFE_6_11], true)
    expect(g.ruleIds).toContain('AD-4')
    // … and the timelock that holds a power is now as weak as that EOA
    const before = tl(7 * DAY, [SAFE_6_11])
    const after = tl(7 * DAY, [SAFE_6_11, eoa(EOA)])
    expect(compareRank(controllerRank(after), controllerRank(before))).toBe(-1)
    expect(controllerRank(after)[0]).toBe(1)
    const v = classifyControllerChange(before, after)
    expect(v.ruleIds).toContain('AD-3')
  })
  it('the delay credit starts at exactly 24 h (86,400 s)', () => {
    const r = (d: number) => controllerRank(tl(d, [SAFE_6_11]))
    expect(compareRank(r(DAY - 1), controllerRank(SAFE_6_11))).toBe(0)
    expect(compareRank(r(DAY), controllerRank(SAFE_6_11))).toBe(1)
    expect(compareRank(r(10 * DAY), r(7 * DAY))).toBe(1)
  })
  it('TIMELOCK_ADMIN / DEFAULT_ADMIN holders count as schedulers (they can grant PROPOSER)', () => {
    // a 10-day timelock proposed by a Safe whose admin role sits with an EOA ranks as the EOA
    const t = tl(10 * DAY, [SAFE_6_11, eoa(EOA)])
    expect(isRed(classifyControllerChange(SAFE_6_11, t))).toBe(true)
  })
  it('an unread proposer set ranks as a plain contract (fail closed) and says so', () => {
    const unread = tl(10 * DAY)
    expect(controllerRank(unread)).toEqual([2])
    expect(controllerRank(tl(10 * DAY, [SAFE_6_11], { schedulersUnread: true }))).toEqual([2])
    expect(isRed(classifyControllerChange(SAFE_6_11, unread))).toBe(true)
    expect(describeController(unread)).toMatch(/proposers UNREAD/)
    expect(describeController(tl(DAY, [eoa(EOA)]))).toMatch(/proposed by EOA/)
  })
  it('the description names the weakest proposer once — a proposer the timelock owns does not repeat it (found on the re-run: WBTC RBACTimelock / MCMS)', () => {
    const mcms: Controller = { kind: 'contract', address: A('ab'), ownedBy: tl(10800, [eoa(EOA)]) }
    const t = tl(10800, [mcms])
    const d = describeController(t)
    expect(d).toMatch(/\[proposed by contract 0xabab…abab → Timelock 3h 0xcccc…cccc\]$/)
    expect(d.match(/proposed by/g)).toHaveLength(1)
    // as a map callback (index as the 2nd argument), every holder keeps its note
    expect([t, t].map(describeController).every((x) => /proposed by/.test(x))).toBe(true)
  })
  it('Dual Governance: ranked through its Aragon Voting proposer (vote + after-submit credit)', () => {
    // 5 d vote + 3 d after submit: stronger than a Safe 6/11 and than the vote alone
    expect(compareRank(controllerRank(dg([voting()])), controllerRank(SAFE_6_11))).toBe(1)
    expect(compareRank(controllerRank(dg([voting()])), controllerRank(voting()))).toBe(1)
    // a governance reset to an EOA proposer: the DG timelock ranks with that EOA
    expect(isRed(classifyControllerChange(SAFE_6_11, dg([eoa(EOA)])))).toBe(true)
    // proposers unread: a plain contract
    expect(controllerRank(dg(undefined))).toEqual([2])
  })
  it('head-state breach: a power held by a timelock an EOA proposes into is AD-3 at head', () => {
    const s = subject({
      powers: [{ power: 'upgrade', contract: PROXY, path: ['eip1967_admin'], label: 'Upgrade P' }],
    })
    const out = build(
      s,
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade P', contract: PROXY, holders: [TL] }],
          controllers: { [`${TL}@head`]: tl(10 * DAY, [eoa(EOA)]) },
        },
      }),
    )
    const item = out.state.items.find((i) => i.key === `admin/power/upgrade/${PROXY}`)!
    expect(item.breaches.map((b) => b.ruleId)).toContain('AD-3')
    // control: proposed by the Safe, no breach
    const ok = build(
      s,
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade P', contract: PROXY, holders: [TL] }],
          controllers: { [`${TL}@head`]: tl(10 * DAY, [SAFE_6_11]) },
        },
      }),
    )
    expect(ok.state.items.find((i) => i.key === `admin/power/upgrade/${PROXY}`)!.breaches).toEqual(
      [],
    )
  })
  it('an unread proposer set at head is a READ GAP (never "no red flags")', () => {
    const out = build(
      subject({
        powers: [
          { power: 'upgrade', contract: PROXY, path: ['eip1967_admin'], label: 'Upgrade P' },
        ],
      }),
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade P', contract: PROXY, holders: [TL] }],
          controllers: { [`${TL}@head`]: tl(10 * DAY) },
        },
      }),
    )
    expect(out.state.readGaps?.join(' ')).toMatch(/proposers not read/)
  })
  it('previous-holder comparison in history: owner Safe 6/11 → a timelock an EOA proposes into is red', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: PROXY,
          event: 'OwnershipTransferred',
          block: 200,
          args: { previousOwner: SAFE, newOwner: TL },
        }),
      ],
      actx(
        { [`${SAFE}@199`]: SAFE_6_11, [`${TL}@200`]: tl(10 * DAY, [eoa(EOA)]) },
        { deployBlocks: { [PROXY]: 1 } },
      ),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-3')
  })
})

// ---- the collector reads the scheduler set ---------------------------------------------------------
describe('ruling #12, collector: timelockSchedulers reads PROPOSER and its admin role at the block', () => {
  const PROPOSER = roleHash('PROPOSER_ROLE').toLowerCase()
  const ADMIN = roleHash('TIMELOCK_ADMIN_ROLE').toLowerCase()
  const GRANTED = keccak256(toHex('RoleGranted(bytes32,address,address)'))
  const SINGLETON = '0x' + '0'.repeat(24) + 'd9db270c1b5e3bd161e8c8503c55ceabee709552'
  const owners = Array.from({ length: 11 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))
  const revert = () =>
    Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
  const world = (t: string, holders: Record<string, string[]>, logs = true) => ({
    getCode: async ({ address }: { address: string }) =>
      address.toLowerCase() === SAFE ? '0x60806040' : address.toLowerCase() === t ? '0x6080' : '0x',
    getBlockNumber: async () => 1000n,
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((c) =>
        c.address.toLowerCase() === SAFE && c.functionName === 'getThreshold'
          ? { status: 'success', result: 6n }
          : c.address.toLowerCase() === SAFE && c.functionName === 'getOwners'
            ? { status: 'success', result: owners }
            : { status: 'failure' },
      ),
    getStorageAt: async ({ address, slot }: { address: string; slot: string }) =>
      address.toLowerCase() === SAFE && BigInt(slot) === 0n ? SINGLETON : '0x' + '0'.repeat(64),
    readContract: async (q: { address: string; functionName: string; args?: unknown[] }) => {
      const a = q.address.toLowerCase()
      if (a === SAFE && q.functionName === 'getModulesPaginated')
        return [[], '0x0000000000000000000000000000000000000001']
      if (a !== t) throw revert()
      if (q.functionName === 'getRoleAdmin') return ADMIN
      if (q.functionName === 'hasRole')
        return (holders[String(q.args![0]).toLowerCase()] ?? []).includes(
          String(q.args![1]).toLowerCase(),
        )
      throw revert() // PROPOSER_ROLE() / getRoleMemberCount: OZ v4 answers the first, not the second
    },
    request: async ({ method, params }: { method: string; params: { address: string }[] }) =>
      method !== 'eth_getLogs' || !logs || params[0].address.toLowerCase() !== t
        ? []
        : Object.entries(holders).flatMap(([role, accts]) =>
            accts.map((acct) => ({
              topics: [GRANTED, role, pad(acct as Hx, { size: 32 }), pad(SAFE, { size: 32 })],
              data: '0x',
              blockNumber: '0x5',
            })),
          ),
  })
  it('PROPOSER held by a Safe 6/11, TIMELOCK_ADMIN by an EOA: both are schedulers', async () => {
    const t = A('a1')
    const r = await timelockSchedulers(world(t, { [PROPOSER]: [SAFE], [ADMIN]: [EOA, t] }), t, 900)
    expect(r.unread).toBe(false)
    // the timelock's own admin role (self-administration) is not a scheduler
    expect(r.schedulers.map((c: Controller) => [c.kind, c.address]).sort()).toEqual(
      [
        ['eoa', EOA],
        ['safe', SAFE],
      ].sort(),
    )
  })
  it('no PROPOSER candidate found (a false-empty log read): unread, fail closed', async () => {
    const t = A('a2')
    const r = await timelockSchedulers(world(t, { [PROPOSER]: [SAFE] }, false), t, 900)
    expect(r.unread).toBe(true)
  })
  it('classify: an OZ timelock carries its schedulers and ranks as the weakest', async () => {
    const t = A('a3')
    const sel = (sig: string) => keccak256(toHex(sig)).slice(2, 10)
    const code =
      '0x6080' +
      [
        'getMinDelay()',
        'getTimestamp(bytes32)',
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
        'execute(address,uint256,bytes,bytes32,bytes32)',
        'hashOperation(address,uint256,bytes,bytes32,bytes32)',
      ]
        .map((x) => '63' + sel(x) + '14')
        .join('') +
      '00'
    const w = world(t, { [PROPOSER]: [SAFE] })
    const c = await classify(
      {
        ...w,
        getCode: async ({ address }: { address: string }) =>
          address.toLowerCase() === t ? code : w.getCode({ address }),
        multicall: async (q: { contracts: { address: string; functionName: string }[] }) =>
          q.contracts[0].address.toLowerCase() === t
            ? q.contracts.map((x) =>
                x.functionName === 'getMinDelay'
                  ? { status: 'success', result: 604800n }
                  : { status: 'failure' },
              )
            : w.multicall(q),
      },
      t,
      900,
    )
    expect(c.kind).toBe('oz_timelock')
    expect(c.schedulers?.map((x: Controller) => x.kind)).toEqual(['safe'])
    // Safe 6/11 + 7 d: an upgrade over the Safe itself
    expect(compareRank(controllerRank(c), controllerRank(SAFE_6_11))).toBe(1)
  })
  it('a proposer that the timelock itself owns (a cycle) settles — no deadlock (found on the 2026-10-08 re-run)', async () => {
    const t = A('a4')
    const h = A('a5') // a plain contract whose owner() is the timelock
    const sel = (sig: string) => keccak256(toHex(sig)).slice(2, 10)
    const code =
      '0x6080' +
      [
        'getMinDelay()',
        'getTimestamp(bytes32)',
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
        'execute(address,uint256,bytes,bytes32,bytes32)',
        'hashOperation(address,uint256,bytes,bytes32,bytes32)',
      ]
        .map((x) => '63' + sel(x) + '14')
        .join('') +
      '00'
    const w = world(t, { [PROPOSER]: [h] })
    const c = await classify(
      {
        ...w,
        getCode: async ({ address }: { address: string }) =>
          address.toLowerCase() === t ? code : address.toLowerCase() === h ? '0x6080' : '0x',
        multicall: async (q: { contracts: { address: string; functionName: string }[] }) =>
          q.contracts.map((x) =>
            x.address.toLowerCase() === t && x.functionName === 'getMinDelay'
              ? { status: 'success', result: 604800n }
              : x.address.toLowerCase() === h && x.functionName === 'owner'
                ? { status: 'success', result: t }
                : { status: 'failure' },
          ),
      },
      t,
      900,
    )
    expect(c.kind).toBe('oz_timelock')
    expect(c.schedulers?.[0]).toMatchObject({ kind: 'contract', address: h })
  })
})

// =====================================================================================================
describe('ruling #13: oracle committee members are replayed and judged by the path (closes KG-1)', () => {
  const TX = ('0x2aac8dd0' + '0'.repeat(56)) as Hx
  const OLD = Array.from({ length: 9 }, (_, i) => A(String(i + 1)) + '')
  const NEW = Array.from({ length: 9 }, (_, i) => ('0x' + 'f' + String(i + 1).repeat(39)) as Hx)
  // the wstETH 2026 swap: 9 removed, 9 added, quorum 5, one Dual Governance execution
  const swap = (
    withPath: { event: string; emitter: string } | null,
    tx: Hx = TX,
  ): AdminEventRow[] => {
    const rows: AdminEventRow[] = []
    let li = 0
    for (let i = 0; i < 9; i++) {
      rows.push(
        row({
          block: 26_054_464,
          tx,
          logIndex: li++,
          event: 'MemberRemoved',
          args: { addr: OLD[i], newTotalMembers: '8', newQuorum: '5' },
        }),
      )
      rows.push(
        row({
          block: 26_054_464,
          tx,
          logIndex: li++,
          event: 'MemberAdded',
          args: { addr: NEW[i], newTotalMembers: '9', newQuorum: '5' },
        }),
      )
    }
    if (withPath)
      rows.push(
        row({
          block: 26_054_464,
          tx,
          logIndex: li++,
          event: withPath.event,
          emitter: withPath.emitter,
          args: {},
        }),
      )
    return rows
  }
  it('event signatures: HashConsensus and EtherFiOracle member events, and ExecuteVote, are scanned', () => {
    for (const [k, sig] of [
      ['MemberAdded', 'MemberAdded(address,uint256,uint256)'],
      ['MemberRemoved', 'MemberRemoved(address,uint256,uint256)'],
      ['CommitteeMemberAdded', 'CommitteeMemberAdded(address)'],
      ['CommitteeMemberRemoved', 'CommitteeMemberRemoved(address)'],
      ['CommitteeMemberUpdated', 'CommitteeMemberUpdated(address,bool)'],
      ['ExecuteVote', 'ExecuteVote(uint256)'],
    ]) {
      expect(TOPIC[k]).toBe(keccak256(toHex(sig)))
      expect(ADMIN_TOPICS).toContain(TOPIC[k])
    }
    const d = decodeLog({
      topics: [TOPIC.MemberAdded, pad(NEW[0], { size: 32 })],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [9n, 5n]),
      address: HC,
      blockNumber: '0x1',
      logIndex: '0x0',
      transactionHash: TX,
    })
    expect(d?.event).toBe('MemberAdded')
    expect(String(d?.args.addr).toLowerCase()).toBe(NEW[0])
  })
  it('a same-size full swap through Dual Governance shows as ONE neutral change (9 replaced, quorum 5)', () => {
    // review round 9: the transaction is SENT to the Dual Governance timelock (as on chain)
    const out = classifyAdminEvents(
      swap({ event: 'ProposalExecuted', emitter: EPT }),
      actx({}, { committeePaths: { [HC]: [EPT, VOTING] }, txTo: { [TX]: EPT } }),
    )
    expect(out).toHaveLength(1)
    const c = out[0]
    expect(c.key).toBe(`oracle/committee/${HC}`)
    expect(c.dimension).toBe('oracle')
    expect(c.red).toBe(false)
    expect(c.severity).toBe('neutral')
    expect(c.title).toMatch(/9 members replaced \(9 → 9 members, quorum 5\)/)
    expect(c.tags).toContain('rotation')
    expect((c.before as string[]).length).toBe(9)
    expect((c.after as string[]).length).toBe(9)
    expect(c.notes?.join(' ')).toMatch(/ProposalExecuted from 0x7777…7777/)
  })
  it('the same swap outside the declared path is RED (AD-5)', () => {
    const out = classifyAdminEvents(
      swap(null),
      actx({}, { committeePaths: { [HC]: [EPT, VOTING] } }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(['AD-5'])
    // an execution by a timelock that is NOT on the declared path does not count
    const other = classifyAdminEvents(
      swap({ event: 'CallExecuted', emitter: OTHER_TL }),
      actx({}, { committeePaths: { [HC]: [EPT, VOTING] } }),
    )
    expect(other[0].red).toBe(true)
  })
  it('the pre-DG path (an Aragon vote executed) is the declared path too', () => {
    const out = classifyAdminEvents(
      swap({ event: 'ExecuteVote', emitter: VOTING }),
      actx({}, { committeePaths: { [HC]: [EPT, VOTING] }, txTo: { [TX]: VOTING } }),
    )
    expect(out[0].red).toBe(false)
  })
  it('no declared path at all: red (fail closed); the deploy block is initialization (control)', () => {
    const x = classifyAdminEvents(
      [row({ block: 100, event: 'CommitteeMemberAdded', args: { member: EOA } })],
      actx({}),
    )
    expect(x[0].red).toBe(true)
    const init = classifyAdminEvents(
      [row({ block: 10, event: 'CommitteeMemberAdded', args: { member: EOA } })],
      actx({}),
    )
    expect(init[0].red).toBe(false)
    expect(init[0].tags).toContain('initialization')
  })
  it('ether.fi-style events: the replayed set gives the sizes; a disable counts as a removal', () => {
    // review round 9: as on chain, each member event is followed by the CallExecuted of the
    // timelock call that made it (target = the committee, calldata naming the member)
    const call = (logIndex: number, member: string) =>
      row({
        block: 100,
        tx: '0x1',
        logIndex,
        event: 'CallExecuted',
        emitter: TL,
        args: { target: HC, data: '0x3b4aea80' + member.slice(2).padStart(64, '0') },
      })
    const rows = [
      row({ block: 100, tx: '0x1', event: 'CommitteeMemberAdded', args: { member: A('a') } }),
      call(1, A('a')),
      row({
        block: 100,
        tx: '0x1',
        logIndex: 2,
        event: 'CommitteeMemberAdded',
        args: { member: A('b') },
      }),
      call(3, A('b')),
      row({
        block: 200,
        tx: '0x2',
        event: 'CommitteeMemberUpdated',
        args: { member: A('a'), enabled: false },
      }),
    ]
    const out = classifyAdminEvents(rows, actx({}, { committeePaths: { [HC]: [TL] }, scanFrom: 5 }))
    expect(out.map((c) => c.title)).toEqual([
      `oracle committee 0xdddd…dddd: 2 added (0 → 2 members)`,
      `oracle committee 0xdddd…dddd: 1 removed (2 → 1 members)`,
    ])
    expect(out.map((c) => c.red)).toEqual([false, true]) // the disable went through no timelock
  })
  it('STILL IN EFFECT: a red member add ends when that member is removed again', () => {
    const red: ConfigChange = {
      id: '1',
      subject: 'z',
      dimension: 'oracle',
      key: `oracle/committee/${HC}`,
      title: 'x',
      before: [],
      after: [EOA],
      state: 'historical',
      stage: 'executed',
      severity: 'downgrade',
      floorBreach: false,
      red: true,
      ruleIds: ['AD-5'],
      tags: [],
      unannounced: null,
      announcement: 'not_checked',
      chainId: 1,
      block: 100,
    }
    const fix: ConfigChange = {
      ...red,
      id: '2',
      before: [EOA],
      after: [],
      red: false,
      severity: 'neutral',
      ruleIds: [],
      block: 200,
    }
    const a = [{ ...red }]
    markStillInEffect(a)
    expect(a[0].stillInEffect).toBe(true)
    const b = [{ ...red }, fix]
    markStillInEffect(b)
    expect(b[0].stillInEffect).toBeFalsy()
  })
  it('engine: the declared path is read from the holders of the committee power (Agent → DG → Voting)', () => {
    const s = subject({
      contracts: [
        {
          role: 'oracle',
          dimension: 'oracle',
          chainId: 1,
          address: HC,
          label: 'HashConsensus',
          deployBlock: 1,
        },
        {
          role: 'timelock',
          dimension: 'admin',
          chainId: 1,
          address: EPT,
          label: 'EPT',
          deployBlock: 1,
        },
      ],
      powers: [
        {
          power: 'oracle',
          contract: HC,
          path: ['role:MANAGE_MEMBERS_AND_QUORUM_ROLE'],
          label: 'Oracle committee members',
        },
      ],
    })
    const agent: Controller = {
      kind: 'contract',
      address: AGENT,
      version: 'Aragon Agent',
      ownedBy: { kind: 'contract', address: EXEC, ownedBy: dg([voting()]) },
    }
    const run = (
      path: { event: string; emitter: string } | null,
      at: Record<string, Controller> = {},
    ) =>
      build(
        s,
        rawOf({
          admin: {
            powers: [
              {
                power: 'oracle',
                label: 'Oracle committee members',
                contract: HC,
                holders: [AGENT],
              },
            ],
            controllers: { [`${AGENT}@head`]: agent, ...at },
            events: swap(path),
            // review round 9: the transaction is sent to the path contract that executes it
            ...(path ? { txTo: { [TX]: path.emitter } } : {}),
          },
        }),
      ).changes.filter((c) => c.key === `oracle/committee/${HC}`)
    const viaDg = run({ event: 'ProposalExecuted', emitter: EPT })
    expect(viaDg).toHaveLength(1)
    expect(viaDg[0].red).toBe(false)
    // the pre-DG era: the Agent was executed by the Voting itself at the block (classified at
    // block − 1 by the collector) — the vote is not below it
    const votingEraAgent: Controller = {
      kind: 'contract',
      address: AGENT,
      version: 'Aragon Agent',
      executors: [voting()],
      ownedBy: voting(),
    }
    expect(
      run({ event: 'ExecuteVote', emitter: VOTING }, { [`${AGENT}@26054463`]: votingEraAgent })[0]
        .red,
    ).toBe(false)
    // UQ-19: in the DG era the same ExecuteVote path ranks BELOW the committee's controller (the
    // DG-governed Agent: vote + 3 d) — a change made through it is red
    expect(run({ event: 'ExecuteVote', emitter: VOTING })[0].red).toBe(true)
    const bypass = run(null)
    expect(bypass[0].red).toBe(true)
    expect(bypass[0].stillInEffect).toBe(true)
  })
})

// =====================================================================================================
describe('ruling #14: a floor breach whose value at risk is UNREAD sorts first, labelled "value unread"', () => {
  it('comparator and label', () => {
    expect(compareValueAtRisk({ usd: null }, { usd: 1e9 })).toBeLessThan(0)
    expect(compareValueAtRisk({ usd: 1e9 }, { usd: null })).toBeGreaterThan(0)
    expect(valueAtRiskLabel(null)).toMatch(/^value unread/)
    expect(
      valueAtRiskLabel({
        usd: null,
        lockedUsd: null,
        remoteSupplyUsd: null,
        basis: null,
        priceUsd: null,
        priceBasis: 'x',
        unread: ['no price (x)'],
      }),
    ).toBe('value unread (no price (x))')
  })
  it('the card lists the unread floor breach before a $300M one', () => {
    const item = (eid: number, usd: number | null): StateItem => ({
      subject: 'z',
      dimension: 'bridge',
      key: `bridge/route/1/${OAPP}/${eid}/receive`,
      chainId: 1,
      block: 1,
      display: `eid ${eid} (x) receive: E=1`,
      breaches: [{ ruleId: 'BR-2', message: 'floor' }],
      valueAtRisk: {
        usd,
        lockedUsd: usd,
        remoteSupplyUsd: null,
        basis: usd === null ? null : 'locked',
        priceUsd: usd === null ? null : 1,
        priceBasis: 'x',
        unread: usd === null ? ['locked balance not read'] : [],
      },
    })
    const b = breachesOf([item(30110, 300e6), item(30184, null)])
    expect(b.map((x) => x.valueAtRisk)).toEqual([
      'value unread (locked balance not read)',
      '$300M at risk (locked on Ethereum)',
    ])
  })

  it('the Kelp backtest framing says the unpriced breaches would be listed ahead of Kelp', () => {
    const f = kelpFraming(
      {
        redOnExploitedEidBeforeCutoff: { pass: true, count: 1, first: 'x', firstTs: 0 },
      } as unknown as Parameters<typeof kelpFraming>[0],
      { exploitedEid: 30320, cutoffTs: 381 * DAY, evalBlock: 24_908_284 },
      null,
      { usd: 295e6, basis: 'locked', rankByValue: 1, priced: 8, ofOApps: 825 },
    )
    expect(f.text).toMatch(/ranked #1 of the 8 priced/)
    expect(f.text).toMatch(/value unread.*those 817 would be listed ahead of this subject/)
  })
})

// =====================================================================================================
describe('KG-2: the red banner counts floor-breach ROUTES like the headline, sides in brackets', () => {
  it('one route breaching on two sides', () => {
    expect(breachBannerTitle(1, 2, 0)).toBe('1 FLOOR BREACH (2 sides) IN FORCE NOW')
  })
  it('sides equal to routes: no brackets; rule breaches follow', () => {
    expect(breachBannerTitle(2, 2, 1)).toBe('2 FLOOR BREACHES · 1 RULE BREACH IN FORCE NOW')
    expect(breachBannerTitle(0, 0, 3)).toBe('3 RULE BREACHES IN FORCE NOW')
    expect(breachBannerTitle(2, 3, 0)).toBe('2 FLOOR BREACHES (3 sides) IN FORCE NOW')
  })
})
