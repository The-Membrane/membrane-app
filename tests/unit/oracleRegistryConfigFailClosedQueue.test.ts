// Config cards — fail-closed audit (2026-10-10), part 4: QUEUES and RULES. A pending / proposed
// change judged against a head value that was NOT read is judged fail closed (never "previous
// holder unknown: neutral"), a previous red queue row is dropped only when its queue was READ this
// run, and the history replay never reads a failed previous-value read as "none". Also the Safe
// Transaction Service answers and the parameter grid. Every test failed on the code before its
// fix unless it is marked (control).

import { encodeFunctionData, pad, parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  classifyAdminEvents,
  classifyParamTransitions,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  carryUnreadQueueRows,
  rejudgeRoleHoldersAtHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  aragonCalls,
  judgeCall,
  safeProposalChanges,
  timelockChanges,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  classifyControllerChange,
  classifyNttThreshold,
  classifyRoleGrant,
  isRed,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  ParamSpec,
  UlnConfigRaw,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import { bisectChanges, paramTransitions } from '@/scripts/oracle-registry/config/lib/params.mjs'
import { safeQueue, safeQueues } from '@/scripts/oracle-registry/config/lib/safe.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const ZERO32 = '0x' + '0'.repeat(64)
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const NEWLIB = A('5')
const OAPP = A('a')
const PROXY = A('1')
const SAFE = A('6')
const TL = A('7')
const EOA = A('e')
const POOL = A('c')
const NTTM = A('8')
const WH = A('9')
const IMPL = A('3')
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const PEER2 = '0x000000000000000000000000d3eacf0612346366db554c991d7858716db09f59'
const ABI = parseAbi([
  'function setSendLibrary(address oapp, uint32 eid, address newLib)',
  'function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod)',
  'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
  'function setWormholePeer(uint16 chainId, bytes32 peerContract)',
  'function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit)',
  'function addRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
  'function setChainRateLimiterConfig(uint64 remoteChainSelector, (bool isEnabled, uint128 capacity, uint128 rate) outboundConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundConfig)',
  'function setRebalancer(address rebalancer)',
  'function setProvider(address provider)',
  'function setRateProvider(address provider)',
  'function upgradeTo(address impl)',
  'function grantRole(bytes32 role, address account)',
  'function transferOwnership(address newOwner)',
  'function setPermissionManager(address newManager, address app, bytes32 role)',
  'function transferAdminRole(address localToken, address newAdmin)',
  'function setApp(bytes32 namespace, bytes32 appId, address app)',
])
const call = (target: string, fn: string, args: unknown[]) => ({
  target,
  value: '0',
  data: encodeFunctionData({ abi: ABI, functionName: fn as never, args: args as never }),
})
const registry: DvnRegistry = {
  byChain: {
    1: { [LZ]: { id: 'layerzero-labs', name: 'LZ' }, [NM]: { id: 'nethermind', name: 'NM' } },
  },
  dead: { 1: [] },
  libraries: { 1: { send: [RECV, NEWLIB], receive: [RECV, NEWLIB], blocked: [], read: [] } },
}
const ctx: EvalCtx = { registry, code: () => true, useDeprecated: false }
const uln = (req: string[]): UlnConfigRaw => ({
  confirmations: '15',
  requiredDVNCount: req.length,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: req,
  optionalDVNs: [],
})
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, n: number): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  modules: [],
})
const timelock = (a: string, d: number): Controller => ({
  kind: 'oz_timelock',
  address: a,
  delaySec: d,
  schedulers: [safe(SAFE, 5, 7)],
})
const qctx = (o: Partial<QueueCtx> = {}): QueueCtx => ({
  subject: 's',
  announcement: 'not_checked',
  eval: ctx,
  block: 1_000_000,
  endpoint: EP,
  routes: {},
  defaults: {},
  libDirection: (l) => (l.toLowerCase() === RECV || l.toLowerCase() === NEWLIB ? 'receive' : null),
  ctl: () => null,
  ownerOf: () => null,
  delegateOf: () => null,
  implHistory: {},
  minDelayOf: () => 86400,
  roleName: (h) => h,
  contracts: [PROXY, POOL, NTTM],
  oapps: [OAPP],
  verified: () => true,
  ...o,
})
const ARMED = { armed: true }

