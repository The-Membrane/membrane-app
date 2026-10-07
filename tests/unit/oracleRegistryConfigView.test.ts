// Config-card payload builder (lib/oracleRegistry/config/view.ts) and its file loader
// (lib/oracleRegistry/config/server.ts): explorer / Safe links, executor replay, timeline
// order and trimming (red rows are never trimmed), head-state counts, the remote-route join,
// power breaches and the header's effective delays — on fixtures, then on the collector's
// committed output.

import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { getConfigCard, getConfigIndex } from '@/lib/oracleRegistry/config/server'
import { getConfigSubjects } from '@/lib/oracleRegistry/config/subjects'
import type {
  ConfigChange,
  ConfigSubject,
  PowerState,
  StateItem,
  SubjectState,
} from '@/lib/oracleRegistry/config/types'
import {
  buildBridge,
  buildConfigCard,
  countsOf,
  delayChips,
  eidPrefix,
  executableBy,
  executorsByTimelock,
  explorerAddressUrl,
  explorerTxUrl,
  HISTORICAL_KEEP,
  latestPeers,
  orderTimeline,
  powerViews,
  requestedAssetSlug,
  routeShape,
  routeSide,
  safeTxUrl,
  signaturesOf,
  subjectSlug,
  subjectSymbol,
  trimTimeline,
} from '@/lib/oracleRegistry/config/view'

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const TX = `0x${'ab'.repeat(32)}`
const OAPP = A(0xaaa)
const OAPP2 = A(0xbbb)
const TL = A(0x71)

const change = (o: Partial<ConfigChange> = {}): ConfigChange => ({
  id: 'c',
  subject: 's',
  dimension: 'bridge',
  key: 'k',
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
  ...o,
})

const item = (o: Partial<StateItem> & Pick<StateItem, 'key' | 'display'>): StateItem => ({
  subject: 's',
  dimension: 'bridge',
  chainId: 1,
  block: 100,
  breaches: [],
  ...o,
})

const route = (
  oapp: string,
  eid: number,
  dir: 'send' | 'receive',
  E: number,
  o: Partial<StateItem> = {},
) =>
  item({
    key: `bridge/lz/1/${oapp}/${eid}/${dir}`,
    display: `eid ${eid} (arbitrum) ${dir}: E=${E} · ${E}-of-${E} (a, b) · 64 conf`,
    value: {
      E,
      live: true,
      operators: ['a', 'b'],
      confirmations: '64',
      required: [],
      optional: [],
    },
    ...o,
  })

describe('links', () => {
  it('explorer by chain; unknown chains and malformed hashes get no link', () => {
    expect(explorerTxUrl(1, TX)).toBe(`https://etherscan.io/tx/${TX}`)
    expect(explorerTxUrl(42161, TX)).toBe(`https://arbiscan.io/tx/${TX}`)
    expect(explorerTxUrl(999_999, TX)).toBeNull()
    expect(explorerTxUrl(1, '0x12')).toBeNull()
    expect(explorerAddressUrl(8453, OAPP)).toBe(`https://basescan.org/address/${OAPP}`)
    expect(explorerAddressUrl(1, A(0))).toBeNull()
  })

  it('Safe transaction link uses the checksummed Safe address', () => {
    const safe = '0x3b0aaf6e6fcd4a7ceef8c92c32dfea9e64dc1862'
    const url = safeTxUrl(safe, TX)!
    expect(url).toContain(`safe=eth:${getAddress(safe)}&`)
    expect(url).toContain(`multisig_${getAddress(safe)}_${TX}`)
    expect(getAddress(safe)).not.toBe(safe)
    expect(safeTxUrl('nope', TX)).toBeNull()
  })

  it('subject slug and symbol', () => {
    expect(subjectSlug({ key: 'rseth', oracleAssetKey: null })).toBe('rseth')
    expect(subjectSlug({ key: 'pt-srusde', oracleAssetKey: 'PT-srUSDe-22OCT2026' })).toBe(
      'pt-srusde-22oct2026',
    )
    expect(subjectSymbol('PT-srUSDe (Pendle × Strata)')).toBe('PT-srUSDe')
  })
})

