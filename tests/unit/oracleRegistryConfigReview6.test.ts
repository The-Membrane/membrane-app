// Config cards — review round 6 (2026-10-07): the CONFIRMED bugs of the fifth adversarial review
// (on-chain, rules, UI). One test (or group) per finding; each failed on the code before the fix.
// Synthetic fixtures; real Ethereum DVN / library addresses where identity matters.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi } from 'viem'

import {
  batchLoudChips,
  batchOpensByDefault,
  headline,
  nextFilter,
  stateText,
  timelineFilterButtons,
} from '@/components/OracleRegistry/configViewModel'
import type { ConfigChangeView, ConfigCounts } from '@/lib/oracleRegistry/config/apiTypes'
import {
  classifyAdminEvents,
  classifyParamTransitions,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import { compareRoute, routeBreaches } from '@/lib/oracleRegistry/config/bridgeRules'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import { replayLz, type LzEvent } from '@/lib/oracleRegistry/config/lzReplay'
import {
  judgeCalls,
  safeProposalChanges,
  timelockChanges,
  type QueueCtx,
  type SafeProposal,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  classifyMultisigChange,
  classifyParamChange,
  classifyRoleAdminChange,
  classifyRoleGrant,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  ParamSpec,
  UlnConfigRaw,
} from '@/lib/oracleRegistry/config/types'
import {
  NIL_CONFIRMATIONS,
  evaluateRoute,
  mergeUln,
  type DvnRegistry,
  type EvalCtx,
} from '@/lib/oracleRegistry/config/uln'
import { buildConfigCard, countsOf } from '@/lib/oracleRegistry/config/view'
import {
  ADMIN_TOPICS,
  TOPIC,
  decodeLog,
  roleSetRow,
} from '@/scripts/oracle-registry/config/lib/abi.mjs'
import { classify, subjectExtraEmitters } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { remoteReadList } from '@/scripts/oracle-registry/config/lib/lz.mjs'
import { safeQueue } from '@/scripts/oracle-registry/config/lib/safe.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const GG = '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc'
const UNKNOWN_DVN = '0x' + '9'.repeat(40)
const SEND = '0xbb2ea70c9e858123480642cf96acbcce1372dce1'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const RECV_OLD = '0x6666666666666666666666666666666666666666'
const BLK = '0x1ccbf0db9c192d969de57e25b3ff09a25bb1d862'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const REMOTE = '0x' + '4'.repeat(40)
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const ZERO32 = '0x' + '0'.repeat(64)
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const C = '0x00000000000000000000000000000000000000cc'
const X = '0x00000000000000000000000000000000000000dd'
const Z = '0x' + '0'.repeat(40)
const MINTING = '0x' + '3'.repeat(40)
const POOL = '0x' + '5'.repeat(40)
const SAFE = '0x' + '6'.repeat(40)
const MCMS = '0x' + '7'.repeat(40)
const TL = '0x' + 'c'.repeat(40)
const TAR = '0x' + 'e'.repeat(40)
const ORACLE = '0x' + '8'.repeat(40)
const USDE = '0x' + 'a'.repeat(40)
const ASSET = '0x' + 'b'.repeat(40)
const OPERATOR_HASH = '0x' + '33'.repeat(32)
const MINTER_HASH = '0x' + '44'.repeat(32)

const dvns = {
  [LZ]: { id: 'layerzero-labs', name: 'LZ' },
  [NM]: { id: 'nethermind', name: 'NM' },
  [GG]: { id: 'google-cloud', name: 'GG' },
}
const libs = { send: [SEND], receive: [RECV, RECV_OLD], blocked: [BLK], read: [] }
const registry: DvnRegistry = {
  byChain: { 1: dvns, 42161: dvns },
  dead: { 1: [], 42161: [] },
  libraries: { 1: libs, 42161: libs },
}
const ctx: EvalCtx = { registry, code: () => true, useDeprecated: false }
const uln = (req: string[], opt: string[] = [], thr = 0, conf = '15'): UlnConfigRaw => ({
  confirmations: conf,
  requiredDVNCount: req.length,
  optionalDVNCount: opt.length,
  optionalDVNThreshold: thr,
  requiredDVNs: req,
  optionalDVNs: opt,
})
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, n: number, o: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  ...o,
})
// Owner ruling 2026-10-08 (#12): a timelock ranks as its weakest proposer + delay credit. The
// fixture's default proposer is a governance Safe 7-of-12 (override with `schedulers`).
const timelock = (a: string, d = 86400, o: Partial<Controller> = {}): Controller => ({
  kind: 'oz_timelock',
  address: a,
  delaySec: d,
  schedulers: [
    {
      kind: 'safe',
      address: '0x00000000000000000000000000000000000000c0',
      threshold: 7,
      signers: 12,
    },
  ],
  ...o,
})
const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
  chainId: 1,
  block: 100,
  logIndex: 0,
  tx: '0xt',
  emitter: MINTING,
  event: 'RoleGranted',
  args: {},
  ...o,
})
const actx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
  subject: 's',
  ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? null,
  ctlExact: (a: string, b: number) => m[`${a}@${b}`] ?? null,
  upgradeTimelocks: {},
  deployBlocks: { [MINTING]: 1, [POOL]: 1, [SAFE]: 50 },
  tokens: [],
  announcement: 'not_checked' as const,
  ...o,
})
const subject = (o: Partial<ConfigSubject> = {}): ConfigSubject => ({
  key: 'z',
  label: 'Z',
  oracleAssetKey: null,
  class: 'lrt',
  contracts: [
    {
      role: 'oft_adapter',
      dimension: 'bridge',
      chainId: 1,
      address: OAPP,
      label: 'a',
      deployBlock: 1,
    },
  ],
  lzOApps: [OAPP],
  ccipPools: [],
  powers: [],
  params: [],
  timelocks: [],
  safes: [],
  govChannels: [],
  ...o,
})
const rawOf = (o: {
  admin?: Partial<RawSubject['admin']>
  lz?: Partial<RawSubject['lz']>
  queues?: Partial<RawSubject['queues']>
  params?: RawSubject['params']
  oracle?: RawSubject['oracle']
  head?: number
}): RawSubject => ({
  version: 1,
  subjectKey: 'z',
  head: { block: o.head ?? 1_000_000, ts: 2000 },
  scan: { from: 1, to: o.head ?? 1_000_000 },
  lz: {
    events: [],
    headRoutes: [],
    headDefaults: {},
    remote: [],
    codeProbes: { [LZ]: { firstCode: 1 }, [NM]: { firstCode: 1 }, [GG]: { firstCode: 1 } },
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
  params: o.params ?? { head: {}, transitions: [] },
  queues: { ops: [], safe: [], safeStatus: [], ...o.queues },
  ccip: { pools: [] },
  oracle: o.oracle,
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'arbitrum', roleName: (h) => h, endpoint: EP })
const qctx = (o: Partial<QueueCtx> = {}): QueueCtx => ({
  subject: 's',
  announcement: 'not_checked',
  eval: ctx,
  block: 1_000_000,
  endpoint: EP,
  routes: {},
  defaults: {},
  libDirection: (l) => (l === SEND ? 'send' : l === RECV || l === RECV_OLD ? 'receive' : null),
  ctl: () => null,
  ownerOf: () => null,
  delegateOf: () => null,
  implHistory: {},
  minDelayOf: () => 86400,
  roleName: (h) => (h === OPERATOR_HASH ? 'OPERATOR_ROLE' : h === MINTER_HASH ? 'MINTER_ROLE' : h),
  contracts: [MINTING, POOL, TAR, OAPP, ORACLE, USDE],
  oapps: [OAPP],
  verified: () => true,
  ...o,
})
const armedOp = (data: string[], target: string[]): TimelockOp => ({
  timelock: TL,
  id: '0xop',
  calls: data.map((d, i) => ({ target: target[i] ?? target[0], value: '0', data: d })),
  predecessor: ZERO32,
  delaySec: 86400,
  scheduledBlock: 10,
  scheduledTx: '0xs',
  timestamp: 500,
  predecessorDone: true,
  simulation: 'ok',
})
const proposal = (o: Partial<SafeProposal>): SafeProposal => ({
  safe: SAFE,
  nonce: 7,
  to: SAFE,
  value: '0',
  data: '0x',
  confirmations: 3,
  confirmationsRequired: 3,
  safeTxHash: '0xh',
  ...o,
})
const multiSend = (calls: { to: string; data: string; op?: number }[]) =>
  encodeFunctionData({
    abi: parseAbi(['function multiSend(bytes transactions)']),
    functionName: 'multiSend',
    args: [
      ('0x' +
        calls
          .map(
            (c) =>
              (c.op ?? 0).toString(16).padStart(2, '0') +
              c.to.slice(2) +
              '0'.repeat(64) +
              ((c.data.length - 2) / 2).toString(16).padStart(64, '0') +
              c.data.slice(2),
          )
          .join('')) as `0x${string}`,
    ],
  })
const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

// =====================================================================================================
describe('on-chain #1: the Safes that propose to a declared timelock are in the subject scope', () => {
  const P = '0x' + '1'.repeat(40)
  const E = '0x' + '2'.repeat(40)
  const CN = '0x' + '5'.repeat(39) + '1'
  const H = (n: string) => n
  it('timelock PROPOSER / EXECUTOR / CANCELLER / admin holders are kept, not only power holders', () => {
    const roleMap = new Map<string, Set<string>>([
      [`${TL}|PROPOSER_ROLE`, new Set([P])],
      [`${TL}|EXECUTOR_ROLE`, new Set([E])],
      [`${TL}|CANCELLER_ROLE`, new Set([CN])],
    ])
    const out = subjectExtraEmitters(
      { timelocks: [TL] },
      [{ holders: [X] }],
      roleMap,
      H,
    ) as Set<string>
    expect([...out].sort()).toEqual([P, E, CN, X].sort())
  })
  it('engine: a proposer Safe AD-1 row (signer added at the same threshold) reaches the card', () => {
    const add = row({
      emitter: SAFE,
      event: 'AddedOwner',
      block: 600,
      tx: '0xa',
      args: { owner: C },
    })
    const out = build(
      subject({
        contracts: [
          ...subject().contracts,
          {
            role: 'timelock',
            dimension: 'admin',
            chainId: 1,
            address: TL,
            label: 't',
            deployBlock: 1,
          },
        ],
        timelocks: [TL],
      }),
      rawOf({
        admin: {
          events: [
            row({
              emitter: TL,
              event: 'RoleGranted',
              block: 500,
              tx: '0xg',
              args: { role: '0x' + '1'.repeat(64), roleName: 'PROPOSER_ROLE', account: SAFE },
            }),
            add,
          ],
          controllers: { [`${SAFE}@599`]: safe(SAFE, 3, 6), [`${SAFE}@500`]: safe(SAFE, 3, 6) },
        },
      }),
    )
    const ms = out.changes.find((c) => c.key === `admin/multisig/${SAFE}`)
    expect(ms?.red).toBe(true)
    expect(ms?.ruleIds).toContain('AD-1')
  })
})

describe('on-chain #2 / rules #7 AD-4: a privileged role to a contract an EOA controls is red', () => {
  const owned: Controller = { kind: 'contract', address: MCMS, ownedBy: eoa(X) }
  it('PROPOSER_ROLE / DEFAULT_ADMIN_ROLE / UPGRADER_ROLE with no current holders', () => {
    for (const role of ['PROPOSER_ROLE', 'DEFAULT_ADMIN_ROLE', 'UPGRADER_ROLE']) {
      const v = classifyRoleGrant(role, owned, [], true)
      expect(v.severity).toBe('downgrade')
      expect(v.ruleIds).toContain('AD-4')
    }
  })
  it('replay: a grant to an EOA-owned contract while the holders could not be classified', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: TL,
          block: 100,
          tx: '0x1',
          args: { role: '0x' + '1'.repeat(64), roleName: 'PROPOSER_ROLE', account: C },
        }),
        row({
          emitter: TL,
          block: 200,
          tx: '0x2',
          args: { role: '0x' + '1'.repeat(64), roleName: 'PROPOSER_ROLE', account: MCMS },
        }),
      ],
      actx({ [`${MCMS}@200`]: owned, [`${C}@100`]: timelock(C) }, { deployBlocks: { [TL]: 1 } }),
    )
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toContain('AD-4')
  })
  it('control: a grant to a contract owned by a timelock is not red', () => {
    const v = classifyRoleGrant(
      'PROPOSER_ROLE',
      { kind: 'contract', address: MCMS, ownedBy: timelock(TL) },
      [],
      true,
    )
    expect(v.severity).not.toBe('downgrade')
  })
})

