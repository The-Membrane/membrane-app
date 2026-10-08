// Config cards — review round 5 (2026-10-07): the CONFIRMED bugs of the fourth adversarial review
// (on-chain, rules, UI). One test (or group) per finding; each failed on the code before the fix.
// Synthetic fixtures; real Ethereum DVN / library addresses where identity matters.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import {
  configTabLabel,
  configTabMarks,
  dimensionFilterLabel,
  timelineFilterButtons,
  headline,
  oracleAside,
  RED_META,
  rowNoteLine,
  tagChips,
  tagToken,
} from '@/components/OracleRegistry/configViewModel'
import type { ConfigCounts, ConfigTabSummary } from '@/lib/oracleRegistry/config/apiTypes'
import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { compareRoute, routeDiffers } from '@/lib/oracleRegistry/config/bridgeRules'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import { replayLz, type LzEvent } from '@/lib/oracleRegistry/config/lzReplay'
import {
  judgeCalls,
  safeProposalChanges,
  timelockChanges,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  applyGrantPattern,
  classifyMultisigChange,
  classifyParamChange,
  classifyRoleGrant,
  down,
  grantPattern,
  neutral,
} from '@/lib/oracleRegistry/config/rules'
import type {
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
import { formatUsdCompact } from '@/lib/oracleRegistry/config/value'
import { breachesOf, buildConfigCard, countsOf } from '@/lib/oracleRegistry/config/view'
import { combineVerification } from '@/scripts/oracle-registry/config/lib/verify.mjs'
import { readCcipPool } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { ADMIN_TOPICS, TOPIC } from '@/scripts/oracle-registry/config/lib/abi.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const GG = '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc'
const SEND = '0xbb2ea70c9e858123480642cf96acbcce1372dce1'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const RECV_OLD = '0x6666666666666666666666666666666666666666'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const PEER_B = '0x0000000000000000000000004444444444444444444444444444444444444444'
const ZERO32 = '0x' + '0'.repeat(64)
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const C = '0x00000000000000000000000000000000000000cc'
const X = '0x00000000000000000000000000000000000000dd'
const Z = '0x' + '0'.repeat(40)
const MINTING = '0x' + '3'.repeat(40)
const POOL = '0x' + '5'.repeat(40)
const SAFE = '0x' + '6'.repeat(40)
const TL = '0x' + 'c'.repeat(40)
const TAR = '0x' + 'e'.repeat(40)
const TOKEN = '0x' + 'f'.repeat(40)
const PAUSER_HASH = '0x' + '22'.repeat(32)

const dvns = {
  [LZ]: { id: 'layerzero-labs', name: 'LZ' },
  [NM]: { id: 'nethermind', name: 'NM' },
  [GG]: { id: 'google-cloud', name: 'GG' },
}
const libs = { send: [SEND], receive: [RECV, RECV_OLD], blocked: [], read: [] }
// Ethereum and the remote chain (Arbitrum, 42161) share the fixture DVNs / libraries
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
    {
      role: 'ccip_pool',
      dimension: 'bridge',
      chainId: 1,
      address: POOL,
      label: 'p',
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
  ccip?: RawSubject['ccip']
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
  ccip: o.ccip ?? { pools: [] },
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'arbitrum', roleName: (h) => h, endpoint: EP })
const qctx = (o: Partial<QueueCtx> = {}): QueueCtx => ({
  subject: 's',
  announcement: 'not_checked',
  eval: ctx,
  block: 100_000,
  endpoint: EP,
  routes: {},
  defaults: {},
  libDirection: (l) => (l === SEND ? 'send' : l === RECV || l === RECV_OLD ? 'receive' : null),
  ctl: () => null,
  ownerOf: () => null,
  delegateOf: () => null,
  implHistory: {},
  minDelayOf: () => 86400,
  roleName: (h) => (h === PAUSER_HASH ? 'PAUSER_ROLE' : h),
  contracts: [MINTING, POOL, TAR, OAPP],
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
const counts = (o: Partial<ConfigCounts> = {}): ConfigCounts => ({
  floorBreaches: 0,
  ruleBreaches: 0,
  redInEffect: 0,
  redOpen: 0,
  openRed: 0,
  redTotal: 0,
  pending: 0,
  armed: 0,
  stale: 0,
  proposed: 0,
  historical: 0,
  unread: 0,
  readGaps: 0,
  ...o,
})
const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

// =====================================================================================================
describe('on-chain #1: a power-graph controller is charged only from the block it held a power', () => {
  const delay = (block: number, tx: string): AdminEventRow =>
    row({
      emitter: TL,
      event: 'MinDelayChange',
      block,
      tx,
      args: { oldDuration: 86400, newDuration: 60 },
    })
  const gain = row({
    emitter: POOL,
    event: 'OwnershipTransferred',
    block: 500,
    tx: '0xgain',
    args: { previousOwner: X, newOwner: TL },
  })
  const bypassGrant = row({
    emitter: TL,
    event: 'RoleGranted',
    block: 60,
    tx: '0xbyp',
    args: { role: '0x' + '9'.repeat(64), roleName: 'BYPASSER_ROLE', account: X },
  })
  const controllers = {
    [`${X}@499`]: eoa(X),
    [`${X}@60`]: eoa(X),
    [`${TL}@500`]: { kind: 'oz_timelock' as const, address: TL, delaySec: 86400 },
  }
  it("another protocol's timelock history (before it held any power here) is not filed", () => {
    const out = build(
      subject(),
      rawOf({
        admin: { events: [bypassGrant, delay(100, '0xd1'), gain, delay(600, '0xd2')], controllers },
      }),
    )
    const tl = out.changes.filter((c) => c.key.includes(TL))
    expect(tl.map((c) => c.block).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([600])
    expect(tl[0].red).toBe(true)
    expect(tl[0].ruleIds).toContain('AD-2')
  })
  it('fail closed: with no event showing when it gained a power, its whole history stays', () => {
    const out = build(
      subject(),
      rawOf({ admin: { events: [delay(100, '0xd1'), delay(600, '0xd2')], controllers } }),
    )
    expect(out.changes.filter((c) => c.key.startsWith(`admin/timelock_delay/${TL}`))).toHaveLength(
      2,
    )
  })
  it("a declared subject contract's own history is always filed", () => {
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
      }),
      rawOf({ admin: { events: [delay(100, '0xd1'), gain], controllers } }),
    )
    expect(out.changes.some((c) => c.key === `admin/timelock_delay/${TL}`)).toBe(true)
  })
})