describe('executors (who can execute a pending timelock op)', () => {
  const grant = (to: string, desc: string, block: number) =>
    change({
      id: `g${block}`,
      dimension: 'admin',
      key: `admin/role/${TL}/EXECUTOR_ROLE`,
      title: `EXECUTOR_ROLE granted to ${desc} on 0x0000…0071`,
      after: to,
      block,
    })
  const revoke = (from: string, block: number) =>
    change({
      id: `r${block}`,
      dimension: 'admin',
      key: `admin/role/${TL}/EXECUTOR_ROLE`,
      title: `EXECUTOR_ROLE revoked from ${from.slice(0, 6)} on 0x0000…0071`,
      before: from,
      block,
    })

  it('replays grants and revokes in block order', () => {
    const ex = executorsByTimelock([
      revoke(A(1), 30),
      grant(A(1), 'EOA 0x0000…0001', 10),
      grant(A(2), 'Safe 3-of-6 0x0000…0002', 20),
    ])
    expect(executableBy(TL, ex)).toBe('Safe 3-of-6 0x0000…0002')
  })

  it('EXECUTOR_ROLE to address 0 means anyone can execute', () => {
    const ex = executorsByTimelock([grant(A(0), 'renounced (address 0)', 5)])
    expect(executableBy(TL, ex)).toBe('anyone (open execution)')
  })

  it('no role events ⇒ null (the card says "executor not read", never a guess)', () => {
    expect(executableBy(TL, executorsByTimelock([]))).toBeNull()
  })

  it('reads Safe signature progress from the proposal note', () => {
    expect(
      signaturesOf(['Safe 0x3b0aaf6e… nonce 740: 2/5 signatures (schedules a timelock op)']),
    ).toBe('2/5')
    expect(signaturesOf(['nothing'])).toBeNull()
  })
})

describe('timeline order and trimming', () => {
  const v = (o: Record<string, unknown>) =>
    ({
      id: 'x',
      state: 'historical',
      stage: null,
      eta: null,
      ts: null,
      block: null,
      red: false,
      stillInEffect: false,
      ...o,
    }) as never

  it('pending (armed, then by ETA, stale last) → proposed (newest) → historical (newest)', () => {
    const ordered = orderTimeline([
      v({ id: 'h1', block: 10 }),
      v({ id: 'h2', block: 20 }),
      v({ id: 'p-stale', state: 'pending', stage: 'stale', eta: 1 }),
      v({ id: 'p-late', state: 'pending', stage: 'scheduled', eta: 900 }),
      v({ id: 'q-old', state: 'proposed', ts: 1 }),
      v({ id: 'p-armed', state: 'pending', stage: 'armed', eta: 5 }),
      v({ id: 'p-soon', state: 'pending', stage: 'scheduled', eta: 600 }),
      v({ id: 'q-new', state: 'proposed', ts: 9 }),
    ]) as { id: string }[]
    expect(ordered.map((r) => r.id)).toEqual([
      'p-armed',
      'p-soon',
      'p-late',
      'p-stale',
      'q-new',
      'q-old',
      'h2',
      'h1',
    ])
  })

  it('keeps every red and still-in-effect row, trims only quiet history', () => {
    const rows = [
      v({ id: 'p', state: 'pending' }),
      ...Array.from({ length: 5 }, (_, i) => v({ id: `q${i}` })),
      v({ id: 'red-old', red: true }),
      v({ id: 'live-old', stillInEffect: true }),
    ]
    const t = trimTimeline(rows, 2)
    expect((t.rows as { id: string }[]).map((r) => r.id)).toEqual([
      'p',
      'q0',
      'q1',
      'red-old',
      'live-old',
    ])
    expect(t.historicalTotal).toBe(7)
    expect(t.historicalShown).toBe(4)
  })
})

