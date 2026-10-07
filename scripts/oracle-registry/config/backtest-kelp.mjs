#!/usr/bin/env node
// Kelp rsETH LayerZero config backtest (REGRESSION test — see lib/oracleRegistry/config/backtest.ts).
//
//   node scripts/oracle-registry/config/backtest-kelp.mjs                  # offline, from the fixture
//   node scripts/oracle-registry/config/backtest-kelp.mjs --build-fixture  # re-read the chain (network)
//   node scripts/oracle-registry/config/backtest-kelp.mjs --base-rate      # every OApp at the eval block (network)
//   node scripts/oracle-registry/config/backtest-kelp.mjs --value-at-eval  # the route's value at risk (network)
//
// Severity rank (owner ruling 2026-10-06 #9) needs the registry's consensus AT the evaluation
// block: data/oracle-registry/config/backtest/registry-at-eval.json, an archive snapshot made by
// `node scripts/oracle-registry/collect.mjs --at-block=24908284` (moved out of snapshots/).
//
// Fixture: data/oracle-registry/config/backtest/kelp-rseth.fixture.json (committed, compact).
// Output:  data/oracle-registry/config/backtest/kelp-rseth.expected.json (summary + criteria).
//
// The rules know nothing about Kelp. This script only CHOOSES what to evaluate: the rsETH
// OFTAdapter, the evaluation block 24,908,284 (the last block before the 2026-04-18 17:35:35
// UTC exploit) and the criteria of docs/research/CONFIG-CARDS-DESIGN.md §5.
// RPC: RECORDER_RPC_URL (keyed; never printed). Unichain: public RPCs from LZ metadata.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from '../../lib/venue-reads.mjs'
import { guardProcessErrors } from '../lib/readers.mjs'
import {
  ETH,
  clientForChain,
  compactLzMetadata,
  fetchLzMetadata,
  firstCodeBlocks,
  pruneDefaults,
  readRoute,
  scanLzConfig,
} from './lib/lz.mjs'
import { FN, TOPIC, fnAbi, lzEventsOf } from './lib/abi.mjs'
import {
  blockTimestamps,
  codeAt,
  ethereumClients,
  pool,
  retry,
  scanLogs,
  tryRead,
} from './lib/rpc.mjs'
import { seedLzState } from './lib/seed.mjs'
import { loadTs } from './lib/ts.mjs'

guardProcessErrors('oracle-registry backtest-kelp')

export const KELP = {
  subject: 'rseth',
  oapp: '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3',
  exploitedEid: 30320, // Unichain → Ethereum
  controlEid: 30325, // Movement: set 2-of-2 before its peer — no red DVN change (its peer re-point is red: BR-6)
  evalBlock: 24_908_284, // last block before the exploit tx (block 24,908,285)
  cutoffTs: Date.UTC(2026, 3, 18, 17, 35, 35) / 1000,
  pointReadBlocks: [24_907_000, 24_908_284],
  remoteWindow: { from: 12_735_000, to: 12_835_000 }, // Unichain, around the route's creation
}

const DIR = join(ROOT, 'data', 'oracle-registry', 'config')
const FIXTURE = join(DIR, 'backtest', 'kelp-rseth.fixture.json')
const OUT = join(DIR, 'backtest', 'kelp-rseth.expected.json')
const CACHE = join(DIR, '.cache')
const log = (...a) => console.error(...a)