describe('on-chain #2: a Safe fallback-handler row shows the previous handler it replaced', () => {
  const H0 = '0x' + '1'.repeat(39) + '0'
  const H1 = '0x' + '1'.repeat(39) + '1'
  const H2 = '0x' + '1'.repeat(39) + '2'
  it('the earlier event (or the archive read at block − 1) is the "before", never "?"', () => {
    const out = classifyAdminEvents(
      [
        row({ emitter: SAFE, event: 'ChangedFallbackHandler', block: 100, args: { handler: H1 } }),
        row({
          emitter: SAFE,
          event: 'ChangedFallbackHandler',
          block: 200,
          tx: '0xt2',
          args: { handler: H2 },
        }),
      ],
      actx({ [`${SAFE}@99`]: safe(SAFE, 2, 3, { fallbackHandler: H0 }) }),
    )
    expect(out[0].before).toBe(H0)
    expect(out[0].notes?.join()).toContain(`${H0} → ${H1}`)
    expect(out[1].before).toBe(H1)
    expect(out[1].notes?.join()).toContain(`${H1} → ${H2}`)
    expect(out[1].notes?.join()).not.toMatch(/\?/)
  })
})

// =====================================================================================================
describe('rules #1 BR-6: a peer re-point through zero (A → 0 → B) is red', () => {
  const base = { chainId: 1, logIndex: 0 }
  const setup: LzEvent[] = [
    { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30110, lib: RECV },
    { ...base, block: 1, tx: '0x1', logIndex: 1, kind: 'default_send_lib', eid: 30110, lib: SEND },
    {
      ...base,
      block: 2,
      tx: '0x2',
      kind: 'uln',
      lib: RECV,
      oapp: OAPP,
      eid: 30110,
      config: uln([LZ, NM]),
    },
    {
      ...base,
      block: 2,
      tx: '0x2',
      logIndex: 1,
      kind: 'uln',
      lib: SEND,
      oapp: OAPP,
      eid: 30110,
      config: uln([LZ, NM]),
    },
    { ...base, block: 3, tx: '0x3', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
    { ...base, block: 10, tx: '0xz', kind: 'peer', oapp: OAPP, eid: 30110, peer: ZERO32 },
  ]
  it('replay: the reopening to a DIFFERENT peer is BR-6 (strict), naming the last non-zero peer', () => {
    const r = replayLz(
      [
        ...setup,
        { ...base, block: 20, tx: '0xb', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER_B },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const reopen = r.changes.filter((c) => c.tx === '0xb')
    expect(reopen.length).toBeGreaterThan(0)
    for (const c of reopen) {
      expect(c.red).toBe(true)
      expect(c.ruleIds).toContain('BR-6')
      expect(c.notes?.join()).toContain(PEER)
    }
    expect(r.lastPeer[`${OAPP}|30110|receive`]).toBe(PEER_B)
  })
  it('replay: reopening to the SAME peer is not a re-point', () => {
    const r = replayLz(
      [
        ...setup,
        { ...base, block: 20, tx: '0xa', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    for (const c of r.changes.filter((x) => x.tx === '0xa')) expect(c.ruleIds).not.toContain('BR-6')
  })
  it('queue: a pending setPeer reopening a zeroed route to a different peer is red BR-6', () => {
    const r = replayLz(setup, { subject: 't', oapps: [OAPP], ctx })
    const abi = parseAbi(['function setPeer(uint32 eid, bytes32 peer)'])
    const data = encodeFunctionData({
      abi,
      functionName: 'setPeer',
      args: [30110, PEER_B as `0x${string}`],
    })
    const routes = Object.fromEntries(r.routes.map((x) => [`${x.oapp}|${x.eid}|${x.direction}`, x]))
    const out = timelockChanges(
      [armedOp([data], [OAPP])],
      qctx({ routes, lz: r.state, lastVerifying: r.lastVerifying, lastPeer: r.lastPeer }),
      1000,
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('BR-6')
  })
  it('remote side between runs: A, then 0, then B is red BR-6', () => {
    const REMOTE = '0x' + '4'.repeat(40)
    const padded = (a: string) => '0x' + '0'.repeat(24) + a.slice(2)
    const head = (direction: 'send' | 'receive') => ({
      oapp: OAPP,
      eid: 30110,
      direction,
      lib: direction === 'send' ? SEND : RECV,
      libIsDefault: false,
      merged: uln([LZ, NM]),
      app: null,
      peer: padded(REMOTE),
    })
    const remote = (peerBack: string) => ({
      oapp: OAPP,
      eid: 30110,
      chainKey: 'arbitrum',
      chainId: 42161,
      status: 'ok' as const,
      peer: REMOTE,
      peerBack,
      directions: {
        receive: { lib: RECV, merged: uln([LZ, NM]) },
        send: { lib: SEND, merged: uln([LZ, NM]) },
      },
      dvnCode: { [LZ]: true, [NM]: true },
    })
    const run = (headBlock: number, peerBack: string, prev?: ReturnType<typeof build>['state']) =>
      build(
        subject(),
        rawOf({
          head: headBlock,
          lz: {
            headRoutes: [head('receive'), head('send')],
            remote: [remote(peerBack)],
            previousRemote: prev
              ? {
                  block: prev.asOf.block,
                  routes: prev.remoteSnapshot!,
                  readAt: prev.remoteReadAt,
                  lastPeer: prev.remoteLastPeer,
                }
              : undefined,
          },
        }),
      )
    const r1 = run(1000, padded(OAPP))
    const r2 = run(2000, ZERO32, r1.state)
    const r3 = run(3000, padded(C), r2.state)
    const repoint = r3.changes.filter((c) => c.id.includes('remote-head'))
    expect(repoint.length).toBeGreaterThan(0)
    expect(repoint.every((c) => c.red && c.ruleIds.includes('BR-6'))).toBe(true)
  })
})

describe('rules #2 BR-3: a weaker config on the receive library still in its grace period is seen', () => {
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
  it('compareRoute: grace library confirmations set to NIL (same DVNs) differ and are red BR-3', () => {
    const before = rt(uln([LZ, NM]))
    const after = rt(uln([LZ, NM], [], 0, String(NIL_CONFIRMATIONS)))
    expect(routeDiffers(before, after)).toBe(true)
    const v = compareRoute(before, after)
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('BR-3')
  })
  it('replay: the override on the grace library emits a red change', () => {
    const base = { chainId: 1, logIndex: 0 }
    const r = replayLz(
      [
        { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30110, lib: RECV_OLD },
        {
          ...base,
          block: 2,
          tx: '0x2',
          kind: 'uln',
          lib: RECV_OLD,
          oapp: OAPP,
          eid: 30110,
          config: uln([LZ, NM]),
        },
        {
          ...base,
          block: 2,
          tx: '0x2',
          logIndex: 1,
          kind: 'uln',
          lib: RECV,
          oapp: OAPP,
          eid: 30110,
          config: uln([LZ, NM]),
        },
        { ...base, block: 3, tx: '0x3', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
        { ...base, block: 4, tx: '0x4', kind: 'recv_lib', oapp: OAPP, eid: 30110, lib: RECV },
        {
          ...base,
          block: 4,
          tx: '0x4',
          logIndex: 1,
          kind: 'recv_timeout',
          oapp: OAPP,
          eid: 30110,
          lib: RECV_OLD,
          expiry: 1_000_000,
        },
        {
          ...base,
          block: 5,
          tx: '0x5',
          kind: 'uln',
          lib: RECV_OLD,
          oapp: OAPP,
          eid: 30110,
          config: uln([LZ, NM], [], 0, String(NIL_CONFIRMATIONS)),
        },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = r.changes.find((x) => x.tx === '0x5' && x.route?.direction === 'receive')
    expect(c).toBeDefined()
    expect(c!.red).toBe(true)
    expect(c!.ruleIds).toContain('BR-3')
  })
})

describe('rules #3 / #4: grace libraries on the remote side and unread grace configs', () => {
  const REMOTE = '0x' + '4'.repeat(40)
  const head = (direction: 'send' | 'receive', o: Record<string, unknown> = {}) => ({
    oapp: OAPP,
    eid: 30110,
    direction,
    lib: direction === 'send' ? SEND : RECV,
    libIsDefault: false,
    merged: uln([LZ, NM]),
    app: null,
    peer: '0x' + '0'.repeat(24) + REMOTE.slice(2),
    ...o,
  })
  const remote = (grace: { lib: string; expiry: number; config: UlnConfigRaw | null }) => ({
    oapp: OAPP,
    eid: 30110,
    chainKey: 'arbitrum',
    chainId: 42161,
    status: 'ok' as const,
    peer: REMOTE,
    peerBack: '0x' + '0'.repeat(24) + OAPP.slice(2),
    block: 5000,
    directions: {
      receive: { lib: RECV, merged: uln([LZ, NM]), grace },
      send: { lib: SEND, merged: uln([LZ, NM]) },
    },
    dvnCode: { [LZ]: true, [NM]: true },
  })
  const rkey = `bridge/lz/42161/${REMOTE}/30101/receive`
  it('#3 the remote receive library in its grace period counts: E is the minimum (BR-2)', () => {
    const out = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [head('receive'), head('send')],
          remote: [remote({ lib: RECV_OLD, expiry: 9_000, config: uln([LZ]) })],
        },
      }),
    )
    const r = out.state.items.find((i) => i.key === rkey)!
    expect((r.value as { E: number }).E).toBe(1)
    expect(r.breaches.map((b) => b.ruleId)).toContain('BR-2')
    // expired on the remote chain (its own block): no longer verifies
    const expired = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [head('receive'), head('send')],
          remote: [remote({ lib: RECV_OLD, expiry: 4_000, config: uln([LZ]) })],
        },
      }),
    )
    expect((expired.state.items.find((i) => i.key === rkey)!.value as { E: number }).E).toBe(2)
  })
  it('#3 a remote grace library whose config could not be read is UNREAD, never calm', () => {
    const out = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [head('receive'), head('send')],
          remote: [remote({ lib: RECV_OLD, expiry: 9_000, config: null })],
        },
      }),
    )
    const r = out.state.items.find((i) => i.key === rkey)!
    expect(r.warnings).toContain('REMOTE UNREAD')
    expect(r.display).toMatch(/grace/)
    expect(out.state.counts && countsOf(out.state.items, []).unread).toBeGreaterThan(0)
  })
  it('#4 a local grace library whose config read failed is UNREAD (it can still verify)', () => {
    const out = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [
            head('receive', { grace: { lib: RECV_OLD, expiry: 2_000_000, config: null } }),
            head('send'),
          ],
        },
      }),
    )
    const r = out.state.items.find((i) => i.key === `bridge/lz/1/${OAPP}/30110/receive`)!
    expect(r.warnings).toContain('UNREAD')
    expect(r.display).toMatch(/grace library .* UNREAD|UNREAD — grace library/)
    // an expired grace (expiry ≤ head) is not a gap
    const expired = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [
            head('receive', { grace: { lib: RECV_OLD, expiry: 10, config: null } }),
            head('send'),
          ],
        },
      }),
    )
    const e = expired.state.items.find((i) => i.key === `bridge/lz/1/${OAPP}/30110/receive`)!
    expect(e.warnings ?? []).not.toContain('UNREAD')
  })
})

