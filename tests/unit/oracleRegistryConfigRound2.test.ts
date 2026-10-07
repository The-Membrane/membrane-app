// Config cards — ROUND-2 owner rulings (2026-10-06, #6–#11) and the defaults the owner did not
// object to. One test (or group) per item; each failed on the code before the change.
// Synthetic fixtures; real Ethereum DVN / endpoint addresses where identity matters.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'

import {
  configTabLabel,
  operatorLabels,
  tagChips,
  NO_WINDOW_TITLE,
} from '@/components/OracleRegistry/configViewModel'
import type { ConfigTabSummary } from '@/lib/oracleRegistry/config/apiTypes'
import { classifyAdminEvents, type AdminEventRow } from '@/lib/oracleRegistry/config/adminReplay'
import { kelpFraming } from '@/lib/oracleRegistry/config/backtest'
import { compareRoute } from '@/lib/oracleRegistry/config/bridgeRules'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import {
  multisigSubmissionChanges,
  timelockChanges,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  ADMIN_LEVEL_ROLES,
  GRANT_BURST_MAX,
  GRANT_BURST_WINDOW_BLOCKS,
  OWNER_INIT_WINDOW_BLOCKS,
  ROLE_NAMES,
  classifyParamChange,
  classifyRoleGrant,
  grantPattern,
  isPrivilegedRole,
  verificationRule,
  neutral,
} from '@/lib/oracleRegistry/config/rules'
import type { ConfigSubject, Controller, UlnConfigRaw } from '@/lib/oracleRegistry/config/types'
import {
  displayRoute,
  evaluateRoute,
  ISSUER_RUN_OPERATORS,
  mergeUln,
  normalizeOperator,
  securityOf,
  type DvnRegistry,
  type EvalCtx,
} from '@/lib/oracleRegistry/config/uln'
import {
  compareValueAtRisk,
  formatUsdCompact,
  valueAtRisk,
} from '@/lib/oracleRegistry/config/value'
import { buildConfigCard, countsOf } from '@/lib/oracleRegistry/config/view'
import { ROLE_HASHES } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import { readMultisigSubmissions } from '@/scripts/oracle-registry/config/lib/admin.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const GG = '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc'
const HZ = '0x380275805876ff19055ea900cdb2b46a94ecf20d'
const M1 = '0x' + '1'.repeat(39) + 'a'
const MBANK = '0x' + '1'.repeat(39) + 'b'
const USDT0 = '0x' + '1'.repeat(39) + 'c'
const UNKNOWN = '0x' + '1'.repeat(39) + 'd'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
const EP = '0x1a44076050125825900e736c501f859c50fe728c'
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const C = '0x00000000000000000000000000000000000000cc'
const Z = '0x' + '0'.repeat(40)
const MINTING = '0x' + '3'.repeat(40)
const POOL = '0x' + '5'.repeat(40)
const MS = '0x' + '7'.repeat(40)
const CTRL = '0x' + '8'.repeat(40)
const TL = '0x' + 'c'.repeat(40)
const MINTER_HASH = '0x' + '11'.repeat(32)

const registry: DvnRegistry = {
  byChain: {
    1: {
      [LZ]: { id: 'layerzero-labs', name: 'LZ' },
      [NM]: { id: 'nethermind', name: 'NM' },
      [GG]: { id: 'google-cloud', name: 'GG' },
      [HZ]: { id: 'horizen', name: 'HZ' },
      [M1]: { id: 'mantle01', name: 'Mantle 1' },
      [MBANK]: { id: 'mantle-bank', name: 'Mantle Bank' },
      [USDT0]: { id: 'usdt0', name: 'USDT0' },
    },
  },
  dead: { 1: [] },
  libraries: { 1: { send: [RECV], receive: [RECV], blocked: [], read: [] } },
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
const route = (cfg: UlnConfigRaw) =>
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
      config: mergeUln(cfg, undefined),
      defaultConfirmations: '15',
    },
    ctx,
  )