// =====================================================================================================
describe('rules #1 AD-1: swapped-in signers that alone meet the threshold are red', () => {
  it('3-of-5 with 3 owners swapped (3 added, 3 removed) is red', () => {
    const v = classifyMultisigChange(safe(SAFE, 3, 5), safe(SAFE, 3, 5), 3)
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('AD-1')
  })
  it('2-of-4 → 3-of-4 with 3 swaps is red, never an upgrade', () => {
    const v = classifyMultisigChange(safe(SAFE, 2, 4), safe(SAFE, 3, 4), 3)
    expect(v.severity).toBe('downgrade')
  })
  it('control: one swap at 3-of-5 stays a rotation', () => {
    const v = classifyMultisigChange(safe(SAFE, 3, 5), safe(SAFE, 3, 5), 1)
    expect(v.severity).toBe('neutral')
  })
  it('replay: one transaction with 3 RemovedOwner + 3 AddedOwner on a 3-of-5 Safe is red AD-1', () => {
    const evs = [0, 1, 2].flatMap((i) => [
      row({
        emitter: SAFE,
        event: 'RemovedOwner',
        block: 200,
        logIndex: i * 2,
        args: { owner: A },
      }),
      row({
        emitter: SAFE,
        event: 'AddedOwner',
        block: 200,
        logIndex: i * 2 + 1,
        args: { owner: B },
      }),
    ])
    const out = classifyAdminEvents(evs, actx({ [`${SAFE}@199`]: safe(SAFE, 3, 5) }))
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-1')
    expect(out[0].tags).not.toContain('rotation')
  })
  it('queue: a fully signed MultiSend of 3 swapOwner calls on a 3-of-5 Safe ends red', () => {
    const abi = parseAbi([
      'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
    ])
    const swap = (n: string) =>
      encodeFunctionData({ abi, functionName: 'swapOwner', args: [A, B, n as `0x${string}`] })
    const data = multiSend([C, X, MCMS].map((n) => ({ to: SAFE, data: swap(n) })))
    const out = safeProposalChanges(
      [proposal({ to: '0x40a2accbd92bca938b02010e17a5b8929b49130d', data })],
      qctx({ ctl: (a) => (a === SAFE ? safe(SAFE, 3, 5) : null), safes: [SAFE] }),
    )
    expect(out).toHaveLength(3)
    expect(out[2].red).toBe(true)
    expect(out[2].ruleIds).toContain('AD-1')
    expect(out[0].red).toBe(false)
  })
})

