// A separate, prospective recent-recipient witness pilot. Not a holder census,
// population exit-risk estimate, or an executable-withdrawal outcome series.
// The default command is dry: --run is required for any RPC or write.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFunctionData, keccak256, parseAbiItem } from 'viem'
import { ABI, DISK_FLOOR_BYTES, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-core-holder-witness-v1.json')
export const LOOKBACK_BLOCKS = 2000
export const LOG_CHUNK_BLOCKS = 500
export const MAX_LOGS_PER_MARKET = 20_000
export const MAX_CANDIDATES = 100
export const QUOTE_RAW = 1_000_000n * 10n ** 6n
export const CANDIDATE_POLICY = 'exclude-zero-dead-low-reserved-v2'
export const EIP1967_POOL_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const STUDY = 'aave-core-holder-witness-v1'
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const WITHDRAW = [
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
]
const lower = (value) => String(value || '').toLowerCase()
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value))
export async function readPoolImplementation(client, blockHash, checkDisk, out) {
  const pinned = { blockHash, requireCanonical: true }
  checkDisk(out)
  let word
  try {
    word = await client.request({
      method: 'eth_getStorageAt',
      params: [POOL, EIP1967_POOL_IMPLEMENTATION_SLOT, pinned],
    })
  } catch {
    return { status: 'unknown', reason: 'pinned-storage-read-unavailable' }
  }
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(word) || !/^0x0{24}/i.test(word))
    return { status: 'unknown', reason: 'invalid-eip1967-word' }
  const address = `0x${word.slice(26)}`.toLowerCase()
  if (address === `0x${'0'.repeat(40)}`)
    return { status: 'unknown', reason: 'zero-eip1967-implementation' }
  checkDisk(out)
  try {
    const code = await client.request({ method: 'eth_getCode', params: [address, pinned] })
    return { status: 'observed', address, codeHash: deployedCodeHash(code, 'Pool implementation') }
  } catch {
    return { status: 'unknown', reason: 'pinned-implementation-code-unavailable', address }
  }
}
export function sentinelReason(address) {
  if (!isAddress(address)) throw new Error('Malformed candidate address')
  const value = BigInt(address)
  if (value === 0n) return 'zero-address'
  if (lower(address) === `0x${'0'.repeat(36)}dead`) return 'dead-address'
  if (value <= 0xffn) return 'low-reserved-address'
  return null
}
class DiskGuardError extends Error {
  constructor(cause) {
    super('Disk reserve check failed; baseline aborted', { cause })
    this.name = 'DiskGuardError'
  }
}
const deployedCodeHash = (code, label) => {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`${label} missing deployed code`)
  return keccak256(code)
}
const raw = (value, label) => {
  const n = BigInt(value)
  if (n < 0n) throw new Error(`Negative ${label}`)
  return n
}
const empty = () => ({
  study: STUDY,
  chainId: 1,
  pool: POOL,
  markets: MARKETS,
  protocol: {
    anchor: 'head-minus-64',
    lookbackBlocks: LOOKBACK_BLOCKS,
    logChunkBlocks: LOG_CHUNK_BLOCKS,
    maxLogsPerMarket: MAX_LOGS_PER_MARKET,
    maxCandidates: MAX_CANDIDATES,
    quoteRaw: QUOTE_RAW.toString(),
    selection: 'max-incoming-transfer-descending/address-ascending',
    caveat:
      'Recent-recipient witness feasibility only; no census, prevalence, causation, or alert performance.',
  },
  baselines: [],
})

