// Config cards — fail-closed audit (2026-10-10), part 3: the ENGINE. What the card does with a
// read that failed: it lists a read gap, it never reads calmer, it never drops a head breach / an
// in-effect red / a red history row the previous run had (carried, marked unconfirmed), and it
// never stores a partial read as the last good one. Every test failed on the code before its fix
// unless it is marked (control).

import { describe, expect, it } from 'vitest'

import {
  buildSubject,
  nttRemoteGaps,
  type RawSubject,
  type RemoteRouteRead,
} from '@/lib/oracleRegistry/config/engine'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  SubjectState,
  UlnConfigRaw,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import {
  readRemoteRoute,
  readRoute as readRouteJs,
  remoteReadList,
} from '@/scripts/oracle-registry/config/lib/lz.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const PROXY = A('1')
const SAFE = A('6')
const TL = A('7')
const EOA = A('e')
const POOL = A('c')
const NTTM = A('a')
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const OLD = '0x' + '5'.repeat(40)
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const REMOTE = '0x' + '4'.repeat(40)
const PEER = '0x' + '0'.repeat(24) + REMOTE.slice(2)
const HEAD1 = 30_000_000
const HEAD2 = 30_007_200

const registry: DvnRegistry = {
  byChain: {
    1: { [LZ]: { id: 'layerzero-labs', name: 'LZ' }, [NM]: { id: 'nethermind', name: 'NM' } },
    42161: { [LZ]: { id: 'layerzero-labs', name: 'LZ' }, [NM]: { id: 'nethermind', name: 'NM' } },
  },
  dead: { 1: [], 42161: [] },
  libraries: {
    1: { send: [RECV], receive: [RECV, OLD], blocked: [], read: [] },
    42161: { send: [RECV], receive: [RECV, OLD], blocked: [], read: [] },
  },
}
const uln = (req: string[]): UlnConfigRaw => ({
  confirmations: '15',
  requiredDVNCount: req.length,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: req,
  optionalDVNs: [],
})
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, n: number, o: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  modules: [],
  ...o,
})
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
  queues?: Partial<RawSubject['queues']>
  params?: Partial<RawSubject['params']>
  ccip?: RawSubject['ccip']
  ntt?: RawSubject['ntt']
  canonical?: RawSubject['canonical']
  oracle?: RawSubject['oracle']
  previous?: SubjectState
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
    params: { head: {}, transitions: [], ...o.params },
    queues: { ops: [], safe: [], safeStatus: [], ...o.queues },
    ccip: o.ccip ?? { pools: [] },
    ...(o.ntt ? { ntt: o.ntt } : {}),
    ...(o.canonical ? { canonical: o.canonical } : {}),
    ...(o.oracle ? { oracle: o.oracle } : {}),
    ...(o.previous
      ? { previousHead: { block: o.previous.asOf.block, items: o.previous.items } }
      : {}),
    ...(o.previousChanges ? { previousChanges: o.previousChanges } : {}),
    ...o.extra,
    warnings: [],
  }) as RawSubject
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const breaches = (st: SubjectState, rule?: string) =>
  st.items.flatMap((i) => i.breaches).filter((b) => !rule || b.ruleId === rule)
const gaps = (st: SubjectState) => (st.readGaps ?? []).join('\n')
// the collector is JavaScript: its inferred parameter types are narrowed here
const readRoute = readRouteJs as unknown as (
  c: unknown,
  o: Record<string, unknown>,
) => Promise<{
  ok: boolean
  closed?: boolean
  mergedReverted?: boolean
  mergedError?: string
  grace?: unknown
}>