// =====================================================================================================
describe('QU-09 / QU-05 / M-1 / PH-02: a previous queue row is dropped only when its queue was READ', () => {
  const row = (id: string, kind: string, address: string, opId = 'x'): ConfigChange =>
    ({
      id,
      subject: 's',
      dimension: 'admin',
      key: 'admin/owner/x',
      title: 't',
      state: 'pending',
      stage: 'armed',
      severity: 'downgrade',
      floorBreach: false,
      red: true,
      ruleIds: ['AD-3', 'AD-8'],
      tags: [],
      unannounced: null,
      announcement: 'not_checked',
      chainId: 1,
      queue: { kind, address, opId },
    }) as ConfigChange
  const base = (q: Partial<RawSubject['queues']>, prev: ConfigChange[]) => ({
    queues: { ops: [], safe: [], safeStatus: [], ...q },
    previousQueue: { block: 100, changes: prev },
  })
  it('an OZ timelock op not re-derived this run (a lost CallScheduled) is carried (oz rows were never carried)', () => {
    const out = carryUnreadQueueRows([], base({}, [row(`${TL}:0xop:0`, 'oz_timelock', TL, '0xop')]))
    expect(out.map((c) => c.id)).toEqual([`${TL}:0xop:0`])
    expect(out[0].tags).toContain('read_gap')
  })
  it('a legacy multisig whose queue was not attempted this run (its power not resolved) is carried', () => {
    const out = carryUnreadQueueRows(
      [],
      base({}, [row('multisig:ms:21:0', 'legacy_multisig', A('4'))]),
    )
    expect(out).toHaveLength(1)
  })
  it("a Safe absent from this run's polled set (M-1) is carried", () => {
    const out = carryUnreadQueueRows([], base({}, [row('safe:s:1:0', 'safe', SAFE)]))
    expect(out).toHaveLength(1)
  })
  it('(control) a Safe read OK, an op re-derived as executed, an op whose getTimestamp read 0: resolved', () => {
    const ops = [{ timelock: TL, id: '0xdone', calls: [], timestamp: 1 } as unknown as TimelockOp]
    const out = carryUnreadQueueRows(
      [],
      base({ safeStatus: [{ safe: SAFE, status: 'ok' }], ops, ozResolved: [`${TL}|0xgone`] }, [
        row('safe:s:1:0', 'safe', SAFE),
        row(`${TL}:0xdone:0`, 'oz_timelock', TL, '0xdone'),
        row(`${TL}:0xgone:0`, 'oz_timelock', TL, '0xgone'),
      ]),
    )
    expect(out).toEqual([])
  })
})

