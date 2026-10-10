// Caller-context sensitivity check for the four sampled pre-Submit EOA holders.
// A call from the vault mimics gate msg.sender, but not the full withdrawal context.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { probeGate } from './morpho-v2-gate-holder-pilot.mjs'

export const STUDY = 'morpho-v2-gate-caller-context-check-v1'
export const PILOT_SHA = '2d9d723ee01129d55a6abc8af29cc17749660d4ae3354942864231ea11e86e55'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function inputs(path) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== PILOT_SHA) throw new Error('Gate pilot SHA mismatch')
  const pilot = JSON.parse(bytes)
  const rows = pilot.results?.filter((row) => row.status === 'probed')
  if (pilot.status !== 'complete' || pilot.results?.length !== 5 || rows?.length !== 4 ||
      rows.some((row) => row.holderGate?.status !== 'true' || !row.holder || !row.proposedGate))
    throw new Error('Gate pilot cohort mismatch')
  return rows
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}

export function verifyOffline({ pilotPath, out }) {
  const rows = inputs(pilotPath)
  const bytes = readFileSync(out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.pilotSha256 !== PILOT_SHA || saved.status !== 'complete' || saved.results?.length !== 4)
    throw new Error('Gate caller-context checkpoint mismatch')
  for (let i = 0; i < rows.length; i++) {
    const prior = rows[i], result = saved.results[i]
    if (result.vault !== prior.vault || result.holder !== prior.holder || result.preBlock !== prior.preBlock ||
        result.preBlockHash !== prior.preBlockHash || result.proposedGate !== prior.proposedGate ||
        !['true', 'false', 'revert', 'rpc-error', 'malformed-return'].includes(result.vaultCallerGate))
      throw new Error('Gate caller-context row mismatch')
  }
  return { checkpointSha256: sha(bytes), results: saved.results.map(({ vault, vaultCallerGate }) => ({ vault, vaultCallerGate })) }
}

export async function run({ client, pilotPath, out }) {
  if (existsSync(out)) return verifyOffline({ pilotPath, out })
  const rows = inputs(pilotPath)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const results = []
  for (const row of rows) {
    const header = await client.getBlock({ blockNumber: BigInt(row.preBlock) })
    if (header.hash.toLowerCase() !== row.preBlockHash.toLowerCase()) throw new Error('Historical block hash mismatch')
    const gate = await probeGate({
      client, gate: row.proposedGate, account: row.holder, preBlock: row.preBlock, caller: row.vault,
    })
    results.push({
      vault: row.vault, holder: row.holder, proposedGate: row.proposedGate,
      preBlock: row.preBlock, preBlockHash: row.preBlockHash,
      vaultCallerGate: gate.status,
    })
  }
  atomic(out, { study: STUDY, pilotSha256: PILOT_SHA, status: 'complete', results })
  return verifyOffline({ pilotPath, out })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    pilotPath: resolve('data/research/venue-signals/morpho-v2-gate-holder-pilot.json'),
    out: resolve('data/research/venue-signals/morpho-v2-gate-context-check.json'),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Gate caller-context check failed; no result was published.\n')
    process.exitCode = 1
  }
}