const eoa = (a: string): Controller => ({ kind: 'eoa', address: a })
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
  deployBlocks: { [MINTING]: 1, [POOL]: 1 },
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
  contracts: [MINTING, A, POOL, CTRL],
  oapps: [],
  verified: () => true,
  ...o,
})
const bot = (i: number) => '0x' + (0x1000 + i).toString(16).padStart(40, '0')
const botCtl: Record<string, Controller> = {}
for (let i = 0; i < 80; i++) botCtl[`${bot(i)}@head`] = eoa(bot(i))
const grant = (block: number, account: string, logIndex = 0, roleName = 'MINTER_ROLE') =>
  row({
    block,
    logIndex,
    tx: `0xn${block}_${logIndex}`,
    args: { role: MINTER_HASH, roleName, account },
  })

// =====================================================================================================
describe('round-2 ruling #6: a wider DVN set at the same threshold is AMBER', () => {
  it('4-of-4 → 2 required + 2-of-3 optional (E unchanged, more DVNs): amber, not red', () => {
    const v = compareRoute(route(uln([LZ, NM, GG, HZ])), route(uln([LZ, NM], [GG, HZ, M1], 2)))
    expect(v.severity).toBe('neutral')
    expect(v.floorBreach).toBe(false)
    expect(v.ruleIds).toEqual([])
    expect(v.tags).toContain('wider_dvn_set')
    expect(v.notes.join()).toMatch(/wider DVN set at the same threshold/)
    expect(tagChips(v.tags).find((t) => t.label === 'WIDER DVN SET')?.loud).toBe(true)
  })
  it('an optional set widened at an unchanged optional threshold is amber too (was red BR-8)', () => {
    const v = compareRoute(route(uln([LZ], [NM, GG], 1)), route(uln([LZ], [NM, GG, HZ], 1)))
    expect(v.severity).toBe('neutral')
    expect(v.tags).toContain('wider_dvn_set')
  })
  it('an UNKNOWN added DVN stays RED under the existing rule (BR-7)', () => {
    const v = compareRoute(route(uln([LZ, NM])), route(uln([LZ, NM], [GG, UNKNOWN], 1)))
    expect(v.severity).toBe('downgrade')
    expect(v.ruleIds).toContain('BR-7')
  })
  it('a same-size swap is still neutral with no amber tag', () => {
    const v = compareRoute(route(uln([LZ], [NM, GG], 1)), route(uln([LZ], [NM, HZ], 1)))
    expect(v.tags).not.toContain('wider_dvn_set')
  })
})

describe('round-2 ruling #7: a first owner set from address(0) long after deployment is RED', () => {
  const ownerSet = (block: number) =>
    classifyAdminEvents(
      [
        row({
          event: 'OwnershipTransferred',
          emitter: MINTING,
          block,
          args: { previousOwner: Z, newOwner: B },
        }),
      ],
      actx({ [`${B}@${block}`]: { kind: 'safe', address: B, threshold: 3, signers: 5 } }),
    )[0]
  it(`the window is ${OWNER_INIT_WINDOW_BLOCKS} blocks`, () => {
    expect(OWNER_INIT_WINDOW_BLOCKS).toBe(7200)
  })
  it('within 7,200 blocks of the deploy block: neutral initialization', () => {
    const c = ownerSet(1 + 7200)
    expect(c.red).toBe(false)
    expect(c.tags).toContain('initialization')
  })
  it('more than 7,200 blocks after: RED (a front-run initialize()), even to a Safe', () => {
    const c = ownerSet(1 + 7201)
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-3')
    expect(c.notes?.join()).toMatch(/7,201 blocks after deployment/)
    expect(c.notes?.join()).toMatch(/initialize\(\) could have been front-run/)
  })
  it('an unknown deploy block fails closed (red, says why)', () => {
    const c = classifyAdminEvents(
      [
        row({
          event: 'OwnershipTransferred',
          emitter: C,
          block: 50,
          args: { previousOwner: Z, newOwner: B },
        }),
      ],
      actx({ [`${B}@50`]: { kind: 'safe', address: B, threshold: 3, signers: 5 } }),
    )[0]
    expect(c.red).toBe(true)
    expect(c.notes?.join()).toMatch(/deploy block unknown/)
  })
})

