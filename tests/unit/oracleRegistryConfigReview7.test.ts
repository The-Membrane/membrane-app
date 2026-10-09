// Config cards — review round 7 (2026-10-07): the CONFIRMED bugs of the sixth adversarial review
// (rules, UI, on-chain) and the UNSURE items fixed with them. One test (or group) per finding;
// each failed on the code before the fix (controls are marked). Synthetic fixtures.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'

import {
  blockText,
  closedRoutesDisclosure,
  filterRows,
  batchRows,
  headline,
  routeLabel,
  timelineFilterButtons,
} from '@/components/OracleRegistry/configViewModel'
import type {
  ConfigChangeView,
  ConfigCounts,
  RouteRowView,
} from '@/lib/oracleRegistry/config/apiTypes'
import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { floorBreachRoutes } from '@/lib/oracleRegistry/config/bridgeRules'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import { replayLz, type LzEvent } from '@/lib/oracleRegistry/config/lzReplay'
import {
  callIsForSubject,
  timelockChanges,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  classifyControllerChange,
  classifyOracleParam,
  classifyRoleGrant,
  compareRank,
  controllerRank,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  StateItem,
  UlnConfigRaw,
} from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import { buildConfigCard, countsOf } from '@/lib/oracleRegistry/config/view'
import { ADMIN_TOPICS, TOPIC } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import { resolvePath, subjectExtraEmitters } from '@/scripts/oracle-registry/config/lib/admin.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const CANARY1 = '0xa4fe5a5b9a846458a70cd0748228aed3bf65c2cd'
const CANARY2 = '0x8bd4000000000000000000000000000000000000'
const SEND = '0xbb2ea70c9e858123480642cf96acbcce1372dce1'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const BLK = '0x1ccbf0db9c192d969de57e25b3ff09a25bb1d862'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const PEER2 = '0x000000000000000000000000d3eacf0612346366db554c991d7858716db09f59'
const ZERO32 = '0x' + '0'.repeat(64)
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const C = '0x00000000000000000000000000000000000000cc'
const X = '0x00000000000000000000000000000000000000dd'
const Z = '0x' + '0'.repeat(40)
const PROXY = '0x' + '1'.repeat(40)
const PA = '0x' + '2'.repeat(40) // a ProxyAdmin NOT declared in the subject
const IMPL = '0x' + '3'.repeat(40)
const MINTING = '0x' + '4'.repeat(40)
const POOL = '0x' + '5'.repeat(40)
const SAFE = '0x' + '6'.repeat(40)
const SAFE2 = '0x' + '7'.repeat(40)
const ORACLE = '0x' + '8'.repeat(40)
const USDE = '0x' + 'a'.repeat(40)
const TL = '0x' + 'c'.repeat(40)
const TAR = '0x' + 'e'.repeat(40)
const TOKEN = '0x' + 'f'.repeat(40)

