/**
 * The live wavefront engine's CLI (lib/wavefront/live; docs/WAVEFRONT_LIVE_ENGINE.md).
 *
 *   npx tsx scripts/wavefront-live/run.ts --mode live --out /path/stream.jsonl
 *   npx tsx scripts/wavefront-live/run.ts --mode historical \
 *       --from 2025-10-10T20:50Z --to 2025-10-10T23:00Z --out /path/hist.jsonl
 *
 * Options
 *   --mode live|historical     live: follow the chain heads; historical: the same engine on a
 *                              simulated clock over archive blocks (default live)
 *   --from <time|chain:block>  ISO time, unix seconds, or e.g. mainnet:23540000 (that block's
 *                              time). Historical: required. Live: default now.
 *   --to <time|chain:block>    historical: stop before this minute; live: stop at this time
 *   --duration-minutes N       live: stop after N minutes of wall time
 *   --chains a,b,…             default mainnet,arbitrum,optimism,base
 *   --out <file.jsonl>         the stream (file sink; its state is <file>.jsonl.state)
 *   --sink file|postgres       postgres reads DATABASE_URL here and only here (default file)
 *   --stream <id>              postgres stream id (default main)
 *   --epoch <time>             minute 0 of a NEW stream (default: UTC midnight of --from)
 *   --stats <file.json>        status, RPC ledger, memory and CPU, rewritten every minute
 *   --horizon-minutes N        close an idle position after N minutes (default 10080 = 7 days)
 *   --reconcile-every N / --reconcile-window N   minutes (default 60 / 120; 0 = off)
 *   --poll-seconds N / --concurrency N / --own-clusters A,B / --walk-on true|false
 *   --grid-end-minute N        kernel grid end (the census's is 2879); default none
 *
 * Nothing here deploys, schedules or creates anything: it runs in the foreground until stopped
 * (SIGINT/SIGTERM finish the current minute; SIGKILL is safe too — see sinks.ts).
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { RpcPool, type ChainKey } from '../oct10-coverage/rpc'
import {
  CountingRpc,
  FileSink,
  LIVE_CHAINS,
  LiveEngine,
  PostgresSink,
  SimClock,
  clockHead,
  liveEndpoints,
  liveHead,
  neonExecutor,
  realClock,
  type StreamSink,
} from '../../lib/wavefront/live'

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) out[k] = 'true'
    else {
      out[k] = v
      i++
    }
  }
  return out
}

const log = (msg: string) => process.stderr.write(`[wavefront-live ${new Date().toISOString()}] ${msg}\n`)

async function timeOf(spec: string, pool: RpcPool): Promise<number> {
  const m = /^(mainnet|arbitrum|optimism|base):(\d+)$/.exec(spec)
  if (m) {
    const a = await pool.request(m[1] as ChainKey, 'eth_getBlockByNumber', ['0x' + Number(m[2]).toString(16), false])
    return Number(BigInt((a.result as { timestamp: string }).timestamp))
  }
  if (/^\d+$/.test(spec)) {
    const n = Number(spec)
    if (n > 1e9) return n
    return timeOf(`mainnet:${n}`, pool)
  }
  const t = Date.parse(spec)
  if (!Number.isFinite(t)) throw new Error(`cannot parse time ${spec}`)
  return Math.floor(t / 1000)
}

async function main() {
  const o = args(process.argv.slice(2))
  const mode = (o.mode ?? 'live') as 'live' | 'historical'
  if (mode !== 'live' && mode !== 'historical') throw new Error('--mode live|historical')
  const chains = (o.chains ?? LIVE_CHAINS.join(',')).split(',') as ChainKey[]
  for (const c of chains) if (!LIVE_CHAINS.includes(c)) throw new Error(`unknown chain ${c}`)
  const pool = new RpcPool(liveEndpoints(mode))
  const rpc = new CountingRpc(pool)

  const nowSec = Math.floor(Date.now() / 1000)
  const from = o.from ? await timeOf(o.from, pool) : nowSec
  if (mode === 'historical' && !o.from) throw new Error('historical mode needs --from')
  const to = o.to ? await timeOf(o.to, pool) : undefined
  const epoch = o.epoch ? await timeOf(o.epoch, pool) : from - (from % 86_400)
  if (epoch % 60) throw new Error('--epoch must be a whole minute')
  const startMinute = Math.floor((from - epoch) / 60)
  const endMinute =
    mode === 'historical' ? Math.ceil(((to ?? from + 3600) - epoch) / 60) : undefined

  let sink: StreamSink
  if ((o.sink ?? 'file') === 'postgres') {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('--sink postgres needs DATABASE_URL')
    sink = new PostgresSink(await neonExecutor(url), o.stream ?? 'main')
  } else {
    if (!o.out) throw new Error('--out <file.jsonl> is required for the file sink')
    sink = new FileSink(o.out)
  }

  const clock = mode === 'historical' ? new SimClock(from * 1000) : realClock
  const engine = new LiveEngine(
    {
      rpc,
      clock,
      sink,
      head: mode === 'historical' ? clockHead() : liveHead,
      backoff: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    },
    {
      mode,
      chains,
      epochTs: epoch,
      startMinute,
      endMinute,
      ...(o['horizon-minutes'] ? { horizonMinutes: Number(o['horizon-minutes']) } : {}),
      ...(o['reconcile-every'] ? { reconcileEveryMinutes: Number(o['reconcile-every']) } : {}),
      ...(o['reconcile-window'] ? { reconcileWindowMinutes: Number(o['reconcile-window']) } : {}),
      ...(o['poll-seconds'] ? { pollSeconds: Number(o['poll-seconds']) } : {}),
      ...(o.concurrency ? { readConcurrency: Number(o.concurrency) } : {}),
      ...(o['own-clusters'] ? { ownClusters: o['own-clusters'].split(',') } : {}),
      ...(o['walk-on'] ? { walkOnAfterT0BandSale: o['walk-on'] === 'true' } : {}),
      ...(o['grid-end-minute'] ? { lastMinute: Number(o['grid-end-minute']) } : {}),
    },
  )

  const started = Date.now()
  const cpu0 = process.cpuUsage()
  const samples: { t: string; rssMb: number; heapMb: number; cpuPct: number }[] = []
  let lastCpu = process.cpuUsage()
  let lastT = Date.now()
  const sample = () => {
    const c = process.cpuUsage()
    const t = Date.now()
    const used = (c.user - lastCpu.user + c.system - lastCpu.system) / 1000
    const m = process.memoryUsage()
    samples.push({
      t: new Date(t).toISOString(),
      rssMb: Math.round((m.rss / 2 ** 20) * 10) / 10,
      heapMb: Math.round((m.heapUsed / 2 ** 20) * 10) / 10,
      cpuPct: t > lastT ? Math.round((used / (t - lastT)) * 1000) / 10 : 0,
    })
    lastCpu = c
    lastT = t
  }
  const writeStats = () => {
    if (!o.stats) return
    const wallMin = (Date.now() - started) / 60_000
    const cpu = process.cpuUsage(cpu0)
    const perChain = Object.fromEntries(
      chains.map((c) => [c, { calls: rpc.total(c), perMinute: Math.round((rpc.total(c) / Math.max(wallMin, 1e-9)) * 10) / 10 }]),
    )
    mkdirSync(dirname(o.stats), { recursive: true })
    writeFileSync(
      o.stats,
      JSON.stringify(
        {
          mode,
          from: new Date(from * 1000).toISOString(),
          epoch: new Date(epoch * 1000).toISOString(),
          wallMinutes: Math.round(wallMin * 100) / 100,
          cpuSeconds: Math.round((cpu.user + cpu.system) / 1e4) / 100,
          memory: {
            maxRssMb: Math.max(...samples.map((s) => s.rssMb), 0),
            maxHeapMb: Math.max(...samples.map((s) => s.heapMb), 0),
            samples: samples.slice(-120),
          },
          rpc: { total: rpc.total(), httpCalls: pool.calls, stuck: rpc.stuck(), perChain, byMethod: rpc.snapshot(), ledger: pool.ledger() },
          engine: engine.status(),
          minutes: engine.minuteLog.slice(-200),
        },
        null,
        1,
      ),
    )
  }
  const timer = setInterval(() => {
    sample()
    writeStats()
  }, 30_000)

  let stopping = false
  const stop = () => {
    if (!stopping) log('stop requested: finishing the current minute')
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const deadline =
    mode === 'live'
      ? Math.min(
          o['duration-minutes'] ? started + Number(o['duration-minutes']) * 60_000 : Infinity,
          to ? to * 1000 : Infinity,
        )
      : Infinity

  const how = await engine.init()
  log(`${how}: mode ${mode}, chains ${chains.join(',')}, epoch ${new Date(epoch * 1000).toISOString()}`)
  sample()
  await engine.run(() => stopping || Date.now() >= deadline)
  clearInterval(timer)
  sample()
  writeStats()
  await sink.close()
  const st = engine.status()
  log(
    `stopped at minute ${st.nextMinute} (${st.nextMinuteIso}); seq ${st.seq}; coverage ${st.coverage.walked}/${st.coverage.total}; RPC requests ${rpc.total()} (HTTP ${pool.calls})`,
  )
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`)
  process.exit(1)
})