// =====================================================================================================
describe('ST-02 / EV-01 (1) / EV-07 / EV-09 / EV-10 / MISSED-1: a red HISTORY row the previous run had is never dropped', () => {
  const ownerMove = {
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0x64' as Hx,
    emitter: PROXY,
    event: 'OwnershipTransferred',
    args: { previousOwner: SAFE, newOwner: EOA },
  }
  const controllers = { [`${SAFE}@99`]: safe(SAFE, 6, 11), [`${EOA}@100`]: eoa(EOA) }
  const run1 = build(subject(), rawOf({ admin: { events: [ownerMove], controllers } }))
  const red1 = run1.changes.filter((c) => c.red && c.stillInEffect)
  it('(control) run 1: the owner move to an EOA is red and in effect', () => {
    expect(red1.map((c) => c.id)).toEqual(['1:0x64:0'])
  })
  it('run 2 lost the event (a false-empty chunk): the red row is CARRIED, in effect, with a read gap', () => {
    const st = build(
      subject(),
      rawOf({
        head: HEAD2,
        admin: { controllers },
        previousChanges: { block: HEAD1, changes: run1.changes },
      }),
    )
    const row = st.changes.find((c) => c.id === '1:0x64:0')
    expect(row).toMatchObject({ red: true, stillInEffect: true })
    expect(row!.tags).toContain('read_gap')
    expect(gaps(st.state)).toMatch(/not re-derived/)
  })
  it('(control) re-derived from the event this run: no carry, no gap', () => {
    const st = build(
      subject(),
      rawOf({
        head: HEAD2,
        admin: { events: [ownerMove], controllers },
        previousChanges: { block: HEAD1, changes: run1.changes },
      }),
    )
    expect(st.changes.filter((c) => c.id === '1:0x64:0')).toHaveLength(1)
    expect(st.changes.find((c) => c.id === '1:0x64:0')!.tags).not.toContain('read_gap')
    expect(gaps(st.state)).not.toMatch(/not re-derived/)
  })
  it('(control) a row that left the scope (its emitter no longer in scope) or the window is dropped', () => {
    // a Safe that WAS a power holder (in scope then): its red threshold row
    const gone = A('8')
    const old = { ...run1.changes[0], id: '1:0x99:0', key: `admin/multisig/${gone}` }
    const st = build(
      subject(),
      rawOf({
        head: HEAD2,
        admin: { controllers, scope: [A('9')] },
        previousChanges: { block: HEAD1, changes: [old] },
      }),
    )
    expect(st.changes.find((c) => c.id === '1:0x99:0')).toBeUndefined()
    const later = build(
      subject(),
      rawOf({
        head: HEAD2,
        admin: { controllers },
        previousChanges: { block: HEAD1, changes: run1.changes },
        extra: { scan: { from: 200, to: HEAD2 } },
      }),
    )
    expect(later.changes.find((c) => c.id === '1:0x64:0')).toBeUndefined()
  })
})

describe('EV-01 (4) / KG-7: an event scan chunk that was not confirmed is a listed read gap', () => {
  it('a scan gap reaches the card (it was invisible: "no red flags" over a lost chunk)', () => {
    const st = build(
      subject(),
      rawOf({
        extra: {
          scanGaps: [
            {
              scan: 'admin event scan',
              from: 1,
              to: 250_000,
              error: 'timeout',
              addresses: [PROXY],
            },
          ],
        },
      }),
    ).state
    expect(gaps(st)).toMatch(/admin event scan.*1.*250,?000/)
  })
})

