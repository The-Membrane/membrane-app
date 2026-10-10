// Config cards — owner rulings of 2026-10-06 and the clear bugs of the third adversarial review
// (on-chain, rules, UI). One test per finding; each one failed on the code before the fix.
// Synthetic fixtures, real Ethereum DVN / endpoint addresses where identity matters.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import {
  blockAside,
  configTabLabel,
  configTabMarks,
  headline,
  NO_WINDOW_TITLE,
  sourcesLine,
  tagChips,
  timelineCountsLine,
} from '@/components/OracleRegistry/configViewModel'
import type { ConfigCounts, ConfigTabSummary } from '@/lib/oracleRegistry/config/apiTypes'
import {
  classifyAdminEvents,
  classifyDvnSignerChanges,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import { compareRoute } from '@/lib/oracleRegistry/config/bridgeRules'
import {
  buildSubject,
  markStillInEffect,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import {
  opStatus,
  safeProposalChanges,
  timelockChanges,
  unwrapCalls,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  ADMIN_LEVEL_ROLES,
  GRANT_BURST_MAX,
  GRANT_BURST_WINDOW_BLOCKS,
  GRANT_RATE_SPIKE_FACTOR,
  GRANT_RATE_WINDOW_BLOCKS,
  OPERATIONAL_PATTERN_MIN_GRANTS,
  classifyControllerChange,
  classifyRoleGrant,
  classifySafeModuleChange,
  grantPattern,
} from '@/lib/oracleRegistry/config/rules'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  UlnConfigRaw,
} from '@/lib/oracleRegistry/config/types'
import {
  NIL_CONFIRMATIONS,
  evaluateRoute,
  mergeUln,
  type DvnRegistry,
  type EvalCtx,
} from '@/lib/oracleRegistry/config/uln'
import { classify } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { replayDvnSigners } from '@/scripts/oracle-registry/config/lib/lz.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const GG = '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const PEER2 = '0x0000000000000000000000004444444444444444444444444444444444444444'
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const C = '0x00000000000000000000000000000000000000cc'
const SAFE = '0x' + 'a'.repeat(40)
const OTHER_SAFE = '0x' + 'e'.repeat(40)
const TL = '0x' + 'c'.repeat(40)
const MINTING = '0x' + '3'.repeat(40)
const MINTER_HASH = '0x' + '11'.repeat(32)

const registry: DvnRegistry = {
  byChain: {
    1: { [LZ]: { id: 'layerzero-labs', name: 'LZ' }, [NM]: { id: 'nethermind', name: 'NM' } },
    42161: {
      [LZ]: { id: 'layerzero-labs', name: 'LZ' },
      [NM]: { id: 'nethermind', name: 'NM' },
      [GG]: { id: 'google-cloud', name: 'GG' },
    },
  },
  dead: { 1: [], 42161: [] },
  libraries: {
    1: { send: [RECV], receive: [RECV], blocked: [], read: [] },
    42161: { send: [RECV], receive: [RECV], blocked: [], read: [] },
  },
}
const ctx: EvalCtx = { registry, code: () => true, useDeprecated: false }
const uln = (req: string[], conf = '15'): UlnConfigRaw => ({
  confirmations: conf,
  requiredDVNCount: req.length,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: req,
  optionalDVNs: [],
})
const route = (
  cfg: UlnConfigRaw,
  o: Partial<{ peer: string; defaultConfirmations: string; lib: string }> = {},
) =>
  evaluateRoute(
    {
      chainId: 1,
      oapp: OAPP,
      eid: 30110,
      direction: 'receive',
      block: 100,
      peer: o.peer ?? PEER,
      lib: o.lib ?? RECV,
      libIsDefault: false,
      config: mergeUln(cfg, undefined),
      defaultConfirmations: o.defaultConfirmations,
    },
    ctx,
  )
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
const safe = (a: string, t: number, s: number, extra: Partial<Controller> = {}): Controller => ({
  kind: 'safe',
  address: a,
  threshold: t,
  signers: s,
  modules: [],
  ...extra,
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
  head?: number
}): RawSubject => ({
  version: 1,
  subjectKey: 'z',
  head: { block: o.head ?? 1000, ts: 2000 },
  scan: { from: 1, to: o.head ?? 1000 },
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
  warnings: [],
})
const build = (s: ConfigSubject, raw: RawSubject) =>
  buildSubject(s, raw, { registry, eidName: () => 'arbitrum', roleName: (h) => h, endpoint: EP })

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
  deployBlocks: { [MINTING]: 1 },
  tokens: [],
  announcement: 'not_checked' as const,
  ...o,
})

const QABI = parseAbi([
  'function grantRole(bytes32 role, address account)',
  'function transferOwnership(address newOwner)',
  'function updateDelay(uint256 newDelay)',
  'function upgradeTo(address impl)',
  'function setMaxMintPerBlock(uint256 n)',
  'function executeWhitelistedBatch(address[] targets, uint256[] values, bytes[] payloads)',
  'function bypasserExecuteBatch((address target, uint256 value, bytes data)[] calls)',
])
const qctx = (o: Partial<QueueCtx> = {}): QueueCtx => ({
  subject: 's',
  announcement: 'not_checked',
  eval: ctx,
  block: 100_000,
  endpoint: EP,
  routes: {},
  defaults: {},
  libDirection: () => null,
  ctl: () => null,
  ownerOf: () => null,
  delegateOf: () => null,
  implHistory: {},
  minDelayOf: () => 86400,
  roleName: (h) => (h === MINTER_HASH ? 'MINTER_ROLE' : h),
  contracts: [MINTING, A],
  oapps: [],
  verified: () => true,
  ...o,
})
const op = (data: string[], target: string, o: Partial<TimelockOp> = {}): TimelockOp => ({
  timelock: TL,
  id: '0x' + 'ab'.repeat(32),
  calls: data.map((d) => ({ target, value: '0', data: d })),
  predecessor: '0x' + '0'.repeat(64),
  delaySec: 86400,
  scheduledBlock: 20,
  scheduledTx: '0xs',
  timestamp: 500,
  predecessorDone: true,
  simulation: 'ok',
  ...o,
})