describe('rules #2 MR-2 / AD-9 through a zeroed value (A → 0 → B)', () => {
  const minter: ParamSpec = {
    key: 'minter',
    contract: USDE,
    sig: 'function minter() view returns (address)',
    rule: 'minter',
    label: 'USDe minter',
  }
  const oracle: ParamSpec = {
    key: 'oracle',
    contract: ORACLE,
    sig: 'function assetPriceOracle(address) view returns (address)',
    rule: 'price_oracle',
    label: 'price oracle',
  }
  const tr = (key: string, before: string, after: string, block: number) => ({
    key,
    block,
    blockFrom: block - 1,
    before,
    after,
  })
  it('a minter re-pointed through address(0) is a new minter (MR-2)', () => {
    const out = classifyParamTransitions(
      [tr('minter', A, Z, 100), tr('minter', Z, B, 200)],
      [minter],
      {
        subject: 's',
        ctl: (a) => (a === B ? { kind: 'contract', address: B } : null),
        announcement: 'not_checked',
        verified: () => true,
      },
    )
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toContain('MR-2')
  })
  it('a price oracle re-pointed through address(0) to unverified code is AD-9', () => {
    const out = classifyParamTransitions(
      [tr('oracle', A, Z, 100), tr('oracle', Z, B, 200)],
      [oracle],
      {
        subject: 's',
        ctl: (a) => (a === B ? { kind: 'contract', address: B } : null),
        announcement: 'not_checked',
        verified: () => false,
      },
    )
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toContain('AD-9')
  })
})

// =====================================================================================================
const padded = (a: string) => '0x' + '0'.repeat(24) + a.slice(2)
const headRoute = (direction: 'send' | 'receive', lib?: string) => ({
  oapp: OAPP,
  eid: 30110,
  direction,
  lib: lib ?? (direction === 'send' ? SEND : RECV),
  libIsDefault: false,
  merged: uln([LZ, NM]),
  app: null,
  peer: padded(REMOTE),
})
const remoteRead = (recv: { lib: string; merged: UlnConfigRaw }, peerBack = padded(OAPP)) => ({
  oapp: OAPP,
  eid: 30110,
  chainKey: 'arbitrum',
  chainId: 42161,
  status: 'ok' as const,
  peer: REMOTE,
  peerBack,
  directions: { receive: recv, send: { lib: SEND, merged: uln([LZ, NM]) } },
  dvnCode: { [LZ]: true, [NM]: true, [GG]: true, [UNKNOWN_DVN]: true },
})

