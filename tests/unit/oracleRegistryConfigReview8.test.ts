// Config cards — review round 8 (2026-10-07, final round): the CONFIRMED bugs of the fourth
// refutation pass (on-chain, rules, UI) that can make a dangerous change read calm, hide a red or
// misstate chain data. One test (or group) per finding; each failed on the code before the fix
// (controls are marked). Synthetic fixtures. Findings registered instead of fixed are in
// docs/research/CONFIG-CARDS-KNOWN-GAPS.md.

import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'

import { headline, headlineTone } from '@/components/OracleRegistry/configViewModel'
import type { ConfigCounts } from '@/lib/oracleRegistry/config/apiTypes'
import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import {
  buildSubject,
  ccipRemotePoolsReplay,
  type NttHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  safeProposalChanges,
  timelockChanges,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  applyGrantPattern,
  classifyCcip,
  classifyNttThreshold,
  controllerRank,
  down,
  neutral,
} from '@/lib/oracleRegistry/config/rules'
import type { ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry, EvalCtx } from '@/lib/oracleRegistry/config/uln'
import { classify, readNtt } from '@/scripts/oracle-registry/config/lib/admin.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const ZERO32 = '0x' + '0'.repeat(64)
const Z = '0x' + '0'.repeat(40)
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const X = '0x00000000000000000000000000000000000000dd'
const PROXY = '0x' + '1'.repeat(40)
const PA = '0x' + '2'.repeat(40)
const IMPL = '0x' + '3'.repeat(40)
const MINTING = '0x' + '4'.repeat(40)
const POOL = '0x' + '5'.repeat(40)
const SAFE = '0x' + '6'.repeat(40)
const MC = '0x' + '7'.repeat(40) // an MCMS-like contract (owned by an EOA, later by a timelock)
const NTTM = '0x' + '8'.repeat(40)
const WH = '0x' + '9'.repeat(40)
const AX = '0x' + 'b'.repeat(40)
const TL = '0x' + 'c'.repeat(40)
const BR = '0x' + 'd'.repeat(40)
const TOKEN = '0x' + 'f'.repeat(40)
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const PEER2 = '0x000000000000000000000000d3eacf0612346366db554c991d7858716db09f59'

const registry: DvnRegistry = {
  byChain: { 1: {} },
  dead: { 1: [] },
  libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
}
const ctx: EvalCtx = { registry, code: () => true, useDeprecated: false }
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, n: number, o: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: n,
  ...o,
})
const timelock = (a: string, d = 86400, o: Partial<Controller> = {}): Controller => ({
  kind: 'oz_timelock',
  address: a,
  delaySec: d,
  ...o,
})
const ownedBy = (a: string, o: Controller): Controller => ({
  kind: 'contract',
  address: a,
  ownedBy: o,
})
const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
  chainId: 1,
  block: 100,
  logIndex: 0,
  tx: '0xt',
  emitter: POOL,
  event: 'RoleGranted',
  args: {},
  ...o,
})
const actx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
  subject: 's',
  ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? null,
  ctlExact: (a: string, b: number) => m[`${a}@${b}`] ?? null,
  upgradeTimelocks: {},
  deployBlocks: { [MINTING]: 1, [POOL]: 1, [NTTM]: 1 },
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
      role: 'token',
      dimension: 'mint_redeem',
      chainId: 1,
      address: MINTING,
      label: 'm',
      deployBlock: 1,
    },
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
const rawOf = (o: {
  admin?: Partial<RawSubject['admin']>
  queues?: Partial<RawSubject['queues']>
  ntt?: RawSubject['ntt']
  canonical?: RawSubject['canonical']
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
  queues: { ops: [], safe: [], safeStatus: [], ...o.queues },
  ccip: { pools: [] },
  ...(o.ntt ? { ntt: o.ntt } : {}),
  ...(o.canonical ? { canonical: o.canonical } : {}),
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'x', roleName: (h) => h, endpoint: EP })
const qctx = (o: Partial<QueueCtx> = {}): QueueCtx => ({
  subject: 's',
  announcement: 'not_checked',
  eval: ctx,
  block: 1_000_000,
  endpoint: EP,
  routes: {},
  defaults: {},
  libDirection: () => null,
  ctl: () => null,
  ownerOf: () => null,
  delegateOf: () => null,
  implHistory: {},
  minDelayOf: () => 86400,
  roleName: (h) => h,
  contracts: [MINTING, POOL, PROXY, NTTM],
  oapps: [],
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
  ...o,
})

