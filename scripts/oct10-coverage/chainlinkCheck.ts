/**
 * Step 6: verify the Aave minute paths for WETH and BTC (WBTC / cbBTC) on each chain against the
 * Chainlink rounds behind them.
 *
 *  - Resolve the source (AaveOracle.getSourceOfAsset): a plain Chainlink proxy (has aggregator()),
 *    or an Aave adapter wrapping feeds (ASSET_TO_PEG/PEG_TO_BASE, BASE_TO_USD_AGGREGATOR +
 *    RATIO_PROVIDER, ASSET_TO_USD_AGGREGATOR). Every wrapped proxy is followed.
 *  - For each proxy: aggregator() and phaseId() at the window's first and last minute blocks
 *    (phase change -> every phase aggregator in between), the aggregator's latestRound() at both.
 *  - AnswerUpdated logs over (b0, bEnd] on >= 2 backend groups, chunked with a per-host span that
 *    halves on refusal. An empty chunk is unconfirmed until a second backend agrees. Round-id
 *    continuity: the logs must hold exactly latestRound(b0)+1 .. latestRound(bEnd), no gaps.
 *  - The round in force at minute start t_i = last log with block <= blocks[i] (else the answer
 *    at b0); for a plain feed it must equal the Aave minute price; for a peg adapter the product
 *    a*b*10^D/10^(da+db) is compared.
 */
import { join } from 'path'
import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { adapterAbi, dec, enc, feedAbi } from './abi'
import { parseAbi, type Hex } from 'viem'
import { aaveSetup } from './aaveOracle'
import { STEPS, type Ctx } from './ctx'
import { loadMinuteBlocks } from './minuteBlocks'
import { toHex, type ChainKey } from './rpc'
import { setupCall, setupMulticall } from './setupCall'
import { JsonlStore, writeJson } from './store'

const OUT = 'chainlink-check'
const ANSWER_UPDATED = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f'
const lc = (s: string) => s.toLowerCase()
const aggAbi = parseAbi([
  'function latestRound() view returns (uint256)',
  'function typeAndVersion() view returns (string)',
])

interface Round {
  roundId: number
  answer: bigint
  updatedAt: number
  block: number
  logIndex: number
  tx: string
}

const INITIAL_SPAN: Record<ChainKey, number> = {
  mainnet: 20_000,
  arbitrum: 400_000,
  optimism: 100_000,
  base: 100_000,
}
const spanOf = new Map<string, number>()

type LogsResult = { logs: Round[]; calls: number; emptyChunks: [number, number][] }
type SavedLogs = {
  rounds: [number, string, number, number, number, string][]
  calls: number
  emptyChunks: [number, number][]
  span: number
}
let logStore: JsonlStore<SavedLogs> | null = null

/** One backend's complete AnswerUpdated scan of [from, to], cached on disk per host. */
async function logsOn(
  ctx: Ctx,
  chain: ChainKey,
  host: string,
  address: string,
  from: number,
  to: number,
): Promise<LogsResult | { error: string }> {
  logStore ??= new JsonlStore<SavedLogs>(join(ctx.stateDir, 'chainlink-logs.jsonl'))
  const key = `${chain}|${host}|${lc(address)}|${from}|${to}`
  const got = logStore.get(key)
  if (got) {
    spanOf.set(`${chain}|${host}`, got.span)
    return {
      logs: got.rounds.map(([roundId, answer, updatedAt, block, logIndex, tx]) => ({
        roundId,
        answer: BigInt(answer),
        updatedAt,
        block,
        logIndex,
        tx,
      })),
      calls: got.calls,
      emptyChunks: got.emptyChunks,
    }
  }
  const r = await logsScan(ctx, chain, host, address, from, to)
  if (!('error' in r)) {
    logStore.put(key, {
      rounds: r.logs.map((x) => [
        x.roundId,
        x.answer.toString(),
        x.updatedAt,
        x.block,
        x.logIndex,
        x.tx,
      ]),
      calls: r.calls,
      emptyChunks: r.emptyChunks,
      span: spanOf.get(`${chain}|${host}`) ?? INITIAL_SPAN[chain],
    })
  }
  return r
}