// =====================================================================================================
describe('rules #5 AD-6: a guard REPLACED (old guard set before the scan) is red, not "added"', () => {
  const OLD = '0x' + '7'.repeat(40)
  const NEW = '0x' + '8'.repeat(40)
  const one = (m: Record<string, Controller>, o: Record<string, unknown> = {}) =>
    classifyAdminEvents(
      [row({ emitter: SAFE, event: 'ChangedGuard', block: 500, args: { guard: NEW } })],
      actx(m, o),
    )[0]
  it('the archive read at block − 1 had a guard: red AD-6 replacement', () => {
    const c = one({ [`${SAFE}@499`]: safe(SAFE, 2, 3, { guard: OLD }) })
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-6')
    expect(c.before).toBe(OLD)
  })
  it('no guard at block − 1: an added guard is an upgrade', () => {
    const c = one({ [`${SAFE}@499`]: safe(SAFE, 2, 3, { guard: Z }) })
    expect(c.red).toBe(false)
    expect(c.severity).toBe('upgrade')
  })
  it('previous guard unread and the Safe older than the scan: fail closed (red)', () => {
    const c = one({}, { scanFrom: 100 })
    expect(c.red).toBe(true)
    expect(c.notes?.join()).toMatch(/previous guard not read/)
  })
  it('previous guard unread but the Safe was deployed inside the scan: the events are complete', () => {
    const c = one({}, { scanFrom: 10 })
    expect(c.severity).toBe('upgrade')
  })
})