// =====================================================================================================
describe('rules #1: a call hidden in upgradeToAndCall / upgradeAndCall data is judged', () => {
  const ABI = parseAbi([
    'function upgradeToAndCall(address impl, bytes data)',
    'function upgradeAndCall(address proxy, address impl, bytes data)',
    'function transferOwnership(address newOwner)',
  ])
  const move = encodeFunctionData({ abi: ABI, functionName: 'transferOwnership', args: [X as Hx] })
  const q = qctx({
    ctl: (a) => (a === TL ? timelock(TL, 10 * 86400) : a === X ? eoa(X) : null),
    ownerOf: (c) => (c === PROXY ? TL : null),
    implHistory: { [PROXY]: { impls: [{ impl: IMPL, block: 5 }], current: IMPL } },
  })
  it('control: transferOwnership(EOA) queued directly is red AD-3 + AD-8', () => {
    const out = timelockChanges([armedOp([move], [PROXY])], q, 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['AD-3', 'AD-8']))
  })
  it('upgradeToAndCall(currentImpl, transferOwnership(EOA)) is red AD-3 + AD-8 (was one amber logic_change row)', () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: 'upgradeToAndCall',
      args: [IMPL as Hx, move as Hx],
    })
    const out = timelockChanges([armedOp([data], [PROXY])], q, 1000)
    const own = out.find((c) => c.key === `admin/owner/${PROXY}`)
    expect(own).toBeDefined()
    expect(own!.red).toBe(true)
    expect(own!.ruleIds).toEqual(expect.arrayContaining(['AD-3', 'AD-8']))
    expect(own!.notes?.join(' ')).toMatch(/upgradeToAndCall/)
    // the upgrade row itself is still there
    expect(out.some((c) => c.key === `admin/implementation/${PROXY}`)).toBe(true)
  })
  it('a ProxyAdmin upgradeAndCall(proxy, impl, transferOwnership(EOA)) is red on the proxy', () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: 'upgradeAndCall',
      args: [PROXY as Hx, IMPL as Hx, move as Hx],
    })
    const out = timelockChanges([armedOp([data], [PA])], q, 1000)
    const own = out.find((c) => c.key === `admin/owner/${PROXY}`)
    expect(own?.red).toBe(true)
    expect(own?.ruleIds).toContain('AD-3')
  })
})

// =====================================================================================================
const nttHead = (o: Partial<NttHead> = {}): NttHead => ({
  manager: NTTM,
  token: TOKEN,
  mode: 'locking',
  threshold: 2,
  transceivers: [
    { address: WH, type: 'wormhole', peers: { 4: PEER } },
    { address: AX, type: 'axelar', peers: {} },
  ],
  peers: { 4: { peer: PEER, decimals: 18 } },
  owner: TL,
  pauser: null,
  paused: false,
  locked: null,
  remote: [
    {
      wormholeChainId: 4,
      chainId: 56,
      chainKey: 'bsc',
      status: 'ok',
      threshold: 2,
      transceivers: [
        { address: WH, type: 'wormhole', peers: {} },
        { address: AX, type: 'axelar', peers: {} },
      ],
      peerBack: { peer: '0x' + '0'.repeat(24) + NTTM.slice(2), decimals: 18 },
      owner: safe(SAFE, 3, 5),
      supply: { raw: '1', decimals: 18 },
    },
  ],
  ...o,
})

