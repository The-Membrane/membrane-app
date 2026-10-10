// Config cards — the review of the fail-closed audit (2026-10-10). Two refuters (on-chain, rules)
// found read paths that still read calmer or dropped a red on a failed read:
//   OC-1  a PARTLY read holder (a rank resting on a read gap) judged as a calm plain contract —
//         owner / admin / delegate moves, role grants, price oracles, CCIP rebalancers, role admins
//   OC-1 / rules #5  a row RE-DERIVED calmer than the previous run's red, with a read failing
//         under it (a lost earlier event, a failed classification): the calm row replaced the red
//   OC-2 / rules #1  "left the scope" judged on a scope built from a failed read
//   OC-3  the LayerZero delegate change (and a queued changeProxyAdmin) without `prevUnread`
//   OC-4 / rules #2  the oracle collector's log confirmation checked only an adaptive read's
//         joined answer (a false-empty half next to a non-empty one was accepted)
//   rules #3  a Safe reached through a holder whose tree was not read left the snapshot
//   rules #4  a Safe guard / fallback handler whose read at block − 1 FAILED read "none before"
//   rules #6  a `:role-head:` red dropped when its RoleGranted was not re-read
//   rules #7  a queued op with a call index never seen crashed the collector
// Every test failed on the code before its fix unless it is marked (control).