describe('round-2 rulings #8 / #10 / #11: role grants', () => {
  it('#11 config / oracle / asset / limit roles are ADMIN-LEVEL: MANAGER is never operational', () => {
    for (const r of ['MANAGER', 'MANAGER_ROLE', 'ADMIN_ROLE', 'BYPASSER_ROLE'])
      expect(ADMIN_LEVEL_ROLES.has(r)).toBe(true)
    const p = grantPattern('MANAGER', eoa(B), 2_000_000, [
      { block: 1, account: A, noCode: true },
      { block: 60_000, account: C, noCode: true },
      { block: 120_000, account: A, noCode: true },
    ])
    expect(p.anomalies.join()).toMatch(/MANAGER is an admin-level role/)
  })

  it('#11 replay: the rsETH-like MANAGER grant to an EOA after 3 earlier EOA grants reads RED', () => {
    const out = classifyAdminEvents(
      [
        grant(18_759_558, bot(0), 0, 'MANAGER'),
        grant(18_813_718, bot(1), 0, 'MANAGER'),
        grant(18_813_732, bot(2), 0, 'MANAGER'),
        grant(18_813_732, bot(3), 1, 'MANAGER'),
      ],
      actx(botCtl),
    )
    const last = out.at(-1)!
    expect(last.red).toBe(true)
    expect(last.tags).not.toContain('operational')
    expect(last.tags).toContain('anomaly')
  })

  it('#8 UNRECOGNISED roles are PRIVILEGED: a grant to a wallet is red; a recognised harmless role is not', () => {
    const UNK = '0x' + 'ab'.repeat(32)
    expect(isPrivilegedRole(UNK)).toBe(true)
    expect(isPrivilegedRole('GUARDIAN')).toBe(true) // a name with no known powers
    expect(isPrivilegedRole('PAUSER_ROLE')).toBe(false)
    expect(isPrivilegedRole('FULL_RESTRICTED_STAKER_ROLE')).toBe(false)
    const v = classifyRoleGrant(UNK, eoa(B), [], true)
    expect(v.ruleIds).toEqual(['AD-4'])
    expect(v.notes.join()).toMatch(/not a recognised role: judged privileged/)
    expect(classifyRoleGrant('PAUSER_ROLE', eoa(B), [], true).severity).toBe('neutral')
    // an unrecognised role never reads operational, however many bot grants preceded it
    const p = grantPattern(
      UNK,
      eoa(B),
      2_000_000,
      [1, 60_000, 120_000].map((b) => ({ block: b, account: A, noCode: true })),
    )
    expect(p.anomalies.join()).toMatch(/not a recognised role/)
  })

  it('#8 the named roles exist in BOTH the collector naming table and the rules (BYPASSER_ROLE / ADMIN_ROLE on WBTC’s CCIP timelock)', () => {
    const named = new Set(Object.values(ROLE_HASHES as Record<string, string>))
    for (const n of ROLE_NAMES) expect(named.has(n)).toBe(true)
    for (const n of ['ADMIN_ROLE', 'BYPASSER_ROLE', 'WHITELISTED_EXECUTOR_ROLE'])
      expect(ADMIN_LEVEL_ROLES.has(n)).toBe(true)
  })

  it('#8 a grantee with code stays RED (the rsETH deposit-pool MINTER grant on LRTConfig)', () => {
    const history = [0, 1, 2].map((i) => grant(1_000_000 + i * 50_400, bot(i)))
    const out = classifyAdminEvents(
      [...history, grant(1_300_000, C)],
      actx({ ...botCtl, [`${C}@1300000`]: { kind: 'contract', address: C } }),
    )
    expect(out.at(-1)!.red).toBe(true)
    expect(out.at(-1)!.notes?.join()).toMatch(/grantee has code/)
  })

  describe('#10 BURST revised: red only when a one-day batch is LARGER than the largest earlier one-day batch', () => {
    const batch = (start: number, n: number, from: number) =>
      Array.from({ length: n }, (_, k) => grant(start, bot(from + k), k))
    it('Ethena-like: the first 20-key batch has no history (fallback > 3 per day); the routine 20-key rotations after it read AMBER operational', () => {
      const out = classifyAdminEvents(
        [...batch(1_000_000, 20, 0), ...batch(1_600_000, 20, 20), ...batch(2_200_000, 20, 40)],
        actx(botCtl),
      )
      const first = out.slice(0, 20)
      // 1–3: no pattern yet (red as before); 4–20: pattern but > 3 per day with no earlier batch
      expect(first.every((c) => c.red)).toBe(true)
      expect(first[3].notes?.join()).toMatch(/no earlier one-day batch: more than 3/)
      const rotations = out.slice(20)
      expect(rotations.every((c) => !c.red && c.tags.includes('operational'))).toBe(true)
    })
    it('a batch one larger than the largest earlier one-day batch: only the grant past it is RED', () => {
      const out = classifyAdminEvents(
        [...batch(1_000_000, 5, 0), ...batch(1_600_000, 5, 5), ...batch(2_200_000, 6, 10)],
        actx(botCtl),
      )
      const last = out.slice(10)
      expect(last.map((c) => c.red)).toEqual([false, false, false, false, false, true])
      expect(last[5].notes?.join()).toMatch(
        /one-day batch of 6 grants is larger than the largest earlier one-day batch \(5\)/,
      )
    })
    it(`with history of single grants, a second grant in one day is a larger batch (RED); the ${GRANT_BURST_MAX}-per-${GRANT_BURST_WINDOW_BLOCKS} fallback applies only with no earlier batch`, () => {
      const singles = [0, 1, 2].map((i) => grant(1_000_000 + i * 50_400, bot(i)))
      const out = classifyAdminEvents(
        [...singles, grant(1_300_000, bot(3)), grant(1_300_010, bot(4), 1)],
        actx(botCtl),
      )
      expect(out.at(-2)!.red).toBe(false) // a batch of 1 = the largest earlier batch
      expect(out.at(-1)!.red).toBe(true) // a batch of 2 > 1
    })
  })
})