// =====================================================================================================
describe('owner rulings 2026-10-06', () => {
  it('#1 BR-3: red only at ZERO or below the pathway default; an unread default fails closed and says so', () => {
    const v = (from: string, to: string, def?: string) =>
      compareRoute(
        route(uln([LZ, NM], from), { defaultConfirmations: def }),
        route(uln([LZ, NM], to), { defaultConfirmations: def }),
      )
    expect(v('64', NIL_CONFIRMATIONS.toString(), '15').ruleIds).toContain('BR-3')
    expect(v('64', '5', '15').ruleIds).toContain('BR-3')
    expect(v('1000000', '30000', '30000').ruleIds).not.toContain('BR-3')
    const unread = v('64', '20')
    expect(unread.ruleIds).toContain('BR-3')
    expect(unread.notes.join()).toMatch(/default for this pathway not read: fail closed/)
  })

  it('#2 AD-6: a guard added where none existed is an UPGRADE; replaced or removed is red — also replayed from ChangedGuard events, which carry only the new guard', () => {
    const Z = '0x' + '0'.repeat(40)
    expect(classifySafeModuleChange('guard', Z, B).severity).toBe('upgrade')
    expect(classifySafeModuleChange('guard', A, B).ruleIds).toEqual(['AD-6'])
    expect(classifySafeModuleChange('guard', A, Z).ruleIds).toEqual(['AD-6'])
    const out = classifyAdminEvents(
      [
        row({ event: 'ChangedGuard', emitter: SAFE, block: 200, tx: '0x1', args: { guard: A } }),
        row({ event: 'ChangedGuard', emitter: SAFE, block: 300, tx: '0x2', args: { guard: B } }),
      ],
      actx({ [`${SAFE}@199`]: safe(SAFE, 3, 5), [`${SAFE}@299`]: safe(SAFE, 3, 5) }),
    )
    expect(out[0].severity).toBe('upgrade') // first guard: added
    expect(out[1].red).toBe(true) // A replaced by B
    expect(out[1].ruleIds).toEqual(['AD-6'])
  })

  it('#3 BR-6 strict: every peer re-point is red, also on a route that is closed now', () => {
    expect(
      compareRoute(route(uln([LZ, NM])), route(uln([LZ, NM]), { peer: PEER2 })).ruleIds,
    ).toContain('BR-6')
    // a route with no DVN at all verifies nothing (closed): re-pointing it is red too
    const before = route(uln([]))
    expect(before.live).toBe(false)
    const closed = compareRoute(before, route(uln([]), { peer: PEER2 }))
    expect(closed.ruleIds).toContain('BR-6')
    expect(closed.notes.join()).toMatch(/while the route was closed/)
  })

  describe('#4 role grants to bot wallets: AMBER operational on the established pattern, RED on anomaly', () => {
    it('the thresholds are named, exported constants with the provisional values', () => {
      expect(OPERATIONAL_PATTERN_MIN_GRANTS).toBe(3)
      expect(GRANT_BURST_WINDOW_BLOCKS).toBe(7200)
      expect(GRANT_BURST_MAX).toBe(3)
      expect(GRANT_RATE_WINDOW_BLOCKS).toBe(216_000)
      expect(GRANT_RATE_SPIKE_FACTOR).toBe(2)
      expect(ADMIN_LEVEL_ROLES.has('DEFAULT_ADMIN_ROLE')).toBe(true)
    })
    const bot = (i: number) => '0x' + (0x1000 + i).toString(16).padStart(40, '0')
    // three earlier bot grants, one per week (no burst), then grant #4 a month later
    const history = [0, 1, 2].map((i) =>
      row({
        block: 1_000_000 + i * 50_400,
        tx: `0xg${i}`,
        args: { role: MINTER_HASH, roleName: 'MINTER_ROLE', account: bot(i) },
      }),
    )
    const ctlMap: Record<string, Controller> = {}
    for (let i = 0; i < 40; i++) ctlMap[`${bot(i)}@head`] = eoa(bot(i))
    const grant = (block: number, account: string, logIndex = 0, roleName = 'MINTER_ROLE') =>
      row({
        block,
        logIndex,
        tx: `0xn${block}${logIndex}`,
        args: { role: MINTER_HASH, roleName, account },
      })

    it('a 4th MINTER_ROLE grant to a bot EOA, no spike: AMBER operational (not red), with the reason', () => {
      const out = classifyAdminEvents([...history, grant(1_300_000, bot(3))], actx(ctlMap))
      const g = out.at(-1)!
      expect(g.red).toBe(false)
      expect(g.tags).toContain('operational')
      expect(g.notes?.join()).toMatch(/established MINTER_ROLE bot pattern \(3 earlier/)
      expect(tagChips(g.tags).find((t) => t.label === 'OPERATIONAL')?.loud).toBe(true)
      // before the pattern exists, the same grant is red as before (AD-4 / MR-2)
      expect(out[0].red).toBe(true)
      expect(out[2].red).toBe(true)
    })

    it('anomaly: the grantee has code — RED, tagged anomaly', () => {
      const out = classifyAdminEvents(
        [...history, grant(1_300_000, C)],
        actx({ ...ctlMap, [`${C}@1300000`]: { kind: 'contract', address: C } }),
      )
      expect(out.at(-1)!.red).toBe(true)
      expect(out.at(-1)!.tags).toContain('anomaly')
      expect(out.at(-1)!.notes?.join()).toMatch(/grantee has code/)
    })

    it(`anomaly (revised by round-2 ruling #10): a one-day batch larger than the largest earlier one-day batch — RED`, () => {
      // the history's one-day batches hold 1 grant each: the 2nd grant of one day is larger
      const burst = [3, 4, 5, 6].map((i) => grant(1_300_000 + i, bot(i)))
      const out = classifyAdminEvents([...history, ...burst], actx(ctlMap))
      expect(out.slice(-4).map((c) => c.red)).toEqual([false, true, true, true])
      expect(out.at(-1)!.notes?.join()).toMatch(
        /one-day batch of 4 grants is larger than the largest earlier one-day batch \(1\)/,
      )
      // with no earlier batch at all, the fallback: more than ${GRANT_BURST_MAX} in ${GRANT_BURST_WINDOW_BLOCKS} blocks
      const fresh = classifyAdminEvents(
        [0, 1, 2, 3, 4].map((i) => grant(1_300_000 + i, bot(i))),
        actx(ctlMap),
      )
      expect(fresh.at(-1)!.notes?.join()).toMatch(/no earlier one-day batch: more than 3/)
    })

    it(`anomaly: the 30-day count beyond ${GRANT_RATE_SPIKE_FACTOR}× the largest earlier one — RED`, () => {
      // baseline: one 30-day window holds 3 grants; the current window then sees 7
      const spaced = (start: number, n: number, from: number) =>
        Array.from({ length: n }, (_, k) => grant(start + k * 10_000, bot(from + k)))
      const out = classifyAdminEvents(
        [...spaced(1_000_000, 3, 0), ...spaced(2_000_000, 7, 3)],
        actx(ctlMap),
      )
      const last = out.at(-1)!
      expect(last.red).toBe(true)
      expect(last.notes?.join()).toMatch(/grant rate: 7 in 216000 blocks vs at most 3/)
      expect(out.at(-2)!.red).toBe(false) // 6 = 2 × 3 is not MORE than 2×
    })

    it('anomaly: an admin-level role or a role-admin role is never operational', () => {
      const p = grantPattern('DEFAULT_ADMIN_ROLE', eoa(B), 2_000_000, [
        { block: 1, account: A, noCode: true },
        { block: 2, account: A, noCode: true },
        { block: 3, account: A, noCode: true },
      ])
      expect(p.anomalies.join()).toMatch(/admin-level/)
      const q = grantPattern('MANAGER_X', eoa(B), 2_000_000, [], new Set(['MANAGER_X']))
      expect(q.anomalies.join()).toMatch(/administers other roles/)
    })

    it('a pending grantRole is judged against the executed grant history (queue)', () => {
      const data = encodeFunctionData({
        abi: QABI,
        functionName: 'grantRole',
        args: [MINTER_HASH as `0x${string}`, bot(9) as `0x${string}`],
      })
      const q = qctx({
        ctl: (a) => (a === bot(9) ? eoa(a) : null),
        roleGrants: () =>
          [0, 1, 2].map((i) => ({ block: 10_000 + i * 50_400, account: bot(i), noCode: true })),
      })
      const out = timelockChanges([op([data], MINTING, { timestamp: 5000 })], q, 1000)
      expect(out[0].state).toBe('pending')
      expect(out[0].red).toBe(false)
      expect(out[0].tags).toContain('operational')
    })
  })

  it('#5 Kelp copy: the backtest doc states the honest framing (red for a year, 825 of 1,835)', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/research/CONFIG-CARDS-DESIGN.md'), 'utf8')
    expect(doc).toMatch(/red for (about )?a year before the exploit/)
    expect(doc).toMatch(/825 of 1,835/)
    expect(doc).toMatch(/Movement has no red DVN changes/)
  })
})