describe('rules #3 BR-1 / BR-3: the remote side weakened while closed, then reopened', () => {
  type Built = ReturnType<typeof build>
  const run = (
    headBlock: number,
    recv: { lib: string; merged: UlnConfigRaw },
    prev?: Built['state'],
  ) =>
    build(
      subject(),
      rawOf({
        head: headBlock,
        lz: {
          headRoutes: [headRoute('receive'), headRoute('send')],
          remote: [remoteRead(recv)],
          previousRemote: prev
            ? {
                block: prev.asOf.block,
                routes: prev.remoteSnapshot!,
                readAt: prev.remoteReadAt,
                lastPeer: prev.remoteLastPeer,
                lastVerifying: prev.remoteLastVerifying,
              }
            : undefined,
        },
      }),
    )
  const key = `bridge/lz/42161/${REMOTE}/30101/receive`
  it('E 3 → closed → 2 is BR-1 against the last config the remote side ran with', () => {
    const r1 = run(1000, { lib: RECV, merged: uln([LZ, NM, GG]) })
    const r2 = run(2000, { lib: BLK, merged: uln([LZ, NM, GG]) }, r1.state)
    const r3 = run(3000, { lib: RECV, merged: uln([LZ, NM]) }, r2.state)
    const c = r3.changes.find((x) => x.key === key)
    expect(c?.red).toBe(true)
    expect(c?.ruleIds).toContain('BR-1')
  })
  it('15 confirmations → closed → NIL is BR-3', () => {
    const r1 = run(1000, { lib: RECV, merged: uln([LZ, NM]) })
    const r2 = run(2000, { lib: BLK, merged: uln([LZ, NM]) }, r1.state)
    const r3 = run(
      3000,
      { lib: RECV, merged: uln([LZ, NM], [], 0, NIL_CONFIRMATIONS.toString()) },
      r2.state,
    )
    const c = r3.changes.find((x) => x.key === key)
    expect(c?.red).toBe(true)
    expect(c?.ruleIds).toContain('BR-3')
  })
})

describe('rules #4: the remote side is judged while both Ethereum directions are closed', () => {
  const weak = { lib: RECV, merged: uln([UNKNOWN_DVN]) }
  const key = `bridge/lz/42161/${REMOTE}/30101/receive`
  it('Ethereum on BlockedMessageLib both ways: the remote 1-of-1 unknown DVN is a floor breach', () => {
    const out = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [headRoute('receive', BLK), headRoute('send', BLK)],
          remote: [remoteRead(weak)],
        },
      }),
    )
    const it = out.state.items.find((i) => i.key === key)
    expect(it).toBeDefined()
    expect(it!.breaches.map((b) => b.ruleId)).toContain('BR-2')
  })
  it('Ethereum peer zeroed (no head route): the remote side read from the last peer is judged', () => {
    const out = build(subject(), rawOf({ lz: { headRoutes: [], remote: [remoteRead(weak)] } }))
    const it = out.state.items.find((i) => i.key === key)
    expect(it!.breaches.map((b) => b.ruleId)).toContain('BR-2')
    // the view can place it on its OApp (no local row to match a peer against)
    expect((it!.value as { localOApp?: string }).localOApp).toBe(OAPP)
  })
  it('collector: a route whose Ethereum peer was zeroed is read at its last non-zero peer', () => {
    const head = new Map([[OAPP, [{ oapp: OAPP, eid: 30110, direction: 'receive', peer: PEER }]]])
    const evs = [
      { kind: 'peer', oapp: OAPP, eid: 30184, peer: padded(REMOTE), block: 10, logIndex: 0 },
      { kind: 'peer', oapp: OAPP, eid: 30184, peer: ZERO32, block: 20, logIndex: 0 },
      { kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER, block: 5, logIndex: 0 },
    ]
    const m = remoteReadList(head, evs, [OAPP]) as Map<number, { oapp: string; peer: string }[]>
    expect(m.get(30110)).toEqual([{ oapp: OAPP, peer: PEER }])
    expect(m.get(30184)).toEqual([{ oapp: OAPP, peer: padded(REMOTE), ethPeerZeroed: true }])
  })
})

describe('rules #5 AD-6: a pending Safe DELEGATECALL (the Bybit singleton swap) is a red row', () => {
  const transfer = encodeFunctionData({
    abi: parseAbi(['function transfer(address to, uint256 amount)']),
    functionName: 'transfer',
    args: [A, 1n],
  })
  it('a fully signed delegatecall to an arbitrary contract: red AD-6 + AD-8', () => {
    const out = safeProposalChanges(
      [proposal({ to: X, data: transfer, operation: 1 })],
      qctx({ safes: [SAFE] }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['AD-6', 'AD-8']))
  })
  it('a DELEGATECALL entry inside a MultiSend is red too; a plain call to another contract is not filed', () => {
    const data = multiSend([{ to: X, data: transfer, op: 1 }])
    const out = safeProposalChanges(
      [proposal({ to: '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761', data, operation: 1 })],
      qctx({ safes: [SAFE] }),
    )
    expect(out.some((c) => c.red && c.ruleIds.includes('AD-6'))).toBe(true)
    const plain = safeProposalChanges(
      [proposal({ to: X, data: transfer, operation: 0 })],
      qctx({ safes: [SAFE] }),
    )
    expect(plain).toHaveLength(0)
  })
  it('collector: the Safe Tx Service operation is kept', async () => {
    const fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              nonce: 7,
              to: X,
              value: '0',
              data: transfer,
              operation: 1,
              confirmations: [],
              confirmationsRequired: 3,
              safeTxHash: '0xh',
            },
          ],
        }),
      }) as unknown as Response
    const r = await safeQueue('0x' + 'a'.repeat(40), 7, fetchImpl)
    expect(r.rows[0].operation).toBe(1)
  })
})

