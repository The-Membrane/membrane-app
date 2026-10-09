// Config-card rules (lib/oracleRegistry/config): one positive and one negative case per rule ID,
// the ULN merge / operator arithmetic the rules stand on, the event replay, and the pending /
// proposed queue judge. Fixtures are synthetic but use real Ethereum DVN addresses so operator
// identity comes from the same registry shape as LZ metadata.

import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'

import type {
  Controller,
  ParamSpec,
  RouteState,
  UlnConfigRaw,
} from '@/lib/oracleRegistry/config/types'
import { compareRoute, routeBreaches } from '@/lib/oracleRegistry/config/bridgeRules'
import { replayLz, type LzEvent } from '@/lib/oracleRegistry/config/lzReplay'
import {
  classifyAdminEvents,
  classifyDvnSignerChanges,
  classifyParamTransitions,
  type AdminEventRow,
} from '@/lib/oracleRegistry/config/adminReplay'
import {
  RULES,
  classifyCcip,
  classifyControllerChange,
  classifyDelayChange,
  classifyDvnSignerChange,
  classifyMultisigChange,
  classifyOracleParam,
  classifyParamChange,
  classifyPauserChange,
  classifyRoleGrant,
  classifySafeModuleChange,
  controllerRank,
  compareRank,
  formatDelay,
  isRed,
  timelockAdminBreach,
} from '@/lib/oracleRegistry/config/rules'
import {
  callIsForSubject,
  decodeMultiSend,
  judgeCall,
  opStatus,
  safeProposalChanges,
  timelockChanges,
  unwrapCalls,
  type QueueCtx,
  type TimelockOp,
} from '@/lib/oracleRegistry/config/queue'
import {
  NIL_CONFIRMATIONS,
  evaluateRoute,
  mergeUln,
  normalizeOperator,
  securityOf,
  type DvnRegistry,
  type EvalCtx,
} from '@/lib/oracleRegistry/config/uln'

// ---- fixtures -------------------------------------------------------------------------------------
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'
const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
const GG = '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc'
const HZ = '0x380275805876ff19055ea900cdb2b46a94ecf20d'
const CAN = '0xa4fe5a5b9a846458a70cd0748228aed3bf65c2cd'
const CAN_SUB = '0x8bd47cbd47980cc6f3f8451fa7586548014b10db'
const DEAD = '0x747c741496a507e4b404b50463e691a8d692f6ac'
const PLACEHOLDER = '0x000000000000000000000000000000000000dead'
const ROGUE = '0x1111111111111111111111111111111111111111'
const ROGUE2 = '0x2222222222222222222222222222222222222222'
const NOCODE = '0xa09db5142654e3eb5cf547d66833fae7097b21c3'
const SEND = '0xbb2ea70c9e858123480642cf96acbcce1372dce1'
const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
// a second allowlisted receive library (the previous ULN version during a library switch)
const RECV_OLD = '0x6666666666666666666666666666666666666666'
const BLOCKED = '0x1ccbf0db9c192d969de57e25b3ff09a25bb1d862'
const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const PEER = '0x000000000000000000000000c3eacf0612346366db554c991d7858716db09f58'
const PEER2 = '0x0000000000000000000000004444444444444444444444444444444444444444'

const registry: DvnRegistry = {
  byChain: {
    1: {
      [LZ]: { id: 'layerzero-labs', name: 'LayerZero Labs' },
      [NM]: { id: 'nethermind', name: 'Nethermind' },
      [GG]: { id: 'google-cloud', name: 'Google' },
      [HZ]: { id: 'horizen-labs', name: 'Horizen' },
      [CAN]: { id: 'canary', name: 'Canary' },
      [CAN_SUB]: { id: 'canary-subsidized', name: 'Canary Subsidized' },
      [DEAD]: { id: 'lz-dead-dvn', name: 'LZDeadDVN', deprecated: true },
      [NOCODE]: { id: 'layerzero-labs', name: 'LayerZero Labs (Manta address)' },
    },
  },
  dead: { 1: [DEAD] },
  libraries: { 1: { send: [SEND], receive: [RECV, RECV_OLD], blocked: [BLOCKED], read: [] } },
}
const code = (_c: number, a: string) => (a === NOCODE || a === PLACEHOLDER ? false : true)
const ctx: EvalCtx = { registry, code, useDeprecated: false }

const uln = (req: string[], opt: string[] = [], t = 0, conf = '15'): UlnConfigRaw => ({
  confirmations: conf,
  requiredDVNCount: req.length,
  optionalDVNCount: opt.length,
  optionalDVNThreshold: t,
  requiredDVNs: req,
  optionalDVNs: opt,
})
const route = (
  cfg: UlnConfigRaw,
  o: Partial<{
    peer: string
    lib: string
    direction: 'send' | 'receive'
    def: UlnConfigRaw
    grace: { lib: string; expiry: number; config: UlnConfigRaw }
    block: number
    defaultConfirmations: string
  }> = {},
): RouteState =>
  evaluateRoute(
    {
      chainId: 1,
      oapp: OAPP,
      eid: 30320,
      direction: o.direction ?? 'receive',
      block: o.block ?? 100,
      peer: o.peer ?? PEER,
      lib: o.lib ?? RECV,
      libIsDefault: false,
      config: mergeUln(cfg, o.def),
      grace: o.grace
        ? { lib: o.grace.lib, expiry: o.grace.expiry, config: mergeUln(o.grace.config, undefined) }
        : undefined,
      defaultConfirmations: o.defaultConfirmations,
    },
    ctx,
  )

const safe = (addr: string, threshold: number, signers: number): Controller => ({
  kind: 'safe',
  address: addr,
  threshold,
  signers,
})
const eoa = (addr: string): Controller => ({ kind: 'eoa', address: addr })
// Owner ruling 2026-10-08 (#12): a timelock ranks as its weakest proposer, then its delay
// credit. The fixture's default proposer is a governance Safe 7-of-12, so a timelock here outranks
// the smaller Safes these tests compare it with — as the tests assumed before the ruling.
const GOV_SAFE: Controller = {
  kind: 'safe',
  address: '0x00000000000000000000000000000000000000c0',
  threshold: 7,
  signers: 12,
}
const timelock = (addr: string, delaySec: number, proposer: Controller = GOV_SAFE): Controller => ({
  kind: 'oz_timelock',
  address: addr,
  delaySec,
  schedulers: [proposer],
})

// ---- ULN merge and E ----------------------------------------------------------------------------------
describe('ULN merge (UlnBase.getUlnConfig semantics)', () => {
  it('inherits 0 fields from the default and treats NIL as explicitly none / zero', () => {
    const def = uln([LZ, GG], [], 0, '20')
    const inherit = mergeUln(uln([], [], 0, '0'), def)
    expect(inherit.required).toEqual([LZ, GG])
    expect(inherit.confirmations).toBe('20')
    expect(inherit.source).toBe('default')
    const nilConf = mergeUln({ ...uln([LZ]), confirmations: NIL_CONFIRMATIONS.toString() }, def)
    expect(nilConf.confirmations).toBe('0')
    expect(nilConf.zeroConfirmations).toBe(true)
    const nilReq = mergeUln({ ...uln([], [NM, GG], 1, '0'), requiredDVNCount: 255 }, def)
    expect(nilReq.required).toEqual([])
    expect(nilReq.source).toBe('mixed')
    expect(mergeUln(uln([]), undefined).noDvn).toBe(true)
  })

  it('counts distinct KNOWN operators: dedupe, operator folding, unknown and no-code DVNs add nothing', () => {
    expect(securityOf(mergeUln(uln([LZ, NM]), undefined), 1, 100, ctx).E).toBe(2)
    // the same DVN in required and optional counts once
    expect(securityOf(mergeUln(uln([LZ], [LZ, NM], 1), undefined), 1, 100, ctx).E).toBe(1)
    // canary + canary-subsidized are one operator
    const fold = securityOf(mergeUln(uln([CAN, CAN_SUB]), undefined), 1, 100, ctx)
    expect(fold.E).toBe(1)
    expect(fold.duplicateOperator.sort()).toEqual([CAN, CAN_SUB].sort())
    expect(normalizeOperator('canary-wbtc')).toBe('canary')
    expect(normalizeOperator('mantle02')).toBe('mantle')
    // an attacker-deployed DVN is free to the attacker
    expect(securityOf(mergeUln(uln([LZ, ROGUE]), undefined), 1, 100, ctx).E).toBe(1)
    // optional picks take the cheapest operators first
    expect(securityOf(mergeUln(uln([LZ], [ROGUE, NM, GG], 2), undefined), 1, 100, ctx).E).toBe(2)
  })

  it('a dead DVN (LZDeadDVN or the launch-era 0x…dead placeholder) blocks the route', () => {
    expect(securityOf(mergeUln(uln([DEAD]), undefined), 1, 100, ctx).blockedReason).toBe('dead_dvn')
    const p = route(uln([PLACEHOLDER]))
    expect(p.live).toBe(false)
    expect(p.security.noCode).toEqual([])
    expect(route(uln([LZ]), { lib: BLOCKED }).security.blockedReason).toBe('blocked_library')
  })

  it('during a receive grace period the old library also verifies: E is the minimum', () => {
    const r = route(uln([LZ, NM, GG]), {
      grace: { lib: RECV_OLD, expiry: 200, config: uln([LZ]) },
      block: 150,
    })
    expect(r.Eeff).toBe(1)
    expect(
      route(uln([LZ, NM, GG]), {
        grace: { lib: RECV_OLD, expiry: 200, config: uln([LZ]) },
        block: 250,
      }).Eeff,
    ).toBe(3)
  })
})

