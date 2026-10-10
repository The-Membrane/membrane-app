// Read-only B−1 state for the two frozen route-switch Panic(0x11) cases.
// This measures adapter/market state, not advance knowledge of the curator's route choice.
// node scripts/research/morpho-v2-route-panic-prestate.mjs
// node scripts/research/morpho-v2-route-panic-prestate.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-route-panic-prestate-v1'
export const POSITION_SHA = '2d0977bf64db3be19fb1728064de23f1e2b1d31a821b5c5c07f120fc458370ca'
export const BASELINE_SHA = '2f6129caafe1a28753a94d9ad0faea24724284b44f383abee3701931ac05600c'
const BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
const BLUE_ABI = parseAbi([
  'function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
])
const ADAPTER_ABI = parseAbi(['function supplyShares(bytes32 id) view returns (uint256)'])
const VAULT_ABI = parseAbi(['function liquidityAdapter() view returns (address)'])
const RESERVE_BYTES = 2_500_000_000
const MAX_OUTPUT_BYTES = 32 * 1024
const HASH = /^0x[\da-f]{64}$/i
const ADDRESS = /^0x[\da-f]{40}$/i
const UINT = /^\d+$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unseal = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({ ...unseal(value), checkpointSha256: sha(JSON.stringify(unseal(value))) })
const lower = (value) => String(value).toLowerCase()