async function logsScan(
  ctx: Ctx,
  chain: ChainKey,
  host: string,
  address: string,
  from: number,
  to: number,
  maxCalls = 600,
): Promise<LogsResult | { error: string }> {
  const out: Round[] = []
  const emptyChunks: [number, number][] = []
  let calls = 0
  let transient = 0
  let b = from
  while (b <= to) {
    let span = spanOf.get(`${chain}|${host}`) ?? INITIAL_SPAN[chain]
    const e = Math.min(to, b + span - 1)
    if (++calls > maxCalls) return { error: `span ${span} needs more than ${maxCalls} calls` }
    const r = await ctx.pool.requestOn(chain, host, 'eth_getLogs', [
      { address, topics: [ANSWER_UPDATED], fromBlock: toHex(b), toBlock: toHex(e) },
    ])
    if (r.error) {
      if (r.rate || /timeout|abort|HTTP 5|null result/i.test(r.error)) {
        // A public endpoint that rate-limits a log scan rarely recovers within minutes: move on.
        if (++transient > (r.rate ? 3 : 8))
          return {
            error: `gave up after repeated ${r.rate ? 'rate limits' : 'transient errors'}: ${r.error}`,
          }
        await new Promise((res) => setTimeout(res, 2000 * transient))
        continue
      }
      if (span <= 10) return { error: r.error }
      span = Math.max(10, Math.floor(span / (/10 block/i.test(r.error) ? 1000 : 4)))
      spanOf.set(`${chain}|${host}`, span)
      continue
    }
    transient = 0
    const logs = r.result as {
      blockNumber: string
      logIndex: string
      transactionHash: string
      topics: string[]
      data: string
      address: string
      removed?: boolean
    }[]
    if (!logs.length) emptyChunks.push([b, e])
    for (const l of logs) {
      if (lc(l.address) !== lc(address) || l.topics[0] !== ANSWER_UPDATED)
        return { error: 'foreign log in answer' }
      out.push({
        roundId: Number(BigInt(l.topics[2])),
        answer: BigInt.asIntN(256, BigInt(l.topics[1])),
        updatedAt: Number(BigInt(l.data)),
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        tx: lc(l.transactionHash),
      })
    }
    b = e + 1
  }
  out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
  return { logs: out, calls, emptyChunks }
}

async function feedInfo(ctx: Ctx, chain: ChainKey, proxy: string, b: number) {
  const r = await setupMulticall(
    ctx,
    OUT,
    chain,
    (['aggregator', 'phaseId', 'decimals', 'description', 'latestRoundData'] as const).map(
      (fn) => ({ target: proxy, abi: feedAbi, fn }),
    ),
    b,
  )
  return {
    aggregator: r[0].ok ? lc(String(r[0].value)) : null,
    phaseId: r[1].ok ? Number(r[1].value) : null,
    decimals: r[2].ok ? Number(r[2].value) : null,
    description: r[3].ok ? String(r[3].value) : null,
    latest: r[4].ok ? (r[4].value as bigint[]).map(String) : null,
  }
}