describe('countsOf', () => {
  it('stale ops are not pending; red queued and red in effect are counted apart', () => {
    const c = countsOf(
      [
        item({ key: 'a', display: 'a', breaches: [{ ruleId: 'BR-2', message: 'floor' }] }),
        item({
          key: 'b',
          display: 'b',
          breaches: [
            { ruleId: 'AD-3', message: 'eoa' },
            { ruleId: 'AD-6', message: 'm' },
          ],
        }),
      ],
      [
        change({ state: 'pending', stage: 'armed', red: true }),
        change({ state: 'pending', stage: 'scheduled' }),
        change({ state: 'pending', stage: 'stale', red: true }),
        change({ state: 'proposed', stage: 'safe_queued', red: true }),
        change({ red: true, stillInEffect: true }),
        change({ red: true }),
        change(),
      ],
    )
    expect(c).toEqual({
      unread: 0,
      readGaps: 0,
      floorBreaches: 1,
      ruleBreaches: 2,
      redInEffect: 1,
      // the red STALE op is still queued: it is an open red flag (review fix 2026-10-06)
      redOpen: 3,
      openRed: 7,
      redTotal: 5,
      pending: 2,
      armed: 1,
      stale: 1,
      proposed: 1,
      // review round 6: fully signed Safe proposals are counted apart (none here)
      armedProposed: 0,
      historical: 3,
    })
  })
})

describe('route display parsing', () => {
  it('eid prefix and shape / confirmations', () => {
    expect(eidPrefix('eid 30110 (arbitrum) remote receive: E=4 · 4-of-4 (a) · 64 conf')).toEqual({
      eid: 30110,
      chainKey: 'arbitrum',
    })
    expect(
      routeShape('eid 30243 (blast) receive: E=4 · 2 required + 2-of-3 optional (a, b) · 15 conf'),
    ).toEqual({ shape: '2 req + 2-of-3 opt', confirmations: '15' })
    expect(routeShape('eid 30214 (scroll) send: blocked (dead_dvn)')).toEqual({
      shape: 'blocked',
      confirmations: null,
    })
    expect(routeShape('eid 1 (x) send: BlockedMessageLib (route closed)').shape).toBe('closed')
  })
})

