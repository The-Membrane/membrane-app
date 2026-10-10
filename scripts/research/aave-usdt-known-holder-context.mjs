// Retrospective context for an address identified AFTER its 50m USDT withdrawal.
// Calendar-grid anchors are fixed before reading balances, but this holder is
// outcome-selected: these rows cannot validate a prospective warning or intent.
// Dry by default; --run requires a unique local output path.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeFunctionResult, encodeFunctionData } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { ABI, diskGuard } from './aave-core-forward-panel.mjs'
import { validateCheckpoint } from './aave-stable-expansion.mjs'

export const STUDY = 'aave-usdt-known-holder-context-v1'
export const SOURCE = resolve('data/research/venue-signals/aave-stable-expansion-v2.json')
export const EXPECTED_SOURCE_SHA256 =
  '2e5c47641b74f1c3d5b46cd23976c2ccd47e29a34cb8cd462a98a81ca3ea3849'
export const OUTPUT_ROOT = resolve('data/research/venue-signals')
export const HOLDER = '0x72132bf09a9ee6517f3f1d997b4b3cd2115e5991'
export const ATOKEN = '0x23878914efe38d27c4d67ab83ed1b93a74d4086a'
export const INDICES = Object.freeze(Array.from({ length: 15 }, (_, j) => 1568 - 4 * j))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const hash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const usdtRaw = (value, label) => {
  if (!Number.isFinite(value) || value < 0 || value * 1e6 > Number.MAX_SAFE_INTEGER)
    throw new Error(`Invalid ${label}`)
  return BigInt(Math.round(value * 1e6))
}
const ppm = (numerator, denominator) =>
  denominator === 0n ? null : ((numerator * 1_000_000n) / denominator).toString()

export function outputPath(path) {
  if (!path) throw new Error('Explicit --out is required for --run')
  const out = resolve(path)
  if (!out.startsWith(`${OUTPUT_ROOT}/`) || !out.endsWith('.json'))
    throw new Error('Output must be a JSON file under data/research/venue-signals')
  return out
}

export function loadGrid(path = SOURCE, readBytes = readFileSync) {
  const bytes = readBytes(path)
  const sourceFileSha256 = sha(bytes)
  if (sourceFileSha256 !== EXPECTED_SOURCE_SHA256)
    throw new Error('Frozen archive physical SHA mismatch')
  const source = JSON.parse(bytes.toString('utf8'))
  validateCheckpoint(source)
  if (source.status !== 'complete' || source.version !== 2 || source.chainId !== 1)
    throw new Error('Core USDT grid must be complete v2 mainnet')
  const rows = source.entries
    .filter((row) => row.market === 'USDT')
    .sort((a, b) => a.block - b.block)
  if (
    rows.length !== 1569 ||
    rows.some(
      (row, i) =>
        row.kind !== 'observed' ||
        row.actualAToken.toLowerCase() !== ATOKEN ||
        row.block !== source.grid.first + source.grid.step * i,
    )
  )
    throw new Error('USDT grid is incomplete or identity changed')
  return {
    sourceFileSha256,
    sourceEntriesSha256: source.entriesSha256,
    grid: source.grid,
    rows,
  }
}

export function plan({ grid = loadGrid() } = {}) {
  return {
    study: STUDY,
    mode: 'dry',
    holder: HOLDER,
    selection: 'retrospectively selected known 50m withdrawer; not a prospective cohort',
    sourceFileSha256: grid.sourceFileSha256,
    sourceEntriesSha256: grid.sourceEntriesSha256,
    anchorIndices: [...INDICES],
    anchors: INDICES.map((i) => ({
      index: i,
      block: grid.rows[i].block,
      at: grid.rows[i].at,
      nextCashIndex: i + 4 < grid.rows.length ? i + 4 : null,
    })),
    networkReads: 0,
  }
}

const defaultIo = {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
}

export function saveSnapshot(out, sealed, checkDisk = diskGuard, io = defaultIo) {
  const target = outputPath(out)
  checkDisk(target)
  if (io.existsSync(target)) throw new Error('Refusing to overwrite an existing holder context')
  io.mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  let fd
  let published = false
  try {
    fd = io.openSync(temp, 'wx', 0o600)
    io.writeFileSync(fd, `${JSON.stringify(sealed, null, 2)}\n`)
    io.closeSync(fd)
    fd = undefined
    checkDisk(target)
    // Hard-link publication is atomic like a same-volume rename, but unlike
    // rename it cannot replace a result another process published meanwhile.
    io.linkSync(temp, target)
    published = true
    const saved = JSON.parse(io.readFileSync(target, 'utf8'))
    if (
      !saved.payload ||
      saved.sha256 !== sha(JSON.stringify(saved.payload)) ||
      saved.sha256 !== sealed.sha256
    )
      throw new Error('Saved SHA mismatch')
  } catch (error) {
    if (fd !== undefined) io.closeSync(fd)
    if (published) io.unlinkSync(target)
    throw error
  } finally {
    if (io.existsSync(temp)) io.unlinkSync(temp)
  }
}