describe('rules #6 AD-8 / MR-2: armed calls to a declared parameter setter are judged', () => {
  const minter: ParamSpec = {
    key: 'minter',
    contract: USDE,
    sig: 'function minter() view returns (address)',
    rule: 'minter',
    label: 'USDe minter',
    setter: { sig: 'function setMinter(address)', value: 0 },
  }
  const oracle: ParamSpec = {
    key: 'assetPriceOracle:stETH',
    contract: ORACLE,
    sig: 'function assetPriceOracle(address) view returns (address)',
    args: [ASSET],
    rule: 'price_oracle',
    label: 'stETH price oracle',
    setter: { sig: 'function updatePriceOracleFor(address,address)', value: 1, match: [0] },
  }
  const cap: ParamSpec = {
    key: 'globalMaxMintPerBlock',
    contract: MINTING,
    sig: 'function globalConfig() view returns (uint128,uint128)',
    outputIndex: 0,
    rule: 'cap',
    zero: 'closed',
    label: 'global max mint per block',
    setter: { sig: 'function setGlobalMaxMintPerBlock(uint128)', value: 0 },
  }
  const q = qctx({
    params: [minter, oracle, cap],
    paramHead: { minter: B, 'assetPriceOracle:stETH': C, globalMaxMintPerBlock: '2000000' },
    ctl: (a) => (a === X ? eoa(X) : { kind: 'contract', address: a }),
  })
  it('armed setMinter(EOA) is red MR-2 + AD-8, never "call not decoded"', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function setMinter(address)']),
      functionName: 'setMinter',
      args: [X],
    })
    const out = timelockChanges([armedOp([data], [USDE])], q, 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['MR-2', 'AD-8']))
    expect(out[0].tags).not.toContain('undecoded')
  })
  it('armed updatePriceOracleFor(stETH, EOA) is red; another asset is not this param', () => {
    const abi = parseAbi(['function updatePriceOracleFor(address,address)'])
    const hit = encodeFunctionData({
      abi,
      functionName: 'updatePriceOracleFor',
      args: [ASSET as Hx, X as Hx],
    })
    const out = timelockChanges([armedOp([hit], [ORACLE])], q, 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].key).toBe('mint/assetPriceOracle:stETH')
  })
  it('a cap set to type(uint128).max is MR-4 (the unlimited sentinel)', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function setGlobalMaxMintPerBlock(uint128)']),
      functionName: 'setGlobalMaxMintPerBlock',
      args: [2n ** 128n - 1n],
    })
    const out = timelockChanges([armedOp([data], [MINTING])], q, 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('MR-4')
  })
  it('changeProxyAdmin to an EOA is AD-3; setContract to an EOA is MR-2', () => {
    const cpa = encodeFunctionData({
      abi: parseAbi(['function changeProxyAdmin(address proxy, address newAdmin)']),
      functionName: 'changeProxyAdmin',
      args: [POOL as Hx, X as Hx],
    })
    const sc = encodeFunctionData({
      abi: parseAbi(['function setContract(bytes32 key, address value)']),
      functionName: 'setContract',
      args: [('0x' + '12'.repeat(32)) as `0x${string}`, X],
    })
    const out = timelockChanges(
      [armedOp([cpa, sc], [TAR, MINTING])],
      qctx({ ctl: (a) => (a === X ? eoa(X) : timelock(a)) }),
      1000,
    )
    expect(out[0].ruleIds).toContain('AD-3')
    expect(out[1].ruleIds).toContain('MR-2')
    expect(out.every((c) => c.red)).toBe(true)
  })
  it('subjects.json declares the setters of the live parameters', () => {
    const f = JSON.parse(src('data/oracle-registry/config/subjects.json')) as {
      subjects: ConfigSubject[]
    }
    const setters = f.subjects.flatMap((s) => s.params.filter((p) => p.setter).map((p) => p.key))
    expect(setters).toEqual(
      expect.arrayContaining([
        'minter',
        'assetPriceOracle:stETH',
        'depositLimit:ETH',
        'globalMaxMintPerBlock',
        'maxMintPerBlock:USDT',
        'cooldownDuration',
        'masterMinter',
      ]),
    )
  })
})

describe('rules #8 role-admin path: admin moved to an empty role, then that role granted', () => {
  it('a move to an admin role with no holder is not an upgrade', () => {
    const v = classifyRoleAdminChange(
      'MINTER_ROLE',
      { name: 'DEFAULT_ADMIN_ROLE', holders: [timelock(TL)] },
      { name: 'OPERATOR_ROLE', holders: [] },
    )
    expect(v.severity).not.toBe('upgrade')
  })
  it('replay: the grant of the role that now administers MINTER_ROLE to an EOA is red AD-4', () => {
    const out = classifyAdminEvents(
      [
        row({
          event: 'RoleAdminChanged',
          block: 100,
          tx: '0x1',
          args: {
            role: MINTER_HASH,
            roleName: 'MINTER_ROLE',
            previousAdminRole: ZERO32,
            previousAdminRoleName: 'DEFAULT_ADMIN_ROLE',
            newAdminRole: OPERATOR_HASH,
            newAdminRoleName: 'OPERATOR_ROLE',
          },
        }),
        row({
          event: 'RoleGranted',
          block: 200,
          tx: '0x2',
          args: { role: OPERATOR_HASH, roleName: 'OPERATOR_ROLE', account: X },
        }),
      ],
      actx({ [`${X}@200`]: eoa(X) }),
    )
    const grant = out.find((c) => c.tx === '0x2')!
    expect(grant.red).toBe(true)
    expect(grant.ruleIds).toContain('AD-4')
  })
  it('queue: a pending grant of a role-admin role to an EOA is red', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function grantRole(bytes32 role, address account)']),
      functionName: 'grantRole',
      args: [OPERATOR_HASH as `0x${string}`, X],
    })
    const out = timelockChanges(
      [armedOp([data], [MINTING])],
      qctx({ ctl: (a) => (a === X ? eoa(X) : null), roleAdmins: () => new Set(['OPERATOR_ROLE']) }),
      1000,
    )
    expect(out[0].red).toBe(true)
  })
})

describe('rules #9 AD-1 at head: a silent change after an evented one in the same run interval', () => {
  const base = (
    head: Controller,
    events: AdminEventRow[] = [],
    ctls: Record<string, Controller> = {},
  ) =>
    build(
      subject({ safes: [SAFE] }),
      rawOf({
        admin: {
          events,
          controllers: { [`${SAFE}@head`]: head, ...ctls },
          previousSafes: {
            block: 500,
            controllers: { [SAFE]: safe(SAFE, 3, 5, { owners: [A, B, C, X, MCMS] }) },
          },
        },
        queues: { safeStatus: [{ safe: SAFE, status: 'ok' }] },
      }),
    )
  const headRows = (o: ReturnType<typeof build>) =>
    o.changes.filter((c) => c.key === `admin/multisig/${SAFE}` && c.tags.includes('bracketed'))
  it('3-of-5 → (events) 4-of-6 → (delegatecall) 1-of-6 at head is red AD-1', () => {
    const out = base(
      safe(SAFE, 1, 6),
      [
        row({ emitter: SAFE, event: 'AddedOwner', block: 600, tx: '0xa', args: { owner: TAR } }),
        row({
          emitter: SAFE,
          event: 'ChangedThreshold',
          block: 600,
          tx: '0xa',
          logIndex: 1,
          args: { threshold: '4' },
        }),
      ],
      { [`${SAFE}@599`]: safe(SAFE, 3, 5) },
    )
    const h = headRows(out)
    expect(h).toHaveLength(1)
    expect(h[0].red).toBe(true)
    expect(h[0].ruleIds).toContain('AD-1')
  })
  it('a silent swap of 3 owners at the same 3-of-5 is red; one swapped owner is a rotation', () => {
    const three = base(safe(SAFE, 3, 5, { owners: [A, B, ORACLE, POOL, TAR] }))
    expect(headRows(three)[0]?.red).toBe(true)
    const one = base(safe(SAFE, 3, 5, { owners: [A, B, C, X, TAR] }))
    expect(headRows(one)).toHaveLength(1)
    expect(headRows(one)[0].red).toBe(false)
  })
})