async function buildFixture() {
  mkdirSync(CACHE, { recursive: true })
  const { state, logs } = ethereumClients()
  const head = Number(await retry(() => state.getBlockNumber())) - 5
  log(
    `head ${head}; scanning Ethereum LZ config for the rsETH adapter from ${ETH.endpointDeployBlock}`,
  )
  let events = await scanLzConfig({
    client: logs,
    chainId: 1,
    endpoint: ETH.endpoint,
    libs: [ETH.sendUln302, ETH.receiveUln302],
    oapps: [KELP.oapp],
    from: ETH.endpointDeployBlock,
    to: head,
    cacheDir: CACHE,
    log,
  })
  events = pruneDefaults(events)
  const ts = await blockTimestamps(
    state,
    events.map((e) => e.block),
    join(CACHE, 'ts-1.json'),
  )
  for (const e of events) e.ts = ts[e.block]
  log(`  ${events.length} LZ events kept`)

  const eids = new Set(events.map((e) => e.eid).filter((x) => x !== undefined))
  eids.add(30101)
  eids.add(KELP.exploitedEid)
  const raw = await fetchLzMetadata(CACHE)
  const metadata = compactLzMetadata(raw, eids, new Date().toISOString())

  // DVN code at the first block each DVN is referenced (BR-4 / "known as of block").
  const firstUse = new Map()
  for (const e of events)
    for (const a of [...(e.config?.requiredDVNs ?? []), ...(e.config?.optionalDVNs ?? [])])
      firstUse.set(a, Math.min(firstUse.get(a) ?? Infinity, e.block))
  const codeProbes = await firstCodeBlocks(
    state,
    [...firstUse.keys()],
    (a) => firstUse.get(a),
    head,
  )

  const pointReads = []
  for (const block of KELP.pointReadBlocks)
    for (const direction of ['receive', 'send']) {
      const r = await readRoute(state, {
        endpoint: ETH.endpoint,
        oapp: KELP.oapp,
        eid: KELP.exploitedEid,
        direction,
        block,
      })
      pointReads.push({ block, eid: KELP.exploitedEid, direction, lib: r.lib, merged: r.merged })
    }

  // Remote (Unichain) side of the exploited route: seed + event window + a read at eval time.
  let remote
  const uni = metadata.chains[KELP.exploitedEid]
  const peerEv = events
    .filter((e) => e.kind === 'peer' && e.eid === KELP.exploitedEid && e.block <= KELP.evalBlock)
    .pop()
  const peer = peerEv ? '0x' + peerEv.peer.slice(-40) : null
  const uc =
    uni && peer ? await clientForChain(uni, { archiveBlock: KELP.remoteWindow.from }) : null
  if (uc) {
    log(`Unichain peer ${peer}: seeding at ${KELP.remoteWindow.from - 1}, scanning the window`)
    const seed = await seedLzState(uc, {
      chainId: uni.chainId,
      endpoint: uni.endpoint,
      oapp: peer,
      eids: [30101],
      block: KELP.remoteWindow.from - 1,
    })
    let rev = await scanLzConfig({
      client: uc,
      chainId: uni.chainId,
      endpoint: uni.endpoint,
      libs: [...uni.libs.send, ...uni.libs.receive],
      oapps: [peer],
      from: KELP.remoteWindow.from,
      to: KELP.remoteWindow.to,
      cacheDir: CACHE,
      span: 5_000,
      log,
    })
    rev = rev.filter((e) => e.oapp || e.eid === 30101)
    const rts = await blockTimestamps(
      uc,
      rev.map((e) => e.block),
      join(CACHE, `ts-${uni.chainId}.json`),
    )
    for (const e of rev) e.ts = rts[e.block]
    // Remote block at the local evaluation block's timestamp (bisection on block timestamps).
    const evalTs = Number((await state.getBlock({ blockNumber: BigInt(KELP.evalBlock) })).timestamp)
    let lo = KELP.remoteWindow.to
    let hi = Number(await uc.getBlockNumber())
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2)
      const t = Number((await retry(() => uc.getBlock({ blockNumber: BigInt(m) }))).timestamp)
      if (t <= evalTs) lo = m
      else hi = m
    }
    const reads = []
    for (const direction of ['send', 'receive']) {
      const r = await readRoute(uc, {
        endpoint: uni.endpoint,
        oapp: peer,
        eid: 30101,
        direction,
        block: lo,
      })
      reads.push({ block: lo, eid: 30101, direction, lib: r.lib, merged: r.merged })
    }
    const rFirst = new Map()
    for (const e of rev)
      for (const a of [...(e.config?.requiredDVNs ?? []), ...(e.config?.optionalDVNs ?? [])])
        rFirst.set(a, Math.min(rFirst.get(a) ?? Infinity, e.block))
    for (const lib of Object.values(seed.overrides))
      for (const cfgs of Object.values(lib))
        for (const c of Object.values(cfgs))
          for (const a of [...c.requiredDVNs, ...c.optionalDVNs])
            rFirst.set(a, Math.min(rFirst.get(a) ?? Infinity, KELP.remoteWindow.from))
    for (const r of reads)
      for (const a of [...(r.merged?.requiredDVNs ?? []), ...(r.merged?.optionalDVNs ?? [])])
        rFirst.set(a, Math.min(rFirst.get(a) ?? Infinity, lo))
    const rProbes = await firstCodeBlocks(uc, [...rFirst.keys()], (a) => rFirst.get(a), lo)
    remote = {
      chainId: uni.chainId,
      eid: KELP.exploitedEid,
      localEid: 30101,
      peer,
      window: KELP.remoteWindow,
      seed,
      events: rev,
      codeProbes: rProbes,
      evalRead: { block: lo, reads },
    }
  } else log('Unichain: no working public RPC — remote side omitted (REMOTE UNREAD)')

  const fixture = {
    version: 1,
    subject: KELP.subject,
    oapp: KELP.oapp,
    builtAt: new Date().toISOString(),
    notes: [
      'Events: Ethereum EndpointV2 / SendUln302 / ReceiveUln302 / adapter, topic-filtered, from the Endpoint deploy block; defaults kept only for eids the adapter uses.',
      'Metadata: LZ /v1/metadata at build time. The engine uses operator identity only; `deprecated` is ignored in the backtest (hindsight).',
      'Remote: Unichain peer seeded by point reads at the window start, then the window events.',
    ],
    metadata,
    local: {
      chainId: 1,
      scan: { from: ETH.endpointDeployBlock, to: head },
      events,
      codeProbes,
      pointReads,
    },
    remote,
  }
  mkdirSync(join(DIR, 'backtest'), { recursive: true })
  writeFileSync(FIXTURE, JSON.stringify(fixture) + '\n')
  log(`fixture written: ${events.length} local events, ${remote?.events.length ?? 0} remote events`)
}