export function readCheckpoint(out = DEFAULT_OUT) {
  if (!existsSync(out)) return empty()
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (!saved?.payload || saved.sha256 !== hash(saved.payload))
    throw new Error('Holder witness checkpoint SHA mismatch')
  const data = saved.payload
  const expected = empty()
  if (
    data.study !== STUDY ||
    data.chainId !== 1 ||
    lower(data.pool) !== lower(POOL) ||
    JSON.stringify(data.markets) !== JSON.stringify(MARKETS) ||
    JSON.stringify(data.protocol) !== JSON.stringify(expected.protocol) ||
    !Array.isArray(data.baselines) ||
    data.baselines.length > 128
  )
    throw new Error('Holder witness checkpoint identity mismatch')
  let prior = null
  for (const row of data.baselines) {
    if (
      !Number.isSafeInteger(row.block) ||
      !isHash(row.blockHash) ||
      !Number.isSafeInteger(row.blockTimestamp) ||
      !Number.isSafeInteger(row.observedAtMs) ||
      (row.captureStartedAtMs !== undefined &&
        (!Number.isSafeInteger(row.captureStartedAtMs) ||
          row.captureStartedAtMs < row.blockTimestamp * 1000 ||
          row.captureStartedAtMs > row.observedAtMs)) ||
      row.previousSha256 !== (prior?.rowSha256 || null) ||
      row.rowSha256 !== hash({ ...row, rowSha256: undefined }) ||
      (row.poolImplementation !== undefined &&
        !(row.poolImplementation?.status === 'observed'
          ? isAddress(row.poolImplementation.address) && isHash(row.poolImplementation.codeHash)
          : row.poolImplementation?.status === 'unknown' &&
            typeof row.poolImplementation.reason === 'string')) ||
      (row.candidatePolicy !== undefined && row.candidatePolicy !== CANDIDATE_POLICY) ||
      (prior && (row.block <= prior.block || row.observedAtMs < prior.observedAtMs)) ||
      !Array.isArray(row.markets) ||
      row.markets.length !== MARKETS.length ||
      row.markets.some((market, i) => market.name !== MARKETS[i].name)
    )
      throw new Error('Holder witness checkpoint row chain mismatch')
    if (
      row.candidatePolicy === CANDIDATE_POLICY &&
      row.markets.some((market) =>
        market.candidates.some((candidate) => {
          const reason = sentinelReason(candidate.address)
          return reason
            ? candidate.withdraw !== 'excluded-sentinel' ||
                candidate.exclusionReason !== reason ||
                candidate.aTokenBalanceRaw !== null ||
                candidate.codeStatus !== null
            : candidate.withdraw === 'excluded-sentinel'
        }),
      )
    )
      throw new Error('Holder witness candidate policy mismatch')
    prior = row
  }
  return data
}

export function rankRecipients(logs) {
  const largest = new Map()
  for (const log of logs) {
    const to = lower(log?.args?.to)
    if (!isAddress(to)) throw new Error('Malformed Transfer recipient')
    const value = raw(log?.args?.value, 'Transfer value')
    if (value > (largest.get(to) ?? -1n)) largest.set(to, value)
  }
  return [...largest]
    .sort(([addressA, amountA], [addressB, amountB]) =>
      amountA === amountB ? addressA.localeCompare(addressB) : amountA > amountB ? -1 : 1,
    )
    .slice(0, MAX_CANDIDATES)
    .map(([address, amount]) => ({ address, maxIncomingRaw: amount.toString() }))
}

function classifyCallError(error) {
  let current = error
  while (current && typeof current === 'object') {
    if (
      ['ExecutionRevertedError', 'ContractFunctionRevertedError', 'RawContractError'].includes(
        current.name,
      )
    )
      return 'revert'
    current = current.cause
  }
  return 'rpc-error'
}

function save(out, data, checkDisk) {
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ payload: data, sha256: hash(data) }))
    closeSync(fd)
    fd = undefined
    checkDisk(out)
    renameSync(temp, out)
    // Verify the bytes that a later outcome reader will actually load.
    readCheckpoint(out)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

export async function collectBaseline({
  client,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
}) {
  const startedAtMs = now()
  return collectBaselineAtStart({ client, out, checkDisk, now }, startedAtMs)
}

