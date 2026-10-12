import { describe, expect, it } from 'vitest'

import fixtureLogs from './fixtures/curator-feed-logs.json'
import {
  EVENTS,
  canonicalSignature,
  decodeParams,
  encodeStatic,
  eventByName,
  eventFor,
  parseEventSignature,
  topicsFor,
  V2_SELECTORS,
  type EmitterKind,
  type RawLog,
} from '@/lib/curatorFeed/abi'
import {
  applyHeadPending,
  classifyEvents,
  decodeV2Call,
  headKey,
  needsHeadRead,
  type ClassifyContext,
} from '@/lib/curatorFeed/classify'
import { decodeLog, type DecodedEvent } from '@/lib/curatorFeed/decode'
import { keccakHex, keccakText } from '@/lib/curatorFeed/keccak'
import { secondsLeft, statusOf, toneOf } from '@/lib/curatorFeed/status'
import type { FeedAction } from '@/lib/curatorFeed/types'
import {
  adapterIdData,
  collateralIdData,
  decodeV2IdData,
  marketIdData,
  marketIdOf,
  v2IdOf,
} from '@/lib/curatorFeed/v2ids'

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Real mainnet logs captured 2026-10-07 (scripts in the PR description). */
const REAL = fixtureLogs as (RawLog & { kind: EmitterKind; name: string })[]
const real = (name: string, i = 0) => REAL.filter((l) => l.name === name)[i]

const V = '0x1111111111111111111111111111111111111111'
const V2V = '0x2222222222222222222222222222222222222222'
const AAVE = '0x64b761d848206f447fe2dd461b0c635ec39ebb27'
const PA = '0xfd32fa2ca22c76dd6e550706ad913fc6ce91c75d'
const CURATOR = '0x3333333333333333333333333333333333333333'
const ALLOC = '0x4444444444444444444444444444444444444444'
const RSETH = '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const M1 = id(1)
const M2 = id(2)
const M3 = id(3)

let seq = 0
/** A decoded event at block `block`, unique tx/logIndex. */
const ev = (
  kind: EmitterKind,
  name: string,
  args: DecodedEvent['args'],
  block: number,
  emitter = kind === 'v2' ? V2V : kind === 'aave' ? AAVE : V,
): DecodedEvent => ({
  kind,
  name,
  emitter,
  args,
  block,
  logIndex: seq++,
  tx: '0x' + (seq * 7919).toString(16).padStart(64, 'a'),
  ts: 1_790_000_000 + block * 12,
})
const tsAt = (block: number) => 1_790_000_000 + block * 12

const baseCtx: ClassifyContext = {
  collateralOf: (_p, scope, target) =>
    scope === 'market'
      ? (({ [M1]: [RSETH], [M2]: [WETH] } as Record<string, string[]>)[target] ?? [])
      : [],
  timelockAt: () => 86_400,
}

// ── keccak ───────────────────────────────────────────────────────────────────

describe('keccak256', () => {
  it('matches the standard vectors', () => {
    expect(keccakText('')).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
    expect(keccakText('Transfer(address,address,uint256)')).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
  })
  it('crosses the 136-byte rate boundary correctly (real Vault V2 market id, 288-byte idData)', () => {
    const log = real('IncreaseAbsoluteCap', 1)
    const def = eventFor('v2', log.topics[0])!
    const r = decodeLog('v2', log)
    expect(def.name).toBe('IncreaseAbsoluteCap')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const idData = r.event.args.idData as string
    expect((idData.length - 2) / 2).toBeGreaterThan(136)
    expect(keccakHex(idData)).toBe(log.topics[1])
  })
})

// ── abi catalog + decoder ────────────────────────────────────────────────────

