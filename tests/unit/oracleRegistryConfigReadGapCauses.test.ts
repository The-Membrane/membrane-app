// Config cards — R3 (2026-10-12, review of F4): RV11-1 — a card never renders a read gap it does not
// count — held for the weETH shapes only. A row judged on a collector read that FAILED (the previous
// FiatToken role / Dual Governance holder / permission manager), a source verification that was not
// read, a Kernel SetApp for an app the unread app ids do not map, a committee change whose
// transaction recipient was not read, a Safe change whose deploy block is unknown, a queued upgrade
// on an incomplete implementation history and a queued setConfig on a library the LayerZero
// metadata does not list were tagged (READ GAP / VERIFICATION LOOKUP FAILED) and listed nowhere; an
// unclassified oracle source was listed TWICE (F4's past-read line repeated it). Each test failed
// on the code before the fix unless it is marked (control).
// Synthetic fixtures, one shape per contract; the on-chain shapes they copy are named.

import { encodeFunctionData, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import type { AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import type { TimelockOp } from '@/lib/oracleRegistry/config/queue'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  ParamSpec,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import {
  buildConfigCard,
  buildConfigSummary,
  readGapsOf,
  type ConfigInputs,
} from '@/lib/oracleRegistry/config/view'

import { causeListed, restsOnAGap } from './oracleRegistryReadGapCause'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const n = (b: number) => b.toLocaleString('en-US')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const ZERO32 = ('0x' + '0'.repeat(64)) as Hx
const HEAD = 22_000_000
const NOW = 1_800_000_000
const B = (i: number) => 21_000_000 + i * 1000

// ---- the subject's contracts: one read_gap shape each --------------------------------------------
const OWN1 = A('11') // owner change: previous owner's classification FAILED at block − 1
const OWN2 = A('12') // owner change: new owner's classification FAILED at block (R2)
const PRX = A('13') // AdminChanged to an admin never classified (R2, c < 0)
const OWN3 = A('14') // Safe → a timelock whose proposers were unread, and back (rank gaps)
const RR = A('15') // a grant ranked against a co-holder not classified at the block
const FT = A('16') // FiatToken: MasterMinter / Blacklister getters failed at block − 1 (PH-12)
const APP = A('17') // Aragon app: getPermissionManager failed at block − 1
const DGT = A('18') // Dual Governance: getGovernance / getAfterSubmitDelay failed at block − 1
const UPX = A('19') // AD-5: upgrade holders not read at block − 1
const UPV = A('1a') // AD-9: new implementation, verification lookup gave no answer
const KERNEL = A('1b') // TV-10: Kernel SetApp for an app the unread app ids do not map
const CM1 = A('1c') // committee change: the transaction's recipient not read
const CM2 = A('1d') // committee change through a path controller not classified
const CM3 = A('1e') // committee change: the declared power over it not read
const SAFE1 = A('1f') // Safe guard change: the Safe not classified at block − 1
const SAFE2 = A('20') // Safe module change, deploy block unknown, no code at block − 1 (ST-04 b)
const CAPC = A('21') // a parameter change the bisection could not resolve (PO-02)
const ORC = A('22') // price oracle → a contract not classified (CL-08)
const RPC = A('23') // rate provider replaced, verification lookup gave no answer
const ORACLE = A('24') // oracle: a source not classified, an implementation unverifiable
const OWN9 = A('25') // a red row of the previous run not re-derived (carried)
const UPQ = A('26') // queued upgrade on a proxy with no implementation history (QU-08)
const UPQ2 = A('27') // queued upgrades: an unverifiable implementation; an op missing calls
const OWNQ = A('28') // queued transferOwnership, owner() not read at head
const TL = A('29') // the declared timelock (committee path, AD-5 fallback, queue)
const OAPP = A('2b') // queued setConfig on a library the LayerZero metadata does not list (LZ-13)
const ACL = A('2a')
// ---- holders --------------------------------------------------------------------------------------
const P1 = A('31')
const SAFE_A = A('32')
const N2 = A('33')
const N3 = A('34')
const TLU = A('35') // a timelock whose proposers were not read
const H0 = A('36')
const SAFE_B = A('37')
const N9 = A('38')
const GOV = A('39')
const IMPL_U = A('3a')
const IMPL_V = A('3b')
const APPX = A('3c')
const APPY = A('3d')
const M1 = A('3e')
const M2 = A('3f')
const OTHER = A('40')
const G1 = A('41')
const MOD = A('42')
const OLDO = A('43')
const NEWO = A('44')
const OLDR = A('45')
const NEWR = A('46')
const SRC = A('47')
const OIMPL = A('48')
const IMPLQ = A('49')
const IMPLQ3 = A('4a')
const CURQ2 = A('4b')
const ASSET = A('4c')
const LIBX = A('4d')
const ROLE = '0x' + '0'.repeat(64)
const ROLE2 = '0x' + '0b'.repeat(32)
const TXC1 = ('0x' + 'c1'.repeat(32)) as Hx
const TXC2 = ('0x' + 'c2'.repeat(32)) as Hx
const TXC3 = ('0x' + 'c3'.repeat(32)) as Hx

const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const declared = [
  OWN1,
  OWN2,
  PRX,
  OWN3,
  RR,
  FT,
  APP,
  DGT,
  UPX,
  UPV,
  KERNEL,
  CM1,
  CM2,
  CM3,
  SAFE1,
  CAPC,
  ORC,
  RPC,
  OWN9,
  UPQ,
  UPQ2,
  OWNQ,
]
const params: ParamSpec[] = [
  {
    key: 'cap1',
    contract: CAPC,
    sig: 'function cap() view returns (uint256)',
    rule: 'cap',
    label: 'deposit cap',
  },
  {
    key: 'oracle1',
    contract: ORC,
    sig: 'function oracle() view returns (address)',
    rule: 'price_oracle',
    label: 'price oracle',
  },
  {
    key: 'rp1',
    contract: RPC,
    sig: 'function rateProvider() view returns (address)',
    rule: 'rate_provider',
    label: 'rate provider',
  },
]
const subject = (): ConfigSubject => ({
  key: 'r3',
  label: 'R3',
  oracleAssetKey: 'r3-asset',
  class: 'lrt',
  contracts: [
    ...declared.map((address) => ({
      role: 'config' as const,
      dimension: 'admin' as const,
      chainId: 1 as const,
      address,
      label: short(address),
      deployBlock: 20_000_000,
    })),
    {
      role: 'timelock' as const,
      dimension: 'admin' as const,
      chainId: 1 as const,
      address: TL,
      label: 'timelock',
      deployBlock: 19_000_000,
    },
  ],
  lzOApps: [OAPP],
  ccipPools: [],
  powers: [{ power: 'oracle', contract: CM3, path: ['owner'], label: 'CM3 owner' }],
  params,
  timelocks: [TL],
  safes: [],
  govChannels: [],
})

const ev = (o: Partial<AdminEventRow> & Pick<AdminEventRow, 'block' | 'event' | 'emitter'>) =>
  ({
    chainId: 1,
    logIndex: 0,
    tx: `0x${o.block.toString(16)}${String(o.logIndex ?? 0).padStart(2, '0')}` as Hx,
    args: {},
    ...o,
  }) as AdminEventRow
const safe = (address: string): Controller => ({ kind: 'safe', address, threshold: 3, signers: 5 })
const tlu: Controller = {
  kind: 'oz_timelock',
  address: TLU,
  delaySec: 2 * 86400,
  schedulersUnread: true,
}
const memberData = (m: string) => `0xdeadbeef${'0'.repeat(24)}${m.slice(2)}`

const events: AdminEventRow[] = [
  ev({
    block: B(1),
    event: 'OwnershipTransferred',
    emitter: OWN1,
    args: { previousOwner: P1, newOwner: SAFE_A },
  }),
  ev({
    block: B(2),
    event: 'OwnershipTransferred',
    emitter: OWN2,
    args: { previousOwner: SAFE_A, newOwner: N2 },
  }),
  ev({
    block: B(3),
    event: 'AdminChanged',
    emitter: PRX,
    args: { previousAdmin: SAFE_A, newAdmin: N3 },
  }),
  ev({
    block: B(4),
    event: 'OwnershipTransferred',
    emitter: OWN3,
    args: { previousOwner: SAFE_A, newOwner: TLU },
  }),
  ev({
    block: B(5),
    event: 'OwnershipTransferred',
    emitter: OWN3,
    args: { previousOwner: TLU, newOwner: SAFE_A },
  }),
  ev({
    block: B(6),
    event: 'RoleGranted',
    emitter: RR,
    args: { role: ROLE, account: H0, sender: SAFE_A, roleName: 'DEFAULT_ADMIN_ROLE' },
  }),
  ev({
    block: B(7),
    event: 'RoleGranted',
    emitter: RR,
    args: { role: ROLE, account: SAFE_B, sender: SAFE_A, roleName: 'DEFAULT_ADMIN_ROLE' },
  }),
  // weETH 0x8221…9f2a: a grant to a timelock whose proposers were not read at the grant block
  ev({
    block: B(28),
    event: 'RoleGranted',
    emitter: RR,
    args: { role: ROLE2, account: TLU, sender: SAFE_A },
  }),
  ev({
    block: B(8),
    event: 'MasterMinterChanged',
    emitter: FT,
    args: { newMasterMinter: SAFE_B },
    prev: null,
    prevUnread: true,
  }),
  ev({
    block: B(9),
    event: 'BlacklisterChanged',
    emitter: FT,
    args: { newBlacklister: N9 },
    prev: null,
    prevUnread: true,
  }),
  ev({
    block: B(10),
    event: 'PermissionManagerChanged',
    emitter: APP,
    args: { role: ROLE, manager: SAFE_B, acl: ACL, roleName: 'MANAGE_ROLE' },
    prev: null,
    prevUnread: true,
  }),
  ev({
    block: B(11),
    event: 'GovernanceSet',
    emitter: DGT,
    args: { newGovernance: GOV },
    prev: null,
    prevUnread: true,
  }),
  ev({
    block: B(12),
    event: 'AfterSubmitDelaySet',
    emitter: DGT,
    args: { newAfterSubmitDelay: 86400 },
    prev: null,
    prevUnread: true,
  }),
  ev({ block: B(13), event: 'Upgraded', emitter: UPX, args: { implementation: IMPL_U } }),
  ev({ block: B(14), event: 'Upgraded', emitter: UPV, args: { implementation: IMPL_V } }),
  ev({
    block: B(15),
    event: 'Upgraded',
    emitter: KERNEL,
    args: {
      implementation: APPX,
      via: 'SetApp',
      appId: '0x' + 'ab'.repeat(32),
      kernel: KERNEL,
      appUnread: true,
    },
  }),
  // committee: a member added, then an unrelated timelocked call — the recipient not read
  ev({ block: B(16), event: 'MemberAdded', emitter: CM1, args: { member: M1 }, tx: TXC1 }),
  ev({
    block: B(16),
    logIndex: 1,
    event: 'CallExecuted',
    emitter: TL,
    tx: TXC1,
    args: { id: '0x01', index: 0, target: OTHER, data: '0x' },
  }),
  // committee: added through the declared timelock, which was not classified at block − 1
  ev({ block: B(17), event: 'MemberAdded', emitter: CM2, args: { member: M2 }, tx: TXC2 }),
  ev({
    block: B(17),
    logIndex: 1,
    event: 'CallExecuted',
    emitter: TL,
    tx: TXC2,
    args: { id: '0x02', index: 0, target: CM2, data: memberData(M2) },
  }),
  ev({ block: B(18), event: 'MemberAdded', emitter: CM3, args: { member: M1 }, tx: TXC3 }),
  ev({ block: B(19), event: 'ChangedGuard', emitter: SAFE1, args: { guard: G1 } }),
  ev({ block: B(20), event: 'EnabledModule', emitter: SAFE2, args: { module: MOD } }),
]

const ABI = parseAbi([
  'function upgradeTo(address impl)',
  'function transferOwnership(address newOwner)',
  'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
])
const call = (target: string, fn: 'upgradeTo' | 'transferOwnership', arg: string) => ({
  target,
  value: '0',
  data: encodeFunctionData({ abi: ABI, functionName: fn, args: [arg as Hx] }),
})
const setConfig = {
  target: EP,
  value: '0',
  data: encodeFunctionData({
    abi: ABI,
    functionName: 'setConfig',
    args: [OAPP, LIBX, [{ eid: 30101, configType: 2, config: '0x' }]],
  }),
}
const op = (id: string, calls: ReturnType<typeof call>[], o: Partial<TimelockOp> = {}) =>
  ({
    timelock: TL,
    id,
    calls,
    predecessor: ZERO32,
    delaySec: 86400,
    scheduledBlock: B(27),
    scheduledTx: `0x${id.slice(2)}`,
    timestamp: NOW - 60,
    predecessorDone: true,
    simulation: 'ok',
    ...o,
  }) as TimelockOp

// the previous run's red row on OWN9, which this run's events no longer show (carried)
const carried: ConfigChange = {
  id: '1:0x9999:0',
  subject: 'r3',
  dimension: 'admin',
  key: `admin/owner/${OWN9}`,
  title: `owner of ${short(OWN9)}: Safe 3/5 → EOA ${short(P1)}`,
  state: 'historical',
  stage: 'executed',
  severity: 'downgrade',
  floorBreach: false,
  red: true,
  ruleIds: ['AD-3'],
  tags: [],
  unannounced: null,
  announcement: 'no_gov_channel',
  chainId: 1,
  block: B(26),
  before: SAFE_A,
  after: P1,
}

const rawOf = (o: Partial<RawSubject> = {}): RawSubject => ({
  version: 1,
  subjectKey: 'r3',
  head: { block: HEAD, ts: NOW },
  scan: { from: 20_000_000, to: HEAD },
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
    events,
    controllers: {
      [`${SAFE_A}@${B(1)}`]: safe(SAFE_A),
      [`${SAFE_A}@${B(2) - 1}`]: safe(SAFE_A),
      [`${SAFE_A}@${B(3) - 1}`]: safe(SAFE_A),
      [`${SAFE_A}@${B(4) - 1}`]: safe(SAFE_A),
      [`${TLU}@${B(4)}`]: tlu,
      [`${TLU}@${B(5) - 1}`]: tlu,
      [`${TLU}@${B(28)}`]: tlu,
      [`${SAFE_A}@${B(5)}`]: safe(SAFE_A),
      [`${H0}@${B(6)}`]: safe(H0),
      [`${SAFE_B}@${B(7)}`]: safe(SAFE_B),
      [`${SAFE_B}@${B(8)}`]: safe(SAFE_B),
      [`${SAFE_B}@${B(10)}`]: safe(SAFE_B),
      [`${GOV}@${B(11)}`]: { kind: 'contract', address: GOV },
      [`${SAFE2}@${B(20) - 1}`]: { kind: 'eoa', address: SAFE2 },
      [`${OLDO}@${B(22) - 1}`]: safe(OLDO),
      [`${OLDR}@${B(23) - 1}`]: safe(OLDR),
      [`${NEWR}@${B(23)}`]: safe(NEWR),
      [`${SAFE_B}@head`]: safe(SAFE_B),
      [`${NEWO}@head`]: safe(NEWO),
      [`${NEWR}@head`]: safe(NEWR),
    },
    classifyFailed: [
      `${P1}@${B(1) - 1}`,
      `${N2}@${B(2)}`,
      `${SAFE1}@${B(19) - 1}`,
      `${NEWO}@${B(22)}`,
    ],
    powers: [
      {
        power: 'oracle',
        label: 'CM3 owner',
        contract: CM3,
        holders: [],
        error: 'owner() reverted',
      },
    ],
    timelockAdmins: [],
    implHistory: {
      [UPQ2]: { impls: [{ impl: CURQ2, block: B(2) }], current: CURQ2 },
    },
    owners: {},
    ownersUnread: [OWNQ],
    delegates: {},
    minDelays: { [TL]: 86400 },
    upgradeHoldersAt: {},
    upgradeHoldersUnread: [`${UPX}@${B(13)}`],
    upgradeHoldersUnreadWhy: { [`${UPX}@${B(13)}`]: 'owner() reverted' },
    aragonAppsUnread: [APPY],
    txTo: { [TXC1]: null, [TXC2]: null, [TXC3]: null },
    verification: {
      [IMPL_U]: true,
      [APPX]: true,
      [IMPLQ]: true,
      [CURQ2]: true,
      [OIMPL]: null,
    },
  },
  params: {
    head: { cap1: '200', oracle1: NEWO, rp1: NEWR },
    transitions: [
      {
        key: 'cap1',
        block: B(21),
        blockFrom: B(21) - 500,
        before: '100',
        after: '200',
        unresolved: true,
      },
      { key: 'oracle1', block: B(22), blockFrom: B(22) - 1, before: OLDO, after: NEWO },
      { key: 'rp1', block: B(23), blockFrom: B(23) - 1, before: OLDR, after: NEWR },
    ],
    unread: [
      {
        key: 'cap1',
        from: B(21) - 500,
        to: B(21),
        reason: 'a bisection read failed: intermediate values not read',
      },
    ],
    from: 20_000_000,
  },
  oracle: {
    events: [
      {
        block: B(24),
        tx: '0xo1',
        logIndex: 0,
        emitter: ORACLE,
        event: 'AssetSourceUpdated',
        args: { asset: ASSET, source: SRC },
        entryIds: ['r3-asset'],
      },
      {
        block: B(25),
        tx: '0xo2',
        logIndex: 0,
        emitter: ORACLE,
        event: 'Upgraded',
        args: { implementation: OIMPL },
        entryIds: ['r3-asset'],
      },
    ],
    window: { startBlock: 20_000_000, endBlock: HEAD, days: 30 },
  },
  queues: {
    ops: [
      op('0x' + 'a1'.repeat(32), [call(UPQ, 'upgradeTo', IMPLQ)]),
      op('0x' + 'a2'.repeat(32), [call(UPQ2, 'upgradeTo', IMPLQ3)]),
      op('0x' + 'a3'.repeat(32), [call(UPQ2, 'upgradeTo', IMPLQ)], { callsIncomplete: true }),
      op('0x' + 'a4'.repeat(32), [call(OWNQ, 'transferOwnership', SAFE_B)]),
      op('0x' + 'a5'.repeat(32), [setConfig]),
    ],
    safe: [],
    safeStatus: [],
  },
  ccip: { pools: [] },
  previousChanges: { block: HEAD - 100, changes: [carried] },
  warnings: [],
  ...o,
})
const build = (raw: RawSubject = rawOf()) =>
  buildSubject(subject(), raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })

const gapsOf = (raw: RawSubject = rawOf()) => build(raw).state.readGaps ?? []
const row = (out: ReturnType<typeof build>, key: string, block: number, tag?: string) =>
  [...out.changes, ...out.queue].find(
    (c) =>
      c.key.toLowerCase() === key.toLowerCase() &&
      c.block === block &&
      // 'gap': tagged read_gap or verification_unread
      (!tag || (tag === 'gap' ? restsOnAGap(c) : c.tags.includes(tag as never))),
  )

// =====================================================================================================
describe('R3 (a) PH-12: a row judged on a previous holder / value the collector could not read is listed', () => {
  it('FiatToken MasterMinter / Blacklister, an Aragon permission manager, Dual Governance governance: one line each, at block − 1 (was none)', () => {
    const gaps = gapsOf()
    for (const [what, b] of [
      [`MasterMinter of ${short(FT)}`, B(8)],
      [`Blacklister of ${short(FT)}`, B(9)],
      [`permission manager of MANAGE_ROLE on ${short(APP)}`, B(10)],
      [`governance of ${short(DGT)}`, B(11)],
    ] as const)
      expect(gaps).toContain(
        `${what}: previous holder not read at block ${n(b - 1)} (a history row judged on it is fail closed)`,
      )
  })

  it('a Dual Governance delay whose previous value was not read: red AD-2, listed as a value (was none)', () => {
    const out = build()
    const c = row(out, `admin/timelock_delay/${DGT}/AfterSubmitDelaySet`, B(12))!
    expect(c.red).toBe(true)
    expect(out.state.readGaps).toContain(
      `Dual Governance after-submit delay of ${short(DGT)}: previous value not read at block ${n(B(12) - 1)} (a history row judged on it is fail closed)`,
    )
  })

  it('(control) the same read failed, but the events showed the previous manager: the row is judged on it — no line', () => {
    const again = ev({
      block: B(10) + 10,
      event: 'PermissionManagerChanged',
      emitter: APP,
      args: { role: ROLE, manager: SAFE_A, acl: ACL, roleName: 'MANAGE_ROLE' },
      prev: null,
      prevUnread: true,
    })
    const base = rawOf()
    const gaps = gapsOf({
      ...base,
      admin: {
        ...base.admin,
        events: [...events, again],
        controllers: { ...base.admin.controllers, [`${SAFE_A}@${B(10) + 10}`]: safe(SAFE_A) },
      },
    })
    expect(gaps.join(' ')).not.toContain(n(B(10) + 9))
  })
})