describe('rules #10 BR-3 floor: a live route at ZERO confirmations, at creation and at head', () => {
  const nil = NIL_CONFIRMATIONS.toString()
  it('replay: a route configured at NIL and then given a peer is red at creation', () => {
    const base = { chainId: 1, logIndex: 0 }
    const evs: LzEvent[] = [
      { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30110, lib: RECV },
      {
        ...base,
        block: 1,
        tx: '0x1',
        logIndex: 1,
        kind: 'default_send_lib',
        eid: 30110,
        lib: SEND,
      },
      {
        ...base,
        block: 2,
        tx: '0x2',
        kind: 'uln',
        lib: RECV,
        oapp: OAPP,
        eid: 30110,
        config: uln([LZ, NM], [], 0, nil),
      },
      { ...base, block: 3, tx: '0x3', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
    ]
    const r = replayLz(evs, { subject: 't', oapps: [OAPP], ctx })
    const created = r.changes.filter((c) => c.tx === '0x3' && c.route?.direction === 'receive')
    expect(created).toHaveLength(1)
    expect(created[0].red).toBe(true)
    expect(created[0].ruleIds).toContain('BR-3')
  })
  it('head: a live route at ZERO confirmations is a state breach', () => {
    const r = evaluateRoute(
      {
        chainId: 1,
        oapp: OAPP,
        eid: 30110,
        direction: 'receive',
        block: 100,
        peer: PEER,
        lib: RECV,
        libIsDefault: false,
        config: mergeUln(uln([LZ, NM], [], 0, nil), undefined),
      },
      ctx,
    )
    expect(routeBreaches(r).map((b) => b.ruleId)).toContain('BR-3')
    expect(compareRoute(undefined, r).ruleIds).toContain('BR-3')
  })
})

describe('rules #11 BR-7: an unknown DVN added to the receive library in its grace period', () => {
  const rt = (graceCfg: UlnConfigRaw) =>
    evaluateRoute(
      {
        chainId: 1,
        oapp: OAPP,
        eid: 30110,
        direction: 'receive',
        block: 100,
        peer: PEER,
        lib: RECV,
        libIsDefault: false,
        config: mergeUln(uln([LZ, NM]), undefined),
        grace: { lib: RECV_OLD, expiry: 1_000_000, config: mergeUln(graceCfg, undefined) },
        defaultConfirmations: '15',
      },
      ctx,
    )
  it('is red BR-7 at the same E', () => {
    const v = compareRoute(rt(uln([LZ, NM])), rt(uln([LZ, NM], [UNKNOWN_DVN], 1)))
    expect(v.ruleIds).toContain('BR-7')
  })
})

describe('rules #12 AD-2: a function whitelisted for the timelock bypass', () => {
  it('collector: FunctionWhitelisted / FunctionRemovedFromWhitelist are scanned and decoded', () => {
    expect(ADMIN_TOPICS).toContain(TOPIC.FunctionWhitelisted)
    expect(ADMIN_TOPICS).toContain(TOPIC.FunctionRemovedFromWhitelist)
    const topics = encodeEventTopics({
      abi: parseAbi(['event FunctionWhitelisted(address indexed target, bytes4 indexed selector)']),
      eventName: 'FunctionWhitelisted',
      args: { target: TAR as Hx, selector: '0x4f1ef286' },
    })
    const d = decodeLog({ topics, data: '0x' })
    expect(d?.event).toBe('FunctionWhitelisted')
  })
  it('replay: whitelisting a function that reaches a power is red AD-2; removing it is an upgrade', () => {
    const out = classifyAdminEvents(
      [
        row({
          emitter: TL,
          event: 'FunctionWhitelisted',
          block: 100,
          args: { target: TAR, selector: '0x4f1ef286' },
        }),
        row({
          emitter: TL,
          event: 'FunctionRemovedFromWhitelist',
          block: 200,
          tx: '0x2',
          args: { target: TAR, selector: '0x4f1ef286' },
        }),
      ],
      actx({}, { whitelistReach: () => 'reaches' as const }),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-2')
    expect(out[1].severity).toBe('upgrade')
  })
  it("engine: a shared timelock's whitelist for another asset's contract is not this card's", () => {
    const wl = (target: string, tx: string) =>
      row({
        emitter: TL,
        event: 'FunctionWhitelisted',
        block: 100,
        tx,
        args: { target, selector: '0x4f1ef286' },
      })
    const out = build(
      subject({
        contracts: [
          ...subject().contracts,
          {
            role: 'timelock',
            dimension: 'admin',
            chainId: 1,
            address: TL,
            label: 't',
            deployBlock: 1,
          },
        ],
        timelocks: [TL],
      }),
      rawOf({ admin: { events: [wl(TAR, '0xf'), wl(OAPP, '0xo')] } }),
    )
    const rows = out.changes.filter((c) => c.key.startsWith('admin/timelock_whitelist/'))
    // the foreign target is not filed; the subject's own contract with no declared power fails closed
    expect(rows.map((c) => c.tx)).toEqual(['0xo'])
    expect(rows[0].red).toBe(true)
  })
  it('engine: a power whose delay a read whitelist bypass skips carries an AD-2 breach', () => {
    const out = build(
      subject({
        powers: [{ power: 'upgrade', contract: TAR, path: ['owner'], label: 'Upgrade T' }],
      }),
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade T', contract: TAR, holders: [TL] }],
          controllers: {
            [`${TL}@head`]: timelock(TL, 86400, {
              bypass: {
                fn: 'executeWhitelisted',
                scope: 'whitelist',
                targets: { [TAR]: ['upgradeToAndCall(address,bytes)'] },
              },
            }),
          },
        },
      }),
    )
    const it = out.state.items.find((i) => i.key === `admin/power/upgrade/${TAR}`)!
    expect(it.breaches.map((b) => b.ruleId)).toContain('AD-2')
  })
  it('queue: a pending addToWhitelist is red AD-2', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function addToWhitelist(address target, bytes4 selector)']),
      functionName: 'addToWhitelist',
      args: [TAR as Hx, '0x4f1ef286'],
    })
    const out = timelockChanges([armedOp([data], [TL])], qctx({ contracts: [TL, TAR] }), 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-2')
  })
})