describe('round-2 ruling #9: severity rank of floor breaches by value at risk (USD)', () => {
  it('value at risk = max(Ethereum adapter locked balance, remote bridged supply), priced in USD', () => {
    const v = valueAtRisk({
      locked: { raw: '100000000000000000000000', decimals: 18 }, // 100,000
      remoteSupply: { raw: '2500000000000000000000', decimals: 18 }, // 2,500
      priceUsd: 3000,
      priceBasis: 'ETH consensus',
    })
    expect(v.usd).toBe(300_000_000)
    expect(v.basis).toBe('locked')
    expect(v.lockedUsd).toBe(300_000_000)
    expect(v.remoteSupplyUsd).toBe(7_500_000)
    expect(formatUsdCompact(v.usd!)).toBe('$300M')
    expect(formatUsdCompact(1_234_567_890)).toBe('$1.23B')
    expect(formatUsdCompact(12_400)).toBe('$12.4K')
    // the remote side alone still values the route; nothing priced ⇒ null, and it says why
    const r = valueAtRisk({
      locked: null,
      remoteSupply: { raw: '5', decimals: 0 },
      priceUsd: 2,
      priceBasis: 'x',
    })
    expect(r.usd).toBe(10)
    expect(r.basis).toBe('remote_supply')
    const none = valueAtRisk({ locked: null, remoteSupply: null, priceUsd: null, priceBasis: 'x' })
    expect(none.usd).toBeNull()
    expect(none.unread.join()).toMatch(/no price/)
  })

  it('sort: highest value first, unknown value last', () => {
    const mk = (usd: number | null) => ({
      usd,
      lockedUsd: usd,
      remoteSupplyUsd: null,
      basis: usd === null ? null : ('locked' as const),
      priceUsd: 1,
      priceBasis: 'x',
      unread: [],
    })
    const xs = [mk(5), mk(null), mk(50), mk(1)]
    expect([...xs].sort(compareValueAtRisk).map((x) => x.usd)).toEqual([50, 5, 1, null])
  })

  it('engine + card: every floor-breach route carries its value at risk, and breaches are sorted by it', () => {
    const EID2 = 30184
    const PEER2 = '0x000000000000000000000000' + 'd'.repeat(40)
    const head = (eid: number, peer: string) =>
      (['send', 'receive'] as const).map((direction) => ({
        oapp: OAPP,
        eid,
        direction,
        lib: RECV,
        libIsDefault: false,
        merged: uln([LZ]),
        app: uln([LZ]),
        peer,
      }))
    const out = build(
      subject(),
      rawOf({
        lz: {
          headRoutes: [...head(30110, PEER), ...head(EID2, PEER2)],
          value: {
            priceUsd: 2,
            priceBasis: 'test consensus',
            locked: { [OAPP]: { amount: { raw: '1000', decimals: 0 } } },
            remoteSupply: {
              [`${OAPP}|30110`]: { amount: { raw: '10', decimals: 0 } },
              [`${OAPP}|${EID2}`]: { amount: { raw: '5000', decimals: 0 } },
            },
          },
        },
      }),
    )
    const recv = (eid: number) =>
      out.state.items.find((i) => i.key === `bridge/lz/1/${OAPP}/${eid}/receive`)!
    expect(recv(30110).valueAtRisk?.usd).toBe(2000) // locked 1,000 × $2 > remote 10 × $2
    expect(recv(EID2).valueAtRisk?.usd).toBe(10_000) // remote 5,000 × $2
    const card = buildConfigCard({
      subject: subject(),
      state: out.state,
      changes: out.changes,
      queue: out.queue,
    })
    const floor = card.breaches.filter((b) => b.ruleId === 'BR-2')
    expect(floor.map((b) => b.valueAtRiskUsd)).toEqual([10_000, 10_000, 2000, 2000])
    expect(card.breaches[0].ruleId).toBe('BR-2') // floor breaches lead, worst first
    const rows = card.bridge.oapps[0].routes
    expect(rows[0].eid).toBe(EID2)
    expect(rows[0].valueAtRisk?.usd).toBe(10_000)
  })

  it('backtest copy states the severity rank by value at risk (no "not built yet")', () => {
    const crit = {
      redOnExploitedEidBeforeCutoff: { pass: true, count: 1, first: 'x', firstTs: 1_000_000 },
    } as unknown as Parameters<typeof kelpFraming>[0]
    const f = kelpFraming(
      crit,
      { exploitedEid: 30320, cutoffTs: 1_000_000 + 381 * 86400, evalBlock: 24_908_284 },
      {
        oappsWithOverrides: 1835,
        oappsWithLiveUnderFloor: 825,
        subject: { oapp: OAPP, liveUnderFloor: 24, rank: 4, ofOApps: 825 },
      },
      {
        usd: 300_000_000,
        basis: 'locked',
        rankByValue: 2,
        priced: 140,
        ofOApps: 825,
      },
    )
    expect(f.text).not.toMatch(/not built yet/)
    expect(f.text).toMatch(/\$300M/)
    expect(f.text).toMatch(/#2 of the 140 priced/)
    const doc = readFileSync(join(process.cwd(), 'docs/research/CONFIG-CARDS-DESIGN.md'), 'utf8')
    expect(doc).toMatch(/SEVERITY RANK/)
    expect(doc).not.toMatch(/it is \*\*not built yet\*\*/)
  })
})

describe('defaults the owner did not object to', () => {
  it('a second CCIP remote pool for an already-served chain is RED (strict BR-6 / CC-1); the first is not', () => {
    const SEL = '4949039107694359620'
    const ev = (block: number, event: string, args: Record<string, unknown>) =>
      row({ block, tx: `0x${block}`, emitter: POOL, event, args })
    const out = classifyAdminEvents(
      [
        ev(10, 'ChainAdded', { remoteChainSelector: SEL }),
        ev(10, 'RemotePoolAdded', { remoteChainSelector: SEL, remotePoolAddress: A }),
        ev(20, 'RemotePoolAdded', { remoteChainSelector: SEL, remotePoolAddress: B }),
        ev(30, 'RemotePoolRemoved', { remoteChainSelector: SEL, remotePoolAddress: A }),
        ev(30, 'RemotePoolRemoved', { remoteChainSelector: SEL, remotePoolAddress: B }),
        ev(40, 'RemotePoolAdded', { remoteChainSelector: SEL, remotePoolAddress: C }),
      ],
      actx({}),
    ).filter((c) => c.key === `bridge/ccip/${POOL}/${SEL}`)
    expect(out[0].red).toBe(false)
    expect(out[1].red).toBe(true)
    expect(out[1].ruleIds).toContain('CC-1')
    expect(out[1].notes?.join()).toMatch(/second remote pool for an already-served chain/)
    // removed both, then a new address: a re-point (strict) — red
    expect(out.at(-1)!.red).toBe(true)
  })

  it('a pending addRemotePool for a chain already served at head is RED', () => {
    const abi = parseAbi([
      'function addRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)',
    ])
    const data = encodeFunctionData({
      abi,
      functionName: 'addRemotePool',
      args: [4949039107694359620n, ('0x' + '00'.repeat(12) + 'e'.repeat(40)) as `0x${string}`],
    })
    const op: TimelockOp = {
      timelock: TL,
      id: '0x' + 'ab'.repeat(32),
      calls: [{ target: POOL, value: '0', data }],
      predecessor: '0x' + '0'.repeat(64),
      delaySec: 86400,
      scheduledBlock: 20,
      scheduledTx: '0xs',
      timestamp: 5000,
      predecessorDone: true,
      simulation: 'ok',
    }
    const served = timelockChanges(
      [op],
      qctx({ ccipRemotePools: () => ['0x' + '00'.repeat(12) + 'a'.repeat(40)] }),
      1000,
    )
    expect(served[0].red).toBe(true)
    expect(served[0].ruleIds).toContain('CC-1')
    const fresh = timelockChanges([op], qctx({ ccipRemotePools: () => [] }), 1000)
    expect(fresh[0].red).toBe(false)
    // head pools unread: fail closed
    expect(timelockChanges([op], qctx({ ccipRemotePools: () => null }), 1000)[0].red).toBe(true)
  })

  it("source verification fails closed, but 'lookup failed' renders distinctly from 'checked, not verified'", () => {
    const failed = verificationRule(neutral(), B, null)
    const notVerified = verificationRule(neutral(), B, false)
    expect(failed.severity).toBe('downgrade')
    expect(notVerified.severity).toBe('downgrade')
    expect(failed.tags).toContain('verification_unread')
    expect(failed.tags).not.toContain('unverified')
    expect(notVerified.tags).toContain('unverified')
    expect(notVerified.tags).not.toContain('verification_unread')
    const [a] = tagChips(['verification_unread'])
    const [b] = tagChips(['unverified'])
    expect(a.label).toBe('VERIFICATION LOOKUP FAILED')
    expect(b.label).toBe('NOT VERIFIED')
    // the same split on a rate provider swap
    const spec = {
      key: 'p',
      contract: A,
      sig: '',
      rule: 'rate_provider' as const,
      label: 'rate provider',
    }
    const p = classifyParamChange(
      spec,
      A,
      B,
      { kind: 'contract', address: B },
      { nextVerified: null },
    )
    expect(p.tags).toContain('verification_unread')
  })

  it('Mantle: mantle01-03, mantle-bank and mantlecross are ONE operator', () => {
    for (const id of ['mantle01', 'mantle02', 'mantle03', 'mantle-bank', 'mantlecross'])
      expect(normalizeOperator(id)).toBe('mantle')
    const s = securityOf(mergeUln(uln([M1, MBANK]), undefined), 1, 100, ctx)
    expect(s.E).toBe(1)
    expect(s.duplicateOperator.sort()).toEqual([M1, MBANK].sort())
  })

  it("issuer-run DVNs (fbtc, usdt0, ondo) count as independent but are labelled 'issuer-run'", () => {
    expect([...ISSUER_RUN_OPERATORS].sort()).toEqual(['fbtc', 'ondo', 'usdt0'])
    const r = route(uln([LZ, USDT0]))
    expect(r.Eeff).toBe(2) // independent: counts
    expect(r.security.issuerRun).toEqual(['usdt0'])
    expect(displayRoute(r)).toMatch(/usdt0 \(issuer-run\)/)
    expect(
      operatorLabels({ operators: ['layerzero-labs', 'usdt0'], issuerRun: ['usdt0'] }),
    ).toEqual(['layerzero-labs', 'usdt0 (issuer-run)'])
  })

  it('the tab never says "no red flags" when a read failed (partial data), not only for route sides', () => {
    const tab = (readGaps: number): ConfigTabSummary => ({
      subject: 'x',
      slug: 'x',
      symbol: 'X',
      label: 'X',
      oracleSlug: null,
      counts: { ...countsOf([], [], readGaps ? ['Safe Tx Service unavailable'] : []) },
      asOf: { block: 1, ts: 1_000_000 },
    })
    expect(configTabLabel(tab(0), 1_000_100)).toBe('config: no red flags')
    const partial = configTabLabel(tab(1), 1_000_100)
    expect(partial).not.toBe('config: no red flags')
    expect(partial).toMatch(/1 read failed — red flags may be missing/)
  })

  it('the engine lists failed reads (unresolved power holders, an unavailable Safe queue or multisig submissions) as read gaps', () => {
    const out = build(
      subject(),
      rawOf({
        admin: {
          powers: [{ power: 'mint', label: 'm', contract: CTRL, holders: [], error: 'reverted' }],
        },
        queues: {
          safeStatus: [{ safe: A, status: 'unavailable', note: '429' }],
          multisigStatus: [{ multisig: MS, status: 'unavailable', note: 'rpc' }],
        },
      }),
    )
    expect(out.state.readGaps?.length).toBe(3)
  })

  it('legacy MultiSigWallet: submitted-but-unexecuted transactions are PENDING (observable on-chain)', () => {
    const abi = parseAbi(['function transferOwnership(address newOwner)'])
    const data = encodeFunctionData({
      abi,
      functionName: 'transferOwnership',
      args: [B as `0x${string}`],
    })
    const q = qctx({
      ctl: (a) =>
        a === B
          ? eoa(B)
          : a === MS
            ? { kind: 'legacy_multisig', address: MS, threshold: 6, signers: 10 }
            : null,
      ownerOf: (c) => (c === CTRL ? MS : null),
      safes: [MS],
    })
    const out = multisigSubmissionChanges(
      [
        {
          multisig: MS,
          txId: 41,
          destination: CTRL,
          value: '0',
          data,
          confirmations: 2,
          required: 6,
          executed: false,
          block: 900,
          ts: 1900,
        },
        {
          multisig: MS,
          txId: 42,
          destination: CTRL,
          value: '0',
          data,
          confirmations: 6,
          required: 6,
          executed: false,
        },
      ],
      q,
    )
    expect(out[0].state).toBe('pending')
    expect(out[0].stage).toBe('submitted')
    expect(out[0].queue).toEqual({ kind: 'legacy_multisig', address: MS, opId: '41' })
    expect(out[0].red).toBe(true) // AD-3: owner → EOA
    expect(out[0].notes?.join()).toMatch(/2\/6 confirmations/)
    // fully confirmed but not executed (execution failed): anyone of the owners can execute it now
    expect(out[1].stage).toBe('armed')
  })

  it('the MultiSigWallet reader asks for exactly the pending count (getTransactionIds pads the tail with id 0 otherwise)', async () => {
    // Gnosis MultiSigWallet: tx 0 and 2 executed, 1 and 3 pending; getTransactionIds(from, to)
    // slices the FILTERED list and pads past its end with 0 (the trap: `to` = transactionCount)
    const txs = [
      { executed: true, conf: 6 },
      { executed: false, conf: 2 },
      { executed: true, conf: 6 },
      { executed: false, conf: 1 },
    ]
    const pendingIds = txs.flatMap((t, i) => (t.executed ? [] : [BigInt(i)]))
    const client = {
      readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        switch (functionName) {
          case 'required':
            return 6n
          case 'transactionCount':
            return BigInt(txs.length)
          case 'getTransactionCount':
            return BigInt(pendingIds.length)
          case 'getTransactionIds': {
            const [from, to] = args as [bigint, bigint]
            return Array.from(
              { length: Number(to - from) },
              (_, k) => pendingIds[Number(from) + k] ?? 0n,
            )
          }
          case 'transactions': {
            const t = txs[Number(args[0] as bigint)]
            return [CTRL, 0n, '0x4e71e0c8', t.executed]
          }
          case 'getConfirmationCount':
            return BigInt(txs[Number(args[0] as bigint)].conf)
        }
        throw new Error(`unexpected ${functionName}`)
      },
    }
    const r = await readMultisigSubmissions(client, MS)
    expect(r.status).toBe('ok')
    expect(r.rows.map((x: { txId: number }) => x.txId)).toEqual([1, 3])
    expect(r.rows.every((x: { executed: boolean }) => !x.executed)).toBe(true)
  })

  it("pending observable: a legacy multisig whose submissions were read is observable; a no-delay owner CONTRACT is 'no pending window · INSTANT'", () => {
    const powers = [
      { power: 'mint' as const, label: 'mint', contract: CTRL, holders: [CTRL] },
      { power: 'bridge_config' as const, label: 'oft owner', contract: OAPP, holders: [C] },
    ]
    const controllers = {
      [`${CTRL}@head`]: {
        kind: 'contract' as const,
        address: CTRL,
        ownedBy: { kind: 'legacy_multisig' as const, address: MS, threshold: 6, signers: 10 },
      },
      [`${C}@head`]: { kind: 'contract' as const, address: C },
    }
    const read = build(
      subject(),
      rawOf({
        admin: { powers, controllers },
        queues: { multisig: [], multisigStatus: [{ multisig: MS, status: 'ok' }] },
      }),
    )
    expect(read.state.powers[0].pendingObservable).toBe(true)
    expect(read.state.powers[0].pendingNote).toMatch(/submitted, unexecuted multisig transactions/)
    // a plain owner contract with no delay (BitGo WalletSimple-like): no pending window, instant
    expect(read.state.powers[1].effectiveDelaySec).toBe(0)
    expect(read.state.powers[1].pendingObservable).toBe(false)
    const item = read.state.items.find((i) => i.key === `admin/power/bridge_config/${OAPP}`)!
    expect(item.display).toMatch(/no pending window · INSTANT/)
    expect(NO_WINDOW_TITLE).toMatch(/a contract with no delay/)
    // the multisig's submissions not read: fail closed (not observable)
    const unread = build(subject(), rawOf({ admin: { powers, controllers } }))
    expect(unread.state.powers[0].pendingObservable).toBe(false)
  })
})