// =====================================================================================================
describe('R3 (b) R2: a new holder that could not be classified is listed by the past-read lines (control)', () => {
  it('a classification that failed at the block, one never made, and "neither" holder read: each listed at its block', () => {
    const gaps = gapsOf()
    for (const [a, b] of [
      [N2, B(2)],
      [N3, B(3)],
      [N9, B(9)],
    ] as const)
      expect(gaps).toContain(
        `${short(a)} could not be classified at block ${n(b)} (a history row judged on it is fail closed)`,
      )
  })
})

// =====================================================================================================
describe('R3 (c) AD-9: a source verification that was not read is listed', () => {
  it('an implementation, a Dual Governance governance contract, a rate provider, an oracle implementation, a queued upgrade (was none)', () => {
    const gaps = gapsOf()
    for (const [a, b] of [
      [IMPL_V, B(14)],
      [GOV, B(11)],
      [NEWR, B(23)],
      [OIMPL, B(25)],
      [IMPLQ3, B(27)],
    ] as const)
      expect(gaps).toContain(
        `source verification of ${short(a)} not read — the row at block ${n(b)} judged fail closed (AD-9)`,
      )
  })

  it('(control) a lookup that ANSWERED "not verified" is no read gap: not listed', () => {
    const base = rawOf()
    const gaps = gapsOf({
      ...base,
      admin: { ...base.admin, verification: { ...base.admin.verification, [IMPL_V]: false } },
    })
    expect(gaps.join(' ')).not.toContain(short(IMPL_V))
  })
})