// =====================================================================================================
describe('review 3: engine', () => {
  it("one app's Safe change never shows on another card (only this subject's Safes are diffed)", () => {
    const now = safe(OTHER_SAFE, 5, 11)
    const out = build(
      subject(),
      rawOf({
        admin: {
          controllers: { [`${OTHER_SAFE}@head`]: now },
          previousSafes: { block: 900, controllers: { [OTHER_SAFE]: safe(OTHER_SAFE, 6, 11) } },
        },
      }),
    )
    expect(out.changes.filter((c) => c.key.includes(OTHER_SAFE))).toEqual([])
    expect(out.state.safeSnapshot ?? []).toEqual([])
    // the same change on this subject's own Safe is a red bracketed AD-1
    const mine = build(
      subject({ safes: [OTHER_SAFE] }),
      rawOf({
        admin: {
          controllers: { [`${OTHER_SAFE}@head`]: now },
          previousSafes: { block: 900, controllers: { [OTHER_SAFE]: safe(OTHER_SAFE, 6, 11) } },
        },
      }),
    )
    expect(mine.changes.find((c) => c.key === `admin/multisig/${OTHER_SAFE}`)?.red).toBe(true)
  })

  it('AD-6: a Safe whose slot-0 singleton was swapped (now a plain contract) is red between runs', () => {
    const canonical = '0xd9db270c1b5e3bd161e8c8503c55ceabee709552'
    const rogue = '0x' + '6'.repeat(40)
    const out = build(
      subject({ safes: [SAFE] }),
      rawOf({
        admin: {
          controllers: {
            [`${SAFE}@head`]: {
              kind: 'contract',
              address: SAFE,
              threshold: 3,
              signers: 5,
              singleton: rogue,
            },
          },
          previousSafes: {
            block: 900,
            controllers: { [SAFE]: safe(SAFE, 3, 5, { singleton: canonical }) },
          },
        },
      }),
    )
    const c = out.changes.find((x) => x.key === `admin/safe/${SAFE}/singleton`)!
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-6'])
    expect([c.blockFrom, c.block]).toEqual([900, 1000])
    // still tracked by the next run (its singleton is kept)
    expect(out.state.safeSnapshot?.map((x) => x.address)).toEqual([SAFE])
  })

  describe('a timelock bypass reaches a power only through the functions that exercise it', () => {
    const wl: Controller = {
      kind: 'oz_timelock',
      address: TL,
      delaySec: 86400,
      bypass: {
        fn: 'executeWhitelisted',
        scope: 'whitelist',
        targets: { [OAPP]: ['setPeer(uint32,bytes32)'], [MINTING]: ['0x16255c43'] },
      },
    }
    const s = subject({
      contracts: [
        ...subject().contracts,
        {
          role: 'minting',
          dimension: 'mint_redeem',
          chainId: 1,
          address: MINTING,
          label: 'm',
          deployBlock: 1,
        },
      ],
      powers: [
        { power: 'bridge_config', contract: OAPP, path: ['owner'], label: 'adapter owner' },
        {
          power: 'bridge_config',
          contract: OAPP,
          path: ['lz_delegate'],
          label: 'adapter delegate',
        },
        {
          power: 'caps',
          contract: MINTING,
          path: ['owner'],
          label: 'minting owner',
          bypassExclude: ['addWhitelistedBenefactor(address)'],
        },
      ],
    })
    const out = build(
      s,
      rawOf({
        admin: {
          powers: [
            { power: 'bridge_config', label: 'adapter owner', contract: OAPP, holders: [TL] },
            { power: 'bridge_config', label: 'adapter delegate', contract: OAPP, holders: [TL] },
            { power: 'caps', label: 'minting owner', contract: MINTING, holders: [TL] },
          ],
          controllers: { [`${TL}@head`]: wl },
        },
      }),
    )
    it('the OApp owner (setPeer whitelisted) is INSTANT', () => {
      expect(out.state.powers[0].effectiveDelaySec).toBe(0)
    })
    it('the LZ delegate acts on the endpoint, which is not whitelisted: the delay holds', () => {
      expect(out.state.powers[1].effectiveDelaySec).toBe(86400)
      expect(out.state.powers[1].pendingObservable).toBe(true)
    })
    it('a whitelisted function outside the power (excluded) keeps the delay, and is listed', () => {
      expect(out.state.powers[2].effectiveDelaySec).toBe(86400)
      const item = out.state.items.find((i) => i.key === `admin/power/caps/${MINTING}`)!
      expect(item.display).not.toMatch(/INSTANT/)
      expect(item.warnings?.join()).toMatch(
        /0x16255c43 on .* outside this power, its delay is kept/,
      )
    })
    it('an unread whitelist (Ethena read failure): a plain contract with no delay for this run, said so', () => {
      const unread = build(
        s,
        rawOf({
          admin: {
            powers: [{ power: 'caps', label: 'minting owner', contract: MINTING, holders: [TL] }],
            controllers: {
              [`${TL}@head`]: {
                ...wl,
                bypass: { fn: 'executeWhitelisted', scope: 'any', unread: true },
              },
            },
          },
        }),
      )
      expect(unread.state.powers[0].effectiveDelaySec).toBe(0)
      const item = unread.state.items.find((i) => i.key.startsWith('admin/power/'))!
      expect(item.display).toMatch(/whitelist UNREAD/)
      expect(item.warnings?.join()).toMatch(
        /could not be read — this run ranks the timelock as a plain contract with no delay/,
      )
    })
  })

  it('a power holder the collector could not classify is kept (no delay), never dropped', () => {
    const out = build(
      subject(),
      rawOf({
        admin: {
          powers: [{ power: 'upgrade', label: 'u', contract: OAPP, holders: [TL, B] }],
          controllers: { [`${TL}@head`]: { kind: 'oz_timelock', address: TL, delaySec: 864000 } },
        },
      }),
    )
    expect(out.state.powers[0].holders).toHaveLength(2)
    expect(out.state.powers[0].effectiveDelaySec).toBe(0)
  })

  describe('remote side', () => {
    const REMOTE = '0x' + '4'.repeat(40)
    const head = (direction: 'send' | 'receive', o: Record<string, unknown> = {}) => ({
      oapp: OAPP,
      eid: 30110,
      direction,
      lib: RECV,
      libIsDefault: false,
      merged: uln([LZ, NM]),
      app: null,
      peer: '0x' + '0'.repeat(24) + REMOTE.slice(2),
      ...o,
    })
    const remote = (recv: UlnConfigRaw | null) => ({
      oapp: OAPP,
      eid: 30110,
      chainKey: 'arbitrum',
      chainId: 42161,
      status: 'ok' as const,
      peer: REMOTE,
      peerBack: '0x' + '0'.repeat(24) + OAPP.slice(2),
      directions: {
        receive: recv ? { lib: RECV, merged: recv } : null,
        send: { lib: RECV, merged: uln([LZ, NM]) },
      },
      dvnCode: { [LZ]: true, [NM]: true, [GG]: true },
    })
    it('Ethereum receive closed but send live: the remote receive side is still evaluated (BR-2)', () => {
      const out = build(
        subject(),
        rawOf({
          lz: {
            headRoutes: [head('receive', { merged: null, mergedReverted: true }), head('send')],
            remote: [remote(uln([LZ]))],
          },
        }),
      )
      const r = out.state.items.find((i) => i.key === `bridge/lz/42161/${REMOTE}/30101/receive`)
      expect(r?.breaches.map((b) => b.ruleId)).toContain('BR-2')
    })
    it('a remote route unread for one run keeps its last read: the next run brackets against it', () => {
      const run1 = build(
        subject(),
        rawOf({
          head: 1000,
          lz: { headRoutes: [head('receive')], remote: [remote(uln([LZ, NM, GG]))] },
        }),
      )
      const k = `bridge/lz/42161/${REMOTE}/30101/receive`
      const prev1 = {
        block: 1000,
        routes: run1.state.remoteSnapshot!,
        readAt: run1.state.remoteReadAt,
      }
      const run2 = build(
        subject(),
        rawOf({
          head: 2000,
          lz: { headRoutes: [head('receive')], remote: [remote(null)], previousRemote: prev1 },
        }),
      )
      expect(Object.keys(run2.state.remoteSnapshot!)).toContain(k)
      expect(run2.state.remoteReadAt?.[k]).toBe(1000)
      const prev2 = {
        block: 2000,
        routes: run2.state.remoteSnapshot!,
        readAt: run2.state.remoteReadAt,
      }
      const run3 = build(
        subject(),
        rawOf({
          head: 3000,
          lz: {
            headRoutes: [head('receive')],
            remote: [remote(uln([LZ, NM]))],
            previousRemote: prev2,
          },
        }),
      )
      const c = run3.changes.find((x) => x.key === k)!
      expect(c.red).toBe(true)
      expect(c.ruleIds).toContain('BR-1')
      expect([c.blockFrom, c.block]).toEqual([1000, 3000])
    })
  })
})