describe('PH-13 / EV-07: an AD-7 timelock-admin breach is carried while its holders cannot be read', () => {
  const tlAdmin = (holders: string[], unread?: boolean) => [
    {
      timelock: TL,
      role: 'TIMELOCK_ADMIN_ROLE / DEFAULT_ADMIN_ROLE',
      holders,
      ...(unread ? { unread: true } : {}),
    },
  ]
  const run1 = build(
    subject({ timelocks: [TL] }),
    rawOf({
      admin: { timelockAdmins: tlAdmin([EOA]), controllers: { [`${EOA}@head`]: eoa(EOA) } },
    }),
  ).state
  it('(control) run 1: AD-7', () => expect(breaches(run1, 'AD-7')).toHaveLength(1))
  it('holders not read (the admin roles were not read on the timelock): carried, with a read gap', () => {
    const st = build(
      subject({ timelocks: [TL] }),
      rawOf({ head: HEAD2, admin: { timelockAdmins: tlAdmin([], true) }, previous: run1 }),
    ).state
    expect(breaches(st, 'AD-7')).toHaveLength(1)
    expect(breaches(st, 'AD-7')[0].message).toMatch(/breach unconfirmed/)
  })
  it('an admin event scan gap: carried (a lost RoleGranted is not "no holder")', () => {
    const st = build(
      subject({ timelocks: [TL] }),
      rawOf({
        head: HEAD2,
        admin: { timelockAdmins: tlAdmin([]) },
        previous: run1,
        extra: {
          scanGaps: [{ scan: 'admin event scan', from: 1, to: 9, error: 'x', addresses: [TL] }],
        },
      }),
    ).state
    expect(breaches(st, 'AD-7')).toHaveLength(1)
  })
  it('(control) holders read, the EOA gone, no gap: resolved', () => {
    const st = build(
      subject({ timelocks: [TL] }),
      rawOf({ head: HEAD2, admin: { timelockAdmins: tlAdmin([]) }, previous: run1 }),
    ).state
    expect(breaches(st, 'AD-7')).toHaveLength(0)
  })
})

// =====================================================================================================
describe('LZ-01 / LZ-04 / LZ-05 / EV-06: an Ethereum route side missing this run is gone ONLY when positively closed', () => {
  const s = subject({ lzOApps: [OAPP] })
  const recv = (o: Record<string, unknown> = {}) => ({
    oapp: OAPP,
    eid: 30110,
    direction: 'receive' as const,
    lib: RECV,
    libIsDefault: false,
    merged: uln([LZ]),
    app: null,
    peer: PEER,
    ...o,
  })
  const run1 = build(s, rawOf({ lz: { headRoutes: [recv()] } })).state
  it('(control) run 1: one DVN — the floor breach BR-2', () => {
    expect(breaches(run1, 'BR-2')).toHaveLength(1)
  })
  it('run 2 did not read the route (lost events / a failed peers read): the breach is carried with a gap', () => {
    const st = build(s, rawOf({ head: HEAD2, lz: { headRoutes: [] }, previous: run1 })).state
    expect(breaches(st, 'BR-2')).toHaveLength(1)
    expect(gaps(st)).toMatch(/not read this run/)
  })
  it('(control) the route read as closed (a zero peer): resolved', () => {
    const st = build(
      s,
      rawOf({
        head: HEAD2,
        lz: { headRoutes: [], closedRoutes: [{ oapp: OAPP, eid: 30110, why: 'zero_peer' }] },
        previous: run1,
      }),
    ).state
    expect(breaches(st, 'BR-2')).toHaveLength(0)
  })
  it('LZ-09 / RC-M1: a grace timeout that was not read makes the side UNREAD and keeps the breach', () => {
    const st = build(
      s,
      rawOf({
        head: HEAD2,
        lz: {
          headRoutes: [recv({ merged: uln([LZ, NM]), grace: { unread: true, error: 'timeout' } })],
        },
        previous: run1,
      }),
    ).state
    const item = st.items.find((i) => i.key.startsWith(`bridge/lz/1/${OAPP}`))!
    expect(item.warnings).toContain('UNREAD')
    expect(breaches(st, 'BR-2')).toHaveLength(1)
  })
})