// ---- bridge rules ----------------------------------------------------------------------------------
describe('bridge rules BR-1..BR-9', () => {
  it('BR-1: E drop on the effective config (an override replacing an inherited 2-of-2)', () => {
    const before = route(uln([]), { def: uln([LZ, GG]) })
    const after = route(uln([LZ]), { def: uln([LZ, GG]) })
    expect(compareRoute(before, after).ruleIds).toContain('BR-1')
    expect(compareRoute(after, before).severity).toBe('upgrade')
  })

  it('BR-2: a live route under 2 operators is red at creation, a 2-of-2 route is not', () => {
    const created = compareRoute(route(uln([DEAD])), route(uln([LZ])))
    expect(created.floorBreach).toBe(true)
    expect(created.ruleIds).toContain('BR-2')
    expect(isRed(created)).toBe(true)
    expect(compareRoute(route(uln([DEAD])), route(uln([LZ, NM]))).floorBreach).toBe(false)
    expect(routeBreaches(route(uln([LZ]))).map((b) => b.ruleId)).toContain('BR-2')
    // not live (peer 0) ⇒ no floor breach
    expect(routeBreaches(route(uln([LZ]), { peer: '0x' + '0'.repeat(64) }))).toEqual([])
  })

  it('BR-3: confirmations to ZERO (uint64-max NIL) or below the pathway default are red; above it they are not', () => {
    const nil = route({ ...uln([LZ, NM]), confirmations: NIL_CONFIRMATIONS.toString() })
    expect(compareRoute(route(uln([LZ, NM], [], 0, '64')), nil).ruleIds).toContain('BR-3')
    expect(
      compareRoute(
        route(uln([LZ, NM], [], 0, '64'), { defaultConfirmations: '15' }),
        route(uln([LZ, NM], [], 0, '5'), { defaultConfirmations: '15' }),
      ).ruleIds,
    ).toContain('BR-3')
    const above = compareRoute(
      route(uln([LZ, NM], [], 0, '1000000'), { defaultConfirmations: '30000' }),
      route(uln([LZ, NM], [], 0, '30000'), { defaultConfirmations: '30000' }),
    )
    expect(above.ruleIds).not.toContain('BR-3')
    expect(above.notes.join()).toMatch(/pathway default/)
  })

  it('BR-4: a DVN without code on the local chain (also parked in a closed route)', () => {
    expect(compareRoute(route(uln([LZ, NM])), route(uln([LZ, NM], [NOCODE], 1))).ruleIds).toContain(
      'BR-4',
    )
    const parked = compareRoute(
      route(uln([PLACEHOLDER])),
      route(uln([PLACEHOLDER], [NM, NOCODE], 2)),
    )
    expect(parked.ruleIds).toContain('BR-4')
    expect(parked.floorBreach).toBe(false)
    expect(compareRoute(route(uln([LZ])), route(uln([LZ, NM]))).ruleIds).not.toContain('BR-4')
  })

  it('BR-5: a library outside the LZ deployment allowlist; BlockedMessageLib is neutral', () => {
    expect(
      compareRoute(route(uln([LZ, NM])), route(uln([LZ, NM]), { lib: ROGUE })).ruleIds,
    ).toContain('BR-5')
    const blocked = compareRoute(route(uln([LZ, NM])), route(uln([LZ, NM]), { lib: BLOCKED }))
    expect(blocked.severity).toBe('neutral')
    expect(blocked.tags).toContain('blocked')
  })

  it('BR-6: a peer moved to another non-zero peer is red (strict); zeroing a peer is neutral', () => {
    expect(
      compareRoute(route(uln([LZ, NM])), route(uln([LZ, NM]), { peer: PEER2 })).ruleIds,
    ).toContain('BR-6')
    const zero = compareRoute(
      route(uln([LZ, NM])),
      route(uln([LZ, NM]), { peer: '0x' + '0'.repeat(64) }),
    )
    expect(zero.severity).toBe('neutral')
    expect(zero.tags).toContain('route_removed')
    // owner ruling 2026-10-06 (#3): STRICT — re-pointing a closed route is red too (the new
    // counterparty is trusted the moment the route reopens)
    expect(compareRoute(route(uln([DEAD])), route(uln([DEAD]), { peer: PEER2 })).ruleIds).toContain(
      'BR-6',
    )
  })

  it('BR-7: the attack the count misses — two reputable DVNs swapped for two rogue ones', () => {
    const v = compareRoute(route(uln([LZ, NM])), route(uln([ROGUE, ROGUE2])))
    expect(v.ruleIds).toEqual(expect.arrayContaining(['BR-7', 'BR-1']))
    // USDe-style swap Canary → Canary Subsidized at the same count: same operator, neutral
    const swap = compareRoute(
      route(uln([LZ, CAN], [HZ, NM, GG], 2)),
      route(uln([LZ, CAN_SUB], [HZ, NM, GG], 2)),
    )
    expect(swap.severity).toBe('neutral')
    expect(isRed(swap)).toBe(false)
  })

  it('BR-8 (owner ruling 2026-10-06 round 2 #6: AMBER): optional set widened at an unchanged threshold is tagged, not red; a swap at the same size is not tagged', () => {
    const wider = compareRoute(route(uln([LZ], [NM, GG], 1)), route(uln([LZ], [NM, GG, HZ], 1)))
    expect(wider.tags).toContain('wider_dvn_set')
    expect(isRed(wider)).toBe(false)
    expect(
      compareRoute(route(uln([LZ], [NM, GG], 1)), route(uln([LZ], [NM, HZ], 1))).tags,
    ).not.toContain('wider_dvn_set')
  })

  it('BR-9: a flip A → B → A between snapshots, and a dip inside one transaction', () => {
    const base = { chainId: 1, tx: '0xa', logIndex: 0 }
    const ev = (block: number, tx: string, logIndex: number, config: UlnConfigRaw): LzEvent => ({
      ...base,
      block,
      tx,
      logIndex,
      kind: 'uln',
      lib: RECV,
      oapp: OAPP,
      eid: 30320,
      config,
    })
    const setup: LzEvent[] = [
      { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30320, lib: RECV },
      {
        ...base,
        block: 1,
        tx: '0x1',
        logIndex: 1,
        kind: 'default_send_lib',
        eid: 30320,
        lib: SEND,
      },
      { ...base, block: 2, tx: '0x2', kind: 'peer', oapp: OAPP, eid: 30320, peer: PEER },
      ev(3, '0x3', 0, uln([LZ, NM])),
    ]
    const cross = replayLz(
      [...setup, ev(10, '0x4', 0, uln([LZ])), ev(20, '0x5', 0, uln([LZ, NM]))],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const down = cross.changes.find((c) => c.tx === '0x4' && c.route?.direction === 'receive')!
    expect(down.ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-9']))
    expect(down.tags).toContain('flash')
    const intra = replayLz(
      [...setup, ev(10, '0x6', 0, uln([LZ])), ev(10, '0x6', 1, uln([LZ, NM]))],
      { subject: 't', oapps: [OAPP], ctx },
    )
    // set 1-of-1 and revert inside one transaction: no net change, still a red change
    const flip = intra.changes.find((c) => c.tx === '0x6' && c.route?.direction === 'receive')!
    expect(flip.ruleIds).toContain('BR-9')
    expect(flip.red).toBe(true)
    const intra2 = replayLz(
      [...setup, ev(10, '0x7', 0, uln([LZ])), ev(10, '0x7', 1, uln([LZ, NM], [], 0, '20'))],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = intra2.changes.find((x) => x.tx === '0x7' && x.route?.direction === 'receive')!
    expect(c.ruleIds).toContain('BR-9')
    const slow = replayLz(
      [...setup, ev(10, '0x4', 0, uln([LZ])), ev(10 + 8000, '0x5', 0, uln([LZ, NM]))],
      { subject: 't', oapps: [OAPP], ctx },
    )
    expect(
      slow.changes.find((x) => x.tx === '0x4' && x.route?.direction === 'receive')!.ruleIds,
    ).not.toContain('BR-9')
  })
})

describe('event replay', () => {
  const base = { chainId: 1, logIndex: 0 }
  it('a DefaultUlnConfigsSet that lowers E is a change on every route inheriting it, tagged default_change', () => {
    const evs: LzEvent[] = [
      { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30110, lib: RECV },
      {
        ...base,
        block: 1,
        tx: '0x1',
        logIndex: 1,
        kind: 'uln_default',
        lib: RECV,
        eid: 30110,
        config: uln([LZ, GG]),
      },
      { ...base, block: 2, tx: '0x2', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
      {
        ...base,
        block: 3,
        tx: '0x3',
        kind: 'uln_default',
        lib: RECV,
        eid: 30110,
        config: uln([LZ]),
      },
    ]
    const r = replayLz(evs, { subject: 't', oapps: [OAPP], ctx })
    const c = r.changes.find((x) => x.tx === '0x3' && x.route?.direction === 'receive')!
    expect(c.ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-2']))
    expect(c.tags).toContain('default_change')
  })

  it('switching the receive library drops an override stored on the old library (keyed by lib)', () => {
    const OTHER = '0x3333333333333333333333333333333333333333'
    const reg2: DvnRegistry = {
      ...registry,
      libraries: { 1: { send: [SEND], receive: [RECV, OTHER], blocked: [BLOCKED], read: [] } },
    }
    const evs: LzEvent[] = [
      { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30110, lib: RECV },
      {
        ...base,
        block: 1,
        tx: '0x1',
        logIndex: 1,
        kind: 'uln_default',
        lib: OTHER,
        eid: 30110,
        config: uln([LZ]),
      },
      { ...base, block: 2, tx: '0x2', kind: 'peer', oapp: OAPP, eid: 30110, peer: PEER },
      {
        ...base,
        block: 3,
        tx: '0x3',
        kind: 'uln',
        lib: RECV,
        oapp: OAPP,
        eid: 30110,
        config: uln([LZ, NM, GG]),
      },
      { ...base, block: 4, tx: '0x4', kind: 'default_recv_lib', eid: 30110, lib: OTHER },
    ]
    const r = replayLz(evs, { subject: 't', oapps: [OAPP], ctx: { ...ctx, registry: reg2 } })
    const c = r.changes.find((x) => x.tx === '0x4' && x.route?.direction === 'receive')!
    expect(c.ruleIds).toContain('BR-1')
    expect(r.routes.find((x) => x.direction === 'receive')!.Eeff).toBe(1)
  })
})

// ---- admin ----------------------------------------------------------------------------------------
describe('admin rules AD-1..AD-9', () => {
  const A = '0x00000000000000000000000000000000000000aa'
  const B = '0x00000000000000000000000000000000000000bb'
  it('ranks: immutable > Safe (threshold, then FEWER signers) > contract > EOA; a timelock = its weakest proposer + delay credit', () => {
    // ruling #12: a 1-day timelock proposed by a Safe 6-of-10 outranks that Safe (credit ≥ 24 h)
    expect(
      compareRank(
        controllerRank(timelock(A, 86400, safe(B, 6, 10))),
        controllerRank(safe(B, 6, 10)),
      ),
    ).toBe(1)
    // … a 10-day timelock an EOA proposes into does not outrank a Safe 6-of-10
    expect(
      compareRank(controllerRank(timelock(A, 864000, eoa(B))), controllerRank(safe(B, 6, 10))),
    ).toBe(-1)
    expect(compareRank(controllerRank(safe(A, 6, 10)), controllerRank(safe(B, 6, 11)))).toBe(1)
    expect(
      compareRank(controllerRank({ kind: 'contract', address: A }), controllerRank(eoa(B))),
    ).toBe(1)
    expect(formatDelay(0)).toBe('INSTANT')
  })

  it('AD-1: threshold drop or a signer added at the same threshold; a signer removed is not a downgrade', () => {
    expect(classifyMultisigChange(safe(A, 8, 13), safe(A, 6, 10)).ruleIds).toContain('AD-1')
    expect(classifyMultisigChange(safe(A, 6, 10), safe(A, 6, 11)).ruleIds).toContain('AD-1')
    expect(classifyMultisigChange(safe(A, 6, 11), safe(A, 6, 10)).severity).toBe('upgrade')
  })

  it('AD-2: delay shortened is red; lengthened is an upgrade', () => {
    expect(classifyDelayChange(864000, 172800).ruleIds).toContain('AD-2')
    expect(classifyDelayChange(180, 864000).severity).toBe('upgrade')
  })

  it('AD-3: WBTC Controller owner 8-of-13 → 6-of-10 is red; cbBTC EOA → EOA is neutral rotation', () => {
    const w = classifyControllerChange(
      { kind: 'legacy_multisig', address: A, threshold: 8, signers: 13 },
      { kind: 'legacy_multisig', address: B, threshold: 6, signers: 10 },
    )
    expect(w.ruleIds).toContain('AD-3')
    expect(isRed(w)).toBe(true)
    const cb = classifyControllerChange(eoa(A), eoa(B))
    expect(cb.severity).toBe('neutral')
    expect(cb.tags).toContain('rotation')
    expect(classifyControllerChange(safe(A, 5, 10), timelock(B, 86400)).severity).toBe('upgrade')
  })

  it('AD-4: privileged role to an EOA or to an account weaker than the holders; EXECUTOR to address(0) is neutral', () => {
    expect(
      classifyRoleGrant('DEFAULT_ADMIN_ROLE', eoa(A), [timelock(B, 86400)], true).ruleIds,
    ).toContain('AD-4')
    expect(
      classifyRoleGrant('DEFAULT_ADMIN_ROLE', safe(A, 3, 5), [timelock(B, 86400)], true).ruleIds,
    ).toContain('AD-4')
    expect(
      classifyRoleGrant('EXECUTOR_ROLE', { kind: 'zero', address: '0x' + '0'.repeat(40) }, [], true)
        .severity,
    ).toBe('neutral')
    expect(
      classifyRoleGrant('DEFAULT_ADMIN_ROLE', timelock(A, 864000), [safe(B, 5, 10)], true).severity,
    ).toBe('neutral')
  })

  const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0xt',
    emitter: A,
    event: 'Upgraded',
    args: {},
    ...o,
  })
  const lookup = (m: Record<string, Controller>) => (a: string, b: number) =>
    m[`${a}@${b}`] ?? m[`${a}@head`] ?? null

  it('AD-5: an upgrade of a timelocked proxy with no CallExecuted from that timelock in the tx', () => {
    const TL = '0x00000000000000000000000000000000000000cc'
    const actx = {
      subject: 's',
      ctl: lookup({}),
      upgradeTimelocks: { [A]: [TL] },
      timelockSince: { [TL]: 50 },
      deployBlocks: {},
      tokens: [],
      announcement: 'no_gov_channel' as const,
    }
    const bypass = classifyAdminEvents([row({ args: { implementation: B } })], actx)
    expect(bypass[0].ruleIds).toContain('AD-5')
    const viaTl = classifyAdminEvents(
      [
        row({ args: { implementation: B } }),
        row({ emitter: TL, event: 'CallExecuted', logIndex: 1, args: {} }),
      ],
      actx,
    )
    expect(viaTl[0].ruleIds).not.toContain('AD-5')
    expect(viaTl[0].ruleIds).toContain('AD-9')
    expect(viaTl[0].tags).toContain('logic_change')
    // before the timelock held the power, an upgrade bypasses nothing
    expect(
      classifyAdminEvents([row({ block: 40, args: { implementation: B } })], actx)[0].ruleIds,
    ).not.toContain('AD-5')
  })

  it('AD-6: Safe module enabled / guard replaced is red; module disabled is not', () => {
    expect(classifySafeModuleChange('module_enabled', undefined, B).ruleIds).toContain('AD-6')
    expect(classifySafeModuleChange('guard', A, B).ruleIds).toContain('AD-6')
    expect(classifySafeModuleChange('guard', A, '0x' + '0'.repeat(40)).ruleIds).toContain('AD-6')
    // adding a guard where there was none only restricts
    expect(classifySafeModuleChange('guard', '0x' + '0'.repeat(40), B).severity).toBe('upgrade')
    expect(classifySafeModuleChange('module_disabled', A).severity).toBe('upgrade')
  })

  it('AD-7: timelock admin role held by anything but the timelock (a precompile is inert)', () => {
    const TL = '0x00000000000000000000000000000000000000cc'
    expect(timelockAdminBreach(TL, [timelock(TL, 172800), safe(A, 3, 5)])).toHaveLength(1)
    expect(
      timelockAdminBreach(TL, [
        timelock(TL, 172800),
        { kind: 'precompile', address: '0x0000000000000000000000000000000000000001' },
      ]),
    ).toHaveLength(0)
  })

  it('AD-1 / AD-3 / AD-4 from events: Safe owner added at the same threshold, ownership to an EOA, role to an EOA', () => {
    const SAFE = A
    const ctl = lookup({
      [`${SAFE}@99`]: safe(SAFE, 3, 5),
      [`${SAFE}@100`]: safe(SAFE, 3, 6),
      [`${B}@100`]: eoa(B),
      [`${'0x' + 'd'.repeat(40)}@99`]: timelock('0x' + 'd'.repeat(40), 86400),
    })
    const actx = {
      subject: 's',
      ctl,
      upgradeTimelocks: {},
      deployBlocks: {},
      tokens: [],
      announcement: 'not_checked' as const,
    }
    const out = classifyAdminEvents(
      [
        row({ event: 'AddedOwner', emitter: SAFE, args: { owner: B } }),
        row({
          event: 'OwnershipTransferred',
          emitter: '0x' + 'e'.repeat(40),
          logIndex: 2,
          tx: '0xu',
          args: { previousOwner: '0x' + 'd'.repeat(40), newOwner: B },
        }),
        row({
          event: 'RoleGranted',
          emitter: '0x' + 'f'.repeat(40),
          logIndex: 3,
          tx: '0xv',
          args: { role: '0x00', roleName: 'DEFAULT_ADMIN_ROLE', account: B },
        }),
      ],
      actx,
    )
    expect(out.map((c) => c.ruleIds[0])).toEqual(['AD-1', 'AD-3', 'AD-4'])
    expect(
      out.every((c) => c.red && c.unannounced === null && c.announcement === 'not_checked'),
    ).toBe(true)
  })
})

// ---- DVN, CCIP, mint/redeem, oracle -------------------------------------------------------------------
describe('DVN signer sets DV-1 / DV-2', () => {
  it('quorum lowered or signer added at the same quorum is red; removing a signer is not', () => {
    expect(
      classifyDvnSignerChange({ quorum: 2, signers: 3 }, { quorum: 1, signers: 3 }, false).ruleIds,
    ).toContain('DV-1')
    expect(
      classifyDvnSignerChange({ quorum: 2, signers: 3 }, { quorum: 2, signers: 4 }, false).ruleIds,
    ).toContain('DV-2')
    expect(
      classifyDvnSignerChange({ quorum: 2, signers: 4 }, { quorum: 2, signers: 3 }, false).severity,
    ).toBe('upgrade')
    const c = classifyDvnSignerChanges(
      [
        {
          chainId: 1,
          dvn: LZ,
          block: 1,
          tx: '0x1',
          logIndex: 0,
          prev: { quorum: 2, signers: 3 },
          next: { quorum: 2, signers: 3 },
          addedAndRemoved: true,
        },
      ],
      's',
      () => 'LZ',
      'no_gov_channel',
    )
    expect(c[0].tags).toContain('rotation')
    expect(c[0].red).toBe(false)
  })
})

describe('CCIP CC-1..CC-3', () => {
  const P1 = '0x00000000000000000000000000000000000000a1'
  const P2 = '0x00000000000000000000000000000000000000a2'
  it('pool replaced is red, pool first set is not; limiter disabled is red; rebalancer to an EOA is red', () => {
    expect(classifyCcip('pool_set', { prev: P1, next: P2 }).ruleIds).toContain('CC-1')
    expect(classifyCcip('pool_set', { prev: '0x' + '0'.repeat(40), next: P2 }).severity).toBe(
      'neutral',
    )
    expect(classifyCcip('rate_limiter', { enabled: false }).ruleIds).toContain('CC-2')
    expect(classifyCcip('rate_limiter', { enabled: true }).severity).toBe('neutral')
    expect(
      classifyCcip('rebalancer', { prevCtl: safe(P1, 6, 11), nextCtl: eoa(P2) }).ruleIds,
    ).toContain('CC-3')
    expect(
      classifyCcip('rebalancer', { prevCtl: safe(P1, 3, 6), nextCtl: safe(P2, 6, 11) }).severity,
    ).toBe('neutral')
  })
})

describe('mint/redeem MR-1..MR-5', () => {
  const spec = (rule: ParamSpec['rule'], extra: Partial<ParamSpec> = {}): ParamSpec => ({
    key: 'k',
    contract: '0x' + '1'.repeat(40),
    sig: 'function k() view returns (uint256)',
    rule,
    label: 'k',
    ...extra,
  })
  it('MR-1: pauser to address(0) / no pauser left', () => {
    expect(
      classifyParamChange(spec('pauser'), '0x' + '1'.repeat(40), '0x' + '0'.repeat(40)).ruleIds,
    ).toContain('MR-1')
    expect(classifyPauserChange(0).ruleIds).toContain('MR-1')
    expect(classifyPauserChange(1).severity).toBe('neutral')
  })
  it('MR-2: rate provider to an EOA, or a new minter; a contract provider is not red', () => {
    expect(
      classifyParamChange(
        spec('rate_provider'),
        null,
        '0x' + '2'.repeat(40),
        eoa('0x' + '2'.repeat(40)),
      ).ruleIds,
    ).toContain('MR-2')
    expect(
      classifyParamChange(spec('rate_provider'), null, '0x' + '2'.repeat(40), {
        kind: 'contract',
        address: '0x' + '2'.repeat(40),
      }).severity,
    ).toBe('neutral')
    expect(
      classifyParamChange(spec('minter'), '0x' + '3'.repeat(40), '0x' + '4'.repeat(40), {
        kind: 'contract',
        address: '0x' + '4'.repeat(40),
      }).ruleIds,
    ).toContain('MR-2')
  })
  it('MR-3: a sanity bound raised or a quorum lowered is red; tightened is not', () => {
    expect(
      classifyParamChange(spec('bound_upper'), '10000000000000000', '20000000000000000').ruleIds,
    ).toContain('MR-3')
    expect(classifyParamChange(spec('bound_upper'), '500', '400').severity).toBe('upgrade')
    expect(classifyParamChange(spec('quorum'), '3', '2').ruleIds).toContain('MR-3')
    expect(classifyParamChange(spec('quorum_members'), '3', '4').ruleIds).toContain('MR-3')
  })
  it('MR-4: Ethena 10M → 20M is only large_raise; Kelp limit 0 is closed (not red); the unlimited sentinel is red', () => {
    const ethena = classifyParamChange(
      spec('cap', { zero: 'closed' }),
      '10000000000000000000000000',
      '20000000000000000000000000',
    )
    expect(isRed(ethena)).toBe(false)
    expect(ethena.tags).toContain('large_raise')
    const kelp = classifyParamChange(
      spec('cap', { zero: 'closed' }),
      '100000000000000000000000',
      '0',
    )
    expect(isRed(kelp)).toBe(false)
    expect(classifyParamChange(spec('cap', { zero: 'unlimited' }), '100', '0').ruleIds).toContain(
      'MR-4',
    )
    expect(
      classifyParamChange(
        spec('cap', { zero: 'closed', unlimited: '340282366920938463463374607431768211455' }),
        '1',
        '340282366920938463463374607431768211455',
      ).ruleIds,
    ).toContain('MR-4')
  })
  it('MR-5: whitelist gate removed is red; a shorter cooldown is tagged run_risk only', () => {
    expect(classifyParamChange(spec('whitelist_gate'), true, false).ruleIds).toContain('MR-5')
    const cd = classifyParamChange(spec('cooldown'), '604800', '86400')
    expect(cd.tags).toContain('run_risk')
    expect(isRed(cd)).toBe(false)
  })
  it('grid transitions become mint_redeem changes with the bracket kept', () => {
    const c = classifyParamTransitions(
      [{ key: 'k', block: 200, blockFrom: 150, before: '500', after: '900' }],
      [spec('bound_upper')],
      { subject: 's', ctl: () => null, announcement: 'not_checked' },
    )
    expect(c[0].red).toBe(true)
    expect(c[0].tags).toContain('bracketed')
  })
})

describe('oracle OR-1', () => {
  it('heartbeat up / TWAP window down / bar down are red; the opposite is not', () => {
    expect(classifyOracleParam('heartbeat', 'heartbeat', 3600, 86400).ruleIds).toContain('OR-1')
    expect(classifyOracleParam('twap_window', 'twapWindow', 1800, 600).ruleIds).toContain('OR-1')
    expect(classifyOracleParam('quorum', 'bar', 13, 7).ruleIds).toContain('OR-1')
    expect(classifyOracleParam('heartbeat', 'heartbeat', 86400, 3600).severity).toBe('neutral')
  })
})

describe('every rule ID has a description', () => {
  it('registry is complete', () => {
    for (const id of [
      'BR-1',
      'BR-2',
      'BR-3',
      'BR-4',
      'BR-5',
      'BR-6',
      'BR-7',
      'BR-8',
      'BR-9',
      'DV-1',
      'DV-2',
      'CC-1',
      'CC-2',
      'CC-3',
      'AD-1',
      'AD-2',
      'AD-3',
      'AD-4',
      'AD-5',
      'AD-6',
      'AD-7',
      'AD-8',
      'AD-9',
      'MR-1',
      'MR-2',
      'MR-3',
      'MR-4',
      'MR-5',
      'OR-1',
    ])
      expect(RULES[id as keyof typeof RULES]).toBeTruthy()
  })
})

// ---- pending / proposed -----------------------------------------------------------------------------
describe('queue: pending (timelock) and proposed (Safe) changes', () => {
  const EP = '0x1a44076050125825900e736c501f859c50fe728c'
  const ABI = parseAbi([
    'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
    'function upgradeTo(address impl)',
    'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  ])
  const ulnBytes = (c: UlnConfigRaw) =>
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'confirmations', type: 'uint64' },
            { name: 'requiredDVNCount', type: 'uint8' },
            { name: 'optionalDVNCount', type: 'uint8' },
            { name: 'optionalDVNThreshold', type: 'uint8' },
            { name: 'requiredDVNs', type: 'address[]' },
            { name: 'optionalDVNs', type: 'address[]' },
          ],
        },
      ],
      [
        {
          confirmations: BigInt(c.confirmations),
          requiredDVNCount: c.requiredDVNCount,
          optionalDVNCount: c.optionalDVNCount,
          optionalDVNThreshold: c.optionalDVNThreshold,
          requiredDVNs: c.requiredDVNs as `0x${string}`[],
          optionalDVNs: c.optionalDVNs as `0x${string}`[],
        },
      ],
    )
  const setConfig = (c: UlnConfigRaw) =>
    encodeFunctionData({
      abi: ABI,
      functionName: 'setConfig',
      args: [OAPP, RECV, [{ eid: 30110, configType: 2, config: ulnBytes(c) }]],
    })
  const PROXY = '0x308861a430be4cce5502d0a12724771fc6daf216'
  const OLD = '0xd27a57bb8f9b7ec7862df87f5143146c161f5a8b'
  const CUR = '0x17a16747d03006c9754548ac0d0aff48783a4a45'
  const headRoute = route(uln([LZ, CAN], [HZ, NM, GG], 2, '15'))
  const q: QueueCtx = {
    subject: 's',
    announcement: 'not_checked',
    eval: ctx,
    block: 100,
    endpoint: EP,
    routes: { [`${OAPP}|30110|receive`]: { ...headRoute, eid: 30110 } },
    defaults: {},
    libDirection: (l) => (l === RECV ? 'receive' : l === SEND ? 'send' : null),
    ctl: () => null,
    ownerOf: () => null,
    delegateOf: () => null,
    implHistory: {
      [PROXY]: {
        impls: [
          { impl: OLD, block: 10 },
          { impl: CUR, block: 50 },
        ],
        current: CUR,
      },
    },
    minDelayOf: () => 864000,
    roleName: (h) => h,
    contracts: [PROXY, OAPP],
    oapps: [OAPP],
    // implementations in this fixture have verified source (AD-9 is exercised separately)
    verified: () => true,
  }
  const op = (
    calls: { target: string; data: string }[],
    timestamp: number,
    simulation: TimelockOp['simulation'] = 'ok',
  ): TimelockOp => ({
    timelock: '0x' + '9'.repeat(40),
    id: '0x' + 'ab'.repeat(32),
    calls: calls.map((c) => ({ ...c, value: '0' })),
    predecessor: '0x' + '0'.repeat(64),
    delaySec: 86400,
    scheduledBlock: 20,
    scheduledTx: '0xs',
    timestamp,
    predecessorDone: true,
    simulation,
  })

  it('op status: pending / armed only when executable / ready-unexecutable / executed / cancelled', () => {
    expect(opStatus(op([], 2000), 1000)).toBe('pending')
    expect(opStatus(op([], 500), 1000)).toBe('armed')
    expect(opStatus(op([], 500, 'revert'), 1000)).toBe('ready_unexecutable')
    expect(opStatus(op([], 1), 1000)).toBe('executed')
    expect(opStatus(op([], 0), 1000)).toBe('cancelled')
  })

  it('a pending USDe-style DVN swap (Canary → Canary Subsidized) is amber, not red', () => {
    const out = timelockChanges(
      [op([{ target: EP, data: setConfig(uln([LZ, CAN_SUB], [HZ, NM, GG], 2, '15')) }], 2000)],
      q,
      1000,
    )
    expect(out).toHaveLength(1)
    expect(out[0].state).toBe('pending')
    expect(out[0].stage).toBe('scheduled')
    expect(out[0].red).toBe(false)
  })

  it('a pending setConfig that drops to 1-of-1 is RED while still pending', () => {
    const out = timelockChanges(
      [op([{ target: EP, data: setConfig(uln([LZ], [], 0, '15')) }], 2000)],
      q,
      1000,
    )
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-2']))
  })

  it('AD-8: an ARMED stale rollback upgrade is red; the same op that cannot execute is only tagged', () => {
    const up = encodeFunctionData({ abi: ABI, functionName: 'upgradeTo', args: [OLD] })
    const armed = timelockChanges([op([{ target: PROXY, data: up }], 500, 'ok')], q, 1000)
    expect(armed[0].ruleIds).toContain('AD-8')
    expect(armed[0].stage).toBe('armed')
    expect(armed[0].tags).toContain('stale_rollback')
    const stuck = timelockChanges([op([{ target: PROXY, data: up }], 500, 'revert')], q, 1000)
    expect(stuck[0].red).toBe(false)
    expect(stuck[0].stage).toBe('stale')
    expect(stuck[0].tags).toEqual(expect.arrayContaining(['stale_rollback', 'not_executable']))
  })

  it('Safe proposals unwrap scheduleBatch / MultiSend and land as PROPOSED', () => {
    const inner = setConfig(uln([LZ], [], 0, '15'))
    const sb = encodeFunctionData({
      abi: ABI,
      functionName: 'scheduleBatch',
      args: [
        [EP],
        [0n],
        [inner],
        ('0x' + '0'.repeat(64)) as `0x${string}`,
        ('0x' + '0'.repeat(64)) as `0x${string}`,
        86400n,
      ],
    })
    expect(
      unwrapCalls({ target: '0x' + '9'.repeat(40), value: '0', data: sb }).calls[0].target,
    ).toBe(EP)
    const packed =
      '0x' +
      '00' +
      EP.slice(2) +
      (0).toString(16).padStart(64, '0') +
      ((inner.length - 2) / 2).toString(16).padStart(64, '0') +
      inner.slice(2)
    expect(decodeMultiSend(packed)[0].data).toBe(inner)
    const out = safeProposalChanges(
      [
        {
          safe: '0x' + '5'.repeat(40),
          nonce: 737,
          to: '0x' + '9'.repeat(40),
          value: '0',
          data: sb,
          confirmations: 2,
          confirmationsRequired: 5,
          safeTxHash: '0xh',
        },
      ],
      q,
    )
    expect(out[0].state).toBe('proposed')
    expect(out[0].stage).toBe('safe_queued')
    expect(out[0].red).toBe(true)
    expect(
      judgeCall({ target: PROXY, value: '0', data: '0xdeadbeef' }, q, { armed: false })[0].v.tags,
    ).toContain('undecoded')
    // a shared timelock / Safe also queues other assets' calls: they belong to another card
    const otherOapp = encodeFunctionData({
      abi: ABI,
      functionName: 'setConfig',
      args: [('0x' + '7'.repeat(40)) as `0x${string}`, RECV, []],
    })
    expect(callIsForSubject({ target: EP, value: '0', data: otherOapp }, q)).toBe(false)
    expect(callIsForSubject({ target: EP, value: '0', data: inner }, q)).toBe(true)
    expect(callIsForSubject({ target: '0x' + '8'.repeat(40), value: '0', data: '0x' }, q)).toBe(
      false,
    )
  })
})