describe('rules #13 burst: sibling grants in one pending batch count', () => {
  it('4 MINTER grants in one armed op vs an earlier largest one-day batch of 1: grants 2–4 red', () => {
    const bots = [1, 2, 3, 4].map((i) => '0x' + String(i).repeat(40).slice(0, 40))
    const abi = parseAbi(['function grantRole(bytes32 role, address account)'])
    const data = bots.map((b) =>
      encodeFunctionData({
        abi,
        functionName: 'grantRole',
        args: [MINTER_HASH as `0x${string}`, b as `0x${string}`],
      }),
    )
    const q = qctx({
      ctl: (a) => eoa(a),
      roleHolders: () => [],
      roleEverHolders: () => [A],
      roleGrants: () =>
        [0, 1, 2].map((i) => ({
          block: 10_000 + i * 50_400,
          account: '0x' + String(i + 5).repeat(40),
          noCode: true,
        })),
    })
    const out = timelockChanges([armedOp(data, [MINTING])], q, 1000)
    expect(out).toHaveLength(4)
    expect(out[0].red).toBe(false)
    expect(out.slice(1).every((c) => c.red && c.tags.includes('anomaly'))).toBe(true)
  })
})

describe('rules #14 AD-9: an oracle source replaced when the previous one predates the window', () => {
  const ev = (verified: boolean) =>
    build(
      subject(),
      rawOf({
        admin: {
          verification: { [B]: verified },
          controllers: { [`${B}@100`]: { kind: 'contract', address: B } },
        },
        oracle: {
          events: [
            {
              block: 100,
              tx: '0xo',
              logIndex: 0,
              emitter: ORACLE,
              event: 'AssetSourceUpdated',
              args: { asset: ASSET, source: B },
              entryIds: ['x.y'],
            },
          ],
        },
      }),
    ).changes.find((c) => c.dimension === 'oracle')!
  it('unverified: red AD-9; verified: amber logic change', () => {
    expect(ev(false).red).toBe(true)
    expect(ev(false).ruleIds).toContain('AD-9')
    expect(ev(true).red).toBe(false)
    expect(ev(true).tags).toContain('logic_change')
  })
})

describe('rules #15 AD-6: a queued setGuard on a Safe not classified at head fails closed', () => {
  it('is red, never "guard added"', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function setGuard(address guard)']),
      functionName: 'setGuard',
      args: [X],
    })
    const j = judgeCalls([{ target: SAFE, value: '0', data }], qctx({ safes: [SAFE] }), {
      armed: false,
    })
    expect(j[0][0].v.severity).toBe('downgrade')
    expect(j[0][0].v.ruleIds).toContain('AD-6')
  })
})

describe('rules #16 MR-4: the unlimited sentinel without a declared one', () => {
  const cap: ParamSpec = {
    key: 'c',
    contract: MINTING,
    sig: '',
    rule: 'cap',
    zero: 'closed',
    label: 'cap',
  }
  it('type(uint128).max and type(uint256).max are unlimited', () => {
    expect(classifyParamChange(cap, '2000000', (2n ** 128n - 1n).toString()).ruleIds).toContain(
      'MR-4',
    )
    expect(classifyParamChange(cap, '2000000', (2n ** 256n - 1n).toString()).ruleIds).toContain(
      'MR-4',
    )
    expect(classifyParamChange(cap, '2000000', '4000000').ruleIds).not.toContain('MR-4')
  })
})

describe('rules #17: Solady RoleSet (ether.fi RoleRegistry) is collected as grants / revokes', () => {
  it('RoleSet is scanned, decoded and turned into RoleGranted / RoleRevoked rows', () => {
    expect(ADMIN_TOPICS).toContain(TOPIC.RoleSet)
    const topics = encodeEventTopics({
      abi: parseAbi([
        'event RoleSet(address indexed holder, uint256 indexed role, bool indexed active)',
      ]),
      eventName: 'RoleSet',
      args: { holder: X, role: 5n, active: true },
    })
    const d = decodeLog({ topics, data: '0x' })
    expect(d?.event).toBe('RoleSet')
    const r = roleSetRow({
      emitter: TAR,
      event: 'RoleSet',
      args: d!.args,
      block: 1,
      logIndex: 0,
      tx: '0x',
    })
    expect(r.event).toBe('RoleGranted')
    expect(r.args.account).toBe(X)
    expect(r.args.role).toBe('0x' + '0'.repeat(63) + '5')
    const off = roleSetRow({ ...r, event: 'RoleSet', args: { ...d!.args, active: false } })
    expect(off.event).toBe('RoleRevoked')
  })
})

describe('collector #9: a Safe classification keeps its owner list (silent swaps)', () => {
  it('classify() returns owners for a canonical Safe', async () => {
    const owners = [A, B, C]
    const fake = {
      getCode: async () => '0x6080',
      getBlockNumber: async () => 1000n,
      multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
        contracts.map((c) =>
          c.functionName === 'getThreshold'
            ? { status: 'success', result: 2n }
            : c.functionName === 'getOwners'
              ? { status: 'success', result: owners }
              : { status: 'failure' },
        ),
      getStorageAt: async ({ slot }: { slot: string }) =>
        BigInt(slot) === 0n
          ? '0x' + '0'.repeat(24) + 'd9db270c1b5e3bd161e8c8503c55ceabee709552'
          : '0x' + '0'.repeat(64),
      readContract: async () => [[], '0x0000000000000000000000000000000000000001'],
      request: async () => [],
    }
    const c = (await classify(fake, '0x' + '1'.repeat(40))) as Controller
    expect(c.kind).toBe('safe')
    expect(c.owners).toEqual(owners)
  })
})