// =====================================================================================================
describe('review 3: STILL IN EFFECT', () => {
  const ch = (o: Partial<ConfigChange>): ConfigChange => ({
    id: Math.random().toString(),
    subject: 's',
    dimension: 'admin',
    key: 'k',
    title: 't',
    state: 'historical',
    severity: 'neutral',
    floorBreach: false,
    red: false,
    ruleIds: [],
    tags: [],
    unannounced: null,
    announcement: 'not_checked',
    chainId: 1,
    ...o,
  })
  it('a red AD-1 followed by a Safe owner swap (rotation) is still in effect', () => {
    const key = `admin/multisig/${SAFE}`
    const red = ch({
      key,
      block: 10,
      before: '6/10',
      after: '6/11',
      red: true,
      severity: 'downgrade',
    })
    const swap = ch({ key, block: 20, before: '6/11', after: '6/11', tags: ['rotation'] })
    markStillInEffect([red, swap])
    expect(red.stillInEffect).toBe(true)
  })
  it('contract → EOA (red), then an EOA → EOA rotation: still in effect', () => {
    const key = `admin/proxy_admin/${A}`
    const red = ch({ key, block: 10, before: C, after: A, red: true, severity: 'downgrade' })
    const rot = ch({ key, block: 20, before: A, after: B, tags: ['rotation'] })
    markStillInEffect([red, rot])
    expect(red.stillInEffect).toBe(true)
  })
  it('a later upgrade with no `before` (Upgraded carries only the new implementation) ends an AD-9 red', () => {
    const key = `admin/implementation/${A}`
    const red = ch({
      key,
      block: 10,
      after: B,
      red: true,
      severity: 'downgrade',
      ruleIds: ['AD-9'],
    })
    const next = ch({ key, block: 22, after: C, tags: ['logic_change'] })
    markStillInEffect([red, next])
    expect(red.stillInEffect).toBeUndefined()
  })
  it('a removed minter ends its MR-2 red; an allowance change does not', () => {
    const out = classifyAdminEvents(
      [
        row({
          event: 'MinterConfigured',
          block: 50,
          tx: '0x1',
          args: { minter: B, minterAllowedAmount: '1' },
        }),
        row({
          event: 'MinterConfigured',
          block: 60,
          tx: '0x2',
          args: { minter: B, minterAllowedAmount: '2' },
        }),
      ],
      actx({}),
    )
    const kept = [...out]
    markStillInEffect(kept)
    expect(out[0].red).toBe(true)
    expect(out[0].stillInEffect).toBe(true)
    const removed = classifyAdminEvents(
      [
        row({
          event: 'MinterConfigured',
          block: 50,
          tx: '0x1',
          args: { minter: B, minterAllowedAmount: '1' },
        }),
        row({ event: 'MinterRemoved', block: 70, tx: '0x3', args: { oldMinter: B } }),
      ],
      actx({}),
    )
    markStillInEffect(removed)
    expect(removed[0].stillInEffect).toBeUndefined()
  })
  it('end to end (buildSubject): rotations carry a red forward; a later upgrade or a removal ends it', () => {
    const PROXY = '0x' + '1'.repeat(40)
    const TOKEN = '0x' + '2'.repeat(40)
    const [X, Y, E1, E2, I1, I2, M1, M2] = ['7a', '7b', 'e1', 'e2', 'f1', 'f2', 'd1', 'd2'].map(
      (h) => '0x' + h.repeat(20),
    )
    const ev = (
      block: number,
      emitter: string,
      event: string,
      args: Record<string, unknown>,
      logIndex = 0,
    ) => ({
      chainId: 1,
      block,
      logIndex,
      tx: `0x${block}`,
      emitter,
      event,
      args,
    })
    const out = build(
      subject({ safes: [SAFE] }),
      rawOf({
        admin: {
          events: [
            ev(100, SAFE, 'AddedOwner', { owner: X }), // 6/10 → 6/11: red AD-1
            ev(200, SAFE, 'AddedOwner', { owner: Y }),
            ev(200, SAFE, 'RemovedOwner', { owner: X }, 1), // owner swap: rotation
            ev(300, PROXY, 'AdminChanged', { previousAdmin: C, newAdmin: E1 }), // contract → EOA: red
            ev(400, PROXY, 'AdminChanged', { previousAdmin: E1, newAdmin: E2 }), // EOA → EOA
            ev(500, PROXY, 'Upgraded', { implementation: I1 }), // unverified: red AD-9
            ev(510, PROXY, 'Upgraded', { implementation: I2 }), // verified: replaces it
            ev(600, TOKEN, 'MinterConfigured', { minter: M1, minterAllowedAmount: '1' }),
            ev(610, TOKEN, 'MinterConfigured', { minter: M2, minterAllowedAmount: '1' }), // red MR-2
            ev(620, TOKEN, 'MinterRemoved', { oldMinter: M2 }),
          ],
          controllers: {
            [`${SAFE}@99`]: safe(SAFE, 6, 10),
            [`${SAFE}@199`]: safe(SAFE, 6, 11),
            [`${SAFE}@200`]: safe(SAFE, 6, 11),
            [`${C}@299`]: { kind: 'contract', address: C },
            [`${E1}@300`]: eoa(E1),
            [`${E1}@399`]: eoa(E1),
            [`${E2}@400`]: eoa(E2),
          },
          deployBlocks: { [PROXY]: 1, [TOKEN]: 1, [SAFE]: 1 },
          verification: { [I1]: false, [I2]: true },
        },
      }),
    )
    const at = (block: number) => out.changes.find((c) => c.block === block)!
    expect(at(100).red).toBe(true)
    expect(at(100).stillInEffect).toBe(true) // the later swap is a rotation
    expect(at(300).red).toBe(true)
    expect(at(300).stillInEffect).toBe(true) // EOA → EOA does not undo contract → EOA
    expect(at(500).red).toBe(true)
    expect(at(500).stillInEffect).toBeUndefined() // replaced by a verified implementation
    expect(at(610).red).toBe(true)
    expect(at(610).stillInEffect).toBeUndefined() // the minter was removed
  })

  it('role keys are sets: a grant to another account never ends a red grant', () => {
    const key = `admin/role/${A}/DEFAULT_ADMIN_ROLE`
    const red = ch({ key, block: 10, after: B, red: true, severity: 'downgrade' })
    const other = ch({ key, block: 20, after: C })
    markStillInEffect([red, other])
    expect(red.stillInEffect).toBe(true)
  })
})

