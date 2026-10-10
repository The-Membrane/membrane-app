// Offline, versioned sensitivity join. Never rewrites a sealed Aave outcome or claims new lead.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE, SOURCE_SHA256, readSnapshot as readSlope } from './aave-core-cash-slope.mjs'
import { readCheckpoint as readOutcomes } from './aave-core-holder-outcomes.mjs'
import { readCheckpoint as readWitness } from './aave-core-holder-witness.mjs'

export const STUDY = 'aave-calendar-identity-corroboration-v1'
export const WITNESS_SHA = '18f69bc26d932e2353cc0eb0bc7fca11b0240672946c59a624fcad3a2b2a6cfa'
export const SLOPE_SHA = '10f7cd71ff3724c4cbe351e42319e08379e038a7c0ab9cfcf927643e11a259c9'
export const OUTCOME_SHA = 'b7eb008b650b206b6aa3ac4ec5eef4368366adb6459a2b28a594f7dba99c9b77'
const BASELINE_BLOCK = 26_059_633
const MIN_FREE = 1_073_741_824n
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const assert = (ok, reason) => {
  if (!ok) throw new Error(reason)
}
const pinned = (path, expected) => {
  const bytes = readFileSync(path)
  assert(sha(bytes) === expected, 'Corroboration source physical SHA changed')
  return JSON.parse(bytes)
}

export function build({ witnessPath, slopePath, outcomePath, sourcePath = SOURCE }) {
  const witness = pinned(witnessPath, WITNESS_SHA)
  const slope = pinned(slopePath, SLOPE_SHA)
  const outcome = pinned(outcomePath, OUTCOME_SHA)
  assert(sha(readFileSync(sourcePath)) === SOURCE_SHA256, 'Slope feature source SHA changed')
  readWitness(witnessPath)
  readSlope(slopePath)
  readOutcomes(outcomePath, witnessPath)
  const baseline = witness.payload.baselines.find((row) => row.block === BASELINE_BLOCK)
  const result = outcome.payload.outcomes.find(
    (row) => row.baselineBlock === BASELINE_BLOCK && row.horizon === '6h',
  )
  const s = slope.payload
  assert(baseline && result, 'Frozen baseline or outcome missing')
  assert(s.block === baseline.block && s.blockHash === baseline.blockHash, 'Slope B mismatch')
  assert(
    result.baselineBlockHash === baseline.blockHash && result.baselineSha256 === baseline.rowSha256,
    'Outcome B ancestry mismatch',
  )
  assert(s.firstKnownAtMs < result.targetTimestamp * 1000, 'Slope not locally known before target')
  assert(
    s.firstKnownAtMs > baseline.blockTimestamp * 1000,
    'Expected post-B source chronology changed',
  )
  const slopeLead = Math.floor((result.targetTimestamp * 1000 - s.firstKnownAtMs) / 1000)
  assert(slopeLead < 6 * 3600, 'Six-hour lead assumption changed')
  assert(
    result.baselineImplementation === null && result.poolImplementationChanged === null,
    'Original censor status changed',
  )
  assert(result.poolImplementation?.status === 'observed', 'Outcome implementation not observed')
  assert(
    result.poolCodeChanged === false && result.poolCodeHash === baseline.poolCodeHash,
    'Pool runtime changed across horizon',
  )
  const markets = result.markets.map((market) => {
    const control = s.markets.find((row) => row.market === market.name)
    assert(control?.status === 'eligible', 'Cash-slope market ineligible')
    assert(
      control.identities?.pool?.atB?.proxyCodeHash === baseline.poolCodeHash,
      'Pool B runtime mismatch',
    )
    const atB = control.identities.pool.atB.implementation
    assert(atB?.address && atB?.codeHash, 'Slope Pool implementation missing')
    const sameImplementation =
      atB.address.toLowerCase() === result.poolImplementation.address.toLowerCase() &&
      atB.codeHash.toLowerCase() === result.poolImplementation.codeHash.toLowerCase()
    const witnesses = market.witnesses.map((holder) => {
      assert(
        holder.censoring.length === 1 && holder.censoring[0] === 'pool-implementation-unresolved',
        'Original witness censor changed',
      )
      return {
        holder: holder.holder,
        originalCall: holder.call,
        originalCensoring: holder.censoring,
        identityCorroboratedSuccess: sameImplementation && holder.call === 'success',
      }
    })
    return { market: market.name, baselineImplementation: atB, sameImplementation, witnesses }
  })
  return {
    study: STUDY,
    kind: 'retrospective-preoutcome-source-join-sensitivity',
    originalOutcomeRemainsCensored: true,
    prospectiveAlertClaim: false,
    identityObservedAtB: false,
    baselineBlock: BASELINE_BLOCK,
    outcomeBlock: result.block,
    outcomeBlockHash: result.blockHash,
    horizon: result.horizon,
    targetTimestamp: result.targetTimestamp,
    slopeFirstKnownAtMs: s.firstKnownAtMs,
    slopeFirstKnownLeadSeconds: slopeLead,
    meetsSixHourLead: slopeLead >= 6 * 3600,
    baselineObservationLeadSeconds: result.baselineObservationLeadSeconds,
    sourcePhysicalSha256: {
      witness: WITNESS_SHA,
      slope: SLOPE_SHA,
      outcome: OUTCOME_SHA,
      feature: SOURCE_SHA256,
    },
    markets,
  }
}