export async function collect({
  client,
  out,
  grid = loadGrid(),
  checkDisk = diskGuard,
  now = Date.now,
  save = (path, sealed) => saveSnapshot(path, sealed, checkDisk),
}) {
  const target = outputPath(out)
  if (existsSync(target)) throw new Error('Refusing to overwrite an existing holder context')
  const rpc = async (method, args = {}) => {
    checkDisk(target)
    return client[method](args)
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet required')
  const selected = plan({ grid })
  const rows = []
  for (const anchor of selected.anchors) {
    const source = grid.rows[anchor.index]
    const block = await rpc('getBlock', { blockNumber: BigInt(source.block) })
    if (
      Number(block?.number) !== source.block ||
      !hash(block?.hash) ||
      block.hash.toLowerCase() !== source.blockHash.toLowerCase() ||
      Number(block.timestamp) !== source.at
    )
      throw new Error(`Saved block identity mismatch at ${source.block}`)
    const result = await rpc('request', {
      method: 'eth_call',
      params: [
        {
          to: ATOKEN,
          data: encodeFunctionData({ abi: ABI.token, functionName: 'balanceOf', args: [HOLDER] }),
        },
        { blockHash: source.blockHash, requireCanonical: true },
      ],
    })
    const claimRaw = decodeFunctionResult({
      abi: ABI.token,
      functionName: 'balanceOf',
      data: result,
    })
    const cashProxyRaw = usdtRaw(source.cashUsdAssumingPeg, 'saved cash proxy')
    const supplyProxyRaw = usdtRaw(source.supplyUsdAssumingPeg, 'saved supply proxy')
    const next = anchor.nextCashIndex === null ? null : grid.rows[anchor.nextCashIndex]
    rows.push({
      index: anchor.index,
      block: source.block,
      blockHash: source.blockHash,
      at: source.at,
      claimRaw: claimRaw.toString(),
      claimIsZero: claimRaw === 0n,
      cashProxyRaw: cashProxyRaw.toString(),
      supplyProxyRaw: supplyProxyRaw.toString(),
      claimToCashPpm: ppm(claimRaw, cashProxyRaw),
      claimToSupplyPpm: ppm(claimRaw, supplyProxyRaw),
      nextCashProxy: next
        ? {
            index: anchor.nextCashIndex,
            block: next.block,
            at: next.at,
            elapsedSeconds: next.at - source.at,
            cashRaw: usdtRaw(next.cashUsdAssumingPeg, 'next saved cash proxy').toString(),
          }
        : null,
      nextCashCensor: next ? null : 'end-of-saved-grid',
    })
  }
  const payload = {
    study: STUDY,
    chainId: 1,
    holder: HOLDER,
    aToken: ATOKEN,
    sourceFileSha256: grid.sourceFileSha256,
    sourceEntriesSha256: grid.sourceEntriesSha256,
    selectedIndices: [...INDICES],
    observedAtMs: now(),
    captureStatus: 'complete',
    rowsExpected: INDICES.length,
    rowsCaptured: rows.length,
    missingCount: 0,
    selectionCaveat:
      'Wallet chosen after known withdrawal; historical context only, no prospective signal or intent inference.',
    proxyCaveat:
      'Cash and supply are rounded six-decimal saved USD-at-peg reserve proxies, not live replayed raw balances or executable outcomes.',
    rows,
  }
  const sealed = { sha256: sha(JSON.stringify(payload)), payload }
  checkDisk(target)
  save(target, sealed)
  return sealed
}

async function main() {
  const argv = process.argv.slice(2)
  const run = argv.includes('--run')
  const outIndex = argv.indexOf('--out')
  const out = outIndex < 0 ? null : argv[outIndex + 1]
  if (argv.some((arg, i) => !['--run', '--out'].includes(arg) && i !== outIndex + 1))
    throw new Error(
      'Usage: node aave-usdt-known-holder-context.mjs [--run --out data/research/venue-signals/unique.json]',
    )
  if (!run) {
    process.stdout.write(`${JSON.stringify(plan(), null, 2)}\n`)
    return
  }
  outputPath(out)
  const result = await collect({
    client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
    out,
  })
  process.stdout.write(
    `${JSON.stringify({ out: outputPath(out), rows: result.payload.rows.length, sha256: result.sha256 })}\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write(
      'Holder context capture failed; check source identity, RPC, and disk reserve.\n',
    )
    process.exitCode = 1
  })