describe('LZ-05 / LZ-07 / LZ-09 (collector): a revert closes a route only when it is the expected LayerZero error', () => {
  const revertWith = (sel: string) =>
    Object.assign(new Error('execution reverted'), {
      name: 'ContractFunctionRevertedError',
      raw: sel + '0'.repeat(56),
    })
  const httpErr = () => Object.assign(new Error('HTTP 503'), { name: 'HttpRequestError' })
  const client = (o: Record<string, () => unknown>) => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      const f = o[functionName]
      if (!f) throw revertWith('0xdeadbeef')
      const v = f()
      if (v instanceof Error) throw v
      return v
    },
  })
  it('LZ-07: a getConfig revert that is NOT LZ_ULN_AtLeastOneDVN / NotImplemented is a failed read (it was "no DVN": closed)', async () => {
    const r = await readRoute(
      client({
        getReceiveLibrary: () => [RECV, false],
        getConfig: () => revertWith('0x12345678'),
        receiveLibraryTimeout: () => ['0x0000000000000000000000000000000000000000', 0n],
      }),
      { endpoint: EP, oapp: OAPP, eid: 30110, direction: 'receive' },
    )
    expect(r.ok).toBe(true)
    expect(r.mergedReverted).toBe(false)
    expect(r.mergedError).toBeTruthy()
  }, 20_000)
  it('LZ-05: a library revert that is not LZ_DefaultReceiveLibUnavailable does not close the route', async () => {
    const r = await readRoute(client({ getReceiveLibrary: () => revertWith('0x12345678') }), {
      endpoint: EP,
      oapp: OAPP,
      eid: 30110,
      direction: 'receive',
    })
    expect(r).toMatchObject({ ok: false, closed: false })
  }, 20_000)
  it('LZ-09: a receive-library timeout that was not read is grace UNREAD (it was "no grace")', async () => {
    const r = await readRoute(
      client({
        getReceiveLibrary: () => [RECV, false],
        getConfig: () => httpErr(),
        receiveLibraryTimeout: () => httpErr(),
      }),
      { endpoint: EP, oapp: OAPP, eid: 30110, direction: 'receive' },
    )
    expect(r.grace).toMatchObject({ unread: true })
  }, 20_000)
})

// =====================================================================================================
describe('RC-04 / MISSED-REMOTE-DVNCODE / RC-M3 / RC-05 / RC-M2: partial remote reads', () => {
  const s = subject({ lzOApps: [OAPP] })
  const remote = (o: {
    dvnCode?: Record<string, boolean | null>
    grace?: { lib: string; expiry: number; config: UlnConfigRaw | null }
    recv?: string[]
  }): RemoteRouteRead => ({
    oapp: OAPP,
    eid: 30110,
    chainKey: 'arbitrum',
    chainId: 42161,
    status: 'ok' as const,
    peer: REMOTE,
    peerBack: '0x' + '0'.repeat(24) + OAPP.slice(2),
    block: 100,
    directions: {
      receive: {
        lib: RECV,
        merged: uln(o.recv ?? [LZ, NM]),
        ...(o.grace ? { grace: o.grace } : {}),
      },
      send: { lib: RECV, merged: uln([LZ, NM]) },
    },
    dvnCode: o.dvnCode ?? { [LZ]: true, [NM]: true },
  })
  const asPrev = (st: SubjectState) => ({
    block: st.asOf.block,
    routes: st.remoteSnapshot!,
    readAt: st.remoteReadAt,
    lastPeer: st.remoteLastPeer,
    lastVerifying: st.remoteLastVerifying,
  })
  it('RC-04: a DVN whose remote code was not read never raises E, keeps BR-4, writes no "upgrade" row', () => {
    const run1 = build(
      s,
      rawOf({ lz: { remote: [remote({ dvnCode: { [LZ]: true, [NM]: false } })] } }),
    ).state
    expect(breaches(run1, 'BR-4').length).toBeGreaterThan(0)
    const out = build(
      s,
      rawOf({
        head: HEAD2,
        lz: {
          remote: [remote({ dvnCode: { [LZ]: true, [NM]: null } })],
          previousRemote: asPrev(run1),
        },
        previous: run1,
      }),
    )
    expect(breaches(out.state, 'BR-4').length).toBeGreaterThan(0)
    expect(out.changes.filter((c) => c.id.includes(':remote-head:'))).toHaveLength(0)
    expect(gaps(out.state)).toMatch(/DVN code not read|code not read/)
  })
  it('RC-05 / RC-M2: a grace config that was not read: no between-runs row, the last good read kept', () => {
    const grace1 = { lib: OLD, expiry: 10_000, config: uln([LZ]) }
    const run1 = build(s, rawOf({ lz: { remote: [remote({ grace: grace1 })] } })).state
    expect(breaches(run1, 'BR-2').length).toBeGreaterThan(0)
    const key = `bridge/lz/42161/${REMOTE}/30101/receive`
    const out = build(
      s,
      rawOf({
        head: HEAD2,
        lz: {
          remote: [remote({ grace: { lib: OLD, expiry: 10_000, config: null } })],
          previousRemote: asPrev(run1),
        },
        previous: run1,
      }),
    )
    expect(out.changes.filter((c) => c.id.includes(':remote-head:'))).toHaveLength(0)
    expect(out.state.remoteSnapshot?.[key]).toEqual(run1.remoteSnapshot?.[key])
    expect(out.state.remoteReadAt?.[key]).toBe(HEAD1)
  })
})