export async function chainlinkCheck(ctx: Ctx, chains: ChainKey[]) {
  const logQuarantine: { chain: ChainKey; host: string; aggregator: string; missing: number }[] = []
  const result: Record<string, unknown> = {
    rule: 'round in force at minute start = last AnswerUpdated with block <= blocks[i]; Aave price must equal it (plain feed) or the adapter formula over its feeds',
    chains: {},
  }
  for (const chain of chains) {
    const setup = await aaveSetup(ctx, chain)
    const blocks = loadMinuteBlocks(ctx, chain)
    const b0 = blocks[0]
    const bEnd = blocks[STEPS - 1]
    const oracleOut = JSON.parse(
      gunzipSync(readFileSync(join(ctx.outDir, `aave-oracle-1m.${chain}.json.gz`))).toString(),
    ) as { prices: Record<string, (string | null)[]> }
    const picks = setup.assets.filter((a) => ['WETH', 'WBTC', 'cbBTC'].includes(a.symbol))
    const chainOut: Record<string, unknown>[] = []
    const roundsCache = new Map<
      string,
      { rounds: Round[]; at0: { answer: bigint; updatedAt: number }; info: Record<string, unknown> }
    >()

    const scanFeed = async (proxy: string) => {
      const cached = roundsCache.get(proxy)
      if (cached) return cached
      const i0 = await feedInfo(ctx, chain, proxy, b0)
      const i1 = await feedInfo(ctx, chain, proxy, bEnd)
      if (!i0.aggregator || !i1.aggregator)
        throw new Error(`${chain} ${proxy}: not a Chainlink proxy`)
      const aggs = [i0.aggregator]
      if (i0.aggregator !== i1.aggregator) {
        // Phase change inside the window: every phase aggregator from phase0 to phaseEnd.
        const ph = await setupMulticall(
          ctx,
          OUT,
          chain,
          Array.from({ length: (i1.phaseId ?? 0) - (i0.phaseId ?? 0) }, (_, k) => ({
            target: proxy,
            abi: feedAbi,
            fn: 'phaseAggregators',
            args: [(i0.phaseId ?? 0) + 1 + k],
          })),
          bEnd,
        )
        for (const p of ph) if (p.ok) aggs.push(lc(String(p.value)))
      }
      // Aggregators gate reads (SimpleReadAccessController: msg.sender must be tx.origin), so they
      // are read with a direct eth_call, never through Multicall3.
      const direct = async (agg: string, fn: 'latestRound' | 'typeAndVersion', b: number) => {
        const s = await setupCall(ctx, OUT, chain, agg, enc({ target: agg, abi: aggAbi, fn }), b)
        if (s.ans.revert) return null
        try {
          return dec({ abi: aggAbi, fn }, s.ans.result as Hex) as bigint | string
        } catch {
          return null
        }
      }
      const proxyRound = (latest: string[] | null) =>
        latest ? Number(BigInt(latest[0]) & ((1n << 64n) - 1n)) : null
      const lr = async (agg: string, b: number, proxyLatest: string[] | null) => {
        const r = await direct(agg, 'latestRound', b)
        return r !== null
          ? { round: Number(r), from: 'aggregator.latestRound()' }
          : { round: proxyRound(proxyLatest), from: 'proxy.latestRoundData() low 64 bits' }
      }
      const aggOut: Record<string, unknown>[] = []
      let rounds: Round[] = []
      // The round in force at b0 is what the PROXY served at b0.
      const at0 = {
        answer: i0.latest ? BigInt(i0.latest[1]) : 0n,
        updatedAt: i0.latest ? Number(i0.latest[3]) : 0,
      }
      for (const agg of aggs) {
        const s = await lr(agg, b0, agg === i0.aggregator ? i0.latest : null)
        const e = await lr(agg, bEnd, agg === i1.aggregator ? i1.latest : null)
        const typeAndVersion = await direct(agg, 'typeAndVersion', b0)
        // >= 2 backend groups, independent.
        const hosts = ctx.pool
          .logEndpoints(chain)
          .filter((h) => !logQuarantine.some((q) => q.chain === chain && q.host === h.host))
        const byGroup = new Map<string, typeof hosts>()
        for (const h of hosts) byGroup.set(h.group, [...(byGroup.get(h.group) ?? []), h])
        const backends: Record<string, unknown>[] = []
        const sets: {
          group: string
          host: string
          logs: Round[]
          emptyChunks: [number, number][]
        }[] = []
        // Fastest independent groups first; stop at two agreeing sets, a third only on disagreement.
        const order = ['tenderly', 'blockpi', 'pokt', 'op-official', 'base-official', 'onfinality']
        const rank = (g: string) => (order.includes(g) ? order.indexOf(g) : order.length)
        const groups = [...byGroup].sort((x, y) => rank(x[0]) - rank(y[0]))
        const same = (x: Round[], y: Round[]) =>
          x.length === y.length &&
          x.every(
            (r, i) =>
              r.block === y[i].block &&
              r.logIndex === y[i].logIndex &&
              r.answer === y[i].answer &&
              r.roundId === y[i].roundId,
          )
        for (const [group, hs] of groups) {
          if (sets.length >= 3) break
          if (sets.length >= 2 && sets.every((x) => same(x.logs, sets[0].logs))) break
          for (const h of hs) {
            const r = await logsOn(ctx, chain, h.host, agg, b0 + 1, bEnd)
            if ('error' in r) {
              backends.push({ host: h.host, group, error: r.error })
              continue
            }
            sets.push({ group, host: h.host, logs: r.logs, emptyChunks: r.emptyChunks })
            backends.push({
              host: h.host,
              group,
              calls: r.calls,
              logs: r.logs.length,
              emptyChunks: r.emptyChunks.length,
              span: spanOf.get(`${chain}|${h.host}`) ?? INITIAL_SPAN[chain],
            })
            break
          }
        }
        const keyOf = (x: Round) => `${x.block}:${x.logIndex}:${x.roundId}:${x.answer}`
        const union = new Map<string, Round>()
        for (const s2 of sets) for (const l of s2.logs) union.set(keyOf(l), l)
        const merged = [...union.values()].sort(
          (x, y) => x.block - y.block || x.logIndex - y.logIndex,
        )
        // Continuity: exactly latestRound(b0)+1 .. latestRound(bEnd).
        const ids = merged.map((x) => x.roundId)
        const idSet = new Set(ids)
        // Without latestRound at an end (should not happen), fall back to the logs' own span.
        const expectFrom = s.round !== null ? s.round + 1 : Math.min(...ids)
        const expectTo = e.round !== null ? e.round : Math.max(...ids)
        const missing: number[] = []
        for (let id = expectFrom; id <= expectTo; id++) if (!idSet.has(id)) missing.push(id)
        const dup = ids.length - idSet.size
        const outside = ids.filter((id) => id < expectFrom || id > expectTo).length
        const perBackend = sets.map((s2) => {
          const k = new Set(s2.logs.map(keyOf))
          return {
            host: s2.host,
            group: s2.group,
            logs: s2.logs.length,
            missingVsUnion: merged.filter((x) => !k.has(keyOf(x))).length,
            emptyChunks: s2.emptyChunks.length,
          }
        })
        // A short getLogs answer quarantines the host for LOGS in this step (its eth_call answers
        // were verified on their own in steps 1-5).
        for (const pb of perBackend)
          if (pb.missingVsUnion > 0)
            logQuarantine.push({
              chain,
              host: pb.host,
              aggregator: agg,
              missing: pb.missingVsUnion,
            })
        aggOut.push({
          aggregator: agg,
          typeAndVersion,
          latestRoundAtB0: s.round,
          latestRoundAtBEnd: e.round,
          latestRoundSource: s.from,
          expectedRounds: Math.max(0, expectTo - expectFrom + 1),
          logs: merged.length,
          missingRoundIds: missing,
          duplicateRoundIds: dup,
          roundIdsOutsideExpected: outside,
          continuous:
            missing.length === 0 &&
            dup === 0 &&
            outside === 0 &&
            merged.length === Math.max(0, expectTo - expectFrom + 1),
          backendsAgreeing: perBackend.filter((p) => p.missingVsUnion === 0).length,
          confirmed: perBackend.filter((p) => p.missingVsUnion === 0).length >= 2,
          backends: perBackend,
          attempts: backends,
        })
        rounds = rounds.concat(merged)
      }
      rounds.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
      const v = {
        rounds,
        at0,
        info: {
          proxy,
          description: i0.description,
          decimals: i0.decimals,
          phaseStart: i0.phaseId,
          phaseEnd: i1.phaseId,
          aggregatorStart: i0.aggregator,
          aggregatorEnd: i1.aggregator,
          latestRoundDataAtB0: i0.latest,
          aggregators: aggOut,
        },
      }
      roundsCache.set(proxy, v)
      return v
    }

    const inForce = (rounds: Round[], at0: bigint) => {
      const out: bigint[] = []
      let k = 0
      let cur = at0
      for (let i = 0; i < STEPS; i++) {
        while (k < rounds.length && rounds[k].block <= blocks[i]) cur = rounds[k++].answer
        out.push(cur)
      }
      return out
    }

    for (const a of picks) {
      const src = a.source
      const probe = await setupMulticall(
        ctx,
        OUT,
        chain,
        [
          { target: src, abi: feedAbi, fn: 'aggregator' },
          { target: src, abi: adapterAbi, fn: 'ASSET_TO_PEG' },
          { target: src, abi: adapterAbi, fn: 'PEG_TO_BASE' },
          { target: src, abi: adapterAbi, fn: 'BASE_TO_USD_AGGREGATOR' },
          { target: src, abi: adapterAbi, fn: 'RATIO_PROVIDER' },
          { target: src, abi: adapterAbi, fn: 'ASSET_TO_USD_AGGREGATOR' },
          { target: src, abi: adapterAbi, fn: 'DECIMALS' },
          { target: src, abi: adapterAbi, fn: 'description' },
        ],
        b0,
      )
      const aave = oracleOut.prices[a.address]
      const row: Record<string, unknown> = {
        asset: a.address,
        symbol: a.symbol,
        source: src,
        sourceEnd: a.sourceEnd,
        sourceDescription: probe[7].ok ? probe[7].value : null,
      }
      try {
        if (a.source !== a.sourceEnd)
          throw new Error('source changed inside the window: comparison not attempted')
        if (probe[0].ok) {
          row.kind = 'chainlink-proxy'
          const f = await scanFeed(src)
          row.feed = f.info
          const exp = inForce(f.rounds, f.at0.answer)
          let match = 0
          const mism: unknown[] = []
          // Characterize every mismatch: is the Aave price an OLDER round (served with a delay, as a
          // Chainlink SVR DualAggregator does with secondary-path transmissions)? How old was the
          // newest logged round at minute start?
          const lagHist: Record<string, number> = {}
          let maxUnservedAge = 0
          let unexplained = 0
          const series = [
            { answer: f.at0.answer, updatedAt: f.at0.updatedAt, block: blocks[0] },
            ...f.rounds,
          ]
          let k = 0
          for (let i = 0; i < STEPS; i++) {
            while (k < f.rounds.length && f.rounds[k].block <= blocks[i]) k++
            if (aave[i] !== null && BigInt(aave[i]!) === exp[i]) {
              match++
              continue
            }
            if (mism.length < 10)
              mism.push({ i, block: blocks[i], aave: aave[i], round: exp[i].toString() })
            let lag = -1
            for (let j = 1; j <= 10 && k - j >= 0; j++) {
              if (aave[i] !== null && series[k - j].answer === BigInt(aave[i]!)) {
                lag = j
                break
              }
            }
            if (lag < 0) unexplained++
            lagHist[String(lag)] = (lagHist[String(lag)] ?? 0) + 1
            const age = 1760054400 + 60 * i - series[k].updatedAt
            if (lag > 0) maxUnservedAge = Math.max(maxUnservedAge, age)
          }
          row.minutesCompared = STEPS
          row.minutesMatch = match
          row.matchRate = match / STEPS
          row.mismatchLagRounds = lagHist
          row.mismatchUnexplained = unexplained
          row.maxAgeSecOfLoggedRoundNotYetServed = maxUnservedAge
          row.mismatchExamples = mism
        } else if (probe[1].ok && probe[2].ok) {
          row.kind = 'adapter-peg-to-base'
          const pegFeed = lc(String(probe[1].value))
          const baseFeed = lc(String(probe[2].value))
          const fa = await scanFeed(pegFeed)
          const fb = await scanFeed(baseFeed)
          row.feeds = [fa.info, fb.info]
          const D = BigInt(Number(probe[6].value ?? 8))
          const da = BigInt(Number(fa.info.decimals))
          const db = BigInt(Number(fb.info.decimals))
          const ea = inForce(fa.rounds, fa.at0.answer)
          const eb = inForce(fb.rounds, fb.at0.answer)
          let match = 0
          const mism: unknown[] = []
          for (let i = 0; i < STEPS; i++) {
            const exp =
              ea[i] <= 0n || eb[i] <= 0n ? 0n : (ea[i] * eb[i] * 10n ** D) / 10n ** (da + db)
            if (aave[i] !== null && BigInt(aave[i]!) === exp) match++
            else if (mism.length < 10)
              mism.push({ i, block: blocks[i], aave: aave[i], expected: exp.toString() })
          }
          row.formula = 'ASSET_TO_PEG * PEG_TO_BASE * 10^DECIMALS / 10^(decA + decB)'
          row.minutesCompared = STEPS
          row.minutesMatch = match
          row.matchRate = match / STEPS
          row.mismatchExamples = mism
        } else if (probe[3].ok) {
          row.kind = 'adapter-capo'
          const fb = await scanFeed(lc(String(probe[3].value)))
          row.feeds = [fb.info]
          row.ratioProvider = probe[4].ok ? lc(String(probe[4].value)) : null
          row.note =
            'capped ratio adapter: underlying feed continuity checked; minute path not compared (ratio provider is not a Chainlink round)'
        } else if (probe[5].ok) {
          row.kind = 'adapter-asset-to-usd'
          const fb = await scanFeed(lc(String(probe[5].value)))
          row.feeds = [fb.info]
          row.note = 'adapter wraps a Chainlink feed; minute path not compared'
        } else {
          row.kind = 'unknown'
          row.note =
            'source exposes neither aggregator() nor a known adapter getter: could not follow'
        }
      } catch (e) {
        row.error = String((e as Error).message)
      }
      chainOut.push(row)
    }
    ;(result.chains as Record<string, unknown>)[chain] = chainOut
    writeJson(join(ctx.stateDir, `chainlink-check.partial.json`), result)
  }
  result.verification = ctx.verifier.stats(OUT)
  result.quarantinedForLogs = logQuarantine
  result.quarantined = ctx.pool.quarantined()
  writeJson(join(ctx.outDir, 'chainlink-check.json'), result)
  return result
}