const dvns = {
  [LZ]: { id: 'layerzero-labs', name: 'LZ' },
  [NM]: { id: 'nethermind', name: 'NM' },
  [CANARY1]: { id: 'canary', name: 'Canary' },
  [CANARY2]: { id: 'canary-subsidized', name: 'Canary Subsidized' },
}
const libs = { send: [SEND], receive: [RECV], blocked: [BLK], read: [] }
const registry: DvnRegistry = {
  byChain: { 1: dvns },
  dead: { 1: [] },
  libraries: { 1: libs },
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
  tokens: [TOKEN],
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
    codeProbes: { [LZ]: { firstCode: 1 }, [NM]: { firstCode: 1 } },
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
  libDirection: (l) => (l === SEND ? 'send' : l === RECV ? 'receive' : null),
  ctl: () => null,
  ownerOf: () => null,
  delegateOf: () => null,
  implHistory: {},
  minDelayOf: () => 86400,
  roleName: (h) => h,
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
const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const PROXY_ADMIN_ABI = parseAbi([
  'function upgradeAndCall(address proxy, address impl, bytes data)',
  'function upgrade(address proxy, address impl)',
  'function transferOwnership(address newOwner)',
])

// =====================================================================================================
describe('rules #1: upgrades routed through an undeclared ProxyAdmin', () => {
  const up = encodeFunctionData({
    abi: PROXY_ADMIN_ABI,
    functionName: 'upgradeAndCall',
    args: [PROXY as Hx, IMPL as Hx, '0x'],
  })
  it('a ProxyAdmin call acting on a subject proxy is the subject’s (matched on its proxy argument)', () => {
    const q = qctx({ contracts: [PROXY] })
    expect(callIsForSubject({ target: PA, value: '0', data: up }, q)).toBe(true)
    // control: a ProxyAdmin call on someone else's proxy is not
    const other = encodeFunctionData({
      abi: PROXY_ADMIN_ABI,
      functionName: 'upgrade',
      args: [TAR as Hx, IMPL as Hx],
    })
    expect(callIsForSubject({ target: PA, value: '0', data: other }, q)).toBe(false)
  })
  it('an armed upgradeAndCall to an unverified implementation is red AD-9 + AD-8', () => {
    const out = timelockChanges(
      [armedOp([up], [PA])],
      qctx({ contracts: [PROXY], verified: () => false }),
      1000,
    )
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['AD-9', 'AD-8']))
  })
  it('engine: the power path hop (the ProxyAdmin) is in scope — a queued ownership move of it is filed red', () => {
    const move = encodeFunctionData({
      abi: PROXY_ADMIN_ABI,
      functionName: 'transferOwnership',
      args: [SAFE as Hx],
    })
    const out = build(
      subject({
        contracts: [
          ...subject().contracts,
          {
            role: 'token',
            dimension: 'mint_redeem',
            chainId: 1,
            address: PROXY,
            label: 'p',
            deployBlock: 1,
          },
        ],
        powers: [
          {
            power: 'upgrade',
            contract: PROXY,
            path: ['eip1967_admin', 'owner'],
            label: 'Upgrade P',
          },
        ],
        timelocks: [TL],
      }),
      rawOf({
        admin: {
          powers: [
            { power: 'upgrade', label: 'Upgrade P', contract: PROXY, holders: [TL], via: [PA] },
          ],
          owners: { [PA]: TL },
          controllers: {
            [`${TL}@head`]: timelock(TL, 10 * 86400),
            [`${SAFE}@head`]: safe(SAFE, 3, 5),
          },
        },
        queues: { ops: [armedOp([move], [PA])] },
      }),
    )
    const q = out.queue.filter((c) => c.key === `admin/owner/${PA}`)
    expect(q).toHaveLength(1)
    expect(q[0].red).toBe(true)
    expect(q[0].ruleIds).toContain('AD-3')
  })
  it('collector: resolvePath records the hop; subjectExtraEmitters scans it', async () => {
    const word = (a: string) => '0x' + a.slice(2).padStart(64, '0')
    const client = {
      getStorageAt: async ({ address }: { address: string }) =>
        address.toLowerCase() === PROXY ? word(PA) : ZERO32,
      readContract: async ({
        address,
        functionName,
      }: {
        address: string
        functionName: string
      }) => {
        if (functionName === 'owner' && address.toLowerCase() === PA) return TL
        throw new Error('revert')
      },
    }
    const trail = new Set<string>()
    const hs = await resolvePath(client, {
      endpoint: EP,
      contract: PROXY,
      path: ['eip1967_admin', 'owner'],
      roleMap: new Map(),
      block: undefined,
      trail,
    })
    expect(hs).toEqual([TL])
    expect([...trail]).toEqual([PA])
    const out = subjectExtraEmitters(
      { timelocks: [] },
      [{ holders: [TL], via: [PA] }],
      new Map(),
      (n: string) => n,
    ) as Set<string>
    expect(out.has(PA)).toBe(true)
  })
})