describe('RC-07: every live Ethereum peer gets its remote side read', () => {
  it('a route whose receive library reverted but whose peer is live (only a send row) is listed (it was skipped)', () => {
    const head = new Map([[OAPP, [{ oapp: OAPP, eid: 30110, direction: 'send', peer: PEER }]]])
    const m = remoteReadList(head, [], [OAPP]) as Map<number, { oapp: string; peer: string }[]>
    expect(m.get(30110)?.map((x) => x.peer)).toEqual([PEER])
  })
  it('an unread peer row falls back to the last non-zero PeerSet peer (RC-M8)', () => {
    const head = new Map([[OAPP, [{ oapp: OAPP, eid: 30110, direction: 'receive', peer: '0x' }]]])
    const evs = [{ kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER, block: 5, logIndex: 0 }]
    const m = remoteReadList(head, evs, [OAPP]) as Map<number, { oapp: string; peer: string }[]>
    expect(m.get(30110)?.map((x) => x.peer)).toEqual([PEER])
  })
})

describe('RC-M4: a remote receive grace is judged on the remote EVM block number', () => {
  it('Arbitrum-style: eth_blockNumber (L2) is not the clock; Multicall3.getBlockNumber() is', async () => {
    const c = {
      getBlockNumber: async () => 513_531_045n,
      readContract: async ({
        functionName,
        address,
      }: {
        functionName: string
        address: string
      }) => {
        if (
          functionName === 'getBlockNumber' &&
          address.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11'
        )
          return 26_162_451n
        throw Object.assign(new Error('HTTP 503'), { name: 'HttpRequestError' })
      },
      getCode: async () => '0x6080',
    }
    const rr = await readRemoteRoute(
      c,
      { chainKey: 'arbitrum', chainId: 42161, endpoint: EP },
      REMOTE,
    )
    expect(rr.block).toBe(26_162_451)
  }, 60_000)
})