// ---- review fixes 2026-10-06 (adversarial fixtures that read calm before the fix) --------------
describe('bridge: a route is closed only when NO library can verify (review fix)', () => {
  const base = { chainId: 1, logIndex: 0 }
  const setup = (cfg: UlnConfigRaw): LzEvent[] => [
    { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30320, lib: RECV },
    { ...base, block: 1, tx: '0x1', logIndex: 1, kind: 'default_send_lib', eid: 30320, lib: SEND },
    { ...base, block: 2, tx: '0x2', kind: 'peer', oapp: OAPP, eid: 30320, peer: PEER },
    { ...base, block: 3, tx: '0x3', kind: 'uln', lib: RECV, oapp: OAPP, eid: 30320, config: cfg },
  ]
  const recv = (r: ReturnType<typeof replayLz>, tx: string) =>
    r.changes.find((c) => c.tx === tx && c.route?.direction === 'receive')

  it('BR-2: BlockedMessageLib with the old library still in its grace period is LIVE at the old E', () => {
    const r = route(uln([LZ, NM]), {
      lib: BLOCKED,
      grace: { lib: RECV, expiry: 1000, config: uln([LZ]) },
    })
    expect(r.live).toBe(true)
    expect(r.Eeff).toBe(1)
    expect(routeBreaches(r).map((b) => b.ruleId)).toContain('BR-2')
    // once the grace period has expired the route is closed
    const expired = route(uln([LZ, NM]), {
      lib: BLOCKED,
      grace: { lib: RECV, expiry: 50, config: uln([LZ]) },
    })
    expect(expired.live).toBe(false)
  })

  it('BR-1/BR-2 in the replay: "close" + grace timeout + weaken the old library in one tx is red', () => {
    const r = replayLz(
      [
        ...setup(uln([LZ, NM, GG])),
        { ...base, block: 10, tx: '0x9', kind: 'recv_lib', oapp: OAPP, eid: 30320, lib: BLOCKED },
        {
          ...base,
          block: 10,
          tx: '0x9',
          logIndex: 1,
          kind: 'recv_timeout',
          oapp: OAPP,
          eid: 30320,
          lib: RECV,
          expiry: 100_000,
        },
        {
          ...base,
          block: 10,
          tx: '0x9',
          logIndex: 2,
          kind: 'uln',
          lib: RECV,
          oapp: OAPP,
          eid: 30320,
          config: uln([LZ]),
        },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = recv(r, '0x9')!
    expect(c.red).toBe(true)
    expect(c.floorBreach).toBe(true)
    expect(c.ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-2']))
    expect(r.routes.find((x) => x.direction === 'receive')!.live).toBe(true)
  })

  it('BR-1: a downgrade written while the route was blocked is red when it reopens', () => {
    const r = replayLz(
      [
        ...setup(uln([LZ, NM, GG])),
        { ...base, block: 10, tx: '0xa', kind: 'recv_lib', oapp: OAPP, eid: 30320, lib: BLOCKED },
        {
          ...base,
          block: 10,
          tx: '0xa',
          logIndex: 1,
          kind: 'uln',
          lib: RECV,
          oapp: OAPP,
          eid: 30320,
          config: uln([LZ, NM]),
        },
        { ...base, block: 20, tx: '0xb', kind: 'recv_lib', oapp: OAPP, eid: 30320, lib: RECV },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    expect(recv(r, '0xa')!.red).toBe(false) // closing is a liveness event
    const reopen = recv(r, '0xb')!
    expect(reopen.ruleIds).toContain('BR-1')
    expect(reopen.red).toBe(true)
    expect(reopen.tags).toContain('unblocked')
  })

  it('BR-5: a grace library outside the allowlist counts E = 0; switching to one is red (not "blocked")', () => {
    const g = route(uln([LZ, NM]), { grace: { lib: ROGUE, expiry: 1000, config: uln([LZ, NM]) } })
    expect(g.Eeff).toBe(0)
    const r = replayLz(
      [
        ...setup(uln([LZ, NM])),
        { ...base, block: 10, tx: '0xc', kind: 'recv_lib', oapp: OAPP, eid: 30320, lib: ROGUE },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = recv(r, '0xc')!
    expect(c.ruleIds).toEqual(expect.arrayContaining(['BR-5', 'BR-2']))
    expect(c.red).toBe(true)
    expect(c.tags).not.toContain('blocked')
  })
})

describe('BR-9: any weaker state inside one transaction, not only an E dip (review fix)', () => {
  const base = { chainId: 1, logIndex: 0 }
  const setup: LzEvent[] = [
    { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30320, lib: RECV },
    { ...base, block: 1, tx: '0x1', logIndex: 1, kind: 'default_send_lib', eid: 30320, lib: SEND },
    { ...base, block: 2, tx: '0x2', kind: 'peer', oapp: OAPP, eid: 30320, peer: PEER },
    {
      ...base,
      block: 3,
      tx: '0x3',
      kind: 'uln',
      lib: RECV,
      oapp: OAPP,
      eid: 30320,
      config: uln([LZ, NM]),
    },
  ]
  it('a peer flipped A → B → A in one transaction', () => {
    const r = replayLz(
      [
        ...setup,
        { ...base, block: 10, tx: '0xf', kind: 'peer', oapp: OAPP, eid: 30320, peer: PEER2 },
        {
          ...base,
          block: 10,
          tx: '0xf',
          logIndex: 1,
          kind: 'peer',
          oapp: OAPP,
          eid: 30320,
          peer: PEER,
        },
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = r.changes.find((x) => x.tx === '0xf' && x.route?.direction === 'receive')!
    expect(c).toBeDefined()
    expect(c.ruleIds).toContain('BR-9')
    expect(c.tags).toContain('flash')
    expect(c.red).toBe(true)
  })
  it('confirmations set to NIL (zero) and back in one transaction', () => {
    const cfg = (conf: string): LzEvent => ({
      ...base,
      block: 10,
      tx: '0xe',
      logIndex: conf === '15' ? 1 : 0,
      kind: 'uln',
      lib: RECV,
      oapp: OAPP,
      eid: 30320,
      config: uln([LZ, NM], [], 0, conf),
    })
    const r = replayLz([...setup, cfg(NIL_CONFIRMATIONS.toString()), cfg('15')], {
      subject: 't',
      oapps: [OAPP],
      ctx,
    })
    const c = r.changes.find((x) => x.tx === '0xe' && x.route?.direction === 'receive')!
    expect(c).toBeDefined()
    expect(c.ruleIds).toContain('BR-9')
    expect(c.red).toBe(true)
  })
})

describe('queue: calls judged in order against a working copy of head (review fix)', () => {
  const EP = '0x1a44076050125825900e736c501f859c50fe728c'
  const QABI = parseAbi([
    'function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)',
    'function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod)',
    'function setPeer(uint32 eid, bytes32 peer)',
    'function changeThreshold(uint256 _threshold)',
    'function addOwnerWithThreshold(address owner, uint256 _threshold)',
    'function enableModule(address module)',
    'function grantRole(bytes32 role, address account)',
    'function setProvider(address provider)',
    'function upgradeTo(address impl)',
  ])
  const ulnBytes = (c: UlnConfigRaw) =>
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'confirmations', type: 'uint64' },
            { name: 'requiredDVNCount', type: 'uint8' },
            { name: 'optionalDVNCount', type: 'uint8' },
            { name: 'optionalDVNThreshold', type: 'uint8' },
            { name: 'requiredDVNs', type: 'address[]' },
            { name: 'optionalDVNs', type: 'address[]' },
          ],
        },
      ],
      [
        {
          confirmations: BigInt(c.confirmations),
          requiredDVNCount: c.requiredDVNCount,
          optionalDVNCount: c.optionalDVNCount,
          optionalDVNThreshold: c.optionalDVNThreshold,
          requiredDVNs: c.requiredDVNs as `0x${string}`[],
          optionalDVNs: c.optionalDVNs as `0x${string}`[],
        },
      ],
    )
  const setConfigRecv = (c: UlnConfigRaw) =>
    encodeFunctionData({
      abi: QABI,
      functionName: 'setConfig',
      args: [OAPP, RECV, [{ eid: 30110, configType: 2, config: ulnBytes(c) }]],
    })
  const reopen = encodeFunctionData({
    abi: QABI,
    functionName: 'setReceiveLibrary',
    args: [OAPP, 30110, RECV, 0n],
  })
  const SAFE = '0x' + '5'.repeat(40)
  const TL = '0x' + 'c'.repeat(40)
  const TOKEN = '0x' + 'd'.repeat(40)
  const FRESH = '0x' + 'e'.repeat(40)
  const PROV = '0x' + 'f'.repeat(40)
  const OLDPROV = '0x' + '3'.repeat(40)
  const ADMIN_HASH = '0x' + '0'.repeat(64)
  const MINTER_HASH = '0x' + '9'.repeat(64)
  const blockedHead = {
    ...route(uln([LZ, NM, GG]), { lib: BLOCKED }),
    eid: 30110,
  }
  const base = (o: Partial<QueueCtx> = {}): QueueCtx => ({
    subject: 's',
    announcement: 'not_checked',
    eval: ctx,
    block: 100,
    endpoint: EP,
    routes: { [`${OAPP}|30110|receive`]: blockedHead },
    defaults: { [`${RECV}|30110`]: uln([LZ, NM]) },
    libDirection: (l) => (l === RECV ? 'receive' : l === SEND ? 'send' : null),
    ctl: (a) =>
      (
        ({
          [SAFE]: safe(SAFE, 4, 7),
          [TL]: timelock(TL, 86400),
          [FRESH]: { kind: 'contract', address: FRESH },
          [PROV]: { kind: 'contract', address: PROV },
          [OLDPROV]: { kind: 'contract', address: OLDPROV },
        }) as Record<string, Controller>
      )[a] ?? null,
    ownerOf: () => null,
    delegateOf: () => null,
    implHistory: {},
    minDelayOf: () => 86400,
    roleName: (h) =>
      h === ADMIN_HASH ? 'DEFAULT_ADMIN_ROLE' : h === MINTER_HASH ? 'MINTER_ROLE' : h,
    contracts: [OAPP, TOKEN, PROV],
    oapps: [OAPP],
    ...o,
  })
  const op = (
    data: string[],
    target: string[] = data.map(() => EP),
    extra: Partial<TimelockOp> = {},
  ): TimelockOp => ({
    timelock: TL,
    id: '0x' + 'ab'.repeat(32),
    calls: data.map((d, i) => ({ target: target[i], value: '0', data: d })),
    predecessor: '0x' + '0'.repeat(64),
    delaySec: 86400,
    scheduledBlock: 20,
    scheduledTx: '0xs',
    timestamp: 2000,
    predecessorDone: true,
    simulation: 'ok',
    ...extra,
  })

  it('BR-2: reopening a blocked route and weakening its library in one batch is red (both orders)', () => {
    for (const calls of [
      [reopen, setConfigRecv(uln([LZ]))],
      [setConfigRecv(uln([LZ])), reopen],
    ]) {
      const out = timelockChanges([op(calls)], base(), 1000)
      expect(out.length).toBeGreaterThan(0)
      expect(out.some((c) => c.red && c.ruleIds.includes('BR-2'))).toBe(true)
      expect(out.every((c) => c.state === 'pending')).toBe(true)
    }
  })

  it('BR-2: a pending setPeer that reopens a zero-peer route at 1-of-1 is red', () => {
    const lz = replayLz(
      [
        {
          chainId: 1,
          logIndex: 0,
          block: 1,
          tx: '0x1',
          kind: 'default_recv_lib',
          eid: 30110,
          lib: RECV,
        },
        {
          chainId: 1,
          logIndex: 1,
          block: 1,
          tx: '0x1',
          kind: 'default_send_lib',
          eid: 30110,
          lib: SEND,
        },
        {
          chainId: 1,
          logIndex: 2,
          block: 1,
          tx: '0x1',
          kind: 'uln_default',
          lib: RECV,
          eid: 30110,
          config: uln([LZ]),
        },
        {
          chainId: 1,
          logIndex: 3,
          block: 1,
          tx: '0x1',
          kind: 'uln_default',
          lib: SEND,
          eid: 30110,
          config: uln([LZ]),
        },
        {
          chainId: 1,
          logIndex: 0,
          block: 2,
          tx: '0x2',
          kind: 'peer',
          oapp: OAPP,
          eid: 30110,
          peer: PEER,
        },
        {
          chainId: 1,
          logIndex: 0,
          block: 3,
          tx: '0x3',
          kind: 'peer',
          oapp: OAPP,
          eid: 30110,
          peer: '0x' + '0'.repeat(64),
        },
      ],
      { subject: 's', oapps: [OAPP], ctx },
    )
    const setPeer = encodeFunctionData({
      abi: QABI,
      functionName: 'setPeer',
      args: [30110, PEER as `0x${string}`],
    })
    const out = timelockChanges(
      [op([setPeer], [OAPP])],
      base({ routes: {}, defaults: {}, lz: lz.state }),
      1000,
    )
    expect(out).toHaveLength(1)
    expect(out[0].red).toBe(true)
    expect(out[0].ruleIds).toContain('BR-2')
    expect(out[0].tags).toContain('route_created')
  })

  it('AD-1 / AD-6: proposed Safe self-calls are decoded and judged against the Safe at head', () => {
    const prop = (data: string) =>
      safeProposalChanges(
        [
          {
            safe: SAFE,
            nonce: 1,
            to: SAFE,
            value: '0',
            data,
            confirmations: 1,
            confirmationsRequired: 4,
            safeTxHash: '0xh',
          },
        ],
        base(),
      )
    const thr = prop(encodeFunctionData({ abi: QABI, functionName: 'changeThreshold', args: [1n] }))
    expect(thr[0].ruleIds).toContain('AD-1')
    expect(thr[0].red).toBe(true)
    expect(thr[0].tags).not.toContain('undecoded')
    const add = prop(
      encodeFunctionData({
        abi: QABI,
        functionName: 'addOwnerWithThreshold',
        args: [FRESH as `0x${string}`, 4n],
      }),
    )
    expect(add[0].ruleIds).toContain('AD-1')
    const mod = prop(
      encodeFunctionData({
        abi: QABI,
        functionName: 'enableModule',
        args: [FRESH as `0x${string}`],
      }),
    )
    expect(mod[0].ruleIds).toContain('AD-6')
    expect(mod[0].red).toBe(true)
  })

  it('AD-4 / MR-2: a pending grant to a fresh contract is judged against the current holders', () => {
    const q = base({
      roleHolders: (c, r) => (c === TOKEN ? [TL] : []),
      roleEverHolders: (c, r) => (c === TOKEN && r === MINTER_HASH ? [TL] : []),
    })
    const grant = (role: string) =>
      encodeFunctionData({
        abi: QABI,
        functionName: 'grantRole',
        args: [role as `0x${string}`, FRESH as `0x${string}`],
      })
    const admin = timelockChanges([op([grant(ADMIN_HASH)], [TOKEN])], q, 1000)
    expect(admin[0].ruleIds).toContain('AD-4')
    expect(admin[0].red).toBe(true)
    const minter = timelockChanges([op([grant(MINTER_HASH)], [TOKEN])], q, 1000)
    expect(minter[0].ruleIds).toContain('MR-2')
    expect(minter[0].red).toBe(true)
  })

  it('AD-8 fails closed: an unreadable state or an execute that could not be simulated', () => {
    const PROXY = TOKEN
    const q = base({
      implHistory: {
        [PROXY]: {
          impls: [
            { impl: OLDPROV, block: 10 },
            { impl: PROV, block: 50 },
          ],
          current: PROV,
        },
      },
      verified: () => true,
    })
    const up = encodeFunctionData({
      abi: QABI,
      functionName: 'upgradeTo',
      args: [OLDPROV as `0x${string}`],
    })
    for (const simulation of ['error', 'not_run'] as const) {
      const out = timelockChanges([op([up], [PROXY], { timestamp: 500, simulation })], q, 1000)
      expect(out[0].stage).toBe('armed')
      expect(out[0].ruleIds).toContain('AD-8')
      expect(out[0].tags).toContain('not_simulated')
      expect(out[0].red).toBe(true)
    }
    expect(opStatus(op([up], [PROXY], { timestamp: null }), 1000)).toBe('unread')
    const unread = timelockChanges([op([up], [PROXY], { timestamp: null })], q, 1000)
    expect(unread).toHaveLength(1) // never dropped as "cancelled"
    expect(unread[0].tags).toContain('state_unread')
  })

  it('AD-9: a rate provider or implementation swapped to an unverified contract is red; verified is amber', () => {
    const spec: ParamSpec = {
      key: 'aprProvider',
      contract: PROV,
      sig: 'function provider() view returns (address)',
      rule: 'rate_provider',
      label: 'APR provider',
    }
    const setProv = encodeFunctionData({
      abi: QABI,
      functionName: 'setProvider',
      args: [FRESH as `0x${string}`],
    })
    const q = (verified: boolean | null) =>
      base({ params: [spec], paramHead: { aprProvider: OLDPROV }, verified: () => verified })
    const bad = timelockChanges([op([setProv], [PROV])], q(false), 1000)
    expect(bad[0].red).toBe(true)
    expect(bad[0].tags).toEqual(expect.arrayContaining(['logic_change', 'unverified']))
    expect(bad[0].before).toBe(OLDPROV)
    const unknown = timelockChanges([op([setProv], [PROV])], q(null), 1000)
    expect(unknown[0].red).toBe(true)
    const ok = timelockChanges([op([setProv], [PROV])], q(true), 1000)
    expect(ok[0].red).toBe(false)
    expect(ok[0].tags).toContain('logic_change')
    const up = encodeFunctionData({
      abi: QABI,
      functionName: 'upgradeTo',
      args: [FRESH as `0x${string}`],
    })
    expect(timelockChanges([op([up], [TOKEN])], q(false), 1000)[0].ruleIds).toContain('AD-9')
    expect(timelockChanges([op([up], [TOKEN])], q(false), 1000)[0].red).toBe(true)
  })
})

describe('admin history review fixes', () => {
  const A = '0x00000000000000000000000000000000000000aa'
  const B = '0x00000000000000000000000000000000000000bb'
  const C = '0x00000000000000000000000000000000000000cc'
  const row = (o: Partial<AdminEventRow>): AdminEventRow => ({
    chainId: 1,
    block: 100,
    logIndex: 0,
    tx: '0xt',
    emitter: A,
    event: 'Upgraded',
    args: {},
    ...o,
  })
  const actx = (m: Record<string, Controller>, o: Record<string, unknown> = {}) => ({
    subject: 's',
    ctl: (a: string, b: number) => m[`${a}@${b}`] ?? m[`${a}@head`] ?? null,
    ctlExact: (a: string, b: number) => m[`${a}@${b}`] ?? null,
    upgradeTimelocks: {},
    deployBlocks: { [A]: 1 },
    tokens: [],
    announcement: 'not_checked' as const,
    ...o,
  })

  it('AD-3: an owner set from address(0) after deployment is a change of control, not initialization', () => {
    // re-initialisation after an upgrade (OZ v5 namespaced storage) with no earlier owner seen
    const out = classifyAdminEvents(
      [
        row({ event: 'Upgraded', block: 400, tx: '0xup', args: { implementation: C } }),
        row({
          event: 'OwnershipTransferred',
          block: 500,
          args: { previousOwner: '0x' + '0'.repeat(40), newOwner: B },
        }),
      ],
      actx({ [`${B}@500`]: eoa(B) }, { verified: () => true }),
    ).filter((c) => c.key.startsWith('admin/owner/'))
    expect(out[0].tags).not.toContain('initialization')
    expect(out[0].ruleIds).toContain('AD-3')
    expect(out[0].red).toBe(true)
    // a deferred initialize() of a contract still on the code it was deployed with is not
    const deferred = classifyAdminEvents(
      [
        row({
          event: 'OwnershipTransferred',
          block: 500,
          args: { previousOwner: '0x' + '0'.repeat(40), newOwner: B },
        }),
      ],
      actx({ [`${B}@500`]: eoa(B) }),
    )
    expect(deferred[0].tags).toContain('initialization')
    // at the deploy block it is initialization
    const init = classifyAdminEvents(
      [
        row({
          event: 'OwnershipTransferred',
          block: 1,
          args: { previousOwner: '0x' + '0'.repeat(40), newOwner: B },
        }),
      ],
      actx({ [`${B}@1`]: eoa(B) }),
    )
    expect(init[0].tags).toContain('initialization')
    // re-initialisation after an upgrade is judged against the last known owner
    const reinit = classifyAdminEvents(
      [
        row({
          event: 'OwnershipTransferred',
          block: 1,
          args: { previousOwner: '0x' + '0'.repeat(40), newOwner: C },
        }),
        row({
          event: 'OwnershipTransferred',
          block: 600,
          tx: '0xu',
          args: { previousOwner: '0x' + '0'.repeat(40), newOwner: B },
        }),
      ],
      actx({ [`${C}@599`]: timelock(C, 86400), [`${B}@600`]: safe(B, 2, 3) }),
    )
    expect(reinit[1].ruleIds).toContain('AD-3')
  })

  it('AD-1: a multisig change never reads its "before" from head; two txs in one block are judged apart', () => {
    // head says 1-of-7; the archive read before the change is missing
    const headOnly = classifyAdminEvents(
      [row({ event: 'ChangedThreshold', args: { threshold: 1 } })],
      actx({ [`${A}@head`]: safe(A, 1, 7) }),
    )
    expect(headOnly[0].red).toBe(true)
    expect(headOnly[0].ruleIds).toContain('AD-1')
    // 4 → 1 then 1 → 4 inside one block (two transactions): the first is a drop
    const twoTx = classifyAdminEvents(
      [
        row({ event: 'ChangedThreshold', tx: '0x1', logIndex: 0, args: { threshold: 1 } }),
        row({ event: 'ChangedThreshold', tx: '0x2', logIndex: 1, args: { threshold: 4 } }),
      ],
      actx({ [`${A}@99`]: safe(A, 4, 7), [`${A}@100`]: safe(A, 4, 7) }),
    )
    expect(twoTx[0].title).toMatch(/4-of-7 → 1-of-7/)
    expect(twoTx[0].red).toBe(true)
    expect(twoTx[1].severity).toBe('upgrade')
  })

  it('MR-2: the first MINTER grant after deployment, to a new contract, is a new minter', () => {
    const out = classifyAdminEvents(
      [
        row({
          event: 'RoleGranted',
          block: 500,
          args: { role: '0x01', roleName: 'MINTER_ROLE', account: B },
        }),
      ],
      actx({ [`${B}@500`]: { kind: 'contract', address: B } }),
    )
    expect(out[0].ruleIds).toContain('MR-2')
    expect(out[0].red).toBe(true)
  })

  it('AD-9: an upgrade to an unverified (or unreadable) implementation is red; verified is amber', () => {
    const up = (verified: boolean | null) =>
      classifyAdminEvents(
        [row({ block: 500, args: { implementation: B } })],
        actx({}, { verified: () => verified }),
      )[0]
    expect(up(false).red).toBe(true)
    expect(up(false).tags).toEqual(expect.arrayContaining(['logic_change', 'unverified']))
    expect(up(null).red).toBe(true)
    expect(up(true).red).toBe(false)
    // AD-9 names an UNVERIFIED logic change: a verified one is an amber LOGIC CHANGE only
    expect(up(true).ruleIds).not.toContain('AD-9')
    expect(up(true).tags).toContain('logic_change')
  })

  it('MR-2 on the getter path: EOA → EOA is a rotation (design: cbBTC EOA→EOA neutral)', () => {
    const spec: ParamSpec = {
      key: 'masterMinter',
      contract: A,
      sig: 'function masterMinter() view returns (address)',
      rule: 'minter',
      label: 'masterMinter',
    }
    const c = classifyParamTransitions(
      [{ key: 'masterMinter', block: 200, blockFrom: 199, before: B, after: C }],
      [spec],
      {
        subject: 's',
        ctl: (a, b) => (a === B && b === 199 ? eoa(B) : a === C && b === 200 ? eoa(C) : null),
        announcement: 'not_checked',
      },
    )
    expect(c[0].red).toBe(false)
    expect(c[0].tags).toContain('rotation')
    // a contract → EOA move is still MR-2
    const d = classifyParamTransitions(
      [{ key: 'masterMinter', block: 200, blockFrom: 199, before: B, after: C }],
      [spec],
      {
        subject: 's',
        ctl: (a, b) =>
          a === B && b === 199 ? { kind: 'contract', address: B } : a === C ? eoa(C) : null,
        announcement: 'not_checked',
      },
    )
    expect(d[0].ruleIds).toContain('MR-2')
  })

  it('controller rank cannot be gamed by a zero delay or a plain contract fronting a timelock', () => {
    // a 0-delay "timelock" is not stronger than the 4-of-7 Safe that proposes into it (ruling
    // #12: no credit below 24 h — neutral), and one an EOA proposes into is a downgrade
    expect(classifyControllerChange(safe(A, 4, 7), timelock(B, 0, safe(A, 4, 7))).severity).toBe(
      'neutral',
    )
    expect(classifyControllerChange(safe(A, 4, 7), timelock(B, 0, eoa(B))).ruleIds).toContain(
      'AD-3',
    )
    // a timelock whose proposers were not read ranks as a plain contract (fail closed)
    expect(
      classifyControllerChange(safe(A, 4, 7), { kind: 'oz_timelock', address: B, delaySec: 864000 })
        .ruleIds,
    ).toContain('AD-3')
    // timelock → a plain contract the timelock owns: strictly weaker
    expect(
      classifyControllerChange(timelock(A, 172800), {
        kind: 'contract',
        address: B,
        ownedBy: timelock(A, 172800),
      }).ruleIds,
    ).toContain('AD-3')
    // an unrestricted bypasser makes a timelock no stronger than a contract
    expect(
      compareRank(
        controllerRank({
          ...timelock(A, 864000),
          bypass: { fn: 'bypasserExecuteBatch', scope: 'any' },
        }),
        controllerRank(safe(B, 3, 5)),
      ),
    ).toBe(-1)
  })
})

describe('BR-9 refinement: a weaker step the transaction kept is the net change, not a flash', () => {
  it('creating a route at 20 confirmations then setting 15 in the same tx is not BR-9', () => {
    const base = { chainId: 1, logIndex: 0 }
    const cfg = (logIndex: number, conf: string): LzEvent => ({
      ...base,
      block: 10,
      tx: '0xc',
      logIndex,
      kind: 'uln',
      lib: RECV,
      oapp: OAPP,
      eid: 30320,
      config: uln([LZ, NM], [], 0, conf),
    })
    const r = replayLz(
      [
        { ...base, block: 1, tx: '0x1', kind: 'default_recv_lib', eid: 30320, lib: RECV },
        { ...base, block: 10, tx: '0xc', kind: 'peer', oapp: OAPP, eid: 30320, peer: PEER },
        cfg(1, '20'),
        cfg(2, '15'),
      ],
      { subject: 't', oapps: [OAPP], ctx },
    )
    const c = r.changes.find((x) => x.tx === '0xc' && x.route?.direction === 'receive')!
    expect(c.ruleIds).not.toContain('BR-9')
  })
})