describe('rules #2: an NTT read that failed never switches the floor or the owner check off', () => {
  const s = subject({ nttManagers: [NTTM] } as Partial<ConfigSubject>)
  const ctls = { [`${TL}@head`]: timelock(TL, 10 * 86400) }
  it('a peer that could not be read is a read gap and the floor is judged (fail closed)', () => {
    const out = build(
      s,
      rawOf({
        admin: { controllers: ctls },
        ntt: [
          nttHead({
            threshold: 1,
            transceivers: [{ address: WH, type: 'wormhole', peers: {} }],
            peers: { 4: null },
            remote: undefined,
          }),
        ],
      }),
    )
    const item = out.state.items.find((i) => i.key === `bridge/ntt/${NTTM}`)!
    expect(item.breaches.map((b) => b.ruleId)).toContain('BR-2')
    expect(out.state.readGaps?.join(' ')).toMatch(/peer for chain 4 not read/)
  })
  it('control: every peer zero (no live route) is no floor breach', () => {
    const out = build(
      s,
      rawOf({
        admin: { controllers: ctls },
        ntt: [
          nttHead({
            threshold: 1,
            transceivers: [{ address: WH, type: 'wormhole', peers: {} }],
            peers: { 4: { peer: ZERO32, decimals: 18 } },
            remote: undefined,
          }),
        ],
      }),
    )
    const item = out.state.items.find((i) => i.key === `bridge/ntt/${NTTM}`)!
    expect(item.breaches.map((b) => b.ruleId)).not.toContain('BR-2')
  })
  it('the Ethereum NTT owner unread is a read gap', () => {
    const out = build(s, rawOf({ admin: { controllers: ctls }, ntt: [nttHead({ owner: null })] }))
    expect(out.state.readGaps?.join(' ')).toMatch(/NTT manager .*owner not read/)
  })
  it('a canonical bridge whose proxy admin was not read is a read gap (not ossified)', () => {
    const out = build(
      subject({
        canonicalBridges: [{ address: BR, token: TOKEN, chain: 'linea', operator: 'x' }],
      } as Partial<ConfigSubject>),
      rawOf({
        canonical: [{ bridge: BR, token: TOKEN, locked: null, admin: null }],
      }),
    )
    expect(out.state.readGaps?.join(' ')).toMatch(/canonical bridge .*proxy admin not read/)
  })
  it('collector: readNtt sweeps the known EVM chains — a peer the PeerUpdated scan missed is still read', async () => {
    const reads: Record<string, unknown> = {
      [`${NTTM}|getThreshold`]: 1,
      [`${NTTM}|getTransceivers`]: [WH],
      [`${WH}|getTransceiverType`]: 'wormhole',
      [`${WH}|getWormholePeer`]: PEER,
      // only chain 4 (BNB) has a peer; every other chain answers zero
      [`${NTTM}|getPeer`]: (args: unknown[]) => ({
        peerAddress: Number(args[0]) === 4 ? PEER : ZERO32,
        tokenDecimals: 18,
      }),
    }
    const lc = (x: string) => x.toLowerCase()
    const client = {
      readContract: async ({
        address,
        functionName,
        args,
      }: {
        address: string
        functionName: string
        args?: unknown[]
      }) => {
        const v = reads[`${lc(address)}|${functionName}`]
        if (v === undefined)
          throw Object.assign(new Error('execution reverted'), {
            name: 'ContractFunctionRevertedError',
          })
        return typeof v === 'function' ? v(args ?? []) : v
      },
    }
    // the event scan came back empty (a false-empty getLogs chunk): no chain named
    const n = await readNtt(client, NTTM, [], [4, 5, 23, 30])
    expect(Object.keys(n.peers)).toEqual(['4'])
    expect((n.peers as Record<string, { peer: string }>)[4].peer).toBe(PEER.toLowerCase())
  })
})