import { encodeFunctionData, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  rejudgeRoleHoldersAtHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  judgeCall,
  timelockChanges,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  classifyCcip,
  classifyControllerChange,
  classifyParamChange,
  classifyRoleAdminChange,
  classifyRoleGrant,
  isRed,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  ParamSpec,
  SubjectState,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import { callAddressArgs } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { confirmedLogs, crossCheckedRange } from '@/scripts/oracle-registry/lib/confirmLogs.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const PROXY = A('1')
const SAFE = A('6')
const SAFE2 = A('5')
const TL = A('7')
const EOA = A('e')
const POOL = A('c')
const OAPP = A('a')
const H = A('2')
const C = A('3')
const ZERO32 = '0x' + '0'.repeat(64)
const HEAD1 = 30_000_000
const HEAD2 = 30_007_200
const HEAD3 = 30_014_400

const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, n: number, o: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  modules: [],
  ...o,
})
const timelock = (
  a: string,
  delaySec: number,
  schedulers: Controller[],
  o: Partial<Controller> = {},
): Controller => ({ kind: 'oz_timelock', address: a, delaySec, schedulers, ...o })
const contract = (a: string, o: Partial<Controller> = {}): Controller => ({
  kind: 'contract',
  address: a,
  ...o,
})
const SAFE_6_11 = safe(SAFE, 6, 11)
// the same holders, PARTLY read: a rank that rests on a read gap
const safeModulesUnread = safe(SAFE, 6, 11, { modulesUnread: true, modules: undefined })
const tl10dUnread = timelock(TL, 10 * 86400, [], { schedulersUnread: true })
const ownerUnread = (a: string) => contract(a, { ownerUnread: true })

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
type Patch = {
  head?: number
  lz?: Partial<RawSubject['lz']>
  admin?: Partial<RawSubject['admin']>
  previousChanges?: { block: number; changes: ConfigChange[] }
  extra?: Record<string, unknown>
}
const rawOf = (o: Patch = {}): RawSubject =>
  ({
    version: 1,
    subjectKey: 'z',
    head: { block: o.head ?? HEAD1, ts: 2_000_000_000 },
    scan: { from: 1, to: o.head ?? HEAD1 },
    lz: {
      events: [],
      headRoutes: [],
      headDefaults: {},
      remote: [],
      codeProbes: {},
      dvnSigner: [],
      dvnHead: {},
      ...o.lz,
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
    ...(o.previousChanges ? { previousChanges: o.previousChanges } : {}),
    ...o.extra,
    warnings: [],
  }) as RawSubject
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const gaps = (st: SubjectState) => (st.readGaps ?? []).join('\n')
const scanGap = (from: number, to: number, addresses: string[]) => ({
  scanGaps: [{ scan: 'admin event scan', from, to, error: 'false-empty chunk', addresses }],
})

// =====================================================================================================
describe('OC-1: a PARTLY read holder (its rank rests on a read gap) is judged like an unread one, never calm', () => {
  it('(control) read: Safe 6-of-11 → a plain contract is red AD-3', () => {
    expect(classifyControllerChange(SAFE_6_11, contract(C)).ruleIds).toContain('AD-3')
  })
  it('Safe 6-of-11 with its module list unread → a plain contract: red AD-3, read gap (was neutral)', () => {
    const v = classifyControllerChange(safeModulesUnread, contract(C))
    expect(isRed(v)).toBe(true)
    expect(v.ruleIds).toContain('AD-3')
    expect(v.tags).toContain('read_gap')
    // the round-12 wording is kept: the previous holder's rank rests on a read gap
    expect(v.notes.join(' ')).toMatch(/previous holder's rank rests on a read gap/)
  })
  it('a 10-day timelock with its proposers unread → a plain contract: red AD-3, read gap (was neutral)', () => {
    const v = classifyControllerChange(tl10dUnread, contract(C))
    expect(v.ruleIds).toContain('AD-3')
    expect(v.tags).toContain('read_gap')
  })
  it('(control) read: a plain contract → a 1 h timelock an EOA proposes into is red AD-3', () => {
    expect(classifyControllerChange(contract(C), timelock(TL, 3600, [eoa(EOA)])).ruleIds).toContain(
      'AD-3',
    )
  })
  it('a plain contract → a 1 h timelock whose proposers were NOT read: red AD-3, read gap (was a calm "rotation")', () => {
    const v = classifyControllerChange(
      contract(C),
      timelock(TL, 3600, [], { schedulersUnread: true }),
    )
    expect(v.ruleIds).toContain('AD-3')
    expect(v.tags).toContain('read_gap')
    expect(v.tags).not.toContain('rotation')
  })
  it('a plain contract → a contract whose owner() was not read: red AD-3, read gap (read, an EOA owner: red)', () => {
    expect(
      classifyControllerChange(contract(C), contract(H, { ownedBy: eoa(EOA) })).ruleIds,
    ).toContain('AD-3')
    const v = classifyControllerChange(contract(C), ownerUnread(H))
    expect(v.ruleIds).toContain('AD-3')
    expect(v.tags).toContain('read_gap')
  })
  it('a previous holder not read (null) → a new holder resting on a read gap: red AD-3 (was neutral)', () => {
    const v = classifyControllerChange(null, ownerUnread(H))
    expect(v.ruleIds).toContain('AD-3')
    expect(v.tags).toContain('read_gap')
  })
  it('(control) an EOA → a holder resting on a read gap: neutral with a read gap (nothing ranks below an EOA)', () => {
    const v = classifyControllerChange(eoa(EOA), tl10dUnread)
    expect(isRed(v)).toBe(false)
    expect(v.severity).not.toBe('upgrade')
    expect(v.tags).toContain('read_gap')
  })
  it('(control) a move to an immutable / renounced holder from a gap-ranked one is not red', () => {
    const v = classifyControllerChange(tl10dUnread, { kind: 'zero', address: ZERO32.slice(0, 42) })
    expect(isRed(v)).toBe(false)
  })

  it('role grants: DEFAULT_ADMIN / MINTER / PROPOSER to a contract whose owner() was not read are red AD-4 (were neutral)', () => {
    // read: the owner is an EOA → red
    expect(
      classifyRoleGrant('DEFAULT_ADMIN_ROLE', contract(H, { ownedBy: eoa(EOA) }), [SAFE_6_11], true)
        .ruleIds,
    ).toContain('AD-4')
    for (const role of ['DEFAULT_ADMIN_ROLE', 'MINTER_ROLE', 'PROPOSER_ROLE']) {
      const v = classifyRoleGrant(role, ownerUnread(H), [contract(C)], true)
      expect(v.ruleIds).toContain('AD-4')
      expect(v.tags).toContain('read_gap')
    }
  })
  it('role grants: to an Aragon Agent whose executors were not found (the wstETH pattern) is red AD-4', () => {
    const agent = contract(H, { version: 'Aragon Agent', executorsUnread: true })
    const v = classifyRoleGrant('DEFAULT_ADMIN_ROLE', agent, [contract(C)], true)
    expect(v.ruleIds).toContain('AD-4')
    expect(v.tags).toContain('read_gap')
  })
  it('role grants: a holder it is ranked against that rests on a read gap counts as unclassified (red AD-4)', () => {
    // read: a Safe 2-of-3 granted next to a 10-day timelock a Safe 6-of-11 proposes into is weaker → red
    expect(
      classifyRoleGrant(
        'DEFAULT_ADMIN_ROLE',
        safe(SAFE2, 2, 3),
        [timelock(TL, 10 * 86400, [SAFE_6_11])],
        true,
      ).ruleIds,
    ).toContain('AD-4')
    const v = classifyRoleGrant('DEFAULT_ADMIN_ROLE', safe(SAFE2, 2, 3), [tl10dUnread], true)
    expect(v.ruleIds).toContain('AD-4')
    expect(v.tags).toContain('read_gap')
  })

  const oracle: ParamSpec = {
    key: 'oracle',
    contract: PROXY,
    sig: 'function oracle() view returns (address)',
    rule: 'price_oracle',
    label: 'price oracle',
  }
  it('a price oracle moved to a contract whose owner() was not read: red MR-2, read gap (was amber logic_change)', () => {
    // read: the new oracle is owned by an EOA → red MR-2
    expect(
      classifyParamChange(oracle, SAFE2, H, contract(H, { ownedBy: eoa(EOA) }), {
        nextVerified: true,
      }).ruleIds,
    ).toContain('MR-2')
    const v = classifyParamChange(oracle, SAFE2, H, ownerUnread(H), { nextVerified: true })
    expect(v.ruleIds).toContain('MR-2')
    expect(v.tags).toContain('read_gap')
  })

  it('a CCIP rebalancer moved to a contract whose owner() was not read: red CC-3 (was neutral)', () => {
    expect(
      classifyCcip('rebalancer', {
        prevCtl: contract(C),
        nextCtl: contract(H, { ownedBy: eoa(EOA) }),
      }).ruleIds,
    ).toContain('CC-3')
    const v = classifyCcip('rebalancer', { prevCtl: contract(C), nextCtl: ownerUnread(H) })
    expect(v.ruleIds).toContain('CC-3')
    expect(v.tags).toContain('read_gap')
  })
  it('a CCIP rebalancer moved FROM a holder resting on a read gap: red CC-3 (was neutral)', () => {
    const v = classifyCcip('rebalancer', { prevCtl: safeModulesUnread, nextCtl: contract(H) })
    expect(v.ruleIds).toContain('CC-3')
    expect(v.tags).toContain('read_gap')
  })

  it('role admin: a previous admin side resting on a read gap → a plain contract is red AD-3; a new side resting on one is red too', () => {
    const v1 = classifyRoleAdminChange(
      'MINTER_ROLE',
      { name: 'A', holders: [tl10dUnread] },
      { name: 'B', holders: [contract(C)] },
    )
    expect(v1.ruleIds).toContain('AD-3')
    expect(v1.tags).toContain('read_gap')
    const v2 = classifyRoleAdminChange(
      'MINTER_ROLE',
      { name: 'A', holders: [contract(C)] },
      { name: 'B', holders: [ownerUnread(H)] },
    )
    expect(v2.ruleIds).toContain('AD-3')
    expect(v2.tags).toContain('read_gap')
  })
})

// =====================================================================================================
describe('OC-3: the LayerZero delegate change and a queued changeProxyAdmin judge an unread previous holder fail closed', () => {
  const del = (block: number, delegate: string, logIndex = 0) => ({
    kind: 'delegate' as const,
    chainId: 1,
    block,
    logIndex,
    tx: `0x${block.toString(16)}` as Hx,
    oapp: OAPP,
    delegate,
  })
  const run = (failed: boolean) =>
    build(
      subject({
        lzOApps: [OAPP],
        contracts: [
          {
            role: 'lz_oapp',
            dimension: 'bridge',
            chainId: 1,
            address: OAPP,
            label: 'oapp',
            deployBlock: 100,
          },
        ],
      }),
      rawOf({
        lz: { events: [del(100, SAFE), del(200, SAFE2)] },
        admin: {
          controllers: {
            ...(failed ? {} : { [`${SAFE}@199`]: SAFE_6_11 }),
            [`${SAFE2}@200`]: safe(SAFE2, 2, 3),
            [`${SAFE}@100`]: SAFE_6_11,
          },
          classifyFailed: failed ? [`${SAFE}@199`] : [],
        },
      }),
    )
  const row = (st: ReturnType<typeof build>) =>
    st.changes.find((c) => c.key === `admin/lz-delegate/${OAPP}` && c.block === 200)!
  it('(control) read: Safe 6-of-11 → Safe 2-of-3 is red AD-3', () => {
    expect(row(run(false)).ruleIds).toContain('AD-3')
  })
  it('the previous delegate not classified at block − 1: red AD-3 with a read gap (was neutral, no tag)', () => {
    const st = run(true)
    // the classification at 199 is missing and failed: no head fallback either
    const r = row(st)
    expect(r.red).toBe(true)
    expect(r.ruleIds).toContain('AD-3')
    expect(r.tags).toContain('read_gap')
  })
  it('a queued changeProxyAdmin on a ProxyAdmin not classified at head: red AD-3, read gap (was neutral)', () => {
    const PA = A('4')
    const abi = parseAbi(['function changeProxyAdmin(address proxy, address newAdmin)'])
    const q: QueueCtx = {
      subject: 's',
      announcement: 'not_checked',
      eval: { registry, code: () => true, useDeprecated: false } as EvalCtx,
      block: 1_000_000,
      endpoint: EP,
      routes: {},
      defaults: {},
      libDirection: () => null,
      ctl: (a) => (a === SAFE2 ? safe(SAFE2, 2, 3) : null),
      ownerOf: () => null,
      delegateOf: () => null,
      implHistory: {},
      minDelayOf: () => 86400,
      roleName: (h) => h,
      contracts: [PROXY, PA],
      oapps: [],
      verified: () => true,
    }
    const j = judgeCall(
      {
        target: PA,
        value: '0',
        data: encodeFunctionData({ abi, functionName: 'changeProxyAdmin', args: [PROXY, SAFE2] }),
      },
      q,
      { armed: false },
    )
    const v = j.find((x) => String(x.key).startsWith('admin/proxy_admin/'))!.v
    expect(v.ruleIds).toContain('AD-3')
    expect(v.tags).toContain('read_gap')
  })
})

// =====================================================================================================
describe('OC-2 / rules #1: "left the scope" is not trusted when the scope rests on a failed read', () => {
  const ownerMove = {
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0x64' as Hx,
    emitter: PROXY,
    event: 'OwnershipTransferred',
    args: { previousOwner: SAFE, newOwner: EOA },
  }
  const controllers = { [`${SAFE}@99`]: SAFE_6_11, [`${EOA}@100`]: eoa(EOA) }
  const run1 = build(subject(), rawOf({ admin: { events: [ownerMove], controllers } }))
  // a proposer Safe's red AD-1 row: its emitter is in scope only through a timelock role grant
  const gone = A('8')
  const old = { ...run1.changes[0], id: '1:0x99:0', key: `admin/multisig/${gone}` }
  const run2 = (extra: Record<string, unknown>, powers: RawSubject['admin']['powers'] = []) =>
    build(
      subject(),
      rawOf({
        head: HEAD2,
        admin: { controllers, scope: [A('9')], powers },
        previousChanges: { block: HEAD1, changes: [old] },
        extra,
      }),
    )
  it('(control) every read that builds the scope confirmed: the row left the scope and is dropped', () => {
    expect(run2({}).changes.find((c) => c.id === '1:0x99:0')).toBeUndefined()
  })
  it('an admin scan chunk not confirmed (the RoleGranted that put it in scope lost): the red is CARRIED', () => {
    const st = run2(scanGap(1, 250_000, [TL]))
    const r = st.changes.find((c) => c.id === '1:0x99:0')
    expect(r).toMatchObject({ red: true })
    expect(r!.tags).toContain('read_gap')
    expect(r!.notes!.join(' ')).toMatch(/scope rests on a failed read/)
    expect(gaps(st.state)).toMatch(/scope built on a failed read/)
  })
  it('a power path that failed to resolve (its via hops missing): the red is CARRIED', () => {
    const st = run2({}, [
      { power: 'upgrade', label: 'P', contract: PROXY, holders: [], error: 'timeout' },
    ])
    expect(st.changes.find((c) => c.id === '1:0x99:0')).toMatchObject({ red: true })
  })
})

// =====================================================================================================
describe('OC-1 / rules #5: a row RE-DERIVED calmer than the red the previous run judged, with a read failing under it, keeps the red', () => {
  const SEL = '5009297550715157269'
  const poolEv = (block: number, pool: string): AdminEventRow => ({
    chainId: 1,
    block,
    logIndex: 0,
    tx: `0x${block.toString(16)}` as Hx,
    emitter: POOL,
    event: 'RemotePoolAdded',
    args: { remoteChainSelector: SEL, remotePoolAddress: pool },
  })
  const s = subject({ ccipPools: [POOL] })
  const run1 = build(
    s,
    rawOf({ admin: { events: [poolEv(100_000, SAFE), poolEv(600_000, SAFE2)] } }),
  )
  const second = run1.changes.find((c) => c.block === 600_000)!
  it('(control) run 1: the second remote pool for an already-served chain is red CC-1', () => {
    expect(second.red).toBe(true)
    expect(second.ruleIds).toContain('CC-1')
  })
  const run2 = (extra: Record<string, unknown>) =>
    build(
      s,
      rawOf({
        head: HEAD2,
        admin: { events: [poolEv(600_000, SAFE2)] },
        previousChanges: { block: HEAD1, changes: run1.changes },
        extra,
      }),
    )
  it('run 2 lost the first add in an unconfirmed chunk: the second stays red (it read route_created, red count 1 → 0)', () => {
    const st = run2(scanGap(1, 250_000, [POOL]))
    const rows = st.changes.filter((c) => c.id === second.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ red: true })
    expect(rows[0].ruleIds).toContain('CC-1')
    expect(rows[0].tags).toContain('read_gap')
    expect(rows[0].notes!.join(' ')).toMatch(/RE-DERIVED CALMER this run/)
    expect(st.state.counts.red).toBeGreaterThanOrEqual(1)
    expect(gaps(st.state)).toMatch(/re-derived calmer/)
  })
  it('(control) every read confirmed: the re-derived verdict stands (a relaxed rule takes effect)', () => {
    const st = run2({})
    const r = st.changes.find((c) => c.id === second.id)!
    expect(r.red).toBe(false)
    expect(r.notes?.join(' ') ?? '').not.toMatch(/RE-DERIVED CALMER/)
  })
  it('a classification that failed at or before the row also keeps the red', () => {
    const st = run2({})
    expect(st.changes.find((c) => c.id === second.id)!.red).toBe(false)
    const st2 = build(
      s,
      rawOf({
        head: HEAD2,
        admin: { events: [poolEv(600_000, SAFE2)], classifyFailed: [`${SAFE}@599999`] },
        previousChanges: { block: HEAD1, changes: run1.changes },
      }),
    )
    expect(st2.changes.find((c) => c.id === second.id)!.red).toBe(true)
  })
})

// =====================================================================================================
describe('rules #6: a `:role-head:` red whose RoleGranted was not re-read is carried', () => {
  const ROLE = '0x' + '0'.repeat(64)
  const prevRow: ConfigChange = {
    id: `1:role-head:${PROXY}:${ROLE}:${SAFE}:${HEAD1}`,
    subject: 'z',
    dimension: 'admin',
    key: `admin/role/${PROXY}/DEFAULT_ADMIN_ROLE`,
    title: 'DEFAULT_ADMIN_ROLE holder weakened since its grant',
    before: SAFE,
    after: SAFE,
    state: 'historical',
    stage: 'executed',
    severity: 'downgrade',
    floorBreach: false,
    red: true,
    ruleIds: ['AD-4'],
    tags: ['bracketed'],
    unannounced: null,
    announcement: 'not_checked',
    chainId: 1,
    block: HEAD1,
    blockFrom: 100,
    stillInEffect: true,
  }
  const opts = {
    ctlAt: () => null,
    ctlRanked: () => null,
    ctlHead: (a: string) => (a === SAFE ? safe(SAFE, 1, 5) : null),
    administers: () => false,
    head: HEAD2,
    subject: 'z',
    announcement: 'not_checked' as const,
    previous: [prevRow],
  }
  it('the grant chunk lost this run (no RoleGranted, no RoleRevoked): the red row is carried, in effect, read gap (was dropped)', () => {
    const out = rejudgeRoleHoldersAtHead([], [], opts)
    const r = out.find((c) => c.id === prevRow.id)
    expect(r).toMatchObject({ red: true, stillInEffect: true })
    expect(r!.tags).toContain('read_gap')
  })
  it('(control) a RoleRevoked for that holder seen this run ends it: not carried', () => {
    const revoke: AdminEventRow = {
      chainId: 1,
      block: 500,
      logIndex: 0,
      tx: '0x1f4' as Hx,
      emitter: PROXY,
      event: 'RoleRevoked',
      args: { role: ROLE, account: SAFE },
    }
    expect(rejudgeRoleHoldersAtHead([], [revoke], opts)).toEqual([])
  })
  it('end to end: the carried row is a listed read gap', () => {
    const st = build(
      subject(),
      rawOf({ head: HEAD2, previousChanges: { block: HEAD1, changes: [prevRow] } }),
    )
    expect(st.changes.find((c) => c.id === prevRow.id)).toMatchObject({ red: true })
    expect(gaps(st.state)).toMatch(/grant behind it was not re-read/)
  })
})

// =====================================================================================================
describe('rules #3: a Safe behind a holder whose tree was not read keeps its snapshot baseline', () => {
  const s = subject({
    powers: [{ power: 'upgrade', contract: PROXY, path: ['owner'], label: 'P' }],
  })
  const raw = (
    head: number,
    holder: Controller,
    more: Record<string, Controller>,
    prevSafes?: SubjectState['safeSnapshot'],
    prevBlock?: number,
  ) =>
    rawOf({
      head,
      admin: {
        powers: [{ power: 'upgrade', label: 'P', contract: PROXY, holders: [H] }],
        controllers: { [`${H}@head`]: holder, ...more },
        ...(prevSafes
          ? {
              previousSafes: {
                block: prevBlock!,
                controllers: Object.fromEntries(prevSafes.map((c) => [c.address, c])),
              },
            }
          : {}),
      },
    })
  const S35 = safe(SAFE, 3, 5)
  const run1 = build(s, raw(HEAD1, contract(H, { ownedBy: S35 }), { [`${SAFE}@head`]: S35 })).state
  it('(control) run 1: the Safe that owns the holder is in the snapshot', () => {
    expect(run1.safeSnapshot!.map((c) => c.address)).toContain(SAFE)
  })
  for (const [label, run2Holder, run2More] of [
    ['the holder read with owner() unread, the Safe not classified', ownerUnread(H), {}],
    [
      'the holder read with owner() unread, the Safe re-read at head',
      ownerUnread(H),
      { [`${SAFE}@head`]: S35 },
    ],
  ] as [string, Controller, Record<string, Controller>][]) {
    it(`${label}: the Safe stays in the snapshot, and run 3 shows its silent threshold drop (was: no row)`, () => {
      const run2 = build(s, raw(HEAD2, run2Holder, run2More, run1.safeSnapshot, HEAD1)).state
      expect(run2.safeSnapshot!.map((c) => c.address)).toContain(SAFE)
      const S25 = safe(SAFE, 2, 5)
      const run3 = build(
        s,
        raw(
          HEAD3,
          contract(H, { ownedBy: S25 }),
          { [`${SAFE}@head`]: S25 },
          run2.safeSnapshot,
          HEAD2,
        ),
      )
      const r = run3.changes.find(
        (c) => c.id.includes(':safe-head:') && c.key === `admin/multisig/${SAFE}`,
      )
      expect(r?.red).toBe(true)
    })
  }
  it('the holder not classified at head at all: the Safe is carried in the snapshot', () => {
    const run2 = build(s, {
      ...raw(HEAD2, contract(H), {}, run1.safeSnapshot, HEAD1),
      admin: {
        ...raw(HEAD2, contract(H), {}, run1.safeSnapshot, HEAD1).admin,
        controllers: {},
        headClassifyFailed: [H],
      },
    } as RawSubject).state
    expect(run2.safeSnapshot!.map((c) => c.address)).toContain(SAFE)
  })
})

// =====================================================================================================
describe('rules #4: a Safe guard whose read at block − 1 FAILED is not "none before"', () => {
  const G2 = A('9')
  const ev: AdminEventRow = {
    chainId: 1,
    block: 300,
    logIndex: 0,
    tx: '0x12c' as Hx,
    emitter: SAFE,
    event: 'ChangedGuard',
    args: { guard: G2 },
  }
  const ctx = (failed: boolean) => ({
    subject: 's',
    ctl: () => null,
    ctlExact: (a: string, b: number) =>
      !failed && a === SAFE && b === 299 ? safe(SAFE, 3, 5, { guard: ZERO32.slice(0, 42) }) : null,
    prevUnread: (a: string, b: number) => failed && a === SAFE && b === 299,
    upgradeTimelocks: {},
    deployBlocks: { [SAFE]: 100 },
    tokens: [],
    announcement: 'not_checked' as const,
  })
  it('(control) read at block − 1 with no guard: adding one is an upgrade (ruling AD-6)', () => {
    const out = classifyAdminEvents([ev], ctx(false))
    expect(out[0].severity).toBe('upgrade')
  })
  it('the read at block − 1 FAILED (the Safe deployed inside the scan, no earlier event): red AD-6, read gap (was an upgrade)', () => {
    const out = classifyAdminEvents([ev], ctx(true))
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-6')
    expect(out[0].tags).toContain('read_gap')
  })
})

// =====================================================================================================
describe('OC-4 / rules #2: the oracle collector cross-checks every piece of a split read', () => {
  const L1 = { transactionHash: '0x01', logIndex: 0, blockNumber: 100n, topics: ['0xaa'] }
  const L2 = { transactionHash: '0x02', logIndex: 0, blockNumber: 9_000n, topics: ['0xbb'] }
  // the primary refuses the whole 10k range (a result-size limit) and answers its first half
  // FALSE-EMPTY; the second endpoint has the log
  const primary = async (from: bigint, to: bigint) => {
    if (to - from > 6_000n) throw new Error('query returned more than 10000 results')
    if (to < 5_000n) return [] // false-empty
    return [L2]
  }
  const secondary = async (from: bigint, to: bigint) =>
    [L1, L2].filter((l) => l.blockNumber >= from && l.blockNumber <= to)
  it('(control, the pre-fix composition) an adaptive split INSIDE the read lost L1: only the joined answer was checked', async () => {
    const adaptive = async (
      read: (f: bigint, t: bigint) => Promise<unknown[]>,
      f: bigint,
      t: bigint,
      depth = 0,
    ): Promise<unknown[]> => {
      try {
        return await read(f, t)
      } catch (e) {
        if (t - f < 500n || depth > 6) throw e
        const mid = f + (t - f) / 2n
        return [
          ...(await adaptive(read, f, mid, depth + 1)),
          ...(await adaptive(read, mid + 1n, t, depth + 1)),
        ]
      }
    }
    const got = await confirmedLogs(
      () => adaptive(primary, 0n, 9_999n),
      () => adaptive(secondary, 0n, 9_999n),
    )
    expect(got).toEqual([L2])
  })
  it('crossCheckedRange: each half is checked on its own — L1 is recovered from the second endpoint', async () => {
    expect(await crossCheckedRange(primary, secondary, 0n, 9_999n)).toEqual([L1, L2])
  })
  it('a second-endpoint answer that is split: a false-empty piece is asked again on the first endpoint', async () => {
    const p = async (from: bigint, to: bigint) =>
      to - from > 6_000n ? [] : [L1, L2].filter((l) => l.blockNumber >= from && l.blockNumber <= to)
    const s2 = async (from: bigint, to: bigint) => {
      if (to - from > 6_000n) throw new Error('range too large')
      return from === 0n ? [L1] : [] // false-empty second piece
    }
    expect(await crossCheckedRange(p, s2, 0n, 9_999n)).toEqual([L1, L2])
  })
  it('a piece neither endpoint can read throws (the range is not read), and no second endpoint throws on empty', async () => {
    const fail = async () => {
      throw new Error('timeout')
    }
    await expect(crossCheckedRange(async () => [], fail, 0n, 100n)).rejects.toThrow()
    await expect(crossCheckedRange(async () => [], null, 0n, 100n)).rejects.toThrow()
    // control: both endpoints confirm empty
    expect(
      await crossCheckedRange(
        async () => [],
        async () => [],
        0n,
        100n,
      ),
    ).toEqual([])
  })
})

// =====================================================================================================
describe('rules #7: a queued op with a call index never seen does not crash the collector or the queue', () => {
  const abi = parseAbi(['function transferOwnership(address newOwner)'])
  const data = encodeFunctionData({ abi, functionName: 'transferOwnership', args: [EOA] })
  // a hole at index 0 (its CallScheduled log lost), as admin.mjs opsFromEvents builds it
  const calls: { target: string; value: string; data: string }[] = []
  calls[1] = { target: PROXY, value: '0', data }
  it('callAddressArgs skips the hole (the inline loop threw a TypeError and stopped the run)', () => {
    expect(() => {
      for (const c of calls) void String((c as { data: string }).data)
    }).toThrow(TypeError)
    expect(callAddressArgs(calls)).toEqual([EOA])
  })
  it('the queue judges the calls seen; a null call (the raw file through JSON) is skipped', () => {
    const op = {
      timelock: TL,
      id: '0xop',
      calls: JSON.parse(JSON.stringify(calls)),
      callsIncomplete: true,
      predecessor: ZERO32,
      delaySec: 86400,
      scheduledBlock: 10,
      scheduledTx: '0xs',
      timestamp: 1_000_000_000,
      predecessorDone: true,
      simulation: 'not_run',
    } as unknown as TimelockOp
    const q = {
      subject: 's',
      announcement: 'not_checked',
      eval: { registry, code: () => true, useDeprecated: false },
      block: 1_000_000,
      endpoint: EP,
      routes: {},
      defaults: {},
      libDirection: () => null,
      ctl: (a: string) => (a === EOA ? eoa(EOA) : null),
      ownerOf: () => SAFE,
      delegateOf: () => null,
      implHistory: {},
      minDelayOf: () => 86400,
      roleName: (h: string) => h,
      contracts: [PROXY],
      oapps: [],
      verified: () => true,
    } as unknown as QueueCtx
    const rows = timelockChanges([op], q, 2_000_000_000)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].tags).toContain('read_gap')
  })
})