// =====================================================================================================
describe('LayerZero queue: an unread head route, an unknown library default, the grace config', () => {
  const k = `${OAPP}|30110|receive`
  it('MISSED-QUEUE-UNREAD-SEED: a queued change on a route NOT read at head is judged fail closed (it used the replay)', () => {
    const q = qctx({ unreadRoutes: [k], defaults: { [`${NEWLIB}|30110`]: uln([LZ, NM]) } })
    const j = judgeCall(call(EP, 'setReceiveLibrary', [OAPP, 30110, NEWLIB, 0n]), q, ARMED)
    expect(j).toHaveLength(1)
    expect(isRed(j[0].v)).toBe(true)
    expect(j[0].v.tags).toContain('read_gap')
  })
  it('MISSED-QUEUE-LIBSWITCH: a switch to a library whose default was never read is UNREAD (it read "blocked")', () => {
    const q = qctx({
      routes: {},
      routeInputs: {
        [`${OAPP}|30110|send`]: {
          chainId: 1,
          oapp: OAPP,
          eid: 30110,
          direction: 'send',
          block: 1_000_000,
          peer: PEER,
          lib: RECV,
          libIsDefault: false,
          config: {
            required: [LZ],
            optional: [],
            optionalThreshold: 0,
            confirmations: '15',
            zeroConfirmations: false,
            source: 'override',
            noDvn: false,
          },
        },
      },
      libDirection: () => 'send',
    })
    const j = judgeCall(call(EP, 'setSendLibrary', [OAPP, 30110, NEWLIB]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('BR-1')
  })
  it("LZ-08: a receive-library switch keeps the OLD library's head config in grace (not a default merge)", () => {
    const q = qctx({
      defaults: { [`${RECV}|30110`]: uln([LZ, NM]), [`${NEWLIB}|30110`]: uln([LZ, NM]) },
      routeInputs: {
        [k]: {
          chainId: 1,
          oapp: OAPP,
          eid: 30110,
          direction: 'receive',
          block: 1_000_000,
          peer: PEER,
          lib: RECV,
          libIsDefault: false,
          // the head read: a 1-DVN override (its app config was not read, so no override is known)
          config: {
            required: [LZ],
            optional: [],
            optionalThreshold: 0,
            confirmations: '15',
            zeroConfirmations: false,
            source: 'override',
            noDvn: false,
          },
        },
      },
    })
    const j = judgeCall(call(EP, 'setReceiveLibrary', [OAPP, 30110, NEWLIB, 100_000n]), q, ARMED)
    expect(j[0].v.severity).not.toBe('upgrade')
  })
  it('LZ-13 (queue): a setConfig whose library direction is unknown is a row (it was skipped silently)', () => {
    const q = qctx({ libDirection: () => null })
    const cfg = '0x' + '0'.repeat(64)
    const j = judgeCall(
      call(EP, 'setConfig', [OAPP, A('4'), [{ eid: 30110, configType: 2, config: cfg }]]),
      q,
      ARMED,
    )
    expect(j.length).toBeGreaterThan(0)
    expect(isRed(j[0].v)).toBe(true)
  })
})

// =====================================================================================================
describe('NB-01 / NB-02 (queue): NTT calls judged against unread head state', () => {
  it('NB-01: a transceiver call while the transceiver list was NOT read is BR-6 (it was "not this card\'s")', () => {
    const q = qctx({
      contracts: [PROXY, NTTM, WH],
      ntt: [{ manager: NTTM, threshold: 2, transceivers: null, peers: {} }],
    })
    const j = judgeCall(call(WH, 'setWormholePeer', [4, PEER2]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('BR-6')
  })
  it('NB-02: a manager peer for a chain that was never read is fail closed BR-6 (it was "a new route")', () => {
    const q = qctx({
      ntt: [
        {
          manager: NTTM,
          threshold: 2,
          transceivers: [
            { address: A('b'), type: 'wormhole' },
            { address: A('d'), type: 'axelar' },
          ],
          peers: { 4: { peer: PEER } },
          peersReadZero: [5],
        } as never,
      ],
    })
    const j = judgeCall(call(NTTM, 'setPeer', [1, PEER2, 18, 0n]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('BR-6')
    // (control) a chain READ as zero: a new route
    const k = judgeCall(call(NTTM, 'setPeer', [5, PEER2, 18, 0n]), q, ARMED)
    expect(k[0].v.ruleIds).not.toContain('BR-6')
  })
})

// =====================================================================================================
describe('CCIP queue: an unread chain list or rebalancer is never a calm baseline', () => {
  const pool = (o: Record<string, unknown> = {}) => ({
    pool: POOL,
    owner: SAFE,
    rebalancer: null,
    chains: [] as never[],
    ...o,
  })
  it('CC-08: addRemotePool on a pool whose chain list was not read is CC-1 (it read "first pool")', () => {
    const q = qctx({ ccipPools: [pool({ chainsUnread: true })] as never })
    const j = judgeCall(call(POOL, 'addRemotePool', [7n, PEER2]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('CC-1')
  })
  it('MISSED-1: switching a rate limiter off on a pool whose chains were not read is CC-2', () => {
    const q = qctx({ ccipPools: [pool({ chainsUnread: true })] as never })
    const off = { isEnabled: false, capacity: 0n, rate: 0n }
    const j = judgeCall(call(POOL, 'setChainRateLimiterConfig', [7n, off, off]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('CC-2')
  })
  it('MISSED-2: a rebalancer change whose current rebalancer was NOT read is CC-3 (it was neutral)', () => {
    const q = qctx({
      ccipPools: [pool({ rebalancerUnread: true })] as never,
      ctl: (a) => (a === SAFE ? safe(SAFE, 2, 5) : null),
    })
    const j = judgeCall(call(POOL, 'setRebalancer', [SAFE]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('CC-3')
  })
})

// =====================================================================================================
describe('PO-05 / PO-06: a queued parameter setter judged against a head value that was not read', () => {
  const spec: ParamSpec = {
    key: 'rateProvider',
    contract: PROXY,
    sig: 'function rateProvider() view returns (address)',
    rule: 'rate_provider',
    label: 'rate provider',
    setter: { sig: 'setRateProvider(address)', value: 0 },
  } as ParamSpec
  it('PO-05: the current provider not read + an unverified new one: AD-9 (it read neutral)', () => {
    const q = qctx({
      params: [spec],
      paramHead: {},
      verified: () => false,
      ctl: () => ({ kind: 'contract', address: IMPL }),
    })
    const j = judgeCall(call(PROXY, 'setRateProvider', [IMPL]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('AD-9')
    expect(j[0].v.tags).toContain('read_gap')
  })
  it('PO-06: setProvider on a contract with no declared provider spec: judged as a replacement (AD-9)', () => {
    const q = qctx({
      params: [],
      verified: () => false,
      ctl: () => ({ kind: 'contract', address: IMPL }),
    })
    const j = judgeCall(call(PROXY, 'setProvider', [IMPL]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('AD-9')
  })
})

// =====================================================================================================
describe('QU-08: an armed upgrade on a proxy whose implementation history was not read', () => {
  it('no history: AD-8 fail closed (a stale rollback cannot be ruled out)', () => {
    const j = judgeCall(call(PROXY, 'upgradeTo', [IMPL]), qctx({ implHistory: {} }), ARMED)
    expect(j[0].v.ruleIds).toContain('AD-8')
    expect(j[0].v.tags).toContain('read_gap')
  })
  it('(control) the full history, a fresh implementation: no AD-8', () => {
    const j = judgeCall(
      call(PROXY, 'upgradeTo', [IMPL]),
      qctx({ implHistory: { [PROXY]: { impls: [{ impl: A('2'), block: 5 }], current: A('2') } } }),
      { armed: true, scheduledBlock: 10 },
    )
    expect(j[0].v.ruleIds).not.toContain('AD-8')
  })
})

// =====================================================================================================
describe('PH-09 / PH-10 / CL-08: a grant ranked against a co-holder that was not classified', () => {
  it('classifyRoleGrant: an unclassified co-holder makes a non-top grantee red AD-4 (it was a note)', () => {
    const v = classifyRoleGrant('DEFAULT_ADMIN_ROLE', safe(SAFE, 2, 3), [], true, {
      unclassifiedHolders: 1,
    })
    expect(v.ruleIds).toContain('AD-4')
    expect(v.tags).toContain('read_gap')
  })
  it('queue grantRole: a co-holder not classified at head is not a calm plain contract', () => {
    const q = qctx({
      ctl: (a) => (a === SAFE ? safe(SAFE, 2, 3) : null),
      roleHolders: () => [TL],
    })
    const j = judgeCall(call(PROXY, 'grantRole', [ZERO32, SAFE]), q, ARMED)
    expect(j[0].v.ruleIds).toContain('AD-4')
  })
})

// =====================================================================================================
describe('PH-11 / PH-12 / CL-07 / MS-1 / LZ-02 / LZ-03: a previous holder that was NOT READ', () => {
  it('classifyControllerChange: prev unread → a Safe 2/3 is red AD-3 with a read gap (it was neutral)', () => {
    const v = classifyControllerChange(null, safe(SAFE, 2, 3), { prevUnread: 'x' })
    expect(isRed(v)).toBe(true)
    expect(v.tags).toContain('read_gap')
    // (control) genuinely unknown (no read failed): neutral, as before
    expect(isRed(classifyControllerChange(null, safe(SAFE, 2, 3)))).toBe(false)
  })
  it('queue transferOwnership with the current owner not read is red (it was neutral)', () => {
    const q = qctx({ ctl: (a) => (a === SAFE ? safe(SAFE, 2, 3) : null), ownersUnread: [PROXY] })
    const j = judgeCall(call(PROXY, 'transferOwnership', [SAFE]), q, ARMED)
    expect(isRed(j[0].v)).toBe(true)
  })
  it('queue setPermissionManager / transferAdminRole with no current holder known: red', () => {
    const q = qctx({ ctl: (a) => (a === SAFE ? safe(SAFE, 2, 3) : null), tokens: [PROXY] })
    const a = judgeCall(call(PROXY, 'setPermissionManager', [SAFE, PROXY, ZERO32]), q, ARMED)
    expect(isRed(a[0].v)).toBe(true)
    const b = judgeCall(call(A('b'), 'transferAdminRole', [PROXY, SAFE]), q, ARMED)
    expect(isRed(b[0].v)).toBe(true)
  })
  const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0xt' as Hx,
    emitter: PROXY,
    event: 'OwnershipTransferred',
    args: {},
    ...o,
  })
  const actx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
    subject: 's',
    ctl: (a: string, b: number) => m[`${a}@${b}`] ?? null,
    upgradeTimelocks: {},
    deployBlocks: { [PROXY]: 1 },
    tokens: [],
    announcement: 'not_checked' as const,
    ...o,
  })
  it('PH-11 / CL-07: an owner move whose previous owner could not be classified at block − 1 is red', () => {
    const out = classifyAdminEvents(
      [row({ args: { previousOwner: TL, newOwner: SAFE } })],
      actx(
        { [`${SAFE}@100`]: safe(SAFE, 2, 3) },
        { prevUnread: (a: string, b: number) => a === TL && b === 99 },
      ),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].tags).toContain('read_gap')
  })
  it('PH-12: a PauserChanged whose previous pauser read failed is red', () => {
    const out = classifyAdminEvents(
      [row({ event: 'PauserChanged', args: { newAddress: SAFE }, prev: null, prevUnread: true })],
      actx({ [`${SAFE}@100`]: safe(SAFE, 2, 3) }),
    )
    expect(out[0].red).toBe(true)
  })
})

// =====================================================================================================
describe('PH-14: the reverse re-judge never drops a previous red row on an unread grant-block read', () => {
  it('the grantee at its grant block could not be read this run: the previous :role-head: row is carried', () => {
    const ev = (o: Partial<AdminEventRow>): AdminEventRow => ({
      chainId: 1,
      block: 100,
      logIndex: 0,
      tx: '0xg' as Hx,
      emitter: PROXY,
      event: 'RoleGranted',
      args: { role: ZERO32, account: SAFE, roleName: 'DEFAULT_ADMIN_ROLE' },
      ...o,
    })
    const grant: ConfigChange = {
      id: '1:0xg:0',
      subject: 's',
      dimension: 'admin',
      key: `admin/role/${PROXY}/DEFAULT_ADMIN_ROLE`,
      title: 'g',
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
      block: 100,
    }
    const prevRow: ConfigChange = {
      ...grant,
      id: `1:role-head:${PROXY}:${ZERO32}:${SAFE}:900`,
      red: true,
      ruleIds: ['AD-4'],
      stillInEffect: true,
    }
    const added = rejudgeRoleHoldersAtHead([grant], [ev({})], {
      ctlAt: () => null, // the grant-block classification failed this run
      ctlRanked: () => null,
      ctlHead: () => eoa(SAFE),
      administers: () => false,
      head: 1000,
      subject: 's',
      announcement: 'not_checked',
      previous: [prevRow],
    })
    expect(added.some((c) => c.id === prevRow.id && c.red)).toBe(true)
  })
})

// =====================================================================================================
describe('DG-02 / M-3 / M-5 / TV-10 (queue)', () => {
  it('DG-02: a Dual Governance proposal whose ETA could not be read is ARMED (it was "scheduled")', () => {
    const op: TimelockOp = {
      kind: 'dg',
      status: 'scheduled',
      timelock: TL,
      id: '7',
      calls: [call(PROXY, 'transferOwnership', [EOA])],
      predecessor: ZERO32,
      delaySec: 0,
      scheduledBlock: 10,
      scheduledTx: '0xs',
      timestamp: null,
      predecessorDone: true,
      simulation: 'not_run',
    }
    const rows = timelockChanges(
      [op],
      qctx({ ctl: (a) => (a === EOA ? eoa(EOA) : null), ownerOf: () => SAFE }),
      1000,
    )
    expect(rows[0].stage).toBe('armed')
  })
  it('M-3: a DELEGATECALL proposal with EMPTY calldata is red AD-6 (it was skipped: no row)', () => {
    const rows = safeProposalChanges(
      [
        {
          safe: SAFE,
          nonce: 1,
          to: A('4'),
          value: '0',
          data: '0x',
          confirmations: 1,
          confirmationsRequired: 2,
          safeTxHash: '0x' + 'ab'.repeat(32),
          operation: 1,
        },
      ],
      qctx({ safes: [SAFE] }),
    )
    expect(rows.some((r) => r.ruleIds.includes('AD-6'))).toBe(true)
  })
  it('M-5: two proposals at one nonce get distinct ids', () => {
    const p = (h: string) => ({
      safe: SAFE,
      nonce: 1,
      to: PROXY,
      value: '0',
      data: call(PROXY, 'transferOwnership', [EOA]).data,
      confirmations: 1,
      confirmationsRequired: 2,
      safeTxHash: h,
      operation: 0,
    })
    const rows = safeProposalChanges(
      [p('0x' + 'aa'.repeat(32)), p('0x' + 'bb'.repeat(32))],
      qctx({ ctl: (a) => (a === EOA ? eoa(EOA) : null), ownerOf: () => SAFE }),
    )
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })
  it('TV-10: a Kernel setApp(base) for an appId not mapped while the mapping is incomplete is judged as an upgrade', () => {
    const BASE = '0xf1f3eb40f5bc1ad1344716ced8b8a0431d840b5783aea1fd01786bc26f35ac0f'
    const KERNEL = A('4')
    const calls = aragonCalls(
      [call(KERNEL, 'setApp', [BASE, '0x' + '12'.repeat(32), IMPL])],
      {},
      { unmappedAsUpgrade: true },
    )
    expect(calls[0].data.slice(0, 10)).toBe('0x3659cfe6') // upgradeTo(address)
  })
})

// =====================================================================================================
describe('NB-03 / NB-06: a transceiver whose verifier network was not read never hides an E drop', () => {
  it('removing the network whose type was unread at an unchanged threshold is BR-1 (it was calm)', () => {
    const v = classifyNttThreshold(
      3,
      3,
      ['wormhole', 'ccip', 'wormhole'],
      ['wormhole', null, 'ccip', 'wormhole'],
    )
    expect(v.ruleIds).toContain('BR-1')
  })
})

// =====================================================================================================
describe('PO-01 / PO-02 / PO-03: the parameter grid and bisection', () => {
  it('PO-02: an unread midpoint never merges two changes into one (A → B → C read as A → C)', async () => {
    // truth: A until 10, B on [10, 20), C from 20; the midpoint 50 is not read
    const read = async (m: number) => (m === 50 ? undefined : m < 10 ? 'A' : m < 20 ? 'B' : 'C')
    const out = await bisectChanges(read, { lo: 0, before: 'A', hi: 100, last: 'C' })
    const merged = out.some(
      (t: { before: unknown; after: unknown; unresolved?: boolean }) =>
        t.before === 'A' && t.after === 'C' && !t.unresolved,
    )
    expect(merged).toBe(false)
  })
  it('PO-03: a grid point that was not read is reported unread (an excursion there was invisible)', async () => {
    const client = {
      multicall: async ({ blockNumber }: { blockNumber: bigint }) =>
        Number(blockNumber) === 100
          ? [
              {
                status: 'failure',
                error: Object.assign(new Error('HTTP 503'), { name: 'HttpRequestError' }),
              },
            ]
          : [{ status: 'success', result: 1n }],
    }
    const r = await paramTransitions(
      client,
      [{ key: 'cap', contract: PROXY, sig: 'function cap() view returns (uint256)' }],
      { from: 0, head: 200, step: 100 },
    )
    expect(r.unread?.length).toBeGreaterThan(0)
  }, 30_000)
  it('classifyParamTransitions: an unresolved bracket of an address param is red, tagged read_gap', () => {
    const spec: ParamSpec = {
      key: 'rateProvider',
      contract: PROXY,
      sig: 'x',
      rule: 'rate_provider',
      label: 'rate provider',
    } as ParamSpec
    const out = classifyParamTransitions(
      [
        {
          key: 'rateProvider',
          block: 100,
          blockFrom: 50,
          before: A('2'),
          after: A('3'),
          unresolved: true,
        } as never,
      ],
      [spec],
      {
        subject: 's',
        ctl: () => ({ kind: 'contract', address: A('3') }),
        announcement: 'not_checked',
        verified: () => true,
      },
    )
    expect(out[0].red).toBe(true)
    expect(out[0].tags).toContain('read_gap')
  })
})

// =====================================================================================================
describe('SQ-03 / SQ-04 / SQ-05: the Safe Transaction Service answer', () => {
  const res = (body: unknown, status = 200) => ({
    status,
    ok: status === 200,
    json: async () => body,
  })
  const tx = (nonce: number) => ({
    nonce,
    to: PROXY,
    value: '0',
    data: '0x',
    operation: 0,
    confirmations: [],
    confirmationsRequired: 2,
    safeTxHash: '0x' + String(nonce).padStart(64, '0'),
  })
  it('SQ-03: a 200 with no results list is UNAVAILABLE (it was "ok, nothing pending")', async () => {
    const r = await safeQueue(SAFE, 5, async () => res({ detail: 'maintenance' }) as never)
    expect(r.status).toBe('unavailable')
  })
  it('SQ-03: a row with a missing operation / nonce / confirmations is UNAVAILABLE (judged as a CALL)', async () => {
    const bad = { ...tx(5), operation: undefined }
    const r = await safeQueue(
      SAFE,
      5,
      async () => res({ count: 1, next: null, results: [bad] }) as never,
    )
    expect(r.status).toBe('unavailable')
  })
  it('SQ-04: more proposals than one page are followed; a page that cannot be followed is UNAVAILABLE', async () => {
    let calls = 0
    const fetchImpl = async (url: string) => {
      calls++
      return url.includes('offset=25')
        ? res({ count: 26, next: null, results: [tx(30)] })
        : res({
            count: 26,
            next: 'https://api.safe.global/x?offset=25',
            results: Array.from({ length: 25 }, (_, i) => tx(5 + i)),
          })
    }
    const r = await safeQueue(SAFE, 5, fetchImpl as never)
    expect(r.status).toBe('ok')
    expect(r.rows).toHaveLength(26)
    expect(calls).toBe(2)
    const cut = await safeQueue(SAFE, 5, (async () =>
      res({
        count: 43,
        next: null,
        results: Array.from({ length: 25 }, (_, i) => tx(5 + i)),
      })) as never)
    expect(cut.status).toBe('unavailable')
  }, 20_000)
  it('SQ-05: a Safe whose on-chain nonce was not read is UNAVAILABLE (it read from nonce 0)', async () => {
    let fetched = false
    const r = await safeQueues([SAFE], async () => null, (async () => {
      fetched = true
      return res({ count: 0, next: null, results: [] })
    }) as never)
    expect(r[0].status).toBe('unavailable')
    expect(fetched).toBe(false)
  }, 20_000)
})

// keep `buildSubject` imported for type-level checks of the RawSubject fields used above
void buildSubject
void ({} as ConfigSubject)
void ({} as DvnRegistry)
void pad