export async function runBacktest(fx) {
  const bt = await loadTs('../../../../lib/oracleRegistry/config/backtest.ts')
  const out = bt.runLzBacktest(fx, KELP.evalBlock)
  const criteria = bt.kelpCriteria(out, KELP)
  // honest framing (owner ruling 2026-10-06): red for how long, next to the base rate and the
  // severity rank by value at risk (round 2 #9)
  let base = null
  try {
    base = JSON.parse(readFileSync(join(DIR, 'backtest', 'kelp-rseth.base-rate.json'), 'utf8'))
  } catch {
    /* no base-rate study on disk: the framing says so */
  }
  const framing = bt.kelpFraming(criteria, KELP, base, bt.kelpSeverity(fx, base))
  return { out, criteria, framing }
}

/** Registry consensus (USD) per catalog asset at the evaluation block, from the archive snapshot. */
async function consensusAtEval() {
  const f = join(DIR, 'backtest', 'registry-at-eval.json')
  if (!existsSync(f))
    return { prices: {}, basis: 'registry snapshot at the evaluation block missing' }
  const snap = JSON.parse(readFileSync(f, 'utf8'))
  const cls = await loadTs('../../../../lib/oracleRegistry/classify.ts')
  const cat = await loadTs('../../../../lib/oracleRegistry/catalog.ts')
  const catalog = cat.getOracleCatalog()
  const board = cls.evaluateSnapshot(catalog, snap)
  const prices = {}
  for (const a of board.assets)
    prices[a.asset] = a.consensus.status === 'ok' ? a.consensus.price : null
  const tokens = {}
  for (const a of catalog.assets) if (a.token) tokens[a.token.toLowerCase()] = a.key
  return { prices, tokens, basis: `registry consensus at block ${snap.block}` }
}

/** The subject's price at the evaluation block: ETH consensus × LRTOracle.rsETHPrice(). */
async function subjectPriceAtEval(state, cons) {
  const subjects = JSON.parse(readFileSync(join(DIR, 'subjects.json'), 'utf8')).subjects
  const v = subjects.find((s) => s.key === KELP.subject)?.valuation
  if (!v) return { priceUsd: null, priceBasis: 'no valuation for the subject' }
  const usd = cons.prices[v.asset] ?? null
  let rate
  let note = ''
  if (v.rate) {
    const fn = v.rate.sig.match(/function (\w+)/)[1]
    const r = await tryRead(state, v.rate.contract, fnAbi(v.rate.sig), fn, [], KELP.evalBlock)
    rate = r.ok ? { raw: String(r.value), decimals: v.rate.decimals } : null
    note = ` × ${fn}() at block ${KELP.evalBlock}${r.ok ? '' : ' (NOT READ)'}`
  }
  const value = await loadTs('../../../../lib/oracleRegistry/config/value.ts')
  return { priceUsd: value.tokenPriceUsd(usd, rate), priceBasis: `${v.asset} ${cons.basis}${note}` }
}

/** Locked balance of an OFT adapter at a block: { token, amount } | { note }. */
async function lockedAt(state, oapp, block) {
  const t = await tryRead(state, oapp, fnAbi(FN.token), 'token', [], block)
  if (!t.ok) return { token: null, amount: null, note: t.reverted ? 'not an OFT adapter' : t.error }
  const token = String(t.value).toLowerCase()
  if (token === oapp.toLowerCase())
    return { token, amount: null, note: 'native OFT: nothing locked' }
  const b = await tryRead(state, token, fnAbi(FN.balanceOf), 'balanceOf', [oapp], block)
  const d = await tryRead(state, token, fnAbi(FN.decimals), 'decimals', [], block)
  return b.ok && d.ok
    ? { token, amount: { raw: String(b.value), decimals: Number(d.value) } }
    : { token, amount: null, note: b.ok ? d.error : b.error }
}