// =====================================================================================================
describe('rules #3: armed NTT downgrades are decoded and judged', () => {
  const NTT_ABI = parseAbi([
    'function setThreshold(uint8 threshold)',
    'function removeTransceiver(address transceiver)',
    'function setTransceiver(address transceiver)',
    'function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit)',
    'function setWormholePeer(uint16 chainId, bytes32 peerContract)',
    'function upgrade(address newImplementation)',
  ])
  const q = qctx({ ntt: [nttHead()], verified: () => false })
  const run = (data: string, target = NTTM) => timelockChanges([armedOp([data], [target])], q, 1000)
  it('setThreshold(1) is red BR-1 + BR-2 (floor)', () => {
    const out = run(encodeFunctionData({ abi: NTT_ABI, functionName: 'setThreshold', args: [1] }))
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-2']))
    expect(out[0].floorBreach).toBe(true)
    expect(out[0].tags).not.toContain('undecoded')
  })
  it('removeTransceiver(axelar) is red BR-1 (2 networks → 1)', () => {
    const out = run(
      encodeFunctionData({ abi: NTT_ABI, functionName: 'removeTransceiver', args: [AX as Hx] }),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('BR-1')
  })
  it('setTransceiver(unknown) is red BR-7 (its verifier network is not known: fail closed)', () => {
    const out = run(
      encodeFunctionData({ abi: NTT_ABI, functionName: 'setTransceiver', args: [X as Hx] }),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('BR-7')
  })
  it('the NTT setPeer re-point is red BR-6', () => {
    const out = run(
      encodeFunctionData({
        abi: NTT_ABI,
        functionName: 'setPeer',
        args: [4, PEER2 as Hx, 18, 0n],
      }),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('BR-6')
  })
  it('a transceiver setWormholePeer re-point is red BR-6 (the transceiver is this card’s)', () => {
    const out = run(
      encodeFunctionData({
        abi: NTT_ABI,
        functionName: 'setWormholePeer',
        args: [4, PEER2 as Hx],
      }),
      WH,
    )
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('BR-6')
  })
  it('the NTT one-argument upgrade(address) is an upgrade (unverified ⇒ AD-9)', () => {
    const out = run(
      encodeFunctionData({ abi: NTT_ABI, functionName: 'upgrade', args: [IMPL as Hx] }),
    )
    expect(out[0].key).toBe(`admin/implementation/${NTTM}`)
    expect(out[0].ruleIds).toContain('AD-9')
  })
  it('a Safe 1.1.1 changeMasterCopy self-call is red AD-6 (singleton swap)', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function changeMasterCopy(address _masterCopy)']),
      functionName: 'changeMasterCopy',
      args: [X as Hx],
    })
    const out = safeProposalChanges(
      [
        {
          safe: SAFE,
          nonce: 1,
          to: SAFE,
          value: '0',
          data,
          confirmations: 1,
          confirmationsRequired: 2,
          safeTxHash: '0xh',
        },
      ],
      qctx({
        safes: [SAFE],
        ctl: (a) => (a === SAFE ? safe(SAFE, 2, 3, { singleton: IMPL }) : null),
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-6')
  })
})

// =====================================================================================================
describe('rules #4: a CCIP rate limiter switched off by removing and re-adding the chain', () => {
  const lim = (on: boolean) => ({ isEnabled: on, capacity: 1n, rate: 1n })
  it('history: the re-add with the limiter off is red CC-2', () => {
    const out = classifyAdminEvents(
      [
        row({
          event: 'ChainAdded',
          block: 100,
          args: {
            remoteChainSelector: '7',
            inboundRateLimiterConfig: lim(true),
            outboundRateLimiterConfig: lim(true),
          },
        }),
        row({ event: 'ChainRemoved', block: 200, args: { remoteChainSelector: '7' } }),
        row({
          event: 'ChainAdded',
          block: 300,
          args: {
            remoteChainSelector: '7',
            inboundRateLimiterConfig: lim(false),
            outboundRateLimiterConfig: lim(false),
          },
        }),
        row({
          event: 'ChainConfigured',
          block: 400,
          args: {
            remoteChainSelector: '7',
            inboundRateLimiterConfig: lim(true),
            outboundRateLimiterConfig: lim(true),
          },
        }),
      ],
      actx({}),
    )
    const readd = out.find((c) => c.block === 300)!
    expect(readd.red).toBe(true)
    expect(readd.ruleIds).toContain('CC-2')
    // control: the first add with the limiter on is not red
    expect(out.find((c) => c.block === 100)!.red).toBe(false)
  })
  it('queue: a chain re-added with its limiter off is red when it was on before its removal', () => {
    const ABI = parseAbi([
      'function applyChainUpdates(uint64[] remoteChainSelectorsToRemove, (uint64 remoteChainSelector, bytes[] remotePoolAddresses, bytes remoteTokenAddress, (bool isEnabled, uint128 capacity, uint128 rate) outboundRateLimiterConfig, (bool isEnabled, uint128 capacity, uint128 rate) inboundRateLimiterConfig)[] chainsToAdd)',
    ])
    const data = encodeFunctionData({
      abi: ABI,
      functionName: 'applyChainUpdates',
      args: [
        [],
        [
          {
            remoteChainSelector: 7n,
            remotePoolAddresses: [A as Hx],
            remoteTokenAddress: B as Hx,
            outboundRateLimiterConfig: lim(false),
            inboundRateLimiterConfig: lim(false),
          },
        ],
      ],
    })
    const q = qctx({
      ccipPools: [
        { pool: POOL, chains: [] } as unknown as NonNullable<QueueCtx['ccipPools']>[number],
      ],
      ccipRemotePools: () => [],
      ccipEverRemotePools: () => [A],
      ccipLastRemotePools: () => [A],
      ccipLastLimiterOn: (p, s) => p === POOL && s === '7',
    })
    const out = timelockChanges([armedOp([data], [POOL])], q, 1000)
    const rl = out.find((c) => c.key === `bridge/ccip/${POOL}/7/rate_limit`)!
    expect(rl.red).toBe(true)
    expect(rl.ruleIds).toContain('CC-2')
  })
})

// =====================================================================================================
describe('rules #5: CC-3 ranks the rebalancer with whoever controls it (isEoaControlled)', () => {
  it('a first rebalancer that is a contract owned by an EOA is red CC-3 (history)', () => {
    const out = classifyAdminEvents(
      [row({ event: 'RebalancerSet', args: { oldRebalancer: Z, newRebalancer: MC } })],
      actx({ [`${MC}@100`]: ownedBy(MC, eoa(X)) }),
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('CC-3')
  })
  it('a rebalancer whose previous holder is unread, moved to a 1-of-3 Safe, is red CC-3', () => {
    const v = classifyCcip('rebalancer', { prevCtl: null, nextCtl: safe(SAFE, 1, 3) })
    expect(v.ruleIds).toContain('CC-3')
  })
  it('control: a 3-of-5 Safe rebalancer with no previous holder is not red', () => {
    const v = classifyCcip('rebalancer', { prevCtl: null, nextCtl: safe(SAFE, 3, 5) })
    expect(v.ruleIds).not.toContain('CC-3')
  })
  it('queue: setRebalancer to a contract an EOA owns is red CC-3', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function setRebalancer(address rebalancer)']),
      functionName: 'setRebalancer',
      args: [MC as Hx],
    })
    const out = timelockChanges(
      [armedOp([data], [POOL])],
      qctx({ ctl: (a) => (a === MC ? ownedBy(MC, eoa(X)) : null) }),
      1000,
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('CC-3')
  })
})

// =====================================================================================================
describe('rules #6: a CCIP remote pool rolled back to an older pool is a re-point', () => {
  const set = (block: number, prev: string, next: string) =>
    row({
      event: 'RemotePoolSet',
      block,
      args: { remoteChainSelector: '7', previousPoolAddress: prev, remotePoolAddress: next },
    })
  it('1.5.0: 0→A, A→B, B→A, A→0, 0→B — the last set is red (was neutral route_created)', () => {
    const out = classifyAdminEvents(
      [set(100, Z, A), set(200, A, B), set(300, B, A), set(400, A, Z), set(500, Z, B)],
      actx({}),
    )
    const last = out.find((c) => c.block === 500)!
    expect(last.red).toBe(true)
    expect(last.ruleIds).toContain('CC-1')
  })
  it('control 1.5.0: A→0 then 0→A (the same pool back) is not red', () => {
    const out = classifyAdminEvents([set(100, Z, A), set(200, A, Z), set(300, Z, A)], actx({}))
    expect(out.find((c) => c.block === 300)!.red).toBe(false)
  })
  const ev = (block: number, event: string, addr: string) =>
    row({ event, block, args: { remoteChainSelector: '7', remotePoolAddress: addr } })
  const rows151 = [
    ev(100, 'RemotePoolAdded', A),
    ev(200, 'RemotePoolRemoved', A),
    ev(300, 'RemotePoolAdded', B),
    ev(400, 'RemotePoolRemoved', B),
    ev(500, 'RemotePoolAdded', A),
  ]
  it('1.5.1: add A, remove A, add B, remove B, add A — the last add is red', () => {
    const out = classifyAdminEvents(rows151, actx({}))
    expect(out.find((c) => c.block === 300)!.red).toBe(true)
    const last = out.find((c) => c.block === 500)!
    expect(last.red).toBe(true)
    expect(last.ruleIds).toContain('CC-1')
  })
  it('engine replay: the pools a chain had when it last served', () => {
    expect(ccipRemotePoolsReplay(rows151, POOL, '7')).toEqual({ now: [A], last: [A] })
    expect(ccipRemotePoolsReplay(rows151.slice(0, 4), POOL, '7')).toEqual({ now: [], last: [B] })
  })
  it('queue: a queued re-add of an older pool (not the last one) is red', () => {
    const data = encodeFunctionData({
      abi: parseAbi([
        'function addRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
      ]),
      functionName: 'addRemotePool',
      args: [7n, A as Hx],
    })
    const q = qctx({
      ccipRemotePools: () => [],
      ccipEverRemotePools: () => [A, B],
      ccipLastRemotePools: () => [B],
    })
    const out = timelockChanges([armedOp([data], [POOL])], q, 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('CC-1')
  })
})

// =====================================================================================================
describe('rules #7: a Safe whose module read failed is not a Safe with no modules', () => {
  const fakeSafe = (modulesOk: boolean) => ({
    getCode: async () => '0x6080',
    getBlockNumber: async () => 1000n,
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) =>
        c.functionName === 'getThreshold'
          ? { status: 'success', result: 2n }
          : c.functionName === 'getOwners'
            ? { status: 'success', result: [A, B, X] }
            : { status: 'failure' },
      ),
    getStorageAt: async ({ slot }: { slot: string }) =>
      BigInt(slot) === 0n
        ? '0x' + '0'.repeat(24) + 'd9db270c1b5e3bd161e8c8503c55ceabee709552'
        : '0x' + '0'.repeat(64),
    readContract: async () => {
      if (!modulesOk)
        throw Object.assign(new Error('execution reverted'), {
          name: 'ContractFunctionRevertedError',
        })
      return [[], '0x0000000000000000000000000000000000000001']
    },
    request: async () => [],
  })
  it('classify(): modules unread ⇒ modulesUnread, no `modules: []`; it ranks as a plain contract', async () => {
    const c = (await classify(fakeSafe(false), SAFE)) as Controller
    expect(c.kind).toBe('safe')
    expect(c.modules).toBeUndefined()
    expect(c.modulesUnread).toBe(true)
    expect(controllerRank(c)).toEqual([2])
  }, 20_000)
  it('control: modules read (none) ⇒ a full 2-of-3 multisig', async () => {
    const c = (await classify(fakeSafe(true), SAFE)) as Controller
    expect(c.modules).toEqual([])
    expect(controllerRank(c)[0]).toBe(4)
  })
  it('engine: a power holder Safe with unread modules is a read gap', () => {
    const out = build(
      subject({
        powers: [{ power: 'upgrade', contract: MINTING, path: ['owner'], label: 'Upgrade M' }],
      }),
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'Upgrade M', contract: MINTING, holders: [SAFE] }],
          controllers: { [`${SAFE}@head`]: safe(SAFE, 2, 3, { modulesUnread: true }) },
        },
      }),
    )
    expect(out.state.readGaps?.join(' ')).toMatch(/modules not read/)
  })
})