describe('event catalog', () => {
  it('every topic0 is keccak256 of its canonical signature', () => {
    for (const e of EVENTS) expect(keccakText(e.sig), e.sig).toBe(e.topic0)
  })
  it('parses human signatures into the canonical form', () => {
    const p = parseEventSignature(
      'CreateMarket(bytes32 indexed id, (address,address,address,address,uint256) marketParams)',
    )
    expect(canonicalSignature(p.name, p.inputs)).toBe(
      'CreateMarket(bytes32,(address,address,address,address,uint256))',
    )
    expect(p.inputs.map((i) => i.indexed)).toEqual([true, false])
    expect(p.inputs[0].name).toBe('id')
  })
  it('Euler Earn and MetaMorpho SubmitCap differ (address vs bytes32 id); shared events resolve per kind', () => {
    expect(eventByName('ee', 'SubmitCap').topic0).not.toBe(eventByName('mm', 'SubmitCap').topic0)
    const t = eventByName('mm', 'SetCurator').topic0
    expect(eventFor('v2', t)?.name).toBe('SetCurator')
    expect(eventFor('ee', t)?.name).toBe('SetCurator')
    expect(eventFor('aave', t)).toBeUndefined()
  })
  it('topicsFor has no duplicates and V2 selectors match their function signatures', () => {
    for (const k of ['mm', 'ee', 'v2', 'aave'] as EmitterKind[])
      expect(new Set(topicsFor(k)).size).toBe(topicsFor(k).length)
    for (const [sel, sig] of Object.entries(V2_SELECTORS))
      expect(keccakText(sig).slice(0, 10), sig).toBe(sel)
  })
})