// =====================================================================================================
describe('review 3: admin / mint replay', () => {
  it('an unread previous holder never turns a move to an EOA into an upgrade', () => {
    const v = classifyControllerChange(null, eoa(B))
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toEqual(['AD-3'])
    expect(classifyControllerChange(null, safe(SAFE, 3, 5)).severity).toBe('neutral')
    expect(classifyControllerChange(null, null).ruleIds).toEqual(['AD-3'])
  })

  it('a privileged grant to an account that could not be classified is red (fail closed)', () => {
    expect(classifyRoleGrant('DEFAULT_ADMIN_ROLE', null, [], true).ruleIds).toEqual(['AD-4'])
  })

  it('MR-2: the FIRST MinterConfigured after deployment is a new minter; in the deploy block it is setup', () => {
    const first = classifyAdminEvents(
      [
        row({
          event: 'MinterConfigured',
          block: 50,
          args: { minter: B, minterAllowedAmount: '1' },
        }),
      ],
      actx({}),
    )
    expect(first[0].ruleIds).toEqual(['MR-2'])
    const init = classifyAdminEvents(
      [row({ event: 'MinterConfigured', block: 1, args: { minter: B, minterAllowedAmount: '1' } })],
      actx({}),
    )
    expect(init[0].red).toBe(false)
  })

  it('FiatToken role change with the previous holder unread, to an EOA, is red; CCIP admin judged against the replayed one', () => {
    const mm = classifyAdminEvents(
      [row({ event: 'MasterMinterChanged', block: 50, args: { newMasterMinter: B }, prev: null })],
      actx({ [`${B}@50`]: eoa(B) }),
    )
    expect(mm[0].red).toBe(true)
    const TOKEN = '0x' + '7'.repeat(40)
    const ccip = classifyAdminEvents(
      [
        row({
          event: 'AdministratorTransferred',
          emitter: C,
          block: 50,
          tx: '0x1',
          args: { token: TOKEN, newAdmin: SAFE },
        }),
        row({
          event: 'AdministratorTransferred',
          emitter: C,
          block: 60,
          tx: '0x2',
          args: { token: TOKEN, newAdmin: B },
        }),
      ],
      actx({ [`${SAFE}@head`]: safe(SAFE, 3, 5), [`${B}@60`]: eoa(B) }, { tokens: [TOKEN] }),
    )
    expect(ccip[1].ruleIds).toEqual(['AD-3'])
    expect(String(ccip[1].notes)).toMatch(/Safe 3-of-5/)
  })

  it('AD-3 on RoleAdminChanged: the admin of a role moved to a role held by an EOA is red', () => {
    const ROLE = '0x' + '22'.repeat(32)
    const MGR = '0x' + '33'.repeat(32)
    const out = classifyAdminEvents(
      [
        row({
          block: 10,
          tx: '0x1',
          args: { role: '0x' + '0'.repeat(64), roleName: 'DEFAULT_ADMIN_ROLE', account: SAFE },
        }),
        row({ block: 20, tx: '0x2', args: { role: MGR, roleName: 'MANAGER', account: B } }),
        row({
          event: 'RoleAdminChanged',
          block: 30,
          tx: '0x3',
          args: {
            role: ROLE,
            roleName: 'MINTER_ROLE',
            previousAdminRole: '0x' + '0'.repeat(64),
            newAdminRole: MGR,
            newAdminRoleName: 'MANAGER',
          },
        }),
      ],
      actx({ [`${SAFE}@head`]: safe(SAFE, 3, 5), [`${B}@head`]: eoa(B) }),
    )
    const c = out.find((x) => x.key.startsWith('admin/role_admin/'))!
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-3'])
    expect(c.title).toMatch(/DEFAULT_ADMIN_ROLE → MANAGER/)
  })

  it('DV-1: a quorum lowered and restored inside one transaction is red (flash); an unread state before is red', async () => {
    const DVN = '0x' + 'd'.repeat(40)
    const ev = (
      logIndex: number,
      event: string,
      args: Record<string, unknown>,
      tx = '0xq',
      block = 100,
    ) => ({
      emitter: DVN,
      block,
      logIndex,
      tx,
      event,
      args,
    })
    const rows = [ev(0, 'UpdateQuorum', { _quorum: 1n }), ev(1, 'UpdateQuorum', { _quorum: 3n })]
    const out = await replayDvnSigners(rows, async () => ({ quorum: 3, signers: 5 }))
    expect(out).toHaveLength(1)
    expect(out[0].prev).toEqual({ quorum: 3, signers: 5 })
    expect(out[0].next).toEqual({ quorum: 3, signers: 5 })
    expect(out[0].dip).toEqual({ quorum: 1, signers: 5 })
    const [c] = classifyDvnSignerChanges(out, 's', (a) => a, 'not_checked')
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['DV-1'])
    expect(c.tags).toContain('flash')
    // two transactions in one block chain on each other; an unread anchor is never calm
    const two = await replayDvnSigners(
      [
        ev(0, 'UpdateSigner', { _signer: A, _active: true }, '0xa'),
        ev(1, 'UpdateQuorum', { _quorum: 2n }, '0xb'),
      ],
      async () => ({ quorum: 3, signers: 5 }),
    )
    expect(two.map((r: { prev: unknown }) => r.prev)).toEqual([
      { quorum: 3, signers: 5 },
      { quorum: 3, signers: 6 },
    ])
    const unread = await replayDvnSigners([ev(0, 'UpdateQuorum', { _quorum: 2n })], async () => ({
      quorum: null,
      signers: null,
    }))
    const [u] = classifyDvnSignerChanges(unread, 's', (a) => a, 'not_checked')
    expect(u.red).toBe(true)
    // a signer rotation (add, then remove) in one transaction is not a flash
    const rot = await replayDvnSigners(
      [
        ev(0, 'UpdateSigner', { _signer: B, _active: true }, '0xr', 300),
        ev(1, 'UpdateSigner', { _signer: A, _active: false }, '0xr', 300),
      ],
      async () => ({ quorum: 3, signers: 5 }),
    )
    const [r] = classifyDvnSignerChanges(rot, 's', (a) => a, 'not_checked')
    expect(r.red).toBe(false)
    expect(r.tags).toContain('rotation')
    // events in the DVN's deploy block (no code one block earlier) are its setup, not "unread"
    const setup = await replayDvnSigners(
      [ev(0, 'UpdateSigner', { _signer: A, _active: true })],
      async () => ({
        quorum: null,
        signers: null,
        noCode: true,
      }),
    )
    const [i] = classifyDvnSignerChanges(setup, 's', (a) => a, 'not_checked')
    expect(i.red).toBe(false)
    expect(i.tags).toContain('initialization')
  })
})