// =====================================================================================================
describe('R3 (d)–(h): the other causes a row rested on, listed nowhere', () => {
  it('(d) TV-10: Aragon app ids not read — named, with the Kernel SetApp judged on them (was none: warnings only)', () => {
    expect(gapsOf()).toContain(
      `Aragon app ids of ${short(APPY)} not read (kernel() / appId()): a Kernel SetApp for an app they do not map is judged as an upgrade of an unknown app (fail closed) — Kernel ${short(KERNEL)} at block ${n(B(15))}`,
    )
  })

  it('(e) a committee change whose transaction recipient was not read (was none)', () => {
    expect(gapsOf()).toContain(
      `transaction ${short(TXC1)} at block ${n(B(16))}: recipient not read — oracle committee ${short(CM1)} could not be matched to its delayed governance path (AD-5 judged fail closed)`,
    )
  })

  it('(f) ST-04 b: a Safe change with its deploy block unknown and no code one block before (was none)', () => {
    expect(gapsOf()).toContain(
      `Safe ${short(SAFE2)}: deploy block not read — no code one block before its change at block ${n(B(20))} is no proof of its setup (judged as a change, fail closed)`,
    )
  })

  it('(g) QU-08: a queued upgrade on an incomplete implementation history (was none)', () => {
    expect(gapsOf()).toContain(
      `upgrade history of ${short(UPQ)} incomplete (the install of its current implementation not read): a queued upgrade on it is judged fail closed (AD-8, a stale rollback cannot be ruled out)`,
    )
  })

  it('(h) LZ-13: a queued setConfig on a library the LayerZero metadata does not list (was none)', () => {
    expect(gapsOf()).toContain(
      `LayerZero library ${short(LIBX)} not in the LayerZero metadata (direction unknown): a queued setConfig for ${short(OAPP)} eid 30101 cannot be judged (fail closed)`,
    )
  })

  it('an unclassified oracle source is counted once (was twice: the OR-1 line and the F4 past-read line)', () => {
    const gaps = gapsOf()
    expect(gaps.filter((g) => g.includes(short(SRC)))).toEqual([
      `oracle source ${short(SRC)} at block ${B(24)} could not be classified`,
    ])
    expect(new Set(gaps).size).toBe(gaps.length)
  })
})