describe('abi decoder', () => {
  it('decodes static words, dynamic arrays, bytes and negative int256', () => {
    const data =
      '0x' +
      encodeStatic([
        { type: 'uint256', value: 64n },
        { type: 'uint256', value: (1n << 256n) - 5n },
      ]) +
      encodeStatic([
        { type: 'uint256', value: 2n },
        { type: 'bytes32', value: M1 },
        { type: 'bytes32', value: M2 },
      ])
    const [arr, neg] = decodeParams(['bytes32[]', 'int256'], data)
    expect(arr).toEqual([M1, M2])
    expect(neg).toBe(-5n)
  })
  it('throws on truncated data instead of returning garbage', () => {
    expect(() => decodeParams(['uint256', 'uint256'], '0x' + '00'.repeat(32))).toThrow()
  })
  it('decodes every real fixture log; indexed topics land in named args', () => {
    for (const l of REAL) {
      const r = decodeLog(l.kind, l)
      expect(r.ok, `${l.kind}.${l.name}`).toBe(true)
      if (r.ok) expect(r.event.name).toBe(l.name)
    }
    const sc = decodeLog('mm', real('SetCap'))
    expect(sc.ok && sc.event.args.id).toBe(real('SetCap').topics[2])
    const wq = decodeLog('mm', real('SetWithdrawQueue'))
    expect(wq.ok && Array.isArray(wq.event.args.newWithdrawQueue)).toBe(true)
    const aave = decodeLog('aave', real('SupplyCapChanged'))
    expect(aave.ok && typeof aave.event.args.newSupplyCap).toBe('bigint')
  })
  it('rejects a topic the kind does not declare, and a log with the wrong topic count', () => {
    expect(decodeLog('aave', real('SetCap')).ok).toBe(false)
    const bad = { ...real('SetCap'), topics: real('SetCap').topics.slice(0, 2) }
    const r = decodeLog('mm', bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })
})

// ── Vault V2 ids ─────────────────────────────────────────────────────────────

describe('Vault V2 idData', () => {
  it('marketIdOf reproduces a real Morpho Blue market id (wstETH/USDC 86%)', () => {
    expect(
      marketIdOf({
        loanToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        collateralToken: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
        oracle: '0x48f7e36eb6b826b2df4b2e630b62cd25e89e40e2',
        irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
        lltv: 860_000_000_000_000_000n,
      }),
    ).toBe('0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc')
  })
  it('decodes the three adapter id shapes and round-trips the encoders', () => {
    const p = {
      loanToken: WETH,
      collateralToken: RSETH,
      oracle: CURATOR,
      irm: ALLOC,
      lltv: 945n * 10n ** 15n,
    }
    expect(decodeV2IdData(collateralIdData(RSETH))).toEqual({
      type: 'collateral',
      collateral: RSETH,
    })
    expect(decodeV2IdData(adapterIdData(ALLOC))).toEqual({ type: 'adapter', adapter: ALLOC })
    const m = decodeV2IdData(marketIdData(ALLOC, p))
    expect(m.type).toBe('market')
    if (m.type === 'market') {
      expect(m.marketParams).toEqual(p)
      expect(m.market).toBe(marketIdOf(p))
    }
    expect(decodeV2IdData('0x1234').type).toBe('unknown')
  })
  it('real IncreaseAbsoluteCap logs: id topic = keccak(idData), and the decoded type names its collateral', () => {
    for (const l of REAL.filter((x) => x.name === 'IncreaseAbsoluteCap')) {
      const r = decodeLog('v2', l)
      if (!r.ok) throw new Error('decode')
      const idData = r.event.args.idData as string
      expect(v2IdOf(idData)).toBe(l.topics[1])
      const d = decodeV2IdData(idData)
      expect(['collateral', 'adapter', 'market']).toContain(d.type)
      if (d.type === 'market') expect(d.marketParams.collateralToken).toMatch(/^0x[0-9a-f]{40}$/)
    }
  })
  it('decodeV2Call reads the queued call out of a real Submit', () => {
    const r = decodeLog('v2', real('Submit'))
    if (!r.ok) throw new Error('decode')
    const call = decodeV2Call(r.event.args.data as string)
    expect(call.selector).toBe(r.event.args.selector)
    expect(call.fn).not.toMatch(/^unknown/)
  })
})

// ── classifier: MetaMorpho / Euler Earn ──────────────────────────────────────

describe('classify — caps (MetaMorpho)', () => {
  it('SubmitCap then SetCap → a resolved submit and a cap_raise', () => {
    const { actions } = classifyEvents(
      [
        ev('mm', 'SubmitCap', { caller: CURATOR, id: M1, cap: 500n }, 10),
        ev('mm', 'SetCap', { caller: CURATOR, id: M1, cap: 500n }, 8000),
      ],
      { ...baseCtx, prevCap: () => '100' },
    )
    expect(actions.map((a) => a.kind)).toEqual(['cap_submit', 'cap_raise'])
    expect(actions[0].resolution?.how).toBe('accepted')
    expect(actions[0].validAt).toBe(tsAt(10) + 86_400)
    expect(actions[0].validAtSource).toBe('derived')
    expect(actions[1]).toMatchObject({
      from: '100',
      to: '500',
      collateral: [RSETH],
      scope: 'market',
    })
  })
  it('a submit accepted in the same transaction (zero timelock) folds into the executed row', () => {
    const sub = ev('mm', 'SubmitCap', { caller: CURATOR, id: M1, cap: 500n }, 10)
    const set = { ...ev('mm', 'SetCap', { caller: CURATOR, id: M1, cap: 500n }, 10), tx: sub.tx }
    const { actions, stats } = classifyEvents([sub, set], { ...baseCtx, prevCap: () => '100' })
    expect(actions.map((a) => a.kind)).toEqual(['cap_raise'])
    expect(stats.sameTxSubmitsFolded).toBe(1)
  })
  it('SetCap to 0 is cap_zero; a lower SetCap with a known previous cap is cap_cut', () => {
    const { actions } = classifyEvents(
      [
        ev('mm', 'SetCap', { caller: CURATOR, id: M1, cap: 0n }, 5),
        ev('mm', 'SetCap', { caller: CURATOR, id: M2, cap: 50n }, 6),
      ],
      { ...baseCtx, prevCap: () => '100' },
    )
    expect(actions.map((a) => a.kind)).toEqual(['cap_zero', 'cap_cut'])
    expect(actions[0].from).toBe('100')
  })
  it('a SetCap with no submit and no prior read is a cut by contract rule, and says so', () => {
    const { actions } = classifyEvents(
      [ev('mm', 'SetCap', { caller: CURATOR, id: M1, cap: 50n }, 5)],
      baseCtx,
    )
    expect(actions[0].kind).toBe('cap_cut')
    expect(actions[0].note).toMatch(/inferred/)
  })
  it('a SetCap above the read previous cap (submit before the window) is a raise', () => {
    const { actions } = classifyEvents(
      [ev('mm', 'SetCap', { caller: CURATOR, id: M1, cap: 500n }, 5)],
      { ...baseCtx, prevCap: () => '100' },
    )
    expect(actions[0].kind).toBe('cap_raise')
  })
  it('RevokePendingCap resolves the submit as revoked and records the revoke', () => {
    const { actions } = classifyEvents(
      [
        ev('mm', 'SubmitCap', { caller: CURATOR, id: M1, cap: 500n }, 10),
        ev('mm', 'RevokePendingCap', { caller: ALLOC, id: M1 }, 20),
      ],
      baseCtx,
    )
    expect(actions[0].resolution?.how).toBe('revoked')
    expect(actions[1]).toMatchObject({ kind: 'cap_revoke', to: '500', actor: ALLOC })
  })
  it('a head read replaces the derived window for an open submit, and flags one the chain shows cleared', () => {
    const e1 = ev('mm', 'SubmitCap', { caller: CURATOR, id: M1, cap: 500n }, 10)
    const e2 = ev('mm', 'SubmitCap', { caller: CURATOR, id: M2, cap: 500n }, 11)
    const e3 = ev('mm', 'SubmitCap', { caller: CURATOR, id: M3, cap: 500n }, 12)
    const e4 = ev('mm', 'SetCap', { caller: CURATOR, id: M3, cap: 500n }, 9000)
    const { actions } = classifyEvents([e1, e2, e3, e4], baseCtx)
    const reads = {
      [headKey(actions[0])]: 1_999_999_999,
      [headKey(actions[1])]: 0,
      [headKey(actions[2])]: 7,
    }
    expect(applyHeadPending(actions, reads)).toBe(1)
    expect(actions[0]).toMatchObject({
      validAt: 1_999_999_999,
      validAtSource: 'chain',
      headPending: true,
    })
    expect(actions[1].headPending).toBe(false)
    // A resolved submit is never touched by a head read.
    expect(actions[2]).toMatchObject({ validAtSource: 'derived', resolution: { how: 'accepted' } })
    expect(needsHeadRead(actions[2])).toBe(false)
  })
  it('resumes: two runs split at any block classify exactly like one run', () => {
    const run = [
      ev('mm', 'SubmitCap', { caller: CURATOR, id: M1, cap: 500n }, 10),
      ev('mm', 'SetWithdrawQueue', { caller: ALLOC, newWithdrawQueue: [M1, M2, M3] }, 11),
      ev('mm', 'SubmitMarketRemoval', { caller: CURATOR, id: M2 }, 12),
      ev('mm', 'SetCap', { caller: CURATOR, id: M1, cap: 500n }, 9000),
      ev('mm', 'SetWithdrawQueue', { caller: ALLOC, newWithdrawQueue: [M1, M3] }, 9100),
      ev('mm', 'SetSupplyQueue', { caller: ALLOC, newSupplyQueue: [M1] }, 9101),
      ev('mm', 'SetSupplyQueue', { caller: ALLOC, newSupplyQueue: [] }, 9102),
    ]
    const ctx = { ...baseCtx, prevCap: () => '100', baselineSupplyQueue: { [V]: [M1, M3] } }
    const whole = classifyEvents(run, ctx)
    const strip = (a: FeedAction[]) => JSON.parse(JSON.stringify(a))
    for (let cut = 1; cut < run.length; cut++) {
      const first = classifyEvents(run.slice(0, cut), ctx)
      const actionsById = new Map(first.actions.map((a) => [a.id, a]))
      const second = classifyEvents(run.slice(cut), ctx, {
        state: JSON.parse(JSON.stringify(first.state)),
        actionsById,
      })
      expect(second.stats.resumeOpenMissing).toBe(0)
      expect(strip([...first.actions, ...second.actions]), `cut ${cut}`).toEqual(
        strip(whole.actions),
      )
      expect(second.state).toEqual(whole.state)
    }
  })
  it('Euler Earn caps are strategy-scoped and use the Euler event set', () => {
    const strat = '0x5555555555555555555555555555555555555555'
    const { actions } = classifyEvents(
      [ev('ee', 'SetCap', { caller: CURATOR, id: strat, cap: 0n }, 5)],
      {
        ...baseCtx,
        collateralOf: (_p, scope) => (scope === 'strategy' ? [RSETH, WETH] : []),
      },
    )
    expect(actions[0]).toMatchObject({
      protocol: 'euler-earn',
      kind: 'cap_zero',
      scope: 'strategy',
      collateral: [RSETH, WETH],
    })
  })
})

describe('classify — queues', () => {
  const ctx = {
    ...baseCtx,
    baselineWithdrawQueue: { [V]: [M1, M2, M3] },
    baselineSupplyQueue: { [V]: [M1, M2] },
  }
  it('a market missing from the next withdraw queue is market_removed; forced when a removal was submitted', () => {
    const { actions } = classifyEvents(
      [
        ev('mm', 'SubmitMarketRemoval', { caller: CURATOR, id: M2 }, 10),
        ev('mm', 'SetWithdrawQueue', { caller: ALLOC, newWithdrawQueue: [M1, M3] }, 9000),
      ],
      ctx,
    )
    expect(actions.map((a) => a.kind)).toEqual(['removal_submit', 'market_removed'])
    expect(actions[1]).toMatchObject({ target: M2, forced: true, collateral: [WETH] })
    expect(actions[0].resolution?.how).toBe('accepted')
  })
  it('a pure reorder emits nothing and is counted', () => {
    const { actions, stats } = classifyEvents(
      [ev('mm', 'SetWithdrawQueue', { caller: ALLOC, newWithdrawQueue: [M3, M2, M1] }, 5)],
      ctx,
    )
    expect(actions).toHaveLength(0)
    expect(stats.withdrawQueueReorders).toBe(1)
  })
  it('diffs consecutive queue events and the supply queue separately', () => {
    const { actions } = classifyEvents(
      [
        ev('mm', 'SetSupplyQueue', { caller: ALLOC, newSupplyQueue: [M1] }, 5),
        ev('mm', 'SetSupplyQueue', { caller: ALLOC, newSupplyQueue: [M1, M3] }, 6),
      ],
      ctx,
    )
    expect(actions.map((a) => [a.kind, a.target])).toEqual([
      ['supply_queue_remove', M2],
      ['supply_queue_add', M3],
    ])
  })
  it('without a baseline the first queue event only sets state (counted, never guessed)', () => {
    const { actions, stats } = classifyEvents(
      [
        ev('mm', 'SetWithdrawQueue', { caller: ALLOC, newWithdrawQueue: [M1] }, 5),
        ev('mm', 'SetWithdrawQueue', { caller: ALLOC, newWithdrawQueue: [] }, 6),
      ],
      baseCtx,
    )
    expect(stats.queueBaselineMissing).toBe(1)
    expect(actions.map((a) => a.kind)).toEqual(['market_removed'])
  })
})

describe('classify — reallocations, timelocks, roles', () => {
  it('tags Public Allocator legs and keeps allocator legs', () => {
    const { reallocations } = classifyEvents(
      [
        ev(
          'mm',
          'ReallocateWithdraw',
          { caller: PA, id: M1, withdrawnAssets: 10n, withdrawnShares: 9n },
          5,
        ),
        ev(
          'mm',
          'ReallocateSupply',
          { caller: ALLOC, id: M2, suppliedAssets: 10n, suppliedShares: 9n },
          5,
        ),
      ],
      { ...baseCtx, publicAllocators: { mm: PA } },
    )
    expect(reallocations.map((r) => [r.dir, r.source])).toEqual([
      ['out', 'public-allocator'],
      ['in', 'allocator'],
    ])
  })
  it('timelock submit → set resolves; revoke resolves as revoked', () => {
    const a = classifyEvents(
      [
        ev('mm', 'SubmitTimelock', { newTimelock: 3600n }, 5),
        ev('mm', 'SetTimelock', { caller: CURATOR, newTimelock: 3600n }, 8000),
      ],
      baseCtx,
    ).actions
    expect(a.map((x) => x.kind)).toEqual(['timelock_submit', 'timelock_set'])
    expect(a[0].resolution?.how).toBe('accepted')
    expect(a[0]).toMatchObject({ from: '86400', to: '3600' })
    const b = classifyEvents(
      [
        ev('mm', 'SubmitTimelock', { newTimelock: 3600n }, 5),
        ev('mm', 'RevokePendingTimelock', { caller: ALLOC }, 6),
      ],
      baseCtx,
    ).actions
    expect(b[0].resolution?.how).toBe('revoked')
  })
  it('role changes are recorded with who and what', () => {
    const { actions } = classifyEvents(
      [
        ev('mm', 'SetCurator', { newCurator: CURATOR }, 1),
        ev('mm', 'SetIsAllocator', { allocator: ALLOC, isAllocator: false }, 2),
        ev('mm', 'OwnershipTransferred', { previousOwner: ALLOC, newOwner: CURATOR }, 3),
        ev('mm', 'SubmitGuardian', { newGuardian: ALLOC }, 4),
        ev('mm', 'SetGuardian', { caller: CURATOR, guardian: ALLOC }, 9000),
      ],
      baseCtx,
    )
    expect(actions.map((a) => a.kind)).toEqual([
      'curator_set',
      'allocator_set',
      'owner_set',
      'guardian_submit',
      'guardian_set',
    ])
    expect(actions[1]).toMatchObject({ target: ALLOC, to: 'false' })
    expect(actions[3].resolution?.how).toBe('accepted')
  })
  it('skips a duplicated log (same tx and log index)', () => {
    const e = ev('mm', 'SetCurator', { newCurator: CURATOR }, 1)
    const { actions, stats } = classifyEvents([e, { ...e }], baseCtx)
    expect(actions).toHaveLength(1)
    expect(stats.duplicatesSkipped).toBe(1)
  })
})

// ── classifier: Vault V2 ─────────────────────────────────────────────────────

describe('classify — Vault V2', () => {
  const idData = collateralIdData(RSETH)
  const capId = v2IdOf(idData)
  const submitData = (fnSel: string, cap: bigint) =>
    fnSel +
    encodeStatic([
      { type: 'uint256', value: 64n },
      { type: 'uint256', value: cap },
    ]) +
    (idData.slice(2).length / 2).toString(16).padStart(64, '0') +
    idData.slice(2)

  it('Submit(increaseAbsoluteCap) is a collateral-scoped cap_submit with the event executableAt; Accept resolves it', () => {
    const data = submitData('0xf6f98fd5', 1000n)
    const { actions } = classifyEvents(
      [
        ev('v2', 'Submit', { selector: '0xf6f98fd5', data, executableAt: 1_800_000_000n }, 5),
        ev('v2', 'Accept', { selector: '0xf6f98fd5', data }, 9000),
        ev('v2', 'IncreaseAbsoluteCap', { id: capId, idData, newAbsoluteCap: 1000n }, 9000),
      ],
      baseCtx,
    )
    expect(actions.map((a) => a.kind)).toEqual(['cap_submit', 'cap_raise'])
    expect(actions[0]).toMatchObject({
      scope: 'collateral',
      target: capId,
      collateral: [RSETH],
      capType: 'absolute',
      to: '1000',
      validAt: 1_800_000_000,
      validAtSource: 'event',
    })
    expect(actions[0].resolution?.how).toBe('accepted')
  })
  it('DecreaseAbsoluteCap to 0 is cap_zero (immediate, no submit); a relative cap of WAD is labelled uncapped', () => {
    const { actions } = classifyEvents(
      [
        ev('v2', 'IncreaseRelativeCap', { id: capId, idData, newRelativeCap: 10n ** 18n }, 4),
        ev(
          'v2',
          'DecreaseAbsoluteCap',
          { sender: CURATOR, id: capId, idData, newAbsoluteCap: 0n },
          5,
        ),
      ],
      baseCtx,
    )
    expect(actions.map((a) => a.kind)).toEqual(['cap_raise', 'cap_zero'])
    expect(actions[0].note).toMatch(/no relative cap/)
    expect(actions[1]).toMatchObject({ actor: CURATOR, collateral: [RSETH] })
  })
  it('Revoke of a queued cap call records cap_revoke and resolves the submit', () => {
    const data = submitData('0xf6f98fd5', 7n)
    const { actions } = classifyEvents(
      [
        ev('v2', 'Submit', { selector: '0xf6f98fd5', data, executableAt: 1_800_000_000n }, 5),
        ev('v2', 'Revoke', { sender: ALLOC, selector: '0xf6f98fd5', data }, 6),
      ],
      baseCtx,
    )
    expect(actions.map((a) => a.kind)).toEqual(['cap_submit', 'cap_revoke'])
    expect(actions[0].resolution?.how).toBe('revoked')
  })
  it('Allocate/Deallocate count only when the sender is an allocator, and map ids to a market', () => {
    const p = { loanToken: WETH, collateralToken: RSETH, oracle: CURATOR, irm: ALLOC, lltv: 1n }
    const mid = v2IdOf(marketIdData(ALLOC, p))
    const ctx: ClassifyContext = {
      ...baseCtx,
      isV2Allocator: (_v, s) => s === ALLOC,
      v2Ids: { [mid]: { type: 'market', adapter: ALLOC, marketParams: p, market: marketIdOf(p) } },
    }
    const { reallocations, stats } = classifyEvents(
      [
        ev(
          'v2',
          'Deallocate',
          { sender: ALLOC, adapter: ALLOC, assets: 50n, ids: [capId, mid], change: -50n },
          5,
        ),
        ev(
          'v2',
          'Allocate',
          { sender: CURATOR, adapter: ALLOC, assets: 50n, ids: [capId, mid], change: 50n },
          6,
        ),
      ],
      ctx,
    )
    expect(reallocations).toHaveLength(1)
    expect(reallocations[0]).toMatchObject({
      protocol: 'morpho-v2',
      dir: 'out',
      target: marketIdOf(p),
    })
    expect(stats.v2DepositPathAllocations).toBe(1)
  })
})

// ── classifier: Vault V2 market adapter ──────────────────────────────────────

describe('classify — Vault V2 adapter (write-offs)', () => {
  const ADAPTER = '0x6666666666666666666666666666666666666666'
  const burnData = '0x3b2de5ac' + M1.slice(2)
  const ctx: ClassifyContext = {
    ...baseCtx,
    adapterParent: (a) => (a === ADAPTER ? V2V : undefined),
  }
  const adapterEv = (name: string, args: DecodedEvent['args'], block: number) =>
    ev('v2adapter', name, args, block, ADAPTER)

  it('a timelocked burnShares is a pending write-off on the parent vault; BurnShares executes it', () => {
    const { actions } = classifyEvents(
      [
        adapterEv(
          'Submit',
          { selector: '0x3b2de5ac', data: burnData, executableAt: 1_800_000_000n },
          5,
        ),
        adapterEv('Accept', { selector: '0x3b2de5ac', data: burnData }, 9000),
        adapterEv('BurnShares', { marketId: M1, supplyShares: 123n }, 9000),
      ],
      ctx,
    )
    expect(actions.map((a) => a.kind)).toEqual(['writeoff_submit', 'writeoff'])
    expect(actions[0]).toMatchObject({
      vault: V2V,
      via: ADAPTER,
      scope: 'market',
      target: M1,
      collateral: [RSETH],
      validAt: 1_800_000_000,
    })
    expect(actions[0].resolution?.how).toBe('accepted')
    expect(actions[1]).toMatchObject({
      vault: V2V,
      via: ADAPTER,
      target: M1,
      to: '123',
      protocol: 'morpho-v2',
    })
  })
  it('a revoked write-off and adapter timelock changes are recorded against the vault', () => {
    const { actions } = classifyEvents(
      [
        adapterEv(
          'Submit',
          { selector: '0x3b2de5ac', data: burnData, executableAt: 1_800_000_000n },
          5,
        ),
        adapterEv('Revoke', { sender: ALLOC, selector: '0x3b2de5ac', data: burnData }, 6),
        adapterEv('IncreaseTimelock', { selector: '0x3b2de5ac', newDuration: 86_400n }, 7),
      ],
      ctx,
    )
    expect(actions.map((a) => a.kind)).toEqual(['writeoff_submit', 'v2_revoke', 'timelock_set'])
    expect(actions[0].resolution?.how).toBe('revoked')
    expect(actions[2].note).toMatch(/^adapter increase timelock of burnShares/)
    expect(actions.every((a) => a.vault === V2V && a.via === ADAPTER)).toBe(true)
  })
  it('decodeV2Call reads the bytes32 market id of a burnShares call', () => {
    expect(decodeV2Call(burnData)).toMatchObject({ fn: 'burnShares(bytes32)', id: M1 })
  })
})

// ── classifier: Aave ─────────────────────────────────────────────────────────

describe('classify — Aave v3 (protocol-level analogues)', () => {
  const a = (name: string, args: DecodedEvent['args'], b: number) =>
    ev('aave', name, { asset: RSETH, ...args }, b)
  it('cap 0 means NO cap: X → 0 is a raise, 0 → X is a cut; equal values are skipped', () => {
    const { actions } = classifyEvents(
      [
        a('SupplyCapChanged', { oldSupplyCap: 100n, newSupplyCap: 0n }, 1),
        a('SupplyCapChanged', { oldSupplyCap: 0n, newSupplyCap: 100n }, 2),
        a('BorrowCapChanged', { oldBorrowCap: 200n, newBorrowCap: 100n }, 3),
        a('BorrowCapChanged', { oldBorrowCap: 100n, newBorrowCap: 100n }, 4),
      ],
      baseCtx,
    )
    expect(actions.map((x) => [x.kind, x.capType])).toEqual([
      ['cap_raise', 'supply'],
      ['cap_cut', 'supply'],
      ['cap_cut', 'borrow'],
    ])
    expect(actions[0].note).toMatch(/no cap/)
    expect(actions[0]).toMatchObject({
      scope: 'reserve',
      target: RSETH,
      collateral: [RSETH],
      protocol: 'aave-v3',
    })
  })
  it('freeze / pause / borrowing flags, LTV to 0, and repeated identical configs', () => {
    const { actions, stats } = classifyEvents(
      [
        a('ReserveFrozen', { frozen: true }, 1),
        a('ReservePaused', { paused: false }, 2),
        a('ReserveBorrowing', { enabled: false }, 3),
        a(
          'CollateralConfigurationChanged',
          { ltv: 7200n, liquidationThreshold: 7500n, liquidationBonus: 10500n },
          4,
        ),
        a(
          'CollateralConfigurationChanged',
          { ltv: 0n, liquidationThreshold: 7500n, liquidationBonus: 10500n },
          5,
        ),
        a(
          'CollateralConfigurationChanged',
          { ltv: 0n, liquidationThreshold: 7500n, liquidationBonus: 10500n },
          6,
        ),
      ],
      baseCtx,
    )
    expect(actions.map((x) => x.kind)).toEqual([
      'freeze',
      'unpause',
      'borrow_off',
      'collateral_params',
      'ltv_zero',
    ])
    expect(actions[4]).toMatchObject({ from: '7200', to: '0' })
    expect(stats.duplicatesSkipped).toBe(1)
  })
})

// ── status ───────────────────────────────────────────────────────────────────

describe('status', () => {
  const base: FeedAction = {
    id: 'x',
    protocol: 'morpho-v1',
    vault: V,
    kind: 'cap_submit',
    scope: 'market',
    collateral: [],
    block: 1,
    ts: 1000,
    tx: '0x',
    validAt: 2000,
  }
  it('open submit: pending inside the window, executable after it', () => {
    expect(statusOf(base, 1500)).toBe('pending')
    expect(secondsLeft(base, 1500)).toBe(500)
    expect(statusOf(base, 2000)).toBe('executable')
    expect(secondsLeft(base, 2500)).toBe(0)
  })
  it('resolved submits and non-submits are history; a cleared one says so', () => {
    expect(
      statusOf({ ...base, resolution: { how: 'accepted', block: 2, ts: 2, tx: '0x' } }, 1500),
    ).toBe('accepted')
    expect(
      statusOf({ ...base, resolution: { how: 'revoked', block: 2, ts: 2, tx: '0x' } }, 1500),
    ).toBe('revoked')
    expect(statusOf({ ...base, headPending: false }, 1500)).toBe('cleared')
    expect(statusOf({ ...base, kind: 'cap_zero' }, 1500)).toBe('executed')
  })
  it('tone: amber for open, grey for history, red for any cluster member', () => {
    expect(toneOf('pending', false)).toBe('amber')
    expect(toneOf('executable', false)).toBe('amber')
    expect(toneOf('executed', false)).toBe('grey')
    expect(toneOf('executed', true)).toBe('red')
    expect(toneOf('pending', true)).toBe('red')
  })
})