// =====================================================================================================
describe('review 3: queue', () => {
  it('an unread predecessor fails closed (armed_unverified), never "stale"', () => {
    // the collector runs no simulation without a known-done predecessor ('not_run')
    expect(opStatus(op([], A, { predecessorDone: null, simulation: 'not_run' }), 1000)).toBe(
      'armed_unverified',
    )
    expect(opStatus(op([], A, { predecessorDone: false }), 1000)).toBe('ready_unexecutable')
  })

  it('an op whose state (getTimestamp) is unread is judged as armed: a stale rollback in it is red AD-8', () => {
    const OLD = '0x' + '8'.repeat(40)
    const CUR = '0x' + '9'.repeat(40)
    const data = encodeFunctionData({
      abi: QABI,
      functionName: 'upgradeTo',
      args: [OLD as `0x${string}`],
    })
    const q = qctx({
      implHistory: {
        [A]: {
          impls: [
            { impl: OLD, block: 10 },
            { impl: CUR, block: 50 },
          ],
          current: CUR,
        },
      },
    })
    const out = timelockChanges([op([data], A, { timestamp: null })], q, 1000)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('AD-8')
    expect(out[0].tags).toContain('state_unread')
    // fail-closed audit (DG-02, 2026-10-10): a state not read may be executable now — counted with
    // the armed ops (it was 'scheduled': plain pending)
    expect(out[0].stage).toBe('armed')
  })

  it('a pending transferOwnership to an EOA, with the current owner unread, is red', () => {
    const data = encodeFunctionData({
      abi: QABI,
      functionName: 'transferOwnership',
      args: [B as `0x${string}`],
    })
    const out = timelockChanges(
      [op([data], A, { timestamp: 5000 })],
      qctx({ ctl: (a) => (a === B ? eoa(B) : null) }),
      1000,
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(['AD-3'])
  })

  it('a pending updateDelay with the current delay unread is red AD-2', () => {
    const data = encodeFunctionData({ abi: QABI, functionName: 'updateDelay', args: [0n] })
    const out = timelockChanges(
      [op([data], TL, { timestamp: 5000 })],
      qctx({ minDelayOf: () => null, contracts: [TL] }),
      1000,
    )
    expect(out[0].ruleIds).toEqual(['AD-2'])
  })

  it('a proposed call routed through a timelock BYPASS is unwrapped and judged (Ethena / RBACTimelock)', () => {
    const inner = encodeFunctionData({ abi: QABI, functionName: 'setMaxMintPerBlock', args: [1n] })
    const grant = encodeFunctionData({
      abi: QABI,
      functionName: 'grantRole',
      args: [('0x' + '0'.repeat(64)) as `0x${string}`, B as `0x${string}`],
    })
    const wl = encodeFunctionData({
      abi: QABI,
      functionName: 'executeWhitelistedBatch',
      args: [
        [MINTING as `0x${string}`, MINTING as `0x${string}`],
        [0n, 0n],
        [inner, grant],
      ],
    })
    const u = unwrapCalls({ target: TL, value: '0', data: wl })
    expect(u.via).toBe('bypass')
    expect(u.calls.map((c) => c.data.slice(0, 10))).toEqual([
      toFunctionSelector('function setMaxMintPerBlock(uint256)'),
      toFunctionSelector('function grantRole(bytes32,address)'),
    ])
    const out = safeProposalChanges(
      [
        {
          safe: SAFE,
          nonce: 741,
          to: TL,
          value: '0',
          data: wl,
          confirmations: 3,
          confirmationsRequired: 5,
          safeTxHash: '0xh',
        },
      ],
      qctx({
        ctl: (a) => (a === B ? eoa(B) : null),
        roleName: (h) => (/^0x0+$/.test(h) ? 'DEFAULT_ADMIN_ROLE' : h),
      }),
    )
    const g = out.find((c) => c.key.includes('DEFAULT_ADMIN_ROLE'))!
    expect(g.red).toBe(true)
    expect(g.notes?.join()).toMatch(/timelock BYPASS: executes with no delay/)
    const rbac = encodeFunctionData({
      abi: QABI,
      functionName: 'bypasserExecuteBatch',
      args: [[{ target: MINTING as `0x${string}`, value: 0n, data: grant }]],
    })
    expect(unwrapCalls({ target: TL, value: '0', data: rbac }).calls[0].target).toBe(MINTING)
  })
})

// =====================================================================================================
describe('review 3: collector', () => {
  const fake = (o: {
    code: string
    views?: Record<string, unknown>
    storage?: Record<string, string>
    logsFail?: boolean
  }) => ({
    getCode: async () => o.code,
    getBlockNumber: async () => 100n,
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) =>
        o.views && c.functionName in o.views
          ? { status: 'success', result: o.views[c.functionName] }
          : { status: 'failure' },
      ),
    getStorageAt: async ({ slot }: { slot: string }) =>
      o.storage?.[BigInt(slot).toString()] ?? '0x' + '0'.repeat(64),
    readContract: async () => {
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    },
    request: async () => {
      if (o.logsFail) throw new Error('HTTP 503')
      return []
    },
  })
  const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
  const codeWith = (sigs: string[]) =>
    '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'

  it('a multisig-shaped proxy whose slot 0 is not a canonical singleton keeps that singleton (tracked run to run)', async () => {
    const owners = Array.from({ length: 5 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))
    const c = await classify(
      fake({
        code: '0x6080',
        views: { getThreshold: 3n, getOwners: owners },
        storage: { '0': '0x' + '0'.repeat(24) + '6'.repeat(40) },
      }),
      '0x' + '5'.repeat(40),
    )
    expect(c.kind).toBe('contract')
    expect((c as { singleton?: string }).singleton).toBe('0x' + '6'.repeat(40))
  })

  it('an Ethena whitelist that cannot be read: unrestricted bypass marked unread (plain contract, no delay, this run)', async () => {
    const c = await classify(
      fake({
        code: codeWith([
          'getMinDelay()',
          'getTimestamp(bytes32)',
          'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
          'execute(address,uint256,bytes,bytes32,bytes32)',
          'hashOperation(address,uint256,bytes,bytes32,bytes32)',
          'executeWhitelisted(address,uint256,bytes)',
        ]),
        views: { getMinDelay: 86400n },
        logsFail: true,
      }),
      '0x' + '6'.repeat(39) + '1',
    )
    expect(c.kind).toBe('oz_timelock')
    expect((c as { bypass?: unknown }).bypass).toEqual({
      fn: 'executeWhitelisted',
      scope: 'any',
      unread: true,
    })
  }, 20_000)
})