// =====================================================================================================
// RV11-1, every shape (R3; replaces F4's weETH-only test). Every producer of `read_gap` /
// `verification_unread` found by grep (tag(v, 'read_gap'), tags: [..., 'read_gap'],
// 'verification_unread') across lib/oracleRegistry/config — adminReplay.ts, rules.ts, engine.ts,
// queue.ts — built below through buildSubject, one contract each. NOT built here (each has a cause
// line by inspection, named; a fixture needs an LZ / NTT / CCIP route or a previous run's queue):
//   queue.ts LZ route not read at head / a mutate() that failed (BR-1; counted apart as UNREAD);
//   queue.ts NTT transceiver list not read (BR-6: "NTT manager …: threshold / transceivers not
//   read"); NTT peer not read at head (BR-6: "NTT manager …: peer for chain … not read");
//   rules.ts classifyCcip rebalancer previous / new not classified (CC-3: past-read lines);
//   adminReplay.ts DVN signer state carried (LZ-15: "DVN …: quorum / signers before block …");
//   engine.ts LZ delegate, previous not classified (OC-3: past-read lines); rules.ts
//   RoleAdminChanged admin sides (past-read and tree lines); engine.ts `:role-head:` carry
//   ("red row … carried"), queue carry ("NOT READ this run"), RE-DERIVED CALMER ("red history row
//   … re-derived calmer"); queue.ts PO-05 / PO-06 parameter setters (head lines: "<label>: not
//   read at head"), contract registry entry not classified at head (headClassifyFailed).
const SHAPES: { shape: string; key: string; block: number; tag?: string }[] = [
  {
    shape: 'previous owner not classified at block − 1 (PH-11)',
    key: `admin/owner/${OWN1}`,
    block: B(1),
  },
  { shape: 'new owner not classified at its block (R2)', key: `admin/owner/${OWN2}`, block: B(2) },
  {
    shape: 'proxy admin → an admin never classified (R2, c < 0)',
    key: `admin/proxy_admin/${PRX}`,
    block: B(3),
  },
  {
    shape: 'owner → a timelock whose proposers were not read (OC-1)',
    key: `admin/owner/${OWN3}`,
    block: B(4),
  },
  { shape: 'owner from that timelock (rules #5)', key: `admin/owner/${OWN3}`, block: B(5) },
  {
    shape: 'grant ranked against a co-holder not classified (PH-09)',
    key: `admin/role/${RR}/DEFAULT_ADMIN_ROLE`,
    block: B(7),
  },
  {
    shape: 'grant to a timelock whose proposers were not read (OC-1; weETH, F4)',
    key: `admin/role/${RR}/${ROLE2}`,
    block: B(28),
  },
  {
    shape: 'MasterMinter: previous holder getter failed (PH-12)',
    key: `admin/masterminter/${FT}`,
    block: B(8),
  },
  {
    shape: 'Blacklister: getter failed, new holder never classified',
    key: `admin/blacklister/${FT}`,
    block: B(9),
  },
  {
    shape: 'permission manager: getPermissionManager failed',
    key: `admin/permission_manager/${APP}/MANAGE_ROLE`,
    block: B(10),
  },
  {
    shape: 'Dual Governance governance: getter failed (read gap)',
    key: `admin/dg/${DGT}/GovernanceSet`,
    block: B(11),
    tag: 'read_gap',
  },
  {
    shape: 'Dual Governance governance: verification unread',
    key: `admin/dg/${DGT}/GovernanceSet`,
    block: B(11),
    tag: 'verification_unread',
  },
  {
    shape: 'AD-5: upgrade holders not read (F4)',
    key: `admin/implementation/${UPX}`,
    block: B(13),
  },
  {
    shape: 'AD-9: implementation verification unread',
    key: `admin/implementation/${UPV}`,
    block: B(14),
  },
  {
    shape: 'Kernel SetApp, app ids not read (TV-10)',
    key: `admin/implementation/${KERNEL}`,
    block: B(15),
  },
  {
    shape: 'committee: transaction recipient not read',
    key: `oracle/committee/${CM1}`,
    block: B(16),
  },
  {
    shape: 'committee: path controller not classified (UQ-19)',
    key: `oracle/committee/${CM2}`,
    block: B(17),
  },
  {
    shape: 'committee: the declared power over it not read',
    key: `oracle/committee/${CM3}`,
    block: B(18),
  },
  {
    shape: 'Safe guard: the Safe not classified at block − 1',
    key: `admin/safe/${SAFE1}/guard`,
    block: B(19),
  },
  {
    shape: 'Safe module: deploy block unknown (ST-04 b)',
    key: `admin/safe/${SAFE2}/module_enabled`,
    block: B(20),
  },
  { shape: 'parameter change unresolved (PO-02)', key: 'mint/cap1', block: B(21) },
  {
    shape: 'price oracle → a controller not classified (CL-08)',
    key: 'mint/oracle1',
    block: B(22),
  },
  { shape: 'rate provider replaced, verification unread', key: 'mint/rp1', block: B(23) },
  {
    shape: 'oracle source not classified (OR-1)',
    key: 'oracle/r3-asset/AssetSourceUpdated',
    block: B(24),
  },
  {
    shape: 'oracle implementation, verification unread',
    key: 'oracle/r3-asset/Upgraded',
    block: B(25),
  },
  {
    shape: "previous run's red row not re-derived (carried)",
    key: `admin/owner/${OWN9}`,
    block: B(26),
  },
  {
    shape: 'queued upgrade, implementation history incomplete (QU-08)',
    key: `admin/implementation/${UPQ}`,
    block: B(27),
    tag: 'read_gap',
  },
  {
    shape: 'queued upgrade, verification unread',
    key: `admin/implementation/${UPQ2}`,
    block: B(27),
    tag: 'verification_unread',
  },
  {
    shape: 'queued op with calls not read (QU-05)',
    key: `admin/implementation/${UPQ2}`,
    block: B(27),
    tag: 'read_gap',
  },
  {
    shape: 'queued transferOwnership, owner() not read at head (PH-11)',
    key: `admin/owner/${OWNQ}`,
    block: B(27),
  },
  {
    shape: 'queued setConfig, library not in the LayerZero metadata (LZ-13)',
    key: `bridge/lz/1/${OAPP}/30101/config`,
    block: B(27),
  },
]