// =====================================================================================================
describe('rules #8: an NTT effective verifier count drop at an unchanged threshold is BR-1', () => {
  it('classifyNttThreshold compares effective counts when the previous transceivers are given', () => {
    const v = classifyNttThreshold(
      3,
      3,
      ['wormhole', 'ccip', 'wormhole'],
      ['wormhole', 'axelar', 'ccip', 'wormhole'],
    )
    expect(v.ruleIds).toContain('BR-1')
    // control: no previous transceivers given ⇒ the raw threshold only
    expect(classifyNttThreshold(3, 3, ['wormhole', 'ccip', 'wormhole']).ruleIds).not.toContain(
      'BR-1',
    )
  })
  it('history: TransceiverRemoved(axelar) at threshold 3 over 3 networks is red BR-1', () => {
    const add = (block: number, t: string, type: string, threshold: number) =>
      row({
        emitter: NTTM,
        event: 'TransceiverAdded',
        block,
        args: { transceiver: t, transceiverType: type, threshold },
      })
    const out = classifyAdminEvents(
      [
        add(100, WH, 'wormhole', 1),
        add(110, AX, 'axelar', 2),
        add(120, X, 'ccip', 3),
        add(130, A, 'wormhole', 3),
        row({
          emitter: NTTM,
          event: 'TransceiverRemoved',
          block: 200,
          args: { transceiver: AX, threshold: 3 },
        }),
      ],
      actx({}),
    )
    const rm = out.find((c) => c.block === 200)!
    expect(rm.red).toBe(true)
    expect(rm.ruleIds).toContain('BR-1')
  })
})