// =====================================================================================================
describe('RC-09 / RC-M6 / NTT MISSED: an NTT remote owner that could not be classified is a read gap', () => {
  const ntt = (owner: Controller): RawSubject['ntt'] => [
    {
      manager: NTTM,
      token: null,
      mode: 'locking',
      threshold: 2,
      transceivers: [
        { address: A('b'), type: 'wormhole', peers: {} },
        { address: A('d'), type: 'axelar', peers: {} },
      ],
      peers: { 4: { peer: PEER, decimals: 18 } },
      owner: SAFE,
      pauser: null,
      paused: false,
      locked: null,
      remote: [
        {
          wormholeChainId: 4,
          chainId: 56,
          chainKey: 'bsc',
          status: 'ok',
          manager: REMOTE,
          threshold: 2,
          transceivers: [
            { address: A('b'), type: 'wormhole', peers: {} },
            { address: A('d'), type: 'axelar', peers: {} },
          ],
          peerBack: { peer: '0x' + '0'.repeat(24) + NTTM.slice(2), decimals: 18 },
          owner,
          pauser: null,
          paused: false,
          supply: null,
        },
      ],
    },
  ]
  it('"not classified on bsc": a gap line (it read as a calm plain contract)', () => {
    const n = ntt({ kind: 'contract', address: EOA, version: 'not classified on bsc' })![0]
    expect(nttRemoteGaps(n).join()).toMatch(/not classified/)
  })
  it('a remote owner timelock whose proposers were not read: its tree gap is listed', () => {
    const n = ntt({
      kind: 'oz_timelock',
      address: TL,
      delaySec: 0,
      schedulers: [],
      schedulersUnread: true,
    })![0]
    expect(nttRemoteGaps(n).join()).toMatch(/proposers not read/)
  })
  it('the previous remote AD-3 is carried when the owner could not be classified', () => {
    const s = subject({ nttManagers: [NTTM] })
    const c = { [`${SAFE}@head`]: safe(SAFE, 3, 5) }
    const run1 = build(s, rawOf({ ntt: ntt(eoa(EOA)), admin: { controllers: c } })).state
    expect(breaches(run1, 'AD-3').length).toBe(1)
    const st = build(
      s,
      rawOf({
        head: HEAD2,
        ntt: ntt({ kind: 'contract', address: EOA, version: 'not classified on bsc' }),
        admin: { controllers: c },
        previous: run1,
      }),
    ).state
    expect(breaches(st, 'AD-3').length).toBe(1)
  })
  it('NTT MISSED: the owner tree read gaps of the Ethereum NTT owner / canonical admin are listed', () => {
    const s = subject({ nttManagers: [NTTM] })
    const tl: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 86400,
      schedulers: [],
      schedulersUnread: true,
    }
    const st = build(
      s,
      rawOf({ ntt: ntt(safe(SAFE, 3, 5)), admin: { controllers: { [`${SAFE}@head`]: tl } } }),
    ).state
    expect(gaps(st)).toMatch(/proposers not read/)
  })
})

// =====================================================================================================
describe('CC-02 / CC-04 / CC-06 / CC-07 / MISSED-3: CCIP pool reads are read gaps on EVERY run', () => {
  const s = subject({ ccipPools: [POOL] })
  const pool = (o: Record<string, unknown> = {}, chain: Record<string, unknown> = {}) => ({
    pools: [
      {
        pool: POOL,
        owner: SAFE,
        rebalancer: null,
        chains: [
          {
            selector: '7',
            inboundEnabled: true,
            outboundEnabled: true,
            remotePools: [],
            siloed: false,
            ...chain,
          },
        ],
        ...o,
      },
    ],
  })
  const c = { [`${SAFE}@head`]: safe(SAFE, 3, 5) }
  it('CC-02: a rebalancer read that failed is a read gap (it was silent: "no red flags")', () => {
    const st = build(
      s,
      rawOf({ ccip: pool({ rebalancerUnread: true }), admin: { controllers: c } }),
    ).state
    expect(gaps(st)).toMatch(/rebalancer not read/)
  })
  it('CC-04: a rate limiter not read is a read gap', () => {
    const st = build(
      s,
      rawOf({ ccip: pool({}, { inboundEnabled: null }), admin: { controllers: c } }),
    ).state
    expect(gaps(st)).toMatch(/rate limiter of chain 7 not read/)
  })
  it('CC-06: siloed not read, its chain rebalancer an EOA: CC-3 (fail closed) and a gap', () => {
    const st = build(
      s,
      rawOf({
        ccip: pool({}, { siloed: null, rebalancer: EOA }),
        admin: { controllers: { ...c, [`${EOA}@head`]: eoa(EOA) } },
      }),
    ).state
    expect(breaches(st, 'CC-3').length).toBe(1)
    expect(gaps(st)).toMatch(/siloed was not read/)
  })
  it('CC-07: a siloed chain whose rebalancer was not read is a read gap', () => {
    const st = build(
      s,
      rawOf({ ccip: pool({}, { siloed: true, rebalancer: null }), admin: { controllers: c } }),
    ).state
    expect(gaps(st)).toMatch(/silo rebalancer of chain 7 not read/)
  })
  it('MISSED-3: a rebalancer whose own tree has a read gap is listed', () => {
    const tl: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 86400,
      schedulers: [],
      schedulersUnread: true,
    }
    const st = build(
      s,
      rawOf({
        ccip: pool({ rebalancer: TL }),
        admin: { controllers: { ...c, [`${TL}@head`]: tl } },
      }),
    ).state
    expect(gaps(st)).toMatch(/proposers not read/)
  })
})