// =====================================================================================================
const view = (o: Partial<ConfigChangeView>): ConfigChangeView => ({
  id: 'i',
  state: 'pending',
  stage: 'scheduled',
  dimension: 'admin',
  title: 't',
  before: null,
  after: null,
  red: false,
  severity: 'neutral',
  floorBreach: false,
  ruleIds: [],
  tags: [],
  stillInEffect: false,
  announcement: 'not_checked',
  unannounced: null,
  chainId: 1,
  block: 1,
  blockFrom: null,
  ts: null,
  eta: null,
  txUrl: null,
  queue: null,
  executableBy: null,
  signatures: null,
  route: null,
  notes: [],
  ...o,
})

describe('UI #1: a fully signed Safe proposal reads ARMED', () => {
  it('state text and counts', () => {
    expect(stateText(view({ state: 'proposed', stage: 'armed', signatures: '6/6' }), null)).toMatch(
      /ARMED/,
    )
    const c = countsOf([], [{ state: 'proposed', stage: 'armed', red: false }])
    expect(c.armedProposed).toBe(1)
    expect(headline('X', c as ConfigCounts)).toMatch(/1 proposed \(1 armed\)/)
  })
})

describe('UI #2: a batch with no red call still shows its calls’ loud chips', () => {
  const rows = [
    view({ tags: ['wider_dvn_set'] }),
    view({ tags: ['undecoded'] }),
    view({ tags: ['timelock_bypass'] }),
  ]
  it('the header chips are the union of the loud chips, and the batch opens', () => {
    const labels = batchLoudChips(rows).map((c) => c.label)
    expect(labels).toEqual(
      expect.arrayContaining(['WIDER DVN SET', 'CALL NOT DECODED', 'TIMELOCK BYPASS']),
    )
    expect(batchOpensByDefault({ redCount: 0, rows })).toBe(true)
    expect(batchOpensByDefault({ redCount: 0, rows: [view({})] })).toBe(false)
    expect(src('components/OracleRegistry/ConfigTimeline.tsx')).toMatch(/batchLoudChips\(/)
  })
  it('queue: a call routed through a timelock bypass carries the TIMELOCK BYPASS tag', () => {
    const inner = encodeFunctionData({
      abi: parseAbi(['function setPeer(uint32 eid, bytes32 peer)']),
      functionName: 'setPeer',
      args: [30110, PEER as `0x${string}`],
    })
    const data = encodeFunctionData({
      abi: parseAbi(['function executeWhitelisted(address target, uint256 value, bytes data)']),
      functionName: 'executeWhitelisted',
      args: [OAPP, 0n, inner],
    })
    const out = safeProposalChanges([proposal({ to: TL, data, confirmations: 1 })], qctx())
    expect(out[0].tags).toContain('timelock_bypass')
  })
})

describe('UI #3: filter labels count the full history, not only the loaded rows', () => {
  it('timeline.totals counts every row; the timeline uses them', () => {
    const hist = (i: number, d: ConfigChange['dimension']): ConfigChange => ({
      id: `h${i}`,
      subject: 'z',
      dimension: d,
      key: `k${i}`,
      title: 't',
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
      block: i,
    })
    const changes = [
      ...Array.from({ length: 60 }, (_, i) => hist(i, 'admin')),
      ...Array.from({ length: 5 }, (_, i) => hist(100 + i, 'oracle')),
    ]
    const v = buildConfigCard({ subject: subject(), state: null, changes, queue: [] })
    expect(v.timeline.complete).toBe(false)
    expect(v.timeline.totals.all).toBe(65)
    expect(v.timeline.totals.byDimension.oracle).toBe(5)
    expect(src('components/OracleRegistry/ConfigTimeline.tsx')).toMatch(/timeline\.totals/)
  })
})

describe('UI #4: notes on the admin powers reach the card', () => {
  it('power views carry the item warnings; an unclassified holder is a read gap', () => {
    const out = build(
      subject({
        powers: [{ power: 'upgrade', contract: TAR, path: ['owner'], label: 'Upgrade T' }],
      }),
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade T', contract: TAR, holders: [X] }],
          controllers: {},
        },
      }),
    )
    expect(out.state.readGaps?.join()).toMatch(/could not be classified/)
    const v = buildConfigCard({
      subject: subject(),
      state: out.state,
      changes: out.changes,
      queue: out.queue,
    })
    expect(v.admin.powers[0].warnings.join()).toMatch(/could not be classified/)
    expect(src('components/OracleRegistry/ConfigCard.tsx')).toMatch(/p\.warnings/)
  })
})

describe('UI #5: timeline filters reset between assets; Red only can always be turned off', () => {
  it('the card remounts per subject; "All" clears both filters; an active Red only stays clickable', () => {
    expect(src('components/OracleRegistry/OracleRegistry.tsx')).toMatch(
      /<ConfigCard\s+key=\{config\.data\.subject\}/,
    )
    expect(nextFilter({ dimension: 'admin', redOnly: true }, { kind: 'all' })).toEqual({
      dimension: null,
      redOnly: false,
    })
    // review round 7: the buttons come from timelineFilterButtons — an ACTIVE Red only with no
    // red row left is still enabled (it can be turned off), asserted on the function's output
    expect(src('components/OracleRegistry/ConfigTimeline.tsx')).toMatch(
      /timelineFilterButtons\(view, filter\)/,
    )
    const view = {
      available: true,
      changesAvailable: true,
      oracle: { collected: true },
      timeline: {
        totals: { all: 3, red: 0, byDimension: { bridge: 1, oracle: 0, admin: 2, mint_redeem: 0 } },
      },
    }
    const redOn = timelineFilterButtons(view, { dimension: null, redOnly: true }).find(
      (b) => b.key === 'red',
    )
    expect(redOn).toMatchObject({ active: true, disabled: false })
    const redOff = timelineFilterButtons(view, { dimension: null, redOnly: false }).find(
      (b) => b.key === 'red',
    )
    expect(redOff).toMatchObject({ active: false, disabled: true })
  })
})