describe('rules #2 CC-1 history: a CCIP pool re-pointed through address(0)', () => {
  it('TokenAdminRegistry PoolSet 0 → A, A → 0, 0 → B: the last is red CC-1', () => {
    const ps = (prev: string, next: string, block: number) =>
      row({
        emitter: TAR,
        event: 'PoolSet',
        block,
        tx: `0x${block}`,
        args: { token: TOKEN, previousPool: prev, newPool: next },
      })
    const out = classifyAdminEvents([ps(Z, A, 100), ps(A, Z, 200), ps(Z, B, 300)], actx({}))
    expect(out.map((c) => c.red)).toEqual([false, false, true])
    expect(out[2].ruleIds).toContain('CC-1')
    // control: re-adding the same pool after a removal is not a re-point
    const same = classifyAdminEvents([ps(Z, A, 100), ps(A, Z, 200), ps(Z, A, 300)], actx({}))
    expect(same[2].red).toBe(false)
  })
  it('a 1.5.0 RemotePoolSet A → 0 → B is red CC-1', () => {
    const rp = (prev: string, next: string, block: number) =>
      row({
        emitter: POOL,
        event: 'RemotePoolSet',
        block,
        tx: `0x${block}`,
        args: { remoteChainSelector: '7', previousPoolAddress: prev, remotePoolAddress: next },
      })
    const out = classifyAdminEvents([rp(Z, A, 100), rp(A, Z, 200), rp(Z, B, 300)], actx({}))
    expect(out[2].red).toBe(true)
    expect(out[2].ruleIds).toContain('CC-1')
  })
})

describe('rules #3 AD-6 between runs: an evented guard add no longer hides a silent replacement', () => {
  const G1 = '0x' + '9'.repeat(40)
  const G2 = '0x' + 'b'.repeat(39) + '1'
  const M1 = '0x' + 'd'.repeat(39) + '1'
  const M2 = '0x' + 'd'.repeat(39) + '2'
  const base = (head: Controller, events: AdminEventRow[]) =>
    build(
      subject({ safes: [SAFE] }),
      rawOf({
        admin: {
          events,
          controllers: { [`${SAFE}@head`]: head, [`${SAFE}@599`]: safe(SAFE, 3, 5) },
          previousSafes: { block: 500, controllers: { [SAFE]: safe(SAFE, 3, 5) } },
          deployBlocks: { [SAFE]: 1 },
        },
        queues: { safeStatus: [{ safe: SAFE, status: 'ok' }] },
      }),
    )
  it('ChangedGuard(G1) since the last run, G2 at head: a red AD-6 row G1 → G2', () => {
    const out = base(safe(SAFE, 3, 5, { guard: G2 }), [
      row({ emitter: SAFE, event: 'ChangedGuard', block: 600, tx: '0xg', args: { guard: G1 } }),
    ])
    const between = out.changes.filter(
      (c) => c.key === `admin/safe/${SAFE}/guard` && c.tags.includes('bracketed'),
    )
    expect(between).toHaveLength(1)
    expect(between[0].red).toBe(true)
    expect(between[0].ruleIds).toContain('AD-6')
    expect(between[0].before).toBe(G1)
    // control: head equal to what the events left adds no row
    const calm = base(safe(SAFE, 3, 5, { guard: G1 }), [
      row({ emitter: SAFE, event: 'ChangedGuard', block: 600, tx: '0xg', args: { guard: G1 } }),
    ])
    expect(calm.changes.filter((c) => c.tags.includes('bracketed'))).toHaveLength(0)
  })
  it('one evented EnabledModule no longer hides a second module enabled silently', () => {
    const out = base(safe(SAFE, 3, 5, { modules: [M1, M2] }), [
      row({ emitter: SAFE, event: 'EnabledModule', block: 600, tx: '0xm', args: { module: M1 } }),
    ])
    const silent = out.changes.filter(
      (c) => c.key === `admin/safe/${SAFE}/module_enabled` && c.tags.includes('bracketed'),
    )
    expect(silent.map((c) => c.after)).toEqual([M2])
    expect(silent[0].red).toBe(true)
  })
})

describe('rules #4 OR-1: an oracle source moved to a contract an EOA controls is red', () => {
  const ownedByEoa: Controller = { kind: 'contract', address: B, ownedBy: eoa(X) }
  it('classifyOracleParam ranks the EOA-owned contract with the EOA', () => {
    const v = classifyOracleParam('market_source', 'source', A, B, ownedByEoa)
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('OR-1')
  })
  it('engine: a verified source owned by an EOA is red, not an amber logic change', () => {
    const out = build(
      subject(),
      rawOf({
        admin: {
          verification: { [B]: true },
          controllers: { [`${B}@100`]: ownedByEoa },
        },
        oracle: {
          events: [
            {
              block: 100,
              tx: '0xo',
              logIndex: 0,
              emitter: ORACLE,
              event: 'AssetSourceUpdated',
              args: { asset: TOKEN, source: B },
              entryIds: ['x.y'],
            },
          ],
        },
      }),
    ).changes.find((c) => c.dimension === 'oracle')!
    expect(out.red).toBe(true)
    expect(out.ruleIds).toContain('OR-1')
  })
})