// =====================================================================================================
describe('NB-02 / NB-03: NTT floor reads', () => {
  const s = subject({ nttManagers: [NTTM] })
  const ntt = (o: Record<string, unknown>): RawSubject['ntt'] => [
    {
      manager: NTTM,
      token: null,
      mode: 'locking',
      threshold: 1,
      transceivers: [{ address: A('b'), type: 'wormhole', peers: {} }],
      peers: { 1: { peer: PEER, decimals: 18 } },
      owner: null,
      pauser: null,
      paused: false,
      locked: null,
      ...o,
    } as never,
  ]
  it('NB-02: a chain live last run and absent this run (a lost PeerUpdated) keeps BR-2 with a gap', () => {
    const run1 = build(s, rawOf({ ntt: ntt({}) })).state
    expect(breaches(run1, 'BR-2')).toHaveLength(1)
    const st = build(s, rawOf({ head: HEAD2, ntt: ntt({ peers: {} }), previous: run1 })).state
    expect(breaches(st, 'BR-2')).toHaveLength(1)
  })
  it('NB-03: a transceiver whose verifier network was not read is a listed read gap', () => {
    const st = build(
      s,
      rawOf({
        ntt: ntt({
          threshold: 2,
          transceivers: [
            { address: A('b'), type: 'wormhole', peers: {} },
            { address: A('d'), type: null, peers: {} },
          ],
        }),
      }),
    ).state
    expect(gaps(st)).toMatch(/verifier network not read/)
  })
})

// =====================================================================================================
describe('PO-04: a declared parameter not read at head is a listed read gap', () => {
  it('a rate provider getter that failed: a read gap (it rendered "unread" and counted nothing)', () => {
    const s = subject({
      params: [
        {
          key: 'rateProvider',
          contract: PROXY,
          sig: 'function rateProvider() view returns (address)',
          rule: 'rate_provider',
          label: 'rate provider',
        },
        {
          key: 'minterAllowance:events',
          contract: PROXY,
          sig: '',
          rule: 'cap',
          label: 'events only',
          eventsOnly: true,
        },
      ] as ConfigSubject['params'],
    })
    const st = build(s, rawOf()).state
    expect(gaps(st)).toMatch(/rate provider: not read at head/)
    expect(gaps(st)).not.toMatch(/events only/)
  })
})

describe('PO-07 / MISSED-1 / MISSED stale window: the oracle governance input', () => {
  const s = subject({ oracleAssetKey: 'zz' })
  it('changes.json not read: a read gap (every oracle row disappeared silently)', () => {
    const st = build(
      s,
      rawOf({ oracle: { events: [], unread: 'changes.json missing' } as never }),
    ).state
    expect(gaps(st)).toMatch(/oracle governance events not read/)
  })
  it('the oracle window ends far below head: a read gap for the blocks after it', () => {
    const st = build(
      s,
      rawOf({
        oracle: { events: [], window: { startBlock: 1, endBlock: HEAD1 - 30_000, days: 180 } },
      }),
    ).state
    expect(gaps(st)).toMatch(/oracle governance events after block/)
  })
  it('CL-10: a source moved to a contract that could not be classified is red OR-1 with a read gap', () => {
    const src = A('5')
    const out = build(
      s,
      rawOf({
        admin: { classifyFailed: [`${src}@500`], verification: { [src]: true } },
        oracle: {
          events: [
            {
              block: 500,
              tx: '0x01',
              logIndex: 0,
              emitter: A('3'),
              event: 'AssetSourceUpdated',
              args: { asset: A('2'), source: src },
              entryIds: ['zz.x'],
            },
          ],
        },
      }),
    )
    const row = out.changes.find((c) => c.dimension === 'oracle')!
    expect(row.red).toBe(true)
    expect(row.tags).toContain('read_gap')
  })
})