describe('buildBridge — local + remote sides', () => {
  const peerChange = (oapp: string, eid: number, peer: string, block: number) =>
    change({
      id: `peer-${oapp}-${eid}-${block}`,
      route: { chainId: 1, oapp, eid, direction: 'receive' },
      after: { peer: `0x${'0'.repeat(24)}${peer.slice(2)}` },
      block,
    })
  const remote = (chainId: number, peer: string, eid: number, dir: 'send' | 'receive', E: number) =>
    item({
      chainId,
      key: `bridge/lz/${chainId}/${peer}/30101/${dir}`,
      display: `eid ${eid} (arbitrum) remote ${dir}: E=${E} · ${E}-of-${E} (a) · 64 conf`,
      value: { E, live: true, operators: ['a'] },
      breaches: E < 2 ? [{ ruleId: 'BR-2', message: 'live route at E=1 (< 2)' }] : [],
    })
  const powers: PowerState[] = [
    {
      power: 'bridge_config',
      label: 'OFTAdapter owner (peers, delegate)',
      contract: OAPP,
      holders: [{ kind: 'safe', address: A(0x5afe), threshold: 3, signers: 6 }],
      effectiveDelaySec: 0,
      weakest: null,
      pendingObservable: false,
    },
    {
      power: 'bridge_config',
      label: 'OFTAdapter LZ delegate (DVN config)',
      contract: OAPP,
      holders: [{ kind: 'eoa', address: A(0xe0a) }],
      effectiveDelaySec: 0,
      weakest: null,
      pendingObservable: false,
    },
  ]

  it('joins a remote read to its OApp through the latest peer, even when two OApps share the eid', () => {
    const R1 = A(0xf1)
    const R2 = A(0xf2)
    const b = buildBridge(
      [
        route(OAPP, 30110, 'receive', 4),
        route(OAPP2, 30110, 'receive', 3),
        remote(42161, R2, 30110, 'receive', 1),
        remote(42161, R1, 30110, 'receive', 4),
      ],
      powers,
      [
        peerChange(OAPP, 30110, A(0xdead), 1),
        peerChange(OAPP, 30110, R1, 2),
        peerChange(OAPP2, 30110, R2, 3),
      ],
      [OAPP, OAPP2],
      (eid, f) => (eid === 30110 ? 'Arbitrum' : (f ?? '')),
    )
    expect(b.warnings).toEqual([])
    const [o1, o2] = b.oapps
    expect(o1.routes[0].remote?.address).toBe(R1)
    expect(o1.routes[0].floorBreach).toBe(false)
    // the remote side under the floor makes the whole route red, though Ethereum shows E=3
    expect(o2.routes[0].remote?.receive?.E).toBe(1)
    expect(o2.routes[0].floorBreach).toBe(true)
    expect(o2.routes[0].minE).toBe(1)
    expect(o2.routes[0].chain).toBe('Arbitrum')
    expect(o1.owner.map((h) => h.label)).toEqual(['Safe 3-of-6 0x0000…5afe'])
    expect(o1.delegate.map((h) => h.label)).toEqual(['EOA 0x0000…0e0a'])
  })

  it('REMOTE UNREAD attaches by (eid, local OApp); an unmatchable remote read is reported', () => {
    const b = buildBridge(
      [
        route(OAPP, 30335, 'receive', 4),
        route(OAPP2, 30335, 'receive', 4),
        item({
          key: `bridge/lz/remote/30335/${OAPP}`,
          chainId: 1923,
          display: 'eid 30335 (swell) remote side: REMOTE UNREAD — no working public RPC',
          warnings: ['REMOTE UNREAD'],
        }),
        remote(1923, A(0x99), 30335, 'receive', 4),
      ],
      [],
      [],
      [OAPP, OAPP2],
      (_e, f) => f ?? '',
    )
    expect(b.oapps[0].routes[0].remote?.unread).toBe('no working public RPC')
    expect(b.oapps[0].remoteUnread).toBe(1)
    expect(b.warnings).toHaveLength(1)
  })

  it('latestPeers keeps the newest peer per (oapp, eid)', () => {
    const p = latestPeers([peerChange(OAPP, 1, A(2), 9), peerChange(OAPP, 1, A(1), 3)])
    expect(p.get(`${OAPP}|1`)).toBe(A(2).slice(-40))
  })

  it('live routes sort before closed; floor breaches first', () => {
    const b = buildBridge(
      [
        route(OAPP, 30101, 'receive', 4, { value: { E: 0, live: false } }),
        route(OAPP, 30184, 'receive', 4),
        route(OAPP, 30320, 'receive', 1, {
          breaches: [{ ruleId: 'BR-2', message: 'live route at E=1 (< 2)' }],
        }),
      ],
      [],
      [],
      [OAPP],
      (_e, f) => f ?? '',
    )
    expect(b.oapps[0].routes.map((r) => r.eid)).toEqual([30320, 30184, 30101])
    expect(b.oapps[0]).toMatchObject({ liveRoutes: 2, closedRoutes: 1 })
  })
})

describe('admin powers and delays', () => {
  const p = (o: Partial<PowerState>): PowerState => ({
    power: 'upgrade',
    label: 'Upgrade',
    contract: A(1),
    holders: [{ kind: 'oz_timelock', address: TL, delaySec: 864000 }],
    effectiveDelaySec: 864000,
    weakest: null,
    pendingObservable: true,
    ...o,
  })

  it('maps state breaches to powers by emission order, even with duplicate keys', () => {
    const powers = [
      p({ power: 'roles', label: 'owner' }),
      p({ power: 'roles', label: 'blacklister' }),
    ]
    const items = [
      item({ dimension: 'admin', key: `admin/power/roles/${A(1)}`, display: 'owner' }),
      item({
        dimension: 'admin',
        key: `admin/power/roles/${A(1)}`,
        display: 'blacklister',
        breaches: [{ ruleId: 'AD-3', message: 'blacklister held by EOA' }],
      }),
    ]
    const v = powerViews(powers, items)
    expect(v[0].breaches).toEqual([])
    expect(v[1].breaches).toEqual([{ ruleId: 'AD-3', message: 'blacklister held by EOA' }])
  })

  it('effective delay = the shortest per kind; immutable is the strongest; INSTANT wording', () => {
    const chips = delayChips([
      p({ effectiveDelaySec: -1 }),
      p({ effectiveDelaySec: 864000 }),
      p({ power: 'mint', effectiveDelaySec: 0, pendingObservable: false }),
      p({ power: 'mint', effectiveDelaySec: 3600 }),
    ])
    expect(chips.map((c) => [c.power, c.delayLabel, c.pendingObservable, c.powers])).toEqual([
      ['upgrade', '10d', true, 2],
      ['mint', 'INSTANT', false, 2],
    ])
    expect(delayChips([p({ effectiveDelaySec: -1 })])[0].delayLabel).toBe('immutable')
  })
})