describe('rules #6 AD-3: ownership taken back after a renounce is red, never "initialization"', () => {
  it('owner X → 0 (renounced), later 0 → a 1-of-1 Safe: red', () => {
    const out = classifyAdminEvents(
      [
        row({ event: 'OwnershipTransferred', block: 100, args: { previousOwner: X, newOwner: Z } }),
        row({
          event: 'OwnershipTransferred',
          block: 500_000,
          tx: '0xback',
          args: { previousOwner: Z, newOwner: SAFE },
        }),
      ],
      actx({ [`${SAFE}@500000`]: safe(SAFE, 1, 1), [`${X}@99`]: eoa(X) }),
    )
    const back = out.find((c) => c.tx === '0xback')!
    expect(back.tags).not.toContain('initialization')
    expect(back.red).toBe(true)
    expect(back.ruleIds).toContain('AD-3')
  })
  it('owner set from 0 after an upgrade, previous owner unknown, new owner unclassified: red', () => {
    const out = classifyAdminEvents(
      [
        row({ event: 'Upgraded', block: 400, tx: '0xup', args: { implementation: C } }),
        row({
          event: 'OwnershipTransferred',
          block: 500,
          tx: '0xo',
          args: { previousOwner: Z, newOwner: B },
        }),
      ],
      actx({}, { verified: () => true }),
    ).find((c) => c.tx === '0xo')!
    expect(out.tags).not.toContain('initialization')
    expect(out.red).toBe(true)
  })
})

describe('rules #7 AD-4: CANCELLER_ROLE (admin-level) granted to an EOA is red', () => {
  it('classifier and replay', () => {
    expect(classifyRoleGrant('CANCELLER_ROLE', eoa(B), [], true).ruleIds).toContain('AD-4')
    const c = classifyAdminEvents(
      [
        row({
          block: 900,
          args: { role: '0x' + 'ca'.repeat(32), roleName: 'CANCELLER_ROLE', account: B },
        }),
      ],
      actx({ [`${B}@900`]: eoa(B) }),
    )[0]
    expect(c.red).toBe(true)
  })
})