/**
 * --value-at-eval (network): the exploited route's value at risk at the evaluation block — the
 * adapter's locked rsETH on Ethereum and the Unichain peer's supply — priced with the registry
 * consensus at that block × the protocol's rsETH/ETH rate. Written into the fixture (`value`).
 */
async function buildValueAtEval(fx) {
  const { state } = ethereumClients()
  const cons = await consensusAtEval()
  const price = await subjectPriceAtEval(state, cons)
  const l = await lockedAt(state, KELP.oapp, KELP.evalBlock)
  const notes = []
  if (!l.amount) notes.push(`Ethereum locked balance: ${l.note}`)
  let remoteSupply = null
  const raw = await fetchLzMetadata(CACHE)
  const meta = compactLzMetadata(raw, new Set([KELP.exploitedEid]), new Date().toISOString())
  const uni = meta.chains[KELP.exploitedEid]
  if (fx.remote?.evalRead && uni) {
    const uc = await clientForChain(uni, { archiveBlock: fx.remote.evalRead.block })
    if (uc) {
      const sup = await tryRead(
        uc,
        fx.remote.peer,
        fnAbi(FN.totalSupply),
        'totalSupply',
        [],
        fx.remote.evalRead.block,
      )
      const dec = await tryRead(
        uc,
        fx.remote.peer,
        fnAbi(FN.decimals),
        'decimals',
        [],
        fx.remote.evalRead.block,
      )
      if (sup.ok && dec.ok) remoteSupply = { raw: String(sup.value), decimals: Number(dec.value) }
      else notes.push(`Unichain supply not read (${sup.ok ? dec.error : sup.error})`)
    } else notes.push('Unichain: no archive RPC')
  }
  fx.value = {
    block: KELP.evalBlock,
    locked: l.amount,
    remoteSupply,
    priceUsd: price.priceUsd,
    priceBasis: price.priceBasis,
    notes,
  }
  writeFileSync(FIXTURE, JSON.stringify(fx) + '\n')
  log(`value at eval: ${JSON.stringify(fx.value)}`)
}

const brief = (c) => ({
  id: c.id,
  block: c.block,
  date: c.ts ? new Date(c.ts * 1000).toISOString() : null,
  eid: c.route?.eid,
  chain: c.route?.chainId,
  dir: c.route?.direction,
  severity: c.severity,
  red: c.red,
  rules: c.ruleIds,
  tags: c.tags,
  before: c.beforeDisplay,
  after: c.afterDisplay,
})

/**
 * --base-rate (network): every OApp's ReceiveUln302 overrides at the evaluation block — how
 * many LIVE routes sit under the floor and where the subject ranks (critique: turn the
 * regression test toward a detection test). Writes backtest/kelp-rseth.base-rate.json.
 */