describe('buildConfigCard (fixture)', () => {
  const subject: ConfigSubject = {
    key: 'demo',
    label: 'DEMO (Issuer)',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      {
        role: 'oft_adapter',
        dimension: 'bridge',
        chainId: 1,
        address: OAPP,
        label: 'DEMO OFTAdapter',
        deployBlock: 1,
      },
    ],
    lzOApps: [OAPP],
    ccipPools: [],
    powers: [],
    params: [],
    timelocks: [TL],
    safes: [],
    govChannels: [],
  }
  const state: SubjectState = {
    version: 1,
    subject: 'demo',
    label: 'DEMO (Issuer)',
    oracleAssetKey: null,
    chainId: 1,
    asOf: { block: 200, ts: 2_000 },
    scan: { from: 1, to: 200 },
    govChannels: [],
    announcement: 'no_gov_channel',
    proposedSources: [{ kind: 'snapshot', status: 'not_ingested' }],
    powers: [],
    items: [
      route(OAPP, 30320, 'receive', 1, {
        breaches: [{ ruleId: 'BR-2', message: 'live route at E=1 (< 2)' }],
      }),
    ],
    counts: { red: 0, pending: 0, proposed: 0, historical: 0, floorBreaches: 1 },
    warnings: [],
  }
  const changes = [
    ...Array.from({ length: HISTORICAL_KEEP + 5 }, (_, i) =>
      change({ id: `q${i}`, block: 1000 - i, tx: TX }),
    ),
    change({
      id: 'kelp',
      block: 1,
      red: true,
      floorBreach: true,
      ruleIds: ['BR-2'],
      route: { chainId: 1, oapp: OAPP, eid: 30320, direction: 'receive' },
      announcement: 'no_gov_channel',
    }),
  ]

  it('keeps the oldest red row although it is past the quiet-row budget', () => {
    const card = buildConfigCard({ subject, state, changes, queue: [] })
    expect(card.timeline.rows.some((r) => r.id === 'kelp')).toBe(true)
    expect(card.timeline.complete).toBe(false)
    expect(card.timeline.historicalShown).toBe(HISTORICAL_KEEP + 1)
    const all = buildConfigCard({ subject, state, changes, queue: [] }, { keep: 'all' })
    expect(all.timeline.complete).toBe(true)
  })

  it('carries the floor breach to the banner, the counts, the rules legend and the route', () => {
    const card = buildConfigCard({ subject, state, changes, queue: [] })
    expect(card.counts.floorBreaches).toBe(1)
    expect(card.breaches).toEqual([
      expect.objectContaining({ ruleId: 'BR-2', dimension: 'bridge' }),
    ])
    expect(Object.keys(card.rules)).toEqual(['BR-2'])
    expect(card.bridge.oapps[0].label).toBe('DEMO OFTAdapter')
    expect(card.bridge.oapps[0].routes[0].floorBreach).toBe(true)
    expect(card.announcement).toBe('no_gov_channel')
    expect(card.slug).toBe('demo')
    expect(card.oracleSlug).toBeNull()
  })

  it('missing collector output renders as unavailable, never a throw', () => {
    const card = buildConfigCard({ subject, state: null, changes: [], queue: [] })
    expect(card.available).toBe(false)
    expect(card.timeline.rows).toEqual([])
  })
})