describe('rules #8 AD-1: signers added so that the new signers alone meet the threshold is red', () => {
  it('Safe 2-of-3 → 3-of-10 (seven new signers, any three act): red', () => {
    const v = classifyMultisigChange(safe(SAFE, 2, 3), safe(SAFE, 3, 10))
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('AD-1')
  })
  it('controls: 3-of-5 → 4-of-7 and 2-of-3 → 3-of-4 stay upgrades', () => {
    expect(classifyMultisigChange(safe(SAFE, 3, 5), safe(SAFE, 4, 7)).severity).toBe('upgrade')
    expect(classifyMultisigChange(safe(SAFE, 2, 3), safe(SAFE, 3, 4)).severity).toBe('upgrade')
  })
  it('replayed from events: 7 AddedOwner + ChangedThreshold(3) on a 2-of-3 Safe is red', () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, i) =>
        row({ emitter: SAFE, event: 'AddedOwner', block: 600, logIndex: i, args: { owner: X } }),
      ),
      row({
        emitter: SAFE,
        event: 'ChangedThreshold',
        block: 600,
        logIndex: 7,
        args: { threshold: 3 },
      }),
    ]
    const c = classifyAdminEvents(rows, actx({ [`${SAFE}@599`]: safe(SAFE, 2, 3) }))[0]
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-1')
  })
})

describe('rules #9 MR-2 / AD-9: a provider moved to a contract an EOA controls is red', () => {
  const spec: ParamSpec = {
    key: 'rateProvider',
    contract: MINTING,
    sig: 'function rateProvider() view returns (address)',
    rule: 'rate_provider',
    label: 'rate provider',
  }
  it('verified contract owned by an EOA: red MR-2 (ranks with an EOA)', () => {
    const v = classifyParamChange(
      spec,
      A,
      B,
      { kind: 'contract', address: B, ownedBy: eoa(X) },
      { prevCtl: { kind: 'contract', address: A }, nextVerified: true },
    )
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('MR-2')
  })
  it('head state: a provider that is a contract owned by an EOA is an MR-2 breach', () => {
    const out = build(
      subject({ params: [spec] }),
      rawOf({
        params: { head: { rateProvider: B }, transitions: [] },
        admin: {
          controllers: { [`${B}@head`]: { kind: 'contract', address: B, ownedBy: eoa(X) } },
        },
      }),
    )
    const i = out.state.items.find((x) => x.key === 'mint/rateProvider')!
    expect(i.breaches.map((b) => b.ruleId)).toContain('MR-2')
  })
  it('a verified proxy in front of an unverified implementation is not verified', () => {
    expect(combineVerification(true, false)).toBe(false)
    expect(combineVerification(true, null)).toBe(null)
    expect(combineVerification(true, true)).toBe(true)
    expect(combineVerification(true, undefined)).toBe(true) // not a proxy
    expect(combineVerification(false, true)).toBe(false)
  })
})