async function collectBaselineAtStart({ client, out, checkDisk, now }, startedAtMs) {
  if (!Number.isSafeInteger(startedAtMs)) throw new Error('Invalid local capture start time')
  const rpc = async (method, args = {}) => {
    try {
      checkDisk(out)
    } catch (error) {
      throw new DiskGuardError(error)
    }
    return client[method](args)
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet required')
  const head = raw(await rpc('getBlockNumber'), 'head')
  if (head <= 64n + BigInt(LOOKBACK_BLOCKS)) throw new Error('Head before window')
  const blockNumber = head - 64n
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported block number')
  const block = Number(blockNumber)
  const header = await rpc('getBlock', { blockNumber })
  const blockTimestamp = Number(raw(header?.timestamp, 'timestamp'))
  if (!isHash(header?.hash) || !Number.isSafeInteger(blockTimestamp))
    throw new Error('Invalid pinned block header')
  const poolCodeHash = deployedCodeHash(
    await rpc('getCode', { address: POOL, blockNumber }),
    'Aave Pool',
  )
  const poolImplementation = await readPoolImplementation(
    client,
    lower(header.hash),
    checkDisk,
    out,
  )
  const rows = []
  for (const market of MARKETS) {
    const underlyingCodeHash = deployedCodeHash(
      await rpc('getCode', { address: market.base, blockNumber }),
      `${market.name} underlying`,
    )
    const aTokenCodeHash = deployedCodeHash(
      await rpc('getCode', { address: market.aToken, blockNumber }),
      `${market.name} aToken`,
    )
    const reserve = await rpc('readContract', {
      address: POOL,
      abi: ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
      blockNumber,
    })
    if (lower(reserve?.aTokenAddress) !== lower(market.aToken))
      throw new Error(`${market.name} aToken identity mismatch`)
    const configurationDecimals = Number(
      (raw(reserve?.configuration?.data, 'configuration') >> 48n) & 255n,
    )
    const tokenDecimals = Number(
      await rpc('readContract', {
        address: market.base,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    const aTokenDecimals = Number(
      await rpc('readContract', {
        address: market.aToken,
        abi: ABI.token,
        functionName: 'decimals',
        blockNumber,
      }),
    )
    if ([configurationDecimals, tokenDecimals, aTokenDecimals].some((v) => v !== market.decimals))
      throw new Error(`${market.name} decimals mismatch`)
    const logs = []
    const logIdentities = new Set()
    const start = blockNumber - BigInt(LOOKBACK_BLOCKS)
    for (let from = start; from < blockNumber; from += BigInt(LOG_CHUNK_BLOCKS)) {
      const to = from + BigInt(LOG_CHUNK_BLOCKS - 1)
      const chunk = await rpc('getLogs', {
        address: market.aToken,
        event: TRANSFER,
        fromBlock: from,
        toBlock: to,
      })
      if (!Array.isArray(chunk)) throw new Error('Malformed Transfer logs')
      if (logs.length + chunk.length > MAX_LOGS_PER_MARKET)
        throw new Error(`${market.name} Transfer log ceiling exceeded; no partial baseline`)
      for (const log of chunk) {
        if (
          lower(log.address) !== lower(market.aToken) ||
          log.blockNumber < from ||
          log.blockNumber > to ||
          !isHash(log.blockHash) ||
          log.removed === true
        )
          throw new Error(`${market.name} Transfer log identity/window mismatch`)
        if (
          !isHash(log.transactionHash) ||
          !Number.isSafeInteger(Number(log.logIndex)) ||
          Number(log.logIndex) < 0
        )
          throw new Error(`${market.name} Transfer log missing transaction identity`)
        const identity = `${lower(log.transactionHash)}:${log.logIndex}`
        if (logIdentities.has(identity))
          throw new Error(`${market.name} duplicate Transfer log identity`)
        logIdentities.add(identity)
      }
      logs.push(...chunk)
    }
    const ranked = rankRecipients(logs)
    const candidates = []
    for (const candidate of ranked) {
      const record = { ...candidate, aTokenBalanceRaw: null, codeStatus: null, withdraw: null }
      candidates.push(record)
      const excluded = sentinelReason(candidate.address)
      if (excluded) {
        record.withdraw = 'excluded-sentinel'
        record.exclusionReason = excluded
        continue
      }
      let stage = 'balance'
      try {
        const balance = raw(
          await rpc('readContract', {
            address: market.aToken,
            abi: ABI.token,
            functionName: 'balanceOf',
            args: [candidate.address],
            blockNumber,
          }),
          'aToken balance',
        )
        record.aTokenBalanceRaw = balance.toString()
        stage = 'code'
        const code = await rpc('getCode', { address: candidate.address, blockNumber })
        if (code !== undefined && (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)))
          throw new Error('Malformed holder code')
        // viem normalizes eth_getCode's `0x` EOA response to undefined.
        record.codeStatus = code === undefined || code === '0x' ? 'eoa' : 'contract'
        if (record.codeStatus !== 'eoa') record.withdraw = 'excluded-contract'
        else if (balance < QUOTE_RAW) record.withdraw = 'excluded-below-quote'
        else {
          stage = 'withdraw'
          const data = encodeFunctionData({
            abi: WITHDRAW,
            functionName: 'withdraw',
            args: [market.base, QUOTE_RAW, candidate.address],
          })
          try {
            const result = await rpc('call', {
              account: candidate.address,
              to: POOL,
              data,
              blockNumber,
            })
            if (
              !result ||
              typeof result.data !== 'string' ||
              !/^0x[0-9a-fA-F]{64}$/.test(result.data)
            )
              throw new Error('Malformed withdraw return')
            if (BigInt(result.data) !== QUOTE_RAW) throw new Error('Unexpected withdraw amount')
            record.withdraw = 'success'
          } catch (error) {
            if (error instanceof DiskGuardError) throw error
            record.withdraw = classifyCallError(error)
            if (record.withdraw === 'rpc-error') record.rpcErrorStage = stage
          }
        }
      } catch (error) {
        if (error instanceof DiskGuardError) throw error
        record.withdraw = 'rpc-error'
        record.rpcErrorStage = stage
      }
    }
    rows.push({
      name: market.name,
      underlying: lower(market.base),
      underlyingCodeHash,
      aToken: lower(market.aToken),
      aTokenCodeHash,
      decimals: market.decimals,
      quoteRaw: QUOTE_RAW.toString(),
      transferWindow: { fromBlock: Number(start), toBlock: block - 1, logs: logs.length },
      transferLogSha256: hash(
        logs.map((log) => ({
          blockNumber: String(log.blockNumber),
          blockHash: lower(log.blockHash),
          transactionHash: lower(log.transactionHash),
          logIndex: String(log.logIndex),
          from: lower(log.args.from),
          to: lower(log.args.to),
          valueRaw: String(log.args.value),
        })),
      ),
      uniqueRecipients: new Set(logs.map((log) => lower(log.args.to))).size,
      candidates,
      qualifyingHolders: candidates
        .filter((candidate) => candidate.withdraw === 'success')
        .map((candidate) => candidate.address),
    })
  }
  const endHeader = await rpc('getBlock', { blockNumber })
  if (
    lower(endHeader?.hash) !== lower(header.hash) ||
    Number(endHeader?.timestamp) !== blockTimestamp
  )
    throw new Error('Pinned block reorganization or inconsistent RPC')
  const observedAtMs = now()
  if (
    !Number.isSafeInteger(observedAtMs) ||
    startedAtMs < blockTimestamp * 1000 ||
    startedAtMs > observedAtMs
  )
    throw new Error('Invalid local observation time')
  return {
    block,
    blockHash: lower(header.hash),
    blockTimestamp,
    captureStartedAtMs: startedAtMs,
    observedAtMs,
    candidatePolicy: CANDIDATE_POLICY,
    poolCodeHash,
    poolImplementation,
    markets: rows,
  }
}

export async function run({ client, out = DEFAULT_OUT, checkDisk = diskGuard, now = Date.now }) {
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const lock = `${out}.lock`
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    const data = readCheckpoint(out)
    if (data.baselines.length >= 128) throw new Error('Baseline cap reached')
    const last = data.baselines.at(-1)
    const captureStartedAtMs = now()
    if (!Number.isSafeInteger(captureStartedAtMs))
      throw new Error('Invalid local capture start time')
    if (last) {
      checkDisk(out)
      const old = await client.getBlock({ blockNumber: BigInt(last.block) })
      if (lower(old?.hash) !== last.blockHash || Number(old?.timestamp) !== last.blockTimestamp)
        throw new Error('Previously saved block no longer canonical')
    }
    const baseline = await collectBaselineAtStart(
      { client, out, checkDisk, now },
      captureStartedAtMs,
    )
    if (last && (baseline.block <= last.block || baseline.observedAtMs < last.observedAtMs))
      throw new Error('Non-monotone holder baseline')
    const withoutHash = { ...baseline, previousSha256: last?.rowSha256 || null }
    const row = { ...withoutHash, rowSha256: hash(withoutHash) }
    const updated = { ...data, baselines: [...data.baselines, row] }
    save(out, updated, checkDisk)
    return {
      out,
      block: row.block,
      markets: row.markets.map((market) => ({
        name: market.name,
        logs: market.transferWindow.logs,
        candidates: market.candidates.length,
        qualifyingHolders: market.qualifyingHolders.length,
      })),
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
}

export function plan(out = DEFAULT_OUT) {
  const data = readCheckpoint(out)
  return {
    out,
    status: 'dry-only',
    baselines: data.baselines.length,
    diskFloorBytes: DISK_FLOOR_BYTES,
    caveat:
      'No RPC or write. --run freezes one recent-recipient baseline; no future outcome reads.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (
      args.some(
        (arg) => !['--run', '--out'].includes(arg) && args[args.indexOf(arg) - 1] !== '--out',
      )
    )
      throw new Error('Invalid arguments')
    const outIndex = args.indexOf('--out')
    const out = outIndex < 0 ? DEFAULT_OUT : args[outIndex + 1]
    if (!out) throw new Error('Missing --out value')
    const result = args.includes('--run')
      ? await run({
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
          out,
        })
      : plan(out)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // RPC exceptions may include credential-bearing URLs.
    process.stderr.write('Holder witness failed. Check local RPC, disk, and checkpoint state.\n')
    process.exitCode = 1
  }
}