describe('collector output (data/oracle-registry/config)', () => {
  const index = getConfigIndex()

  it('lists every subject; rsETH is a config-only tab', () => {
    expect(index.subjects.map((s) => s.subject)).toEqual(
      expect.arrayContaining(['rseth', 'weeth', 'usde', 'wbtc', 'cbbtc', 'pt-srusde']),
    )
    const rs = index.subjects.find((s) => s.subject === 'rseth')!
    expect(rs.slug).toBe('rseth')
    expect(rs.oracleSlug).toBeNull()
  })

  for (const s of index.subjects) {
    it(`${s.subject}: every red row survives trimming; no row claims an announcement`, () => {
      const card = getConfigCard(s.slug)!
      const all = getConfigCard(s.slug, { keep: 'all' })!
      const kept = new Set(card.timeline.rows.map((r) => r.id))
      for (const r of all.timeline.rows) {
        if (r.red || r.state !== 'historical') expect(kept.has(r.id)).toBe(true)
        expect(r.unannounced).toBeNull()
      }
      expect(all.timeline.rows.length).toBe(
        card.counts.pending +
          card.counts.stale +
          card.counts.proposed +
          card.timeline.historicalTotal,
      )
      // every remote read joined to a local OApp
      expect(card.warnings.filter((w) => w.startsWith('remote read'))).toEqual([])
      // chain names are capitalised although LZ metadata mixes "Arbitrum" with "bera"
      for (const o of card.bridge.oapps)
        for (const r of o.routes) expect(r.chain).toMatch(/^([A-Z0-9]|eid \d)/)
      for (const r of all.timeline.rows)
        if (r.route) expect(r.route.chain).toMatch(/^([A-Z0-9]|eid \d)/)
    })
  }

  it('pending timelock rows carry an ETA and name who can execute them', () => {
    let n = 0
    for (const s of index.subjects) {
      const card = getConfigCard(s.slug)!
      for (const r of card.timeline.rows.filter(
        (x) => x.state === 'pending' && x.queue?.kind === 'oz_timelock',
      )) {
        n++
        expect(r.eta).not.toBeNull()
        expect(r.executableBy).toEqual(expect.any(String))
      }
    }
    expect(n).toBeGreaterThan(0)
  })

  it('the open-execution Strata op reads "anyone"; Safe queue rows carry a Safe link', () => {
    const pt = index.subjects.find((s) => s.subject === 'pt-srusde')
    // Conditional: the op leaves the queue once someone executes it (a re-collect drops it).
    const armed = getConfigCard(pt!.slug)!.timeline.rows.filter((r) => r.stage === 'armed')
    expect(armed.every((r) => r.executableBy === 'anyone (open execution)')).toBe(true)
    for (const s of index.subjects)
      for (const r of getConfigCard(s.slug)!.timeline.rows.filter((x) => x.state === 'proposed'))
        expect(r.queue?.url).toMatch(/^https:\/\/app\.safe\.global\/transactions\/tx\?safe=eth:/)
  })
})

describe('review fixes 2026-10-06 (view)', () => {
  it("?asset=<subject key> opens that subject's oracle asset, not the default", () => {
    const s = getConfigSubjects().subjects.find((x) => x.key === 'pt-srusde')!
    expect(requestedAssetSlug('pt-srusde', s)).toBe('pt-srusde-22oct2026')
    expect(requestedAssetSlug('eth', null)).toBe('eth')
  })

  it('a red op past its ETA (stale) still counts as an open red flag', () => {
    const c = countsOf([], [change({ state: 'pending', stage: 'stale', red: true })])
    expect(c.stale).toBe(1)
    expect(c.redOpen).toBe(1)
    expect(c.openRed).toBe(1)
  })

  it('an UNREAD local or remote side is unread, not a closed side', () => {
    const local = routeSide(
      item({
        key: `bridge/lz/1/${A(1)}/30110/receive`,
        display: 'eid 30110 (arbitrum) receive: config UNREAD — HTTP 503',
        warnings: ['UNREAD'],
      }),
      'receive',
    )
    expect(local.unread).toBe('HTTP 503')
    const remote = routeSide(
      item({
        key: `bridge/lz/42161/${A(2)}/30101/send`,
        display: 'eid 30110 (arbitrum) remote send: REMOTE UNREAD — send config read failed',
        warnings: ['REMOTE UNREAD'],
      }),
      'send',
    )
    expect(remote.unread).toBe('send config read failed')
    const b = buildBridge(
      [
        item({
          key: `bridge/lz/1/${A(1)}/30110/receive`,
          display: 'eid 30110 (arbitrum) receive: config UNREAD — HTTP 503',
          warnings: ['UNREAD'],
        }),
      ],
      [],
      [],
      [A(1)],
      (e) => String(e),
    )
    expect(b.oapps[0].routes[0].live).toBe(true) // kept open, never folded away as closed
  })
})