// =====================================================================================================
describe('ui #2: head state missing but change files present — the headline keeps the reds', () => {
  it('names red queued / red in effect', () => {
    const h = headline('rsETH', counts({ redOpen: 1, openRed: 1, pending: 1 }), false, true)
    expect(h).toMatch(/1 red queued/)
    const h2 = headline('rsETH', counts({ redInEffect: 2, openRed: 2 }), false, true)
    expect(h2).toMatch(/2 red in effect/)
  })
  it('the headline tone is red, not amber, when a red is known', () => {
    expect(headlineTone(false, true, 1)).toBe('red')
    expect(headlineTone(false, true, 0)).toBe('warning')
    expect(headlineTone(false, false, 0)).toBe('warning')
    expect(headlineTone(true, true, 1)).toBe('red')
    expect(headlineTone(true, true, 0)).toBe('normal')
  })
})

// =====================================================================================================
describe('ui #3: a red grant an established pattern would NOT clear leads with its anomaly', () => {
  const red = () => down(neutral(), 'AD-4', 'MINTER_ROLE → contract')
  it('no pattern + grantee has code ⇒ anomaly tag, the anomaly leads (not "no pattern yet")', () => {
    const v = applyGrantPattern(red(), 'MINTER_ROLE', {
      established: false,
      earlierBotGrants: 0,
      anomalies: ['grantee has code (contract 0x7777…7777)'],
    })
    expect(v.tags).toContain('anomaly')
    expect(v.notes[0]).not.toMatch(/no established/)
    expect(v.notes[0]).toMatch(/grantee has code/)
    expect(v.notes.join(' ')).not.toMatch(/no established/)
  })
  it('control: no pattern and no anomaly keeps the "no established pattern yet" note', () => {
    const v = applyGrantPattern(red(), 'MINTER_ROLE', {
      established: false,
      earlierBotGrants: 1,
      anomalies: [],
    })
    expect(v.notes[0]).toMatch(/no established MINTER_ROLE bot pattern yet/)
    expect(v.tags).not.toContain('anomaly')
  })
})