// =====================================================================================================
describe('PH-07: an upgrade whose holders before it could not be classified is judged against the declared timelock', () => {
  it('the holder classification failed: AD-5 (it became a plain contract and AD-5 was skipped)', () => {
    const s = subject({
      timelocks: [TL],
      powers: [{ power: 'upgrade', contract: PROXY, path: ['owner'], label: 'upgrade' }],
    })
    const st = build(
      s,
      rawOf({
        admin: {
          events: [
            {
              chainId: 1,
              block: 500,
              logIndex: 0,
              tx: '0xab' as Hx,
              emitter: PROXY,
              event: 'Upgraded',
              args: { implementation: A('5') },
            },
          ],
          upgradeHoldersAt: { [`${PROXY}@500`]: [TL] },
          classifyFailed: [`${TL}@499`],
          verification: { [A('5')]: true },
          powers: [{ power: 'upgrade', label: 'upgrade', contract: PROXY, holders: [TL] }],
          controllers: {
            [`${TL}@head`]: {
              kind: 'oz_timelock',
              address: TL,
              delaySec: 86400,
              schedulers: [safe(SAFE, 5, 7)],
            },
          },
        },
      }),
    )
    const row = st.changes.find((c) => c.key === `admin/implementation/${PROXY}`)!
    expect(row.ruleIds).toContain('AD-5')
  })
})

// =====================================================================================================
describe('DG M2 / M3 / DG-02 / SQ-07 (engine)', () => {
  const dgNode = (o: Partial<NonNullable<Controller['dg']>> = {}): Controller => ({
    kind: 'aragon_dg',
    address: A('b'),
    delaySec: 259_200,
    schedulers: [safe(SAFE, 6, 11)],
    dg: {
      afterSubmitDelaySec: 259_200,
      afterScheduleDelaySec: 86_400,
      governance: null,
      adminExecutor: null,
      emergencyGovernance: null,
      activationCommittee: null,
      executionCommittee: null,
      emergencyModeActive: true,
      emergencyProtectionEndsAfter: null,
      ...o,
    },
  })
  it('DG M2: emergency mode through an Agent with several executors is AD-2 (leaf() stopped at the Agent)', () => {
    const agent: Controller = {
      kind: 'contract',
      address: A('3'),
      version: 'Aragon Agent',
      executors: [dgNode(), safe(SAFE, 6, 11)],
    }
    const s = subject({
      powers: [{ power: 'upgrade', contract: PROXY, path: ['owner'], label: 'P' }],
    })
    const st = build(
      s,
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'P', contract: PROXY, holders: [A('3')] }],
          controllers: { [`${A('3')}@head`]: agent },
        },
      }),
    ).state
    expect(breaches(st, 'AD-2').some((b) => /emergency mode/.test(b.message))).toBe(true)
  })
  it('DG M3: a committee whose own tree rests on a read gap is listed', () => {
    const com = A('9')
    const s = subject({
      powers: [{ power: 'upgrade', contract: PROXY, path: ['owner'], label: 'P' }],
    })
    const st = build(
      s,
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'P', contract: PROXY, holders: [A('b')] }],
          controllers: {
            [`${A('b')}@head`]: dgNode({ emergencyModeActive: false, executionCommittee: com }),
            [`${com}@head`]: safe(com, 3, 5, { modulesUnread: true, modules: undefined }),
          },
        },
      }),
    ).state
    expect(gaps(st)).toMatch(/modules not read/)
  })
  it('SQ-07: a declared Safe outside every power tree whose modules were not read is a read gap', () => {
    const s = subject({ safes: [SAFE] })
    const st = build(
      s,
      rawOf({
        admin: {
          controllers: {
            [`${SAFE}@head`]: safe(SAFE, 3, 5, { modulesUnread: true, modules: undefined }),
          },
        },
      }),
    ).state
    expect(gaps(st)).toMatch(/modules not read/)
  })
})