function pinned(path, expected, label) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error(`${label} SHA mismatch`)
  return JSON.parse(bytes)
}
function writeBounded(path, value) {
  const bytes = JSON.stringify(value)
  const size = Buffer.byteLength(bytes)
  if (size > MAX_OUTPUT_BYTES) throw new Error('Output cap reached')
  mkdirSync(dirname(path), { recursive: true })
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - size < RESERVE_BYTES)
    throw new Error('Disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}

export function selectCases(position, baseline) {
  if (
    position?.study !== 'morpho-v2-route-panic-position-v1' ||
    baseline?.study !== 'morpho-v2-route-exit-baseline-first20-v1' ||
    position.chainId !== 1 ||
    baseline.chainId !== 1 ||
    position.status !== 'complete' ||
    baseline.status !== 'complete' ||
    position.results?.length !== 2 ||
    baseline.anchors?.length !== 20 ||
    baseline.results?.length !== 20
  )
    throw new Error('Frozen source mismatch')
  return [15, 18].map((index, slot) => {
    const p = position.results[slot],
      anchor = baseline.anchors[index],
      b = baseline.results[index]
    if (
      p?.index !== index ||
      p.vault !== anchor?.vault ||
      p.vault !== b?.vault ||
      p.block !== anchor.block ||
      p.block !== b.block ||
      lower(p.blockHash) !== lower(anchor.blockHash) ||
      p.adapter !== anchor.toAdapter ||
      b.route !== anchor.fromAdapter ||
      b.status !== 'baseline-success' ||
      b.preBlock !== anchor.block - 1 ||
      !HASH.test(b.preBlockHash) ||
      !HASH.test(p.withdraw?.marketId) ||
      !ADDRESS.test(anchor.fromAdapter) ||
      !ADDRESS.test(anchor.toAdapter) ||
      p.positionSupplyShares !== '0' ||
      p.adapterSupplyShares !== '0'
    )
      throw new Error('Frozen case linkage mismatch')
    return {
      index,
      vault: p.vault,
      routeBlock: p.block,
      preBlock: b.preBlock,
      preBlockHash: b.preBlockHash,
      oldAdapter: anchor.fromAdapter,
      newAdapter: anchor.toAdapter,
      marketId: p.withdraw.marketId,
      loanToken: p.withdraw.marketParams?.loanToken,
    }
  })
}

export function validateOutput(saved, cases) {
  if (
    saved?.study !== STUDY ||
    saved.chainId !== 1 ||
    saved.status !== 'complete' ||
    saved.positionSha256 !== POSITION_SHA ||
    saved.baselineSha256 !== BASELINE_SHA ||
    JSON.stringify(saved.cases) !== JSON.stringify(cases) ||
    saved.results?.length !== 2 ||
    saved.checkpointSha256 !== sha(JSON.stringify(unseal(saved)))
  )
    throw new Error('Prestate checkpoint mismatch')
  for (let slot = 0; slot < 2; slot++) {
    const row = saved.results[slot],
      source = cases[slot]
    if (
      row.index !== source.index ||
      row.preBlock !== source.preBlock ||
      lower(row.preBlockHash) !== lower(source.preBlockHash) ||
      row.vault !== source.vault ||
      row.marketId !== source.marketId ||
      row.selectedAdapter !== source.oldAdapter ||
      !UINT.test(row.newPositionSupplyShares) ||
      !UINT.test(row.newTrackedSupplyShares) ||
      !UINT.test(row.oldPositionSupplyShares) ||
      (row.oldTrackedSupplyShares !== null && !UINT.test(row.oldTrackedSupplyShares))
    )
      throw new Error('Prestate row mismatch')
  }
  return saved
}

export function verifyOffline({ positionPath, baselinePath, out }) {
  const cases = selectCases(
    pinned(positionPath, POSITION_SHA, 'Position'),
    pinned(baselinePath, BASELINE_SHA, 'Baseline'),
  )
  return validateOutput(JSON.parse(readFileSync(out, 'utf8')), cases)
}

export async function run({ client, positionPath, baselinePath, out }) {
  const cases = selectCases(
    pinned(positionPath, POSITION_SHA, 'Position'),
    pinned(baselinePath, BASELINE_SHA, 'Baseline'),
  )
  if (existsSync(out)) return validateOutput(JSON.parse(readFileSync(out, 'utf8')), cases)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const results = []
  for (const c of cases) {
    const blockNumber = BigInt(c.preBlock)
    const header = await client.getBlock({ blockNumber })
    if (header.number !== blockNumber || lower(header.hash) !== lower(c.preBlockHash))
      throw new Error('Pinned B−1 header mismatch')
    const selectedAdapter = lower(
      await client.readContract({
        address: c.vault,
        abi: VAULT_ABI,
        functionName: 'liquidityAdapter',
        blockNumber,
      }),
    )
    if (selectedAdapter !== c.oldAdapter) throw new Error('Old route not selected at B−1')
    const readPosition = (adapter) =>
      client.readContract({
        address: BLUE,
        abi: BLUE_ABI,
        functionName: 'position',
        args: [c.marketId, adapter],
        blockNumber,
      })
    const readTracked = (adapter) =>
      client.readContract({
        address: adapter,
        abi: ADAPTER_ABI,
        functionName: 'supplyShares',
        args: [c.marketId],
        blockNumber,
      })
    const [newPosition, newTracked, oldPosition, oldTracked] = await Promise.all([
      readPosition(c.newAdapter),
      readTracked(c.newAdapter),
      readPosition(c.oldAdapter),
      readTracked(c.oldAdapter).catch(() => null),
    ])
    results.push({
      index: c.index,
      vault: c.vault,
      preBlock: c.preBlock,
      preBlockHash: c.preBlockHash,
      marketId: c.marketId,
      selectedAdapter,
      newPositionSupplyShares: BigInt(newPosition[0]).toString(),
      newTrackedSupplyShares: BigInt(newTracked).toString(),
      oldPositionSupplyShares: BigInt(oldPosition[0]).toString(),
      oldTrackedSupplyShares: oldTracked === null ? null : BigInt(oldTracked).toString(),
    })
  }
  const saved = seal({
    study: STUDY,
    chainId: 1,
    status: 'complete',
    positionSha256: POSITION_SHA,
    baselineSha256: BASELINE_SHA,
    cases,
    results,
  })
  validateOutput(saved, cases)
  writeBounded(out, saved)
  return saved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const paths = {
    positionPath: resolve('data/research/venue-signals/morpho-v2-route-panic-position.json'),
    baselinePath: resolve('data/research/venue-signals/morpho-v2-route-exit-baseline-first20.json'),
    out: resolve('data/research/venue-signals/morpho-v2-route-panic-prestate.json'),
  }
  try {
    if (args.length && args.join(' ') !== '--verify offline')
      throw new Error('Unsupported arguments')
    const saved = args.length
      ? verifyOffline(paths)
      : await run({
          ...paths,
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
        })
    process.stdout.write(
      JSON.stringify({
        status: saved.status,
        rows: saved.results.length,
        sha256: sha(readFileSync(paths.out)),
      }) + '\n',
    )
  } catch {
    process.stderr.write('Panic prestate probe stopped; no result was published.\n')
    process.exitCode = 1
  }
}