// =====================================================================================================
describe('review 3: view model', () => {
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
  const tab = (o: Partial<ConfigTabSummary> = {}): ConfigTabSummary => ({
    subject: 'x',
    slug: 'x',
    symbol: 'X',
    label: 'X',
    oracleSlug: null,
    counts: counts(),
    asOf: { block: 1, ts: 1_000_000 },
    ...o,
  })

  it('the tab never says "no red flags" for stale output or unread route sides', () => {
    expect(configTabLabel(tab(), 1_000_100)).toBe('config: no red flags')
    const unread = configTabLabel(tab({ counts: counts({ unread: 2 }) }), 1_000_100)
    expect(unread).not.toBe('config: no red flags')
    expect(unread).toMatch(/2 route sides unread — red flags may be missing/)
    const stale = configTabLabel(tab(), 1_000_000 + 3 * 86400)
    expect(stale).toMatch(/STALE/)
    expect(configTabMarks(tab({ counts: counts({ unread: 1 }) }))).toEqual([
      expect.objectContaining({ glyph: '?', count: 1, token: SEMANTIC_COLORS.warning }),
    ])
  })

  it('no collector output: block asides and the timeline count line say "not collected", never zeros', () => {
    expect(blockAside(false, 0, 'power')).toBe('not collected')
    expect(blockAside(true, 4, 'power')).toBe('4 powers')
    expect(
      timelineCountsLine({
        available: false,
        changesAvailable: false,
        counts: counts(),
        timeline: { historicalTotal: 0 },
      }),
    ).toBe('not collected')
    // head state missing, change files present: the queue counts are known, the breaches are not
    const h = headline('X', counts({ pending: 9 }), false, true)
    expect(h).toMatch(/head state not collected/)
    expect(h).toMatch(/9 pending/)
    expect(h).not.toMatch(/pending and proposed changes are unknown/)
  })

  it('copy: the no-window tooltip names the timelock bypass; a NO GOV CHANNEL card does not list Snapshot / forum as "not ingested"', () => {
    expect(NO_WINDOW_TITLE).toMatch(/timelock bypass/)
    const sources = [
      { kind: 'safe_tx_service' as const, status: 'ok' as const, note: null },
      { kind: 'snapshot' as const, status: 'not_ingested' as const, note: null },
      { kind: 'discourse' as const, status: 'not_ingested' as const, note: null },
    ]
    expect(sourcesLine(sources, 'no_gov_channel')).toBe(
      'Safe queue: 1 read · no governance channel (no Snapshot space or forum)',
    )
    expect(sourcesLine(sources, 'not_checked')).toMatch(/Snapshot: not ingested/)
  })

  it('contrast: config components colour text only with AA tokens (never textTertiary / danger / a raw .token)', () => {
    const dir = join(process.cwd(), 'components/OracleRegistry')
    const files = [
      'ConfigAtoms.tsx',
      'ConfigBridge.tsx',
      'ConfigCard.tsx',
      'ConfigTimeline.tsx',
      'ViewSwitch.tsx',
      'AssetTabs.tsx',
    ]
    const bad: string[] = []
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8')
      for (const m of src.matchAll(/(?<![A-Za-z])color=\{([^}]*)\}/g)) {
        const e = m[1]
        if (/disabled/.test(e)) continue // disabled controls are exempt (WCAG 1.4.3)
        if (
          /textTertiary|SEMANTIC_COLORS\.danger\b|RED_META\.token/.test(e) ||
          /^[\w.]*\.token$/.test(e.trim())
        )
          bad.push(`${f}: color={${e.trim()}}`)
      }
    }
    expect(bad).toEqual([])
  })
})