describe('rules #5 rank: a threshold-1 multisig ranks with an EOA (any one signer acts alone)', () => {
  it('controllerRank: Safe 1-of-N = EOA, below a plain contract', () => {
    expect(compareRank(controllerRank(safe(SAFE, 1, 5)), controllerRank(eoa(X)))).toBe(0)
    expect(
      compareRank(
        controllerRank(safe(SAFE, 1, 2)),
        controllerRank({ kind: 'contract', address: C }),
      ),
    ).toBeLessThan(0)
    // control: a 2-of-N Safe still outranks a contract
    expect(
      compareRank(
        controllerRank(safe(SAFE, 2, 5)),
        controllerRank({ kind: 'contract', address: C }),
      ),
    ).toBeGreaterThan(0)
  })
  it('MANAGER (admin-level) granted to a 1-of-2 Safe is red AD-4', () => {
    const v = classifyRoleGrant('MANAGER', safe(SAFE, 1, 2), [], true)
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('AD-4')
  })
  it('EOA → Safe 1-of-5 is not an upgrade; Safe 3-of-5 → Safe 1-of-5 is a downgrade', () => {
    expect(classifyControllerChange(eoa(X), safe(SAFE, 1, 5)).severity).not.toBe('upgrade')
    expect(classifyControllerChange(safe(SAFE, 3, 5), safe(SAFE2, 1, 5)).severity).toBe('downgrade')
    // unread previous holder → a 1-of-N successor is judged like an EOA successor (red)
    expect(classifyControllerChange(null, safe(SAFE, 1, 3)).severity).toBe('downgrade')
  })
  it('head: a power held by a 1-of-N Safe carries the AD-3 breach an EOA holder does', () => {
    const out = build(
      subject({
        powers: [{ power: 'upgrade', contract: TAR, path: ['owner'], label: 'Upgrade T' }],
      }),
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade T', contract: TAR, holders: [SAFE] }],
          controllers: { [`${SAFE}@head`]: safe(SAFE, 1, 4) },
        },
      }),
    )
    const it = out.state.items.find((i) => i.key === `admin/power/upgrade/${TAR}`)!
    expect(it.breaches.map((b) => b.ruleId)).toContain('AD-3')
  })
})