describe('RV11-1 (every shape): a row that rests on a read gap always rests on one the card lists and counts', () => {
  it(`all ${SHAPES.length} shapes are built, and each row's cause is listed (was 12 unlisted)`, () => {
    const out = build()
    const gaps = out.state.readGaps ?? []
    const rows = [...out.changes, ...out.queue].filter(restsOnAGap)
    expect(
      SHAPES.filter((s) => !row(out, s.key, s.block, s.tag ?? 'gap')).map((s) => s.shape),
    ).toEqual([])
    const unlisted = rows.filter((c) => !causeListed(c, gaps))
    expect(unlisted.map((c) => `${c.key}@${c.block ?? 'queued'} [${c.tags.join(',')}]`)).toEqual([])
    // counted once each
    expect(new Set(gaps).size).toBe(gaps.length)
  })

  // S1 (2026-10-12): the view lists the rows of a STORED card whose cause its read gaps do not name
  // (oracleRegistryConfigStoredReadGaps.test.ts); on every shape the current engine builds it names
  // each cause already — the card adds no line and counts nothing twice.
  it('(control) S1: the card built from these shapes gets no untraced-rows line — its lines are the stored ones', () => {
    const out = build()
    const inputs: ConfigInputs = {
      subject: subject(),
      state: out.state,
      changes: out.changes,
      queue: out.queue,
    }
    const card = buildConfigCard(inputs)
    expect([...out.changes, ...out.queue].filter(restsOnAGap).length).toBeGreaterThan(0)
    expect(card.readGaps).toEqual(readGapsOf(out.state))
    expect((card.readGaps ?? []).join('\n')).not.toMatch(/judged on reads that failed/)
    expect(card.counts.readGaps).toBe(readGapsOf(out.state).length)
    expect(buildConfigSummary(inputs).counts.readGaps).toBe(card.counts.readGaps)
  })
})
