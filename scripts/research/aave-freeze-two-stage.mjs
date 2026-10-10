// Explicitly post-hoc follow-up to the preregistered event census.
// Uses *only* pre-event cached 14d cash history for a p95 six-hour decline
// threshold. It is not a validated warning rule or a replacement for the
// independently preregistered event/control analysis.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { DAY, empiricalQuantile, rollingSixHourDrops } from './aave-freeze-event-logic.mjs'

const opts = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, args) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : [])),
)
if (!opts['study-in'] || !opts.out)
  throw new Error('Pass --study-in and --out to preserve the exploratory result')
const study = JSON.parse(readFileSync(opts['study-in'], 'utf8'))
if (study.status !== 'complete' || !Array.isArray(study.incidents))
  throw new Error('Study input must contain complete event incidents')
const manifest = JSON.parse(readFileSync('data/research/venue-signals/manifest.json', 'utf8'))
const dense = JSON.parse(
  readFileSync(
    opts['dense-in'] ||
      `data/research/venue-signals/${manifest.artifacts['aave-usde-cash-mar-jun-2026'].file}`,
    'utf8',
  ),
).rows
const sparse = JSON.parse(
  readFileSync(
    opts['sparse-in'] ||
      `data/research/venue-signals/${manifest.artifacts['aave-usde-cash-sparse-400d'].file}`,
    'utf8',
  ),
).rows
const config = loadConfig().find((v) => v.name === 'aave-v3-usde' && v.enabled)
if (!config?.address || !config?.underlying) throw new Error('Missing USDe reserve configuration')
const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
const client = makeClient(rpc)
const balanceAbi = [parseAbiItem('function balanceOf(address) view returns (uint256)')]
const headers = new Map([...dense, ...sparse].map((r) => [r.block, r.at]))
async function at(block) {
  if (!headers.has(block)) {
    const result = await client.getBlock({ blockNumber: BigInt(block) })
    headers.set(block, Number(result.timestamp))
  }
  return headers.get(block)
}
async function blockAtOrAfter(targetAt, aroundBlock) {
  let left = Math.max(1, aroundBlock - 4000)
  let right = aroundBlock + 4000
  if ((await at(left)) > targetAt || (await at(right)) < targetAt)
    throw new Error(`Timestamp not bracketed near ${aroundBlock}`)
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    if ((await at(mid)) < targetAt) left = mid + 1
    else right = mid
  }
  return left
}
async function cash(block) {
  return (
    Number(
      await client.readContract({
        address: config.underlying,
        abi: balanceAbi,
        functionName: 'balanceOf',
        args: [config.address],
        blockNumber: BigInt(block),
      }),
    ) / 1e18
  )
}
async function assess(label, anchor, allRows) {
  const start = anchor.at - 14 * DAY
  const local = allRows.filter((r) => r.at >= start - 7 * 3600 && r.at < anchor.at)
  const coverage = {
    from: local[0]?.at ?? null,
    to: local.at(-1)?.at ?? null,
    rows: local.length,
    maxGapHours:
      local.length > 1
        ? Math.max(...local.slice(1).map((r, i) => (r.at - local[i].at) / 3600))
        : null,
  }
  const sufficient =
    local.length >= 75 &&
    coverage.from <= start + 4 * 3600 &&
    coverage.to >= anchor.at - 4 * 3600 &&
    coverage.maxGapHours <= 4
  if (!sufficient) return { label, anchorAt: anchor.at, baseline: 'unavailable', coverage }
  const drops = rollingSixHourDrops(local, anchor.at, 14)
  if (drops.length < 60)
    return {
      label,
      anchorAt: anchor.at,
      baseline: 'insufficient-pairs',
      coverage,
      pairs: drops.length,
    }
  const p95 = empiricalQuantile(
    drops.map((r) => r.drop),
    0.95,
  )
  const checkpoints = []
  for (const hour of [3, 6]) {
    const nowBlock = await blockAtOrAfter(
      anchor.at + hour * 3600,
      anchor.block + Math.round(hour * 300),
    )
    const priorBlock = await blockAtOrAfter(
      anchor.at + (hour - 6) * 3600,
      anchor.block + Math.round((hour - 6) * 300),
    )
    const nowCash = await cash(nowBlock)
    const priorCash = await cash(priorBlock)
    checkpoints.push({
      hour,
      at: await at(nowBlock),
      nowBlock,
      priorBlock,
      nowCash,
      priorCash,
      sixHourDrop: priorCash - nowCash,
      flagged: priorCash - nowCash > p95,
    })
  }
  return {
    label,
    anchorAt: anchor.at,
    baseline: '14d pre-anchor p95',
    coverage,
    pairs: drops.length,
    p95,
    checkpoints,
  }
}

const rows = [...dense, ...sparse].sort((a, b) => a.at - b.at)
const out = []
for (const incident of study.incidents.filter((r) => r.response?.[100000000]?.eligible)) {
  out.push(await assess(new Date(incident.at * 1000).toISOString(), incident, rows))
  if (incident.control)
    out.push(
      await assess(
        `control-for-${new Date(incident.at * 1000).toISOString()}`,
        incident.control,
        rows,
      ),
    )
}
const path = opts.out
const tmp = `${path}.${process.pid}.tmp`
writeFileSync(
  tmp,
  JSON.stringify({
    status: 'complete',
    exploratory: true,
    rule: 'positive cross-reserve configuration incident then trailing 6h USDe cash drop > 14d pre-anchor p95 at +3h or +6h',
    results: out,
  }),
)
renameSync(tmp, path)
console.log(JSON.stringify(out, null, 2))
