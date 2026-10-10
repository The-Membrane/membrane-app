// Standalone, read-only RPC collector with one atomic local snapshot.
// Run from the repo root: node scripts/route-rates/run-hourly.mjs
// The filename is legacy; production now collects this route leg daily.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ROOT, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { collectExactLegSpread } from './exact-leg-spread.mjs'

export const DEFAULT_OUTPUT = join(ROOT, 'scripts', 'route-rates', '.cache', 'gho-sgho-latest.json')

export function rpcUrlFromEnvironment() {
  let get = () => null
  try {
    get = readEnv().get
  } catch {
    // A shell-injected secret is also valid; never print either source.
  }
  return (
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL') ||
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    null
  )
}

export async function writeAtomicJson(outputPath, value) {
  await mkdir(dirname(outputPath), { recursive: true })
  const temp = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temp, outputPath)
  } finally {
    await rm(temp, { force: true })
  }
}

export async function runSnapshot({ client, outputPath = DEFAULT_OUTPUT, now = () => Date.now() }) {
  const fetchedAt = Math.floor(now() / 1000)
  let measurement = await collectExactLegSpread({ rpc: client })
  const ageSeconds = measurement.asOf == null ? null : fetchedAt - measurement.asOf
  if (measurement.status === 'priced' && (ageSeconds < -120 || ageSeconds > 7200)) {
    measurement = {
      ...measurement,
      status: 'unavailable',
      borrowApy: null,
      yieldApy: null,
      spread: null,
      error: 'Finalized RPC head is outside the two-hour freshness window',
    }
  }
  const snapshot = {
    schemaVersion: 1,
    fetchedAt,
    cadenceSeconds: 86400,
    freshness: {
      state: measurement.status === 'priced' ? 'fresh' : 'unavailable',
      asOf: measurement.asOf,
      ageSeconds,
      expiresAt: measurement.status === 'priced' ? fetchedAt + 86400 : null,
    },
    measurement,
  }
  await writeAtomicJson(outputPath, snapshot)
  return snapshot
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rpcUrl = rpcUrlFromEnvironment()
  if (!rpcUrl) {
    console.error('Set RECORDER_RPC_URLS or RECORDER_RPC_URL in .env.local or the environment.')
    process.exitCode = 1
  } else {
    try {
      const snapshot = await runSnapshot({ client: makeClient(rpcUrl) })
      console.log(
        `${snapshot.measurement.status} ${snapshot.measurement.key ?? 'GHO→sGHO'} ` +
          `as-of ${snapshot.measurement.asOf ?? 'unavailable'}; snapshot ${DEFAULT_OUTPUT}`,
      )
      if (snapshot.measurement.status !== 'priced') process.exitCode = 2
    } catch (error) {
      // Transport-level failure still writes an explicit unavailable snapshot.
      const snapshot = {
        schemaVersion: 1,
        fetchedAt: Math.floor(Date.now() / 1000),
        cadenceSeconds: 86400,
        freshness: { state: 'unavailable', asOf: null, ageSeconds: null, expiresAt: null },
        measurement: {
          status: 'unavailable',
          spread: null,
          borrowApy: null,
          yieldApy: null,
          error: 'RPC or local snapshot write failed',
        },
      }
      await writeAtomicJson(DEFAULT_OUTPUT, snapshot)
      console.error(`unavailable; snapshot ${DEFAULT_OUTPUT}`)
      process.exitCode = 2
    }
  }
}