// =====================================================================================================
describe('rules #10 / #11: CCIP pool calls are decoded; a siloed pool reports its per-chain rebalancer', () => {
  const SEL = 4949039107694359620n
  const enc = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as `0x${string}`])
  const pools = [
    {
      pool: POOL,
      owner: TL,
      rebalancer: B,
      chains: [
        {
          selector: String(SEL),
          inboundEnabled: true,
          outboundEnabled: true,
          remotePools: [enc(C)],
        },
      ],
    },
  ]
  const ABI = parseAbi([
    'function setRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
    'function setChainRateLimiterConfig(uint64 remoteChainSelector, (bool isEnabled, uint128 capacity, uint128 rate) outboundConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundConfig)',
    'function setRebalancer(address rebalancer)',
    'function setSiloRebalancer(uint64 remoteChainSelector, address newRebalancer)',
    'function applyChainUpdates(uint64[] remoteChainSelectorsToRemove, (uint64 remoteChainSelector, bytes[] remotePoolAddresses, bytes remoteTokenAddress, (bool isEnabled, uint128 capacity, uint128 rate) outboundRateLimiterConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundRateLimiterConfig)[] chainsToAdd)',
    'function setPool(address localToken, address pool)',
  ])
  const off = { isEnabled: false, capacity: 0n, rate: 0n }
  const on = { isEnabled: true, capacity: 10n, rate: 1n }
  const q = () =>
    qctx({
      ctl: (a) => (a === X ? eoa(X) : a === B ? safe(B, 3, 5) : null),
      ccipPools: pools,
      tokens: [TOKEN],
      subjectCcipPools: [POOL],
    })
  const judge = (data: string, target = POOL) =>
    timelockChanges([armedOp([data], [target])], q(), 1000)
  it('setRemotePool to a new pool: red CC-1 (+ AD-8 armed)', () => {
    const c = judge(
      encodeFunctionData({ abi: ABI, functionName: 'setRemotePool', args: [SEL, enc(X)] }),
    )[0]
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(expect.arrayContaining(['CC-1', 'AD-8']))
  })
  it('setChainRateLimiterConfig off/off: red CC-2', () => {
    const c = judge(
      encodeFunctionData({
        abi: ABI,
        functionName: 'setChainRateLimiterConfig',
        args: [SEL, off, off],
      }),
    )[0]
    expect(c.ruleIds).toEqual(expect.arrayContaining(['CC-2', 'AD-8']))
  })
  it('setRebalancer / setSiloRebalancer to an EOA: red CC-3', () => {
    const a = judge(encodeFunctionData({ abi: ABI, functionName: 'setRebalancer', args: [X] }))[0]
    expect(a.ruleIds).toEqual(expect.arrayContaining(['CC-3', 'AD-8']))
    const b = judge(
      encodeFunctionData({ abi: ABI, functionName: 'setSiloRebalancer', args: [SEL, X] }),
    )[0]
    expect(b.ruleIds).toContain('CC-3')
  })
  it('applyChainUpdates: a chain re-added with another pool (CC-1) or with its limiter off (CC-2)', () => {
    const repoint = judge(
      encodeFunctionData({
        abi: ABI,
        functionName: 'applyChainUpdates',
        args: [
          [SEL],
          [
            {
              remoteChainSelector: SEL,
              remotePoolAddresses: [enc(X)],
              remoteTokenAddress: enc(X),
              outboundRateLimiterConfig: on,
              inboundRateLimiterConfig: on,
            },
          ],
        ],
      }),
    )
    expect(repoint.some((c) => c.ruleIds.includes('CC-1'))).toBe(true)
    const add = (sel: bigint, remove: bigint[], outbound: typeof on) =>
      judge(
        encodeFunctionData({
          abi: ABI,
          functionName: 'applyChainUpdates',
          args: [
            remove,
            [
              {
                remoteChainSelector: sel,
                remotePoolAddresses: [enc(C)],
                remoteTokenAddress: enc(X),
                outboundRateLimiterConfig: outbound,
                inboundRateLimiterConfig: on,
              },
            ],
          ],
        }),
      )
    // a served chain re-added (same pool) with its limiter off: the limiter is on now → CC-2
    expect(add(SEL, [SEL], off).some((c) => c.ruleIds.includes('CC-2'))).toBe(true)
    expect(add(SEL, [SEL], off).some((c) => c.ruleIds.includes('CC-1'))).toBe(false)
    // a NEW chain with no limiter has nothing to switch off (like an executed ChainAdded)
    const fresh = add(5009297550715157269n, [], off)
    expect(fresh.some((c) => c.red)).toBe(false)
    expect(fresh.flatMap((c) => c.notes ?? []).join()).toMatch(/rate limiter outbound off/)
  })
  it("TokenAdminRegistry.setPool for the subject's token to another pool: red CC-1", () => {
    const c = judge(
      encodeFunctionData({
        abi: ABI,
        functionName: 'setPool',
        args: [TOKEN as `0x${string}`, X as `0x${string}`],
      }),
      TAR,
    )[0]
    expect(c.ruleIds).toContain('CC-1')
  })
  it('a queued call that still cannot be decoded is a loud chip, not a quiet word', () => {
    expect(tagChips(['undecoded'])[0]).toMatchObject({ label: 'CALL NOT DECODED', loud: true })
  })
  it('the collector scans the 1.6 siloed-pool events', () => {
    for (const e of ['SiloRebalancerSet', 'UnsiloedRebalancerSet', 'ChainSiloed'])
      expect(ADMIN_TOPICS).toContain(TOPIC[e])
  })
  it('the collector reads getChainRebalancer for a siloed chain', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case 'owner':
            return TL
          case 'getRebalancer':
            return Z
          case 'getSupportedChains':
            return [SEL]
          case 'getCurrentInboundRateLimiterState':
          case 'getCurrentOutboundRateLimiterState':
            return { isEnabled: true }
          case 'getRemotePools':
            return [enc(C)]
          case 'isSiloed':
            return true
          case 'getChainRebalancer':
            return X
          default:
            throw new Error('unexpected ' + functionName)
        }
      },
    }
    const p = (await readCcipPool(client, POOL)) as unknown as {
      chains: { siloed: boolean | null; rebalancer: string | null }[]
    }
    expect(p.chains[0].siloed).toBe(true)
    expect(p.chains[0].rebalancer).toBe(X)
  })
  it('engine: a siloed chain whose rebalancer is an EOA is a CC-3 breach (not "renounced")', () => {
    const out = build(
      subject({ ccipPools: [POOL] }),
      rawOf({
        ccip: {
          pools: [
            {
              pool: POOL,
              owner: TL,
              rebalancer: Z,
              chains: [
                {
                  selector: String(SEL),
                  inboundEnabled: true,
                  outboundEnabled: true,
                  remotePools: [enc(C)],
                  siloed: true,
                  rebalancer: X,
                },
              ],
            },
          ],
        },
        admin: {
          controllers: { [`${X}@head`]: eoa(X), [`${Z}@head`]: { kind: 'zero', address: Z } },
        },
      }),
    )
    const i = out.state.items.find((x) => x.key === `bridge/ccip/${POOL}`)!
    expect(i.breaches.map((b) => b.ruleId)).toContain('CC-3')
    expect(i.display).toMatch(/siloed/)
  })
  it('replay: SiloRebalancerSet to an EOA is red CC-3', () => {
    const c = classifyAdminEvents(
      [
        row({
          emitter: POOL,
          event: 'SiloRebalancerSet',
          block: 700,
          args: { remoteChainSelector: String(SEL), oldRebalancer: B, newRebalancer: X },
        }),
      ],
      actx({ [`${X}@700`]: eoa(X), [`${B}@699`]: safe(B, 3, 5) }),
    )[0]
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('CC-3')
  })
})