describe('rules #6 CC-1 queue: re-adding a remote pool after an executed removal', () => {
  const add = encodeFunctionData({
    abi: parseAbi(['function addRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)']),
    functionName: 'addRemotePool',
    args: [7n, B as Hx],
  })
  const base = (ever: string[]) =>
    qctx({
      contracts: [POOL],
      ccipRemotePools: () => [],
      ccipEverRemotePools: () => ever,
    })
  it('a pool the chain never had, after the old one was removed, is red CC-1', () => {
    const out = timelockChanges([armedOp([add], [POOL])], base([A]), 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('CC-1')
    // control: a fresh chain (no history) is a new route, and the same pool is no re-point
    expect(timelockChanges([armedOp([add], [POOL])], base([]), 1000)[0].red).toBe(false)
    expect(timelockChanges([armedOp([add], [POOL])], base([B]), 1000)[0].red).toBe(false)
  })
  it('engine: the history of remote pools reaches the queue', () => {
    const out = build(
      subject({
        contracts: [
          ...subject().contracts,
          {
            role: 'ccip_pool',
            dimension: 'bridge',
            chainId: 1,
            address: POOL,
            label: 'p',
            deployBlock: 1,
          },
        ],
        ccipPools: [POOL],
      }),
      {
        ...rawOf({
          admin: {
            events: [
              row({
                emitter: POOL,
                event: 'RemotePoolAdded',
                block: 100,
                tx: '0x1',
                args: { remoteChainSelector: '7', remotePoolAddress: A },
              }),
              row({
                emitter: POOL,
                event: 'RemotePoolRemoved',
                block: 200,
                tx: '0x2',
                args: { remoteChainSelector: '7', remotePoolAddress: A },
              }),
            ],
          },
          queues: { ops: [armedOp([add], [POOL])] },
        }),
        // the pool read at head: chain 7 is not served (its pool was removed)
        ccip: { pools: [{ pool: POOL, owner: null, rebalancer: null, chains: [] }] },
      },
    )
    const q = out.queue.find((c) => c.key === `bridge/ccip/${POOL}/7`)!
    expect(q.red).toBe(true)
    expect(q.ruleIds).toContain('CC-1')
  })
})

// ---- on-chain ---------------------------------------------------------------------------------------
describe('on-chain #1: the whitelist matcher follows holder chains like the head bypass check', () => {
  const SEL = toFunctionSelector('function setMaxMintPerBlock(uint256)')
  const RESTRICT = 'removeMinterRole(address)'
  const minterSubject = (exclude?: string[]) =>
    subject({
      contracts: [
        ...subject().contracts,
        {
          role: 'token',
          dimension: 'mint_redeem',
          chainId: 1,
          address: USDE,
          label: 'u',
          deployBlock: 1,
        },
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
      powers: [
        {
          power: 'mint',
          contract: USDE,
          path: ['call:minter()'],
          label: 'USDe minter contract',
          ...(exclude ? { bypassExclude: exclude } : {}),
        },
      ],
    })
  const raw = (sel: string) =>
    rawOf({
      admin: {
        powers: [
          { power: 'mint', label: 'USDe minter contract', contract: USDE, holders: [MINTING] },
        ],
        controllers: {
          [`${MINTING}@head`]: {
            kind: 'contract',
            address: MINTING,
            ownedBy: timelock(TL, 86400, {
              bypass: {
                fn: 'executeWhitelisted',
                scope: 'whitelist',
                targets: { [MINTING]: [sel] },
              },
            }),
          },
        },
        events: [
          row({
            emitter: TL,
            event: 'FunctionWhitelisted',
            block: 100,
            tx: '0xw',
            args: { target: MINTING, selector: sel },
          }),
        ],
      },
    })
  it('a function whitelisted on a holder-chain contract (not declared) is filed, judged as the head judges it', () => {
    const out = build(minterSubject(), raw(SEL))
    const wl = out.changes.filter((c) => c.key.startsWith('admin/timelock_whitelist/'))
    expect(wl).toHaveLength(1)
    expect(wl[0].red).toBe(true)
    const it = out.state.items.find((i) => i.key === `admin/power/mint/${USDE}`)!
    expect(it.breaches.map((b) => b.ruleId)).toContain('AD-2')
  })
  it('a restrict-only function declared on the power: neither the history nor the head is red', () => {
    const sel = toFunctionSelector(`function ${RESTRICT}`)
    const out = build(minterSubject([RESTRICT]), raw(sel))
    const wl = out.changes.filter((c) => c.key.startsWith('admin/timelock_whitelist/'))
    expect(wl).toHaveLength(1)
    expect(wl[0].red).toBe(false)
    const it = out.state.items.find((i) => i.key === `admin/power/mint/${USDE}`)!
    expect(it.breaches.map((b) => b.ruleId)).not.toContain('AD-2')
  })
  it('data: the USDe minter power declares the restrict-only EthenaMinting functions', () => {
    const subjects = JSON.parse(src('data/oracle-registry/config/subjects.json')).subjects
    const usde = subjects.find((s: ConfigSubject) => s.key === 'usde')
    const minter = usde.powers.find((p: { label: string }) => p.label === 'USDe minter contract')
    const sels = (minter.bypassExclude ?? []).map((x: string) =>
      toFunctionSelector(`function ${x}`),
    )
    for (const s of [
      '0x16255c43',
      '0xc5ff38bd',
      '0x8db940e0',
      '0xd547741f',
      '0x7274c25c',
      '0x54f1e126',
      '0x532c3f82',
    ])
      expect(sels).toContain(s)
  })
})

describe('on-chain #2: rsETH tracks the ETHx price oracle', () => {
  it('param, contract (its proxy) and its upgrade power are declared', () => {
    const subjects = JSON.parse(src('data/oracle-registry/config/subjects.json')).subjects
    const rs = subjects.find((s: ConfigSubject) => s.key === 'rseth') as ConfigSubject
    const ethx = '0x3d08ccb47cccde84755924ed6b0642f9ab30dfd2'
    expect(rs.params.find((p) => p.key === 'assetPriceOracle:ETHx')?.rule).toBe('price_oracle')
    expect(rs.contracts.some((c) => c.address === ethx)).toBe(true)
    expect(rs.powers.some((p) => p.contract === ethx && p.power === 'upgrade')).toBe(true)
  })
})

describe('on-chain #3: a timelock EXECUTOR / CANCELLER Safe is in the run-to-run snapshot', () => {
  it('safeSnapshot includes the Safe holding EXECUTOR_ROLE on a declared timelock', () => {
    const out = build(
      subject({ timelocks: [TL] }),
      rawOf({
        admin: {
          events: [
            row({
              emitter: TL,
              event: 'RoleGranted',
              block: 100,
              args: { role: '0x' + '1'.repeat(64), roleName: 'EXECUTOR_ROLE', account: SAFE2 },
            }),
          ],
          controllers: { [`${SAFE2}@head`]: safe(SAFE2, 3, 6) },
        },
      }),
    )
    expect((out.state.safeSnapshot ?? []).map((c) => c.address)).toContain(SAFE2)
  })
})

// ---- UI ---------------------------------------------------------------------------------------------
const view0 = (o: Record<string, unknown> = {}) => ({
  available: false,
  changesAvailable: false,
  oracle: { collected: false },
  timeline: {
    totals: { all: 0, red: 0, byDimension: { bridge: 0, oracle: 0, admin: 0, mint_redeem: 0 } },
  },
  ...o,
})

describe('UI #1: "not collected" never renders as zeros on the filter buttons', () => {
  it('no collector output: every button says not collected and is disabled', () => {
    const bs = timelineFilterButtons(view0(), { dimension: null, redOnly: false })
    expect(bs.every((b) => /not collected/.test(b.label))).toBe(true)
    expect(bs.filter((b) => b.key !== 'all').every((b) => b.disabled)).toBe(true)
    expect(bs.some((b) => /\b0\b/.test(b.label))).toBe(false)
  })
  it('change files but no state: oracle rows in them make the oracle dimension collected', () => {
    const card = buildConfigCard({
      subject: subject({ oracleAssetKey: 'wbtc' }),
      state: null,
      changes: [
        {
          id: '1',
          subject: 'z',
          dimension: 'oracle',
          key: 'oracle/x/y',
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
          block: 5,
        } as ConfigChange,
      ],
      queue: [],
    })
    expect(card.oracle.collected).toBe(true)
    const btn = timelineFilterButtons(card, { dimension: null, redOnly: false }).find(
      (b) => b.key === 'oracle',
    )!
    expect(btn.label).toBe('Oracles 1')
    expect(btn.disabled).toBe(false)
  })
})

describe('UI #2: a red closed route opens its disclosure and the summary says so', () => {
  const side = (o: Record<string, unknown> = {}) => ({
    E: 1,
    live: false,
    breaches: [] as { ruleId: string; message: string }[],
    tags: [],
    warnings: [],
    operators: [],
    display: '',
    floorBreach: false,
    unread: null,
    ...o,
  })
  const route = (breaches: { ruleId: string; message: string }[]) =>
    ({
      local: { send: side(), receive: side({ breaches }) },
      remote: null,
      floorBreach: false,
    }) as unknown as Pick<RouteRowView, 'local' | 'remote' | 'floorBreach'>
  it('open + red count; a calm one stays collapsed (control)', () => {
    const d = closedRoutesDisclosure([route([{ ruleId: 'BR-4', message: 'x' }]), route([])])
    expect(d.open).toBe(true)
    expect(d.summary).toMatch(/1 with red flags/)
    expect(closedRoutesDisclosure([route([])]).open).toBe(false)
    expect(src('components/OracleRegistry/ConfigBridge.tsx')).toMatch(/open=\{disclosure\.open/)
  })
})

describe('UI #3: before → after lines say what moved', () => {
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
      config: uln([LZ, NM, CANARY1]),
    },
    { ...base, block: 3, tx: '0x3', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
  ]
  it('a DVN contract swapped within one operator: lines differ, a rotation tag and a note', () => {
    const r = replayLz(
      [
        ...setup,
        {
          ...base,
          block: 4,
          tx: '0x4',
          kind: 'uln',
          lib: RECV,
          oapp: OAPP,
          eid: 30110,
          config: uln([LZ, NM, CANARY2]),
        },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = r.changes.find((x) => x.tx === '0x4')!
    expect(c.beforeDisplay).not.toBe(c.afterDisplay)
    expect(c.afterDisplay).toMatch(/canary-subsidized 0x8bd4/)
    expect(c.tags).toContain('rotation')
    expect((c.notes ?? []).join()).toMatch(/same operator/)
  })
  it('a peer re-point is titled as a peer change and shows the peers', () => {
    const r = replayLz(
      [
        ...setup,
        { ...base, block: 4, tx: '0x4', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER2 },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = r.changes.find((x) => x.tx === '0x4' && x.route?.direction === 'receive')!
    expect(c.red).toBe(true)
    expect(c.title).toMatch(/peer/)
    expect(c.title).not.toMatch(/E=\d → E=\d/)
    expect(c.beforeDisplay).not.toBe(c.afterDisplay)
    expect(c.afterDisplay).toMatch(/peer 0xd3ea/)
  })
  it('a queued setPeer shows the peers (not the receive config twice), both directions, no send-side tag', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function setPeer(uint32 eid, bytes32 peer)']),
      functionName: 'setPeer',
      args: [30110, ZERO32 as Hx],
    })
    const out = timelockChanges([armedOp([data], [OAPP])], qctx(), 1000)
    expect(out).toHaveLength(1)
    expect(out[0].beforeDisplay).toMatch(/^peer /)
    expect(out[0].afterDisplay).toMatch(/^peer 0 \(none\)/)
    expect(out[0].tags).not.toContain('send_side')
    expect(routeLabel({ eid: 30110, direction: 'both', chain: 'Arbitrum' })).toBe(
      'Arbitrum send + receive (peer)',
    )
  })
  it('a multisig owner swap names the owners; equal lines say "same as before"', () => {
    const out = classifyAdminEvents(
      [
        row({ emitter: SAFE, event: 'AddedOwner', block: 600, tx: '0xs', args: { owner: B } }),
        row({
          emitter: SAFE,
          event: 'RemovedOwner',
          block: 600,
          tx: '0xs',
          logIndex: 1,
          args: { owner: A },
        }),
      ],
      actx({ [`${SAFE}@599`]: safe(SAFE, 3, 6), [`${SAFE}@600`]: safe(SAFE, 3, 6) }),
    )
    const c = out.find((x) => x.key === `admin/multisig/${SAFE}`)!
    expect(c.beforeDisplay).toMatch(/owner 0x0000…00aa removed/)
    expect(c.afterDisplay).toMatch(/owner 0x0000…00bb added/)
    const card = buildConfigCard({
      subject: subject(),
      state: null,
      changes: [{ ...c, beforeDisplay: undefined, afterDisplay: undefined }],
      queue: [],
    })
    expect(card.timeline.rows[0].after).toMatch(/same as before/)
  })
})

describe('UI #4: the rsETH note names the on-chain pending source (the 10 d timelock)', () => {
  it('no longer says the Safe Tx Service is the only pending source', () => {
    const subjects = JSON.parse(src('data/oracle-registry/config/subjects.json')).subjects
    const notes = (subjects.find((s: ConfigSubject) => s.key === 'rseth').notes ?? []).join(' ')
    expect(notes).not.toMatch(/so the Safe Tx Service is the only pending source/)
    expect(notes).toMatch(/Timelock 10 d/)
  })
})

describe('UI #5: "floor breaches" counts routes, like "under floor"', () => {
  const item = (dir: string, o: Partial<StateItem> = {}): StateItem => ({
    subject: 'z',
    dimension: 'bridge',
    key: `bridge/lz/1/${OAPP}/30110/${dir}`,
    display: `eid 30110 (arbitrum) ${dir}: E=1`,
    chainId: 1,
    block: 1,
    breaches: [{ ruleId: 'BR-2', message: 'E=1 under the floor' }],
    ...o,
  })
  it('a route under the floor on send and receive (and its remote side) is ONE floor breach', () => {
    const items = [
      item('send'),
      item('receive'),
      item('send', {
        key: `bridge/lz/42161/${C}/30101/send`,
        display: 'eid 30110 (arbitrum) remote send: E=1',
        value: { localOApp: OAPP },
      }),
    ]
    expect(floorBreachRoutes(items)).toHaveLength(1)
    expect(countsOf(items, []).floorBreaches).toBe(1)
  })
})

describe('UI #6: pending legacy-multisig rows show when they were submitted', () => {
  const r = (o: Partial<ConfigChangeView>) =>
    ({
      state: 'pending',
      block: null,
      blockFrom: null,
      queue: { kind: 'legacy_multisig', address: SAFE, opId: '14', label: '', url: '' },
      ...o,
    }) as ConfigChangeView
  it('submitted at block N, or says the block was not read — never "—"', () => {
    expect(blockText(r({ block: 6_500_000 }))).toBe('submitted at block 6,500,000')
    expect(blockText(r({}))).toMatch(/submitted · tx 14 · block not read/)
    expect(src('components/OracleRegistry/ConfigCard.tsx')).toMatch(
      /submitted to an on-chain multisig/,
    )
  })
  it('collector: Submission is decodable and scanned per multisig, not in the admin scan', () => {
    expect(TOPIC.Submission).toBeDefined()
    expect(ADMIN_TOPICS).not.toContain(TOPIC.Submission)
    expect(src('scripts/oracle-registry/config/collect-config.mjs')).toMatch(
      /topics0: \[TOPIC\.Submission\]/,
    )
  })
})

// ---- UNSURE items fixed with the round ---------------------------------------------------------------
describe('unsure: BURNER_ROLE burns any holder’s balance (Kelp RSETH.burnFrom) — privileged', () => {
  it('a grant to an EOA is red AD-4', () => {
    const v = classifyRoleGrant('BURNER_ROLE', eoa(X), [], true)
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('AD-4')
  })
})

describe('unsure: a queued op is atomic under the timeline filters', () => {
  const v = (o: Partial<ConfigChangeView>) =>
    ({
      id: Math.random().toString(),
      state: 'pending',
      stage: 'armed',
      dimension: 'admin',
      title: 't',
      red: false,
      tags: [],
      queue: { kind: 'oz_timelock', address: TL, opId: '0xop', label: '', url: '' },
      ...o,
    }) as ConfigChangeView
  it('filtering on Admin keeps the op’s red bridge call: its batch reads 1 red', () => {
    const rows = [v({ dimension: 'admin' }), v({ dimension: 'bridge', red: true })]
    const kept = filterRows(rows, { dimension: 'admin', redOnly: false })
    expect(kept).toHaveLength(2)
    const b = batchRows(kept)[0]
    expect(b.kind === 'batch' && b.redCount).toBe(1)
  })
})

describe('unsure: "0 floor breaches" for a subject with no LayerZero route', () => {
  it('reads not applicable instead of zero', () => {
    const c = {
      floorBreaches: 0,
      ruleBreaches: 0,
      redInEffect: 0,
      redOpen: 0,
      pending: 0,
      proposed: 0,
    } as ConfigCounts
    expect(headline('cbBTC', c, true, true, false)).toMatch(/floor n\/a/)
    expect(headline('cbBTC', c, true, true, false)).not.toMatch(/0 floor breaches/)
    expect(headline('rsETH', c)).toMatch(/0 floor breaches/)
  })
})

describe('unsure: a selector the subject declares is named, not CALL NOT DECODED', () => {
  it('a declared restrict-only function on the contract is named and not loud', () => {
    const data =
      toFunctionSelector('function addWhitelistedBenefactor(address)') +
      B.slice(2).padStart(64, '0')
    const out = timelockChanges(
      [armedOp([data], [MINTING])],
      qctx({
        declaredSelectors: (c, s) =>
          c === MINTING && s === '0x16255c43'
            ? { signature: 'addWhitelistedBenefactor(address)', restrictOnly: true }
            : null,
      }),
      1000,
    )
    expect(out[0].title).toMatch(/addWhitelistedBenefactor/)
    expect(out[0].tags).not.toContain('undecoded')
    expect(out[0].red).toBe(false)
  })
})

describe('unsure: the persistent banner is not a second live announcement', () => {
  it('the red banner is a region; the headline keeps aria-live', () => {
    const card = src('components/OracleRegistry/ConfigCard.tsx')
    expect(card).not.toMatch(/role="alert"/)
    expect(card).toMatch(/aria-live="polite"/)
  })
})