// =====================================================================================================
describe('on-chain #1: role holders are re-judged at head', () => {
  const ROLE = '0x' + 'ab'.repeat(32)
  const grant = (block: number, account: string, logIndex = 0) =>
    row({
      emitter: MINTING,
      event: 'RoleGranted',
      block,
      logIndex,
      tx: `0x${block.toString(16)}`,
      args: { role: ROLE, roleName: 'PROPOSER_ROLE', account },
    })
  const run = (controllers: Record<string, Controller>, events = [grant(100, MC)]) =>
    build(subject(), rawOf({ admin: { events, controllers } }))
  it('a red grant to an EOA-owned contract that a timelock owns at head is no longer in effect', () => {
    const out = run({
      [`${MC}@100`]: ownedBy(MC, eoa(X)),
      [`${MC}@head`]: ownedBy(MC, timelock(TL, 10 * 86400)),
    })
    const g = out.changes.find((c) => c.key === `admin/role/${MINTING}/PROPOSER_ROLE`)!
    expect(g.red).toBe(true)
    expect(g.stillInEffect).toBeFalsy()
    expect(g.notes?.join(' ')).toMatch(/no longer in effect at head/i)
  })
  it('control: still EOA-owned at head ⇒ still in effect', () => {
    const out = run({
      [`${MC}@100`]: ownedBy(MC, eoa(X)),
      [`${MC}@head`]: ownedBy(MC, eoa(X)),
    })
    const g = out.changes.find((c) => c.key === `admin/role/${MINTING}/PROPOSER_ROLE`)!
    expect(g.stillInEffect).toBe(true)
  })
  it('control: head controller not read ⇒ still in effect (never resolved on missing data)', () => {
    const out = run({ [`${MC}@100`]: ownedBy(MC, eoa(X)) })
    const g = out.changes.find((c) => c.key === `admin/role/${MINTING}/PROPOSER_ROLE`)!
    expect(g.stillInEffect).toBe(true)
  })
  it('control: improved but still weaker than the holders it was ranked against ⇒ still in effect', () => {
    const out = run(
      {
        [`${TL}@50`]: timelock(TL, 10 * 86400),
        [`${TL}@100`]: timelock(TL, 10 * 86400),
        [`${MC}@100`]: ownedBy(MC, eoa(X)),
        [`${MC}@head`]: safe(MC, 2, 3),
      },
      [grant(50, TL), grant(100, MC, 1)],
    )
    const g = out.changes.find((c) => c.block === 100 && c.key.endsWith('/PROPOSER_ROLE'))!
    expect(g.red).toBe(true)
    expect(g.stillInEffect).toBe(true)
  })
  it('reverse: a holder granted while a 3-of-5 Safe and 1-of-5 at head is a red in effect', () => {
    const out = run({ [`${SAFE}@100`]: safe(SAFE, 3, 5), [`${SAFE}@head`]: safe(SAFE, 1, 5) }, [
      grant(100, SAFE),
    ])
    const g = out.changes.find((c) => c.block === 100)!
    expect(g.red).toBe(false)
    const w = out.changes.filter((c) => c.red && c.stillInEffect)
    expect(w).toHaveLength(1)
    expect(w[0].ruleIds).toContain('AD-4')
    expect(w[0].title).toMatch(/weakened since/)
    expect(w[0].tags).toContain('bracketed')
  })
  it('control: an operational EOA holder (EOA then and now) is not flagged', () => {
    const out = run({ [`${A}@100`]: eoa(A), [`${A}@head`]: eoa(A) }, [grant(100, A)])
    expect(out.changes.filter((c) => c.title.match(/weakened since/))).toHaveLength(0)
  })
})