describe('rules #12 MR-1: a pending revoke of the last pauser is red', () => {
  const abi = parseAbi(['function revokeRole(bytes32 role, address account)'])
  const revoke = (a: string) =>
    encodeFunctionData({
      abi,
      functionName: 'revokeRole',
      args: [PAUSER_HASH as `0x${string}`, a as `0x${string}`],
    })
  it('the only pauser revoked: red MR-1', () => {
    const out = timelockChanges(
      [armedOp([revoke(A)], [MINTING])],
      qctx({ roleHolders: () => [A] }),
      1000,
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('MR-1')
  })
  it('both pausers revoked in one op: the second call leaves none (judged in order)', () => {
    const out = timelockChanges(
      [armedOp([revoke(A), revoke(B)], [MINTING])],
      qctx({ roleHolders: () => [A, B] }),
      1000,
    )
    expect(out[0].red).toBe(false)
    expect(out[1].red).toBe(true)
  })
})

describe('rules #13 AD-8: a fully signed Safe proposal is ARMED (anyone can execute it)', () => {
  const abi = parseAbi(['function changeThreshold(uint256 _threshold)'])
  const data = encodeFunctionData({ abi, functionName: 'changeThreshold', args: [1n] })
  const prop = (confirmations: number) => ({
    safe: SAFE,
    nonce: 7,
    to: SAFE,
    value: '0',
    data,
    confirmations,
    confirmationsRequired: 3,
    safeTxHash: '0xh',
  })
  const q = qctx({ ctl: (a) => (a === SAFE ? safe(SAFE, 3, 5) : null), safes: [SAFE] })
  it('3/3 signatures: stage armed, AD-8', () => {
    const c = safeProposalChanges([prop(3)], q)[0]
    expect(c.stage).toBe('armed')
    expect(c.ruleIds).toEqual(expect.arrayContaining(['AD-1', 'AD-8']))
  })
  it('2/3 signatures: still queued, no AD-8', () => {
    const c = safeProposalChanges([prop(2)], q)[0]
    expect(c.stage).toBe('safe_queued')
    expect(c.ruleIds).not.toContain('AD-8')
  })
  it('judgeCalls is unchanged for a not-armed call', () => {
    expect(judgeCalls([], q, { armed: false })).toEqual([])
  })
})

describe('rules #14 AD-3: a FIRST LZ delegate set long after the OApp was deployed is red', () => {
  const delegate = (block: number): LzEvent => ({
    chainId: 1,
    block,
    logIndex: 0,
    tx: `0xdel${block}`,
    kind: 'delegate',
    oapp: OAPP,
    delegate: B,
  })
  const run = (block: number) =>
    build(
      subject(),
      rawOf({
        lz: { events: [delegate(block)] },
        admin: { controllers: { [`${B}@${block}`]: safe(B, 3, 5) } },
      }),
    ).changes.find((c) => c.key === `admin/lz-delegate/${OAPP}`)!
  it('within 7,200 blocks of deployment: initialization', () => {
    expect(run(100).tags).toContain('initialization')
    expect(run(100).red).toBe(false)
  })
  it('more than 7,200 blocks after: red (front-run initialize())', () => {
    const c = run(9_000)
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-3')
  })
})

// =====================================================================================================
describe('UI: every reason is shown, and the amber / red chips differ', () => {
  it('the pattern note leads (operational or anomaly), and the row shows every note', () => {
    const bots = [1, 2, 3].map((i) => ({ block: i * 100_000, account: X, noCode: true }))
    const v = down(neutral(), 'AD-4', 'MINTER_ROLE → EOA')
    v.notes.push('new minter')
    applyGrantPattern(v, 'MINTER_ROLE', grantPattern('MINTER_ROLE', eoa(B), 1_000_000, bots))
    expect(v.notes[0]).toMatch(/^operational: matches the established MINTER_ROLE bot pattern/)
    const a = down(neutral(), 'AD-4', 'x')
    a.notes.push('y')
    applyGrantPattern(a, 'MINTER_ROLE', grantPattern('MINTER_ROLE', safe(B, 1, 1), 1_000_000, bots))
    expect(a.notes[0]).toMatch(/^outside the established MINTER_ROLE bot pattern/)
    expect(rowNoteLine([], ['n1', 'n2', 'the reason'])).toContain('the reason')
    expect(src('components/OracleRegistry/ConfigTimeline.tsx')).not.toMatch(/notes\.slice\(0, ?2\)/)
  })
  it('ANOMALY / NOT VERIFIED / LOOKUP FAILED chips are red; OPERATIONAL stays amber', () => {
    for (const t of ['anomaly', 'unverified', 'verification_unread'] as const)
      expect(tagToken(tagChips([t])[0])).toBe(RED_META.token)
    expect(tagToken(tagChips(['operational'])[0])).toBe(SEMANTIC_COLORS.warning)
    expect(src('components/OracleRegistry/ConfigTimeline.tsx')).toMatch(/tagToken\(/)
  })
})

describe('UI: "not collected" never reads as zero or calm', () => {
  it('the Oracles block of a subject with no oracle asset says "not collected", else its window', () => {
    expect(
      oracleAside({ oracleSlug: null, entries: 0, changes: 0, collected: false, windowDays: null }),
    ).toBe('not collected')
    expect(
      oracleAside({
        oracleSlug: 'weeth',
        entries: 3,
        changes: 2,
        collected: true,
        windowDays: 180,
      }),
    ).toBe('2 config changes · last 180 d')
    expect(dimensionFilterLabel('oracle', 0, false)).toMatch(/not collected/)
    expect(dimensionFilterLabel('admin', 4, true)).toBe('Admin 4')
    const card = buildConfigCard({ subject: subject(), state: null, changes: [], queue: [] })
    expect(card.oracle.collected).toBe(false)
    expect(src('components/OracleRegistry/ConfigCard.tsx')).toMatch(/oracleAside\(/)
    // review round 7: the buttons come from timelineFilterButtons (which labels them with
    // dimensionFilterLabel) — asserted on its output, and on the timeline rendering it
    expect(src('components/OracleRegistry/ConfigTimeline.tsx')).toMatch(
      /timelineFilterButtons\(view, filter\)/,
    )
    expect(src('components/OracleRegistry/configViewModel.ts')).toMatch(/dimensionFilterLabel\(/)
    const oracleBtn = timelineFilterButtons(
      {
        available: true,
        changesAvailable: true,
        oracle: { collected: false },
        timeline: {
          totals: {
            all: 3,
            red: 0,
            byDimension: { bridge: 1, oracle: 0, admin: 2, mint_redeem: 0 },
          },
        },
      },
      { dimension: null, redOnly: false },
    ).find((b) => b.key === 'oracle')
    expect(oracleBtn?.label).toMatch(/not collected/)
    expect(oracleBtn?.disabled).toBe(true)
  })
  it('the engine records the oracle window; the card exposes it', () => {
    const out = build(subject({ oracleAssetKey: 'zz' }), rawOf({}))
    const withWindow = build(subject({ oracleAssetKey: 'zz' }), {
      ...rawOf({}),
      oracle: { events: [], window: { startBlock: 1, endBlock: 2, days: 180 } },
    })
    expect(out.state.oracleWindow).toBeUndefined()
    expect(withWindow.state.oracleWindow?.days).toBe(180)
    const card = buildConfigCard({
      subject: subject({ oracleAssetKey: 'zz' }),
      state: withWindow.state,
      changes: [],
      queue: [],
    })
    expect(card.oracle).toMatchObject({ collected: true, windowDays: 180 })
  })
  it('a tab with no collector output carries a visible mark', () => {
    const tab = (asOf: ConfigTabSummary['asOf']): ConfigTabSummary => ({
      subject: 'x',
      slug: 'x',
      symbol: 'X',
      label: 'X',
      oracleSlug: null,
      counts: counts(),
      asOf,
    })
    const marks = configTabMarks(tab(null))
    expect(marks).toHaveLength(1)
    expect(marks[0].label).toMatch(/not collected/)
    expect(configTabMarks(tab({ block: 1, ts: 1 }))).toEqual([])
    expect(configTabLabel(tab(null))).toBe('config: not collected')
  })
})

describe('UI: failed reads show on the card and hedge the headline', () => {
  it('headline says the reads failed and that red flags may be missing', () => {
    const h = headline('USDe', counts({ readGaps: 2, unread: 5 }))
    expect(h).toMatch(/5 route sides unread/)
    expect(h).toMatch(/2 reads failed/)
    expect(h).toMatch(/red flags may be missing/)
    expect(headline('USDe', counts())).not.toMatch(/may be missing/)
    expect(src('components/OracleRegistry/ConfigCard.tsx')).toMatch(/view\.readGaps/)
  })
  it('tab marks: unread sides and failed reads have distinct glyphs, and keys are unique', () => {
    const marks = configTabMarks({
      counts: counts({ unread: 5, readGaps: 2 }),
      asOf: { block: 1, ts: 1 },
    })
    const glyphs = marks.map((m) => m.glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
    for (const f of [
      'components/OracleRegistry/AssetTabs.tsx',
      'components/OracleRegistry/ViewSwitch.tsx',
    ])
      expect(src(f)).not.toMatch(/key=\{m\.glyph\}/)
  })
})

describe('UI: the red banner names the route of each breach; $999.6M is "$1B"', () => {
  it('breachesOf carries where the breach is', () => {
    const b = breachesOf([
      {
        subject: 'z',
        dimension: 'bridge',
        key: `bridge/lz/1/${OAPP}/30110/receive`,
        display: 'eid 30110 (arbitrum) receive: E=1 · 1-of-1 (layerzero-labs) · 15 conf',
        chainId: 1,
        block: 1,
        breaches: [
          {
            ruleId: 'BR-2',
            message: 'live route at E=1: fewer than 2 distinct known DVN operators',
          },
        ],
      },
      {
        subject: 'z',
        dimension: 'bridge',
        key: `bridge/lz/42161/${C}/30101/send`,
        display: 'eid 30110 (arbitrum) remote send: E=1 · 1-of-1 (layerzero-labs) · 15 conf',
        chainId: 42161,
        block: 1,
        breaches: [
          {
            ruleId: 'BR-2',
            message: 'live route at E=1: fewer than 2 distinct known DVN operators',
          },
        ],
      },
    ])
    expect(b.map((x) => x.where)).toEqual([
      'eid 30110 (arbitrum) receive',
      'eid 30110 (arbitrum) remote send',
    ])
    expect(src('components/OracleRegistry/ConfigAtoms.tsx')).toMatch(/b\.where/)
  })
  it('formatUsdCompact rolls a rounded 1000 into the next unit', () => {
    expect(formatUsdCompact(999.6e6)).toBe('$1B')
    expect(formatUsdCompact(999_960)).toBe('$1M')
    expect(formatUsdCompact(999.4e6)).toBe('$999M')
    expect(formatUsdCompact(295_000_000)).toBe('$295M')
  })
})