export function save(out, result) {
  assert(!existsSync(out), 'Refusing to overwrite corroboration')
  const body = JSON.stringify({ payload: result, sha256: sha(JSON.stringify(result)) })
  const fs = statfsSync(dirname(out), { bigint: true })
  assert(fs.bavail * fs.bsize - BigInt(Buffer.byteLength(body)) >= MIN_FREE, 'Disk reserve reached')
  writeFileSync(out, body, { flag: 'wx', mode: 0o600 })
  return sha(readFileSync(out))
}

export function readSnapshot(out, paths) {
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  assert(saved?.sha256 === sha(JSON.stringify(saved.payload)), 'Sidecar payload seal mismatch')
  assert(
    JSON.stringify(saved.payload) === JSON.stringify(build(paths)),
    'Sidecar source join changed',
  )
  return saved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = 'data/research/venue-signals/'
  try {
    const result = build({
      witnessPath: resolve(`${base}aave-core-holder-witness-2026-09-26.json`),
      slopePath: resolve(`${base}aave-core-cash-slope-2026-09-26.json`),
      outcomePath: resolve(`${base}aave-core-holder-outcomes-calendar-v1.json`),
    })
    const out = resolve(`${base}aave-calendar-identity-corroboration-v1.json`)
    if (process.argv.includes('--verify')) {
      readSnapshot(out, {
        witnessPath: resolve(`${base}aave-core-holder-witness-2026-09-26.json`),
        slopePath: resolve(`${base}aave-core-cash-slope-2026-09-26.json`),
        outcomePath: resolve(`${base}aave-core-holder-outcomes-calendar-v1.json`),
      })
      process.stdout.write(
        JSON.stringify({ verified: true, physicalSha256: sha(readFileSync(out)) }) + '\n',
      )
    } else if (process.argv.includes('--run')) {
      process.stdout.write(
        JSON.stringify({
          out,
          physicalSha256: save(out, result),
          markets: result.markets.map((m) => ({
            market: m.market,
            corroborated: m.witnesses.filter((w) => w.identityCorroboratedSuccess).length,
          })),
        }) + '\n',
      )
    } else process.stdout.write(JSON.stringify({ dry: true, result }) + '\n')
  } catch {
    process.stderr.write('Aave identity corroboration stopped; sealed sources retained.\n')
    process.exitCode = 1
  }
}
