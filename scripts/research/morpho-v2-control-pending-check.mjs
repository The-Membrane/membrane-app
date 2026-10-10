// Historical pending-state audit for the four frozen controls in the two-anchor pilot.
// An executable timestamp in the past remains pending until Accept or Revoke.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-control-pending-check-v1'
const ABI = parseAbi(['function executableAt(bytes data) view returns (uint256)'])
const SHA = /^[\da-f]{64}$/i
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned Stage-1 SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}

export function selectChecks(stage1, outcome) {
  if (stage1.status !== 'complete' || outcome.status !== 'complete' || outcome.treated?.length !== 2)
    throw new Error('Frozen pilot inputs mismatch')
  const checks = []
  for (const treated of outcome.treated) {
    if (treated.controls?.length !== 2 || !Number.isSafeInteger(treated.anchor?.anchorBlock))
      throw new Error('Frozen control set mismatch')
    for (const control of treated.controls) {
      if (control.preBlock !== treated.anchor.anchorBlock - 1 || !/^0x[\da-f]{64}$/i.test(control.preBlockHash))
        throw new Error('Control anchor mismatch')
      const events = stage1.rawEvents.filter(
        (event) => event.vault.toLowerCase() === control.vault.toLowerCase() && event.block < treated.anchor.anchorBlock,
      )
      if (events.length !== 2) throw new Error('Expected two prior cap submissions per control')
      for (const event of events) {
        checks.push({
          treatedBlock: treated.anchor.anchorBlock,
          controlVault: control.vault.toLowerCase(),
          preBlock: control.preBlock,
          preBlockHash: control.preBlockHash,
          submitBlock: event.block,
          txHash: event.txHash,
          logIndex: event.logIndex,
          data: event.data,
          dataSha256: sha(Buffer.from(event.data)),
        })
      }
    }
  }
  if (checks.length !== 8) throw new Error('Expected eight historical pending-state checks')
  return checks
}

export function classifyPending(value, anchorTimestamp) {
  const when = BigInt(value)
  if (when === 0n) return 'settled'
  return when <= BigInt(anchorTimestamp) ? 'pending-executable' : 'pending-timelocked'
}

export function verifyOffline({ out, stage1Path, outcomePath }) {
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  const outcomeBytes = readFileSync(outcomePath)
  const outcome = JSON.parse(outcomeBytes)
  const expected = selectChecks(stage1, outcome)
  const savedBytes = readFileSync(out)
  const saved = JSON.parse(savedBytes)
  if (
    saved.study !== STUDY || saved.status !== 'complete' ||
    saved.stage1Sha256 !== STAGE1_SHA || saved.outcomeSha256 !== sha(outcomeBytes) ||
    !Array.isArray(saved.checks) || saved.checks.length !== expected.length
  ) throw new Error('Pending-state checkpoint mismatch')
  for (let i = 0; i < expected.length; i++) {
    const { data, ...publicRow } = expected[i]
    const actual = saved.checks[i]
    if (Object.entries(publicRow).some(([key, value]) => actual[key] !== value))
      throw new Error('Pending-state row provenance mismatch')
    if (!/^\d+$/.test(actual.executableAt) || actual.state !== classifyPending(actual.executableAt, actual.anchorTimestamp))
      throw new Error('Pending-state row result mismatch')
  }
  return { checkpointSha256: sha(savedBytes), checks: saved.checks.map(({ controlVault, submitBlock, executableAt, state }) => ({ controlVault, submitBlock, executableAt, state })) }
}

export async function run({ client, out, stage1Path, outcomePath }) {
  if (existsSync(out)) return verifyOffline({ out, stage1Path, outcomePath })
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  const outcomeBytes = readFileSync(outcomePath)
  const outcome = JSON.parse(outcomeBytes)
  const expected = selectChecks(stage1, outcome)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const headers = new Map()
  const checks = []
  for (const row of expected) {
    const key = `${row.controlVault}:${row.preBlock}`
    let header = headers.get(key)
    if (!header) {
      header = await client.getBlock({ blockNumber: BigInt(row.preBlock) })
      if (header.hash.toLowerCase() !== row.preBlockHash.toLowerCase()) throw new Error('Historical block hash mismatch')
      headers.set(key, header)
    }
    const executableAt = await client.readContract({
      address: row.controlVault, abi: ABI, functionName: 'executableAt', args: [row.data], blockNumber: BigInt(row.preBlock),
    })
    const { data, ...publicRow } = row
    checks.push({
      ...publicRow,
      anchorTimestamp: Number(header.timestamp),
      executableAt: executableAt.toString(),
      state: classifyPending(executableAt, header.timestamp),
    })
  }
  atomic(out, { study: STUDY, status: 'complete', stage1Sha256: STAGE1_SHA, outcomeSha256: sha(outcomeBytes), checks })
  return verifyOffline({ out, stage1Path, outcomePath })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-control-pending-check.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
    outcomePath: resolve('data/research/venue-signals/morpho-v2-exit-outcome-pilot.json'),
  }
  try {
    const result = args.length
      ? verifyOffline(paths)
      : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    // RPC exception chains may contain credential-bearing URLs.
    process.stderr.write('Pending-state check failed; no result was published.\n')
    process.exitCode = 1
  }
}