async function buildBaseRate(fx) {
  const { state, logs } = ethereumClients()
  const rows = await scanLogs({
    client: logs,
    chainId: 1,
    addresses: [ETH.receiveUln302],
    topics0: [TOPIC.UlnConfigSet, TOPIC.DefaultUlnConfigsSet],
    from: ETH.endpointDeployBlock,
    to: KELP.evalBlock,
    cacheDir: CACHE,
    cacheKey: 'base-rate-all-oapps',
    span: 250_000,
  })
  const evs = rows.flatMap((r) => lzEventsOf(r, null)).filter((e) => e.block <= KELP.evalBlock)
  const over = new Map()
  const defaults = {}
  for (const e of evs) {
    if (e.kind === 'uln')
      over.set(`${e.oapp.toLowerCase()}|${e.eid}`, {
        oapp: e.oapp.toLowerCase(),
        eid: e.eid,
        config: e.config,
      })
    if (e.kind === 'uln_default') defaults[e.eid] = e.config
  }
  log(
    `base rate: ${over.size} overridden (oapp, eid) receive routes, ${new Set([...over.values()].map((o) => o.oapp)).size} OApps`,
  )
  const uln = await loadTs('../../../../lib/oracleRegistry/config/uln.ts')
  const bt = await loadTs('../../../../lib/oracleRegistry/config/backtest.ts')
  const dvns = new Set()
  for (const o of over.values())
    for (const a of [...o.config.requiredDVNs, ...o.config.optionalDVNs]) dvns.add(a)
  for (const d of Object.values(defaults))
    for (const a of [...d.requiredDVNs, ...d.optionalDVNs]) dvns.add(a)
  const code = {}
  await pool([...dvns], 6, async (a) => {
    code[a] = !!(await codeAt(state, a, KELP.evalBlock))
  })
  const ctx = {
    registry: bt.registryFromMeta(fx.metadata),
    code: (_c, a) => code[a.toLowerCase()] ?? null,
    useDeprecated: false,
  }
  const cands = [...over.values()].filter((o) => {
    const sec = uln.securityOf(uln.mergeUln(o.config, defaults[o.eid]), 1, KELP.evalBlock, ctx)
    return !sec.blocked && sec.E < 2
  })
  log(`  ${cands.length} under-floor overrides: reading peers at block ${KELP.evalBlock}`)
  const live = {}
  await pool(cands, 6, async (o) => {
    const p = await tryRead(state, o.oapp, fnAbi(FN.peers), 'peers', [o.eid], KELP.evalBlock)
    live[`${o.oapp}|${o.eid}`] = p.ok ? !/^0x0*$/i.test(p.value) : null
  })
  const inp = {
    chainId: 1,
    evalBlock: KELP.evalBlock,
    overrides: [...over.values()],
    defaults,
    live,
  }
  // severity rank (owner ruling #9): each floor-breaching OApp's locked balance on Ethereum,
  // priced with the registry consensus at the block (catalog tokens only; the subject through its
  // own valuation). Remote supplies are not read for the base rate (stated in the scope).
  const per = bt.liveUnderFloorOApps(inp, ctx)
  const cons = await consensusAtEval()
  const subjPrice = await subjectPriceAtEval(state, cons)
  const value = await loadTs('../../../../lib/oracleRegistry/config/value.ts')
  const values = {}
  log(`  valuing ${Object.keys(per).length} floor-breaching OApps at block ${KELP.evalBlock}`)
  await pool(Object.keys(per), 6, async (o) => {
    const l = await lockedAt(state, o, KELP.evalBlock)
    const asset = l.token ? cons.tokens?.[l.token] : undefined
    const priceUsd =
      o === KELP.oapp ? subjPrice.priceUsd : asset ? (cons.prices[asset] ?? null) : null
    const n = value.amountToNumber(l.amount)
    values[o] = { usd: n !== null && priceUsd !== null ? n * priceUsd : null, token: l.token }
  })
  const out = bt.baseRate(inp, ctx, KELP.oapp, values)
  writeFileSync(
    join(DIR, 'backtest', 'kelp-rseth.base-rate.json'),
    JSON.stringify(
      {
        version: 1,
        builtAt: new Date().toISOString(),
        scope:
          "ReceiveUln302 overrides only; OApps inheriting defaults not counted; liveness = peers(eid) ≠ 0 at the block (unknown if peers() reverts); metadata identity only, code at the block; value at risk = an OFT adapter's locked balance on Ethereum at the block, priced with the registry consensus at the block (catalog tokens; the subject through its own rate) — remote supplies not read for the base rate",
        ...out,
      },
      null,
      1,
    ) + '\n',
  )
  console.log(JSON.stringify({ baseRate: { ...out, top: out.top.slice(0, 10) } }, null, 1))
}

if (process.argv.includes('--build-fixture')) await buildFixture()
if (process.argv.includes('--value-at-eval')) {
  await buildValueAtEval(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  process.exit(0)
}
if (process.argv.includes('--base-rate')) {
  await buildBaseRate(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  process.exit(0)
}
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const { out, criteria, framing } = await runBacktest(fx)
const summary = {
  version: 1,
  fixtureBuiltAt: fx.builtAt,
  evalBlock: KELP.evalBlock,
  framing,
  criteria,
  counts: {
    changes: out.timeline.length,
    red: out.timeline.filter((c) => c.red).length,
    redBeforeEval: out.timeline.filter((c) => c.red && c.block <= KELP.evalBlock).length,
    remoteChanges: out.remoteTimeline.length,
  },
  headAtEval: out.headAtEval.filter((r) => r.live || r.breaches.length),
  remoteHeadAtEval: out.remoteHeadAtEval,
  crossChecks: out.crossChecks,
  red: out.timeline.filter((c) => c.red).map(brief),
  remote: out.remoteTimeline.map(brief),
  after: out.timeline.filter((c) => c.block > KELP.evalBlock).map(brief),
}
writeFileSync(OUT, JSON.stringify(summary, null, 1) + '\n')
const ok = Object.values(criteria).every((c) => c.pass || c.gating === false)
console.log(
  JSON.stringify({ pass: ok, framing: framing.text, criteria, counts: summary.counts }, null, 1),
)
process.exit(ok ? 0 : 3)
