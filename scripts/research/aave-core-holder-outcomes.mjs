// Prospective fixed-holder exit witnesses, not a population-risk or predictive-alert score.
// Dry by default. A horizon can be collected only once its first eligible block is finalized.
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
import { encodeFunctionData, keccak256 } from 'viem'
import { ABI, DISK_FLOOR_BYTES, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import {
  DEFAULT_OUT as DEFAULT_BASELINE,
  readCheckpoint as readBaseline,
} from './aave-core-holder-witness.mjs'
import {
  DEFAULT_OUT as DEFAULT_CONFIG,
  EIP1967_IMPLEMENTATION_SLOT,
  FROZEN_BLOCK,
  USER_ABI,
  decodeUserBitmap,
  readCheckpoint as readConfig,
} from './aave-core-holder-config.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const DEFAULT_OUT = resolve('data/research/venue-signals/aave-core-holder-outcomes-v1.json')
export const HORIZONS = Object.freeze({ '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600 })
const STUDY = 'aave-core-holder-outcomes-v1'
const QUOTE_RAW = 1_000_000n * 10n ** 6n
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
const uint = (value, label) => {
  let number
  try {
    number = BigInt(value)
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  if (number < 0n) throw new Error(`Negative ${label}`)
  return number
}
const codeHash = (code, label) => {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error(`${label} missing deployed code`)
  return keccak256(code)
}
const accountFields = [
  'totalCollateralBase',
  'totalDebtBase',
  'availableBorrowsBase',
  'currentLiquidationThreshold',
  'ltv',
  'healthFactor',
]
const accountRaw = (value) => {
  if (!Array.isArray(value) || value.length !== accountFields.length)
    throw new Error('Malformed user account data')
  return Object.fromEntries(
    accountFields.map((name, index) => [name, uint(value[index], name).toString()]),
  )
}
const revertBytes = (error) => {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = typeof current.data === 'string' ? current.data : current.data?.data
    if (typeof candidate === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,2048}$/.test(candidate)) {
      const data = candidate.toLowerCase()
      return { data, selector: data.slice(0, 10) }
    }
    current = current.cause
  }
  return { data: null, selector: null }
}
async function pinnedImplementation(client, contract, blockHash, checkDisk, out) {
  const pinned = { blockHash, requireCanonical: true }
  checkDisk(out)
  let word
  try {
    word = await client.request({
      method: 'eth_getStorageAt',
      params: [contract, EIP1967_IMPLEMENTATION_SLOT, pinned],
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
    return { status: 'observed', address, codeHash: codeHash(code, 'Implementation') }
  } catch {
    return { status: 'unknown', reason: 'pinned-implementation-code-unavailable', address }
  }
}
const empty = (baselinePath) => ({
  study: STUDY,
  chainId: 1,
  pool: POOL,
  baselinePath: resolve(baselinePath),
  horizonSeconds: HORIZONS,
  caveat:
    'Recent-recipient fixed-holder witnesses only; no census, prevalence, causation, or alert performance.',
  outcomes: [],
})

export function readCheckpoint(out = DEFAULT_OUT, baselinePath = DEFAULT_BASELINE) {
  if (!existsSync(out)) return empty(baselinePath)
  const saved = JSON.parse(readFileSync(out, 'utf8'))
  if (!saved?.payload || saved.sha256 !== hash(saved.payload))
    throw new Error('Holder outcomes checkpoint SHA mismatch')
  const data = saved.payload
  const expected = empty(baselinePath)
  if (
    data.study !== STUDY ||
    data.chainId !== 1 ||
    lower(data.pool) !== lower(POOL) ||
    data.baselinePath !== expected.baselinePath ||
    JSON.stringify(data.horizonSeconds) !== JSON.stringify(HORIZONS) ||
    data.caveat !== expected.caveat ||
    !Array.isArray(data.outcomes) ||
    data.outcomes.length > 384
  )
    throw new Error('Holder outcomes checkpoint identity mismatch')
  let previous = null
  const keys = new Set()
  const baselines = data.outcomes.length ? readBaseline(baselinePath).baselines : []
  for (const row of data.outcomes) {
    const key = `${row.baselineBlock}:${row.horizon}`
    const baseline = baselines.find((item) => item.block === row.baselineBlock)
    const frozen = baseline ? frozenMarkets(baseline) : null
    if (
      !Number.isSafeInteger(row.baselineBlock) ||
      !/^[0-9a-f]{64}$/.test(String(row.baselineSha256)) ||
      !Object.hasOwn(HORIZONS, row.horizon) ||
      !Number.isSafeInteger(row.block) ||
      !isHash(row.blockHash) ||
      !Number.isSafeInteger(row.blockTimestamp) ||
      row.previousSha256 !== (previous?.rowSha256 || null) ||
      row.rowSha256 !== hash({ ...row, rowSha256: undefined }) ||
      !baseline ||
      row.baselineSha256 !== baseline.rowSha256 ||
      lower(row.baselineBlockHash) !== lower(baseline.blockHash) ||
      row.targetTimestamp !== baseline.blockTimestamp + HORIZONS[row.horizon] ||
      !Array.isArray(row.markets) ||
      row.markets.length !== frozen.length ||
      row.markets.some((market, index) => {
        const entry = frozen[index]
        return (
          market?.name !== entry.market.name ||
          lower(market?.underlying) !== lower(entry.market.base) ||
          lower(market?.aToken) !== lower(entry.market.aToken) ||
          market?.quoteRaw !== QUOTE_RAW.toString() ||
          !Array.isArray(market?.witnesses) ||
          market.witnesses.length !== entry.holders.length ||
          market.witnesses.some(
            (witness, holderIndex) => lower(witness?.holder) !== lower(entry.holders[holderIndex]),
          )
        )
      }) ||
      keys.has(key)
    )
      throw new Error('Holder outcomes checkpoint row chain mismatch')
    keys.add(key)
    previous = row
  }
  return data
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

function frozenMarkets(baseline) {
  if (!Array.isArray(baseline.markets) || baseline.markets.length !== MARKETS.length)
    throw new Error('Malformed baseline markets')
  return baseline.markets.map((row, index) => {
    const market = MARKETS[index]
    if (
      row.name !== market.name ||
      lower(row.underlying) !== lower(market.base) ||
      lower(row.aToken) !== lower(market.aToken) ||
      row.decimals !== market.decimals ||
      uint(row.quoteRaw, 'baseline quote') !== QUOTE_RAW ||
      !isHash(row.underlyingCodeHash) ||
      !isHash(row.aTokenCodeHash) ||
      !Array.isArray(row.candidates) ||
      !Array.isArray(row.qualifyingHolders)
    )
      throw new Error('Baseline market identity mismatch')
    const successes = row.candidates.filter((candidate) => candidate.withdraw === 'success')
    if (
      successes.length !== row.qualifyingHolders.length ||
      successes.some(
        (candidate, i) =>
          lower(candidate.address) !== lower(row.qualifyingHolders[i]) ||
          candidate.codeStatus !== 'eoa' ||
          uint(candidate.aTokenBalanceRaw, 'baseline holder balance') < QUOTE_RAW,
      ) ||
      new Set(row.qualifyingHolders.map(lower)).size !== row.qualifyingHolders.length ||
      row.qualifyingHolders.some((holder) => !isAddress(holder))
    )
      throw new Error('Baseline qualifying-holder ledger mismatch')
    return { market, baselineRow: row, holders: row.qualifyingHolders }
  })
}

export function selectBaseline(baselines, baselineBlock) {
  if (!Number.isSafeInteger(baselineBlock) || baselineBlock < 0)
    throw new Error('Explicit baseline block required')
  const baseline = baselines.find((row) => row.block === baselineBlock)
  if (!baseline || !isHash(baseline.blockHash) || !isHash(baseline.poolCodeHash))
    throw new Error('Baseline block absent or malformed')
  frozenMarkets(baseline)
  return baseline
}

export async function firstFinalizedBlock({ client, targetTimestamp, anchorBlock, rpc }) {
  const finalized = await rpc('getBlock', { blockTag: 'finalized' })
  if (!isHash(finalized?.hash)) throw new Error('Provider lacks consensus finalized block')
  let high = uint(finalized.number, 'finalized block')
  if (high <= BigInt(anchorBlock)) throw new Error('Horizon not finalized')
  const cache = new Map()
  const header = async (number) => {
    const key = Number(number)
    if (!Number.isSafeInteger(key)) throw new Error('Unsupported block number')
    if (!cache.has(key)) {
      const value = await rpc('getBlock', { blockNumber: number })
      if (!isHash(value?.hash) || !Number.isSafeInteger(Number(value?.timestamp)))
        throw new Error('Invalid block header')
      cache.set(key, { block: key, hash: lower(value.hash), timestamp: Number(value.timestamp) })
    }
    return cache.get(key)
  }
  const highHeader = await header(high)
  if (
    highHeader.hash !== lower(finalized.hash) ||
    highHeader.timestamp !== Number(finalized.timestamp)
  )
    throw new Error('Finalized header inconsistent with pinned block')
  if (highHeader.timestamp < targetTimestamp) throw new Error('Horizon not finalized')
  let low = BigInt(anchorBlock)
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n
    if ((await header(mid)).timestamp >= targetTimestamp) high = mid
    else low = mid
  }
  const found = await header(high)
  const prior = await header(high - 1n)
  if (found.timestamp < targetTimestamp || prior.timestamp >= targetTimestamp)
    throw new Error('Target block is not earliest finalized block')
  return found
}

export async function collectOutcome({
  client,
  baseline,
  baselineConfig = null,
  horizon,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now = Date.now,
}) {
  if (!Object.hasOwn(HORIZONS, horizon)) throw new Error('Unknown horizon')
  if (baseline.observedAtMs >= (baseline.blockTimestamp + HORIZONS[horizon]) * 1000)
    throw new Error('Baseline observation is not prospective for horizon')
  const rpc = async (method, args = {}) => {
    checkDisk(out)
    return client[method](args)
  }
  // Disk exhaustion is a hard stop. Only provider/decode errors become missing observations.
  const optional = async (method, args, decode = (value) => value) => {
    checkDisk(out)
    try {
      return { ok: true, value: decode(await client[method](args)) }
    } catch {
      return { ok: false, value: null }
    }
  }
  if (Number(await rpc('getChainId')) !== 1) throw new Error('Ethereum mainnet required')
  const baseHeader = await rpc('getBlock', { blockNumber: BigInt(baseline.block) })
  if (
    lower(baseHeader?.hash) !== lower(baseline.blockHash) ||
    Number(baseHeader?.timestamp) !== baseline.blockTimestamp
  )
    throw new Error('Baseline block no longer canonical')
  const targetTimestamp = baseline.blockTimestamp + HORIZONS[horizon]
  const outcomeHeader = await firstFinalizedBlock({
    client,
    targetTimestamp,
    anchorBlock: baseline.block,
    rpc,
  })
  const blockNumber = BigInt(outcomeHeader.block)
  const poolCode = await optional('getCode', { address: POOL, blockNumber }, (code) =>
    codeHash(code, 'Pool'),
  )
  const poolCodeHash = poolCode.value
  const poolImplementation = await pinnedImplementation(
    client,
    POOL,
    outcomeHeader.hash,
    checkDisk,
    out,
  )
  // New prospective daily witnesses carry B-state Pool identity themselves.
  // Legacy Sep 26 frozen witnesses lack it and retain their original config/censor path.
  const baselineImplementation =
    baseline.poolImplementation ?? baselineConfig?.poolImplementation ?? null
  const poolImplementationChanged =
    poolImplementation.status === 'observed' && baselineImplementation?.status === 'observed'
      ? poolImplementation.address !== baselineImplementation.address ||
        poolImplementation.codeHash !== baselineImplementation.codeHash
      : null
  const marketRows = []
  for (const { market, baselineRow, holders } of frozenMarkets(baseline)) {
    const readErrors = []
    const underlyingCode = await optional(
      'getCode',
      { address: market.base, blockNumber },
      (code) => codeHash(code, `${market.name} underlying`),
    )
    if (!underlyingCode.ok) readErrors.push('underlying-code')
    const aTokenCode = await optional('getCode', { address: market.aToken, blockNumber }, (code) =>
      codeHash(code, `${market.name} aToken`),
    )
    if (!aTokenCode.ok) readErrors.push('aToken-code')
    const underlyingCodeHash = underlyingCode.value
    const aTokenCodeHash = aTokenCode.value
    const baselineATokenImplementation = await pinnedImplementation(
      client,
      market.aToken,
      baseline.blockHash,
      checkDisk,
      out,
    )
    const aTokenImplementation = await pinnedImplementation(
      client,
      market.aToken,
      outcomeHeader.hash,
      checkDisk,
      out,
    )
    const aTokenImplementationChanged =
      baselineATokenImplementation.status === 'observed' &&
      aTokenImplementation.status === 'observed'
        ? baselineATokenImplementation.address !== aTokenImplementation.address ||
          baselineATokenImplementation.codeHash !== aTokenImplementation.codeHash
        : null
    const reserveRead = await optional(
      'readContract',
      {
        address: POOL,
        abi: ABI.reserve,
        functionName: 'getReserveData',
        args: [market.base],
        blockNumber,
      },
      (reserve) => {
        const configuration = uint(reserve?.configuration?.data, 'configuration')
        const reserveAToken = lower(reserve?.aTokenAddress)
        if (!isAddress(reserveAToken)) throw new Error('Malformed reserve aToken')
        return {
          reserveAToken,
          reserveId: Number(uint(reserve?.id, 'reserve id')),
          flags: {
            active: ((configuration >> 56n) & 1n) === 1n,
            frozen: ((configuration >> 57n) & 1n) === 1n,
            paused: ((configuration >> 60n) & 1n) === 1n,
          },
          decimals: Number((configuration >> 48n) & 255n),
        }
      },
    )
    if (!reserveRead.ok) readErrors.push('reserve')
    const reserveAToken = reserveRead.value?.reserveAToken ?? null
    const reserveId = reserveRead.value?.reserveId ?? null
    if (reserveId !== null && (!Number.isInteger(reserveId) || reserveId < 0 || reserveId > 127))
      throw new Error('Invalid reserve id')
    const flags = reserveRead.value?.flags ?? null
    const decimals = reserveRead.value?.decimals ?? null
    const cashRead = reserveAToken
      ? await optional(
          'readContract',
          {
            address: market.base,
            abi: ABI.token,
            functionName: 'balanceOf',
            args: [reserveAToken],
            blockNumber,
          },
          (value) => uint(value, 'reserve cash').toString(),
        )
      : { ok: false, value: null }
    if (!cashRead.ok) readErrors.push('reserve-cash')
    const cashRaw = cashRead.value
    const witnesses = []
    for (const holder of holders) {
      const row = {
        holder: lower(holder),
        aTokenBalanceRaw: null,
        codeStatus: null,
        bitmapRaw: null,
        selectedReserveBorrowing: null,
        selectedReserveCollateral: null,
        anyBorrow: null,
        accountData: null,
        healthReadErrors: [],
        call: null,
        returnedRaw: null,
        revertData: null,
        revertSelector: null,
        censoring: [],
        readErrorStage: null,
      }
      witnesses.push(row)
      const balanceRead = await optional(
        'readContract',
        {
          address: market.aToken,
          abi: ABI.token,
          functionName: 'balanceOf',
          args: [holder],
          blockNumber,
        },
        (value) => uint(value, 'holder aToken balance').toString(),
      )
      if (balanceRead.ok) row.aTokenBalanceRaw = balanceRead.value
      else row.readErrorStage = 'balance'
      const holderCodeRead = await optional('getCode', { address: holder, blockNumber }, (code) => {
        if (code !== undefined && (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)))
          throw new Error('Malformed holder code')
        return code === undefined || code === '0x' ? 'eoa' : 'contract'
      })
      if (holderCodeRead.ok) row.codeStatus = holderCodeRead.value
      else row.readErrorStage = row.readErrorStage || 'code'
      if (reserveId !== null) {
        const configurationRead = await optional(
          'readContract',
          {
            address: POOL,
            abi: USER_ABI,
            functionName: 'getUserConfiguration',
            args: [holder],
            blockNumber,
          },
          (configuration) => decodeUserBitmap(configuration?.data, reserveId),
        )
        if (configurationRead.ok) Object.assign(row, configurationRead.value)
        else row.healthReadErrors.push('getUserConfiguration')
      } else row.healthReadErrors.push('reserve-id-unavailable')
      const accountRead = await optional(
        'readContract',
        {
          address: POOL,
          abi: USER_ABI,
          functionName: 'getUserAccountData',
          args: [holder],
          blockNumber,
        },
        accountRaw,
      )
      if (accountRead.ok) row.accountData = accountRead.value
      else row.healthReadErrors.push('getUserAccountData')
      checkDisk(out)
      try {
        const result = await client.call({
          account: holder,
          to: POOL,
          data: encodeFunctionData({
            abi: WITHDRAW,
            functionName: 'withdraw',
            args: [market.base, QUOTE_RAW, holder],
          }),
          blockNumber,
        })
        if (!result || typeof result.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.data))
          throw new Error('Malformed withdraw return')
        row.returnedRaw = BigInt(result.data).toString()
        row.call = BigInt(result.data) === QUOTE_RAW ? 'success' : 'unexpected-return'
      } catch (error) {
        row.call = classifyCallError(error)
        if (row.call === 'revert') {
          const bytes = revertBytes(error)
          row.revertData = bytes.data
          row.revertSelector = bytes.selector
        }
      }
      if (row.aTokenBalanceRaw === null) row.censoring.push('holder-balance-unavailable')
      else if (BigInt(row.aTokenBalanceRaw) < QUOTE_RAW) row.censoring.push('holder-attrition')
      if (row.codeStatus === null) row.censoring.push('holder-code-unavailable')
      else if (row.codeStatus !== 'eoa') row.censoring.push('holder-now-contract')
      if (!poolCode.ok) row.censoring.push('pool-code-unavailable')
      if (poolImplementationChanged === true) row.censoring.push('pool-implementation-changed')
      else if (poolImplementationChanged === null)
        row.censoring.push('pool-implementation-unresolved')
      if (!underlyingCode.ok) row.censoring.push('underlying-code-unavailable')
      if (!aTokenCode.ok) row.censoring.push('aToken-code-unavailable')
      if (aTokenImplementationChanged === true) row.censoring.push('aToken-implementation-changed')
      else if (aTokenImplementationChanged === null)
        row.censoring.push('aToken-implementation-unresolved')
      if (!reserveRead.ok) row.censoring.push('reserve-state-unavailable')
      else {
        if (reserveAToken !== lower(market.aToken)) row.censoring.push('reserve-aToken-changed')
        if (decimals !== market.decimals) row.censoring.push('reserve-decimals-changed')
        if (!flags.active || flags.paused) row.censoring.push('reserve-inactive-or-paused')
      }
      if (!cashRead.ok) row.censoring.push('reserve-cash-unavailable')
      if (row.healthReadErrors.length) row.censoring.push('wallet-health-unavailable')
      if (
        (poolCode.ok && poolCodeHash !== baseline.poolCodeHash) ||
        (underlyingCode.ok && underlyingCodeHash !== baselineRow.underlyingCodeHash) ||
        (aTokenCode.ok && aTokenCodeHash !== baselineRow.aTokenCodeHash)
      )
        row.censoring.push('runtime-code-changed')
      if (row.call === 'rpc-error' || row.call === 'unexpected-return')
        row.censoring.push('call-unresolved')
      row.deterioration =
        row.call === 'revert' && row.censoring.length === 0
          ? 'baseline-success-to-unattributed-revert'
          : row.censoring.length > 0
            ? 'censored'
            : 'no-observed-revert'
      row.cause = row.call === 'revert' ? 'unknown-post-withdraw-health-unattested' : null
    }
    marketRows.push({
      name: market.name,
      underlying: lower(market.base),
      underlyingCodeHash,
      aToken: lower(market.aToken),
      aTokenCodeHash,
      baselineATokenImplementation,
      aTokenImplementation,
      aTokenImplementationChanged,
      underlyingProxyIdentityCaveat:
        'Underlying runtime hash does not attest proxy implementation identity.',
      reserveAToken,
      reserveId,
      reserveIdentityChanged:
        reserveAToken === null ? null : reserveAToken !== lower(market.aToken),
      decimals,
      decimalsChanged: decimals === null ? null : decimals !== market.decimals,
      flags,
      cashAt: reserveAToken,
      cashRaw,
      cashBelowQuote: cashRaw === null ? null : BigInt(cashRaw) < QUOTE_RAW,
      quoteRaw: QUOTE_RAW.toString(),
      readErrors,
      witnesses,
    })
  }
  const finalBaseHeader = await rpc('getBlock', { blockNumber: BigInt(baseline.block) })
  const finalOutcomeHeader = await rpc('getBlock', { blockNumber })
  if (
    lower(finalBaseHeader?.hash) !== lower(baseline.blockHash) ||
    Number(finalBaseHeader?.timestamp) !== baseline.blockTimestamp ||
    lower(finalOutcomeHeader?.hash) !== outcomeHeader.hash ||
    Number(finalOutcomeHeader?.timestamp) !== outcomeHeader.timestamp
  )
    throw new Error('Pinned block reorganized or inconsistent RPC')
  const observedAtMs = now()
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < outcomeHeader.timestamp * 1000)
    throw new Error('Invalid observation time')
  return {
    baselineBlock: baseline.block,
    baselineBlockHash: lower(baseline.blockHash),
    baselineSha256: baseline.rowSha256,
    horizon,
    targetTimestamp,
    block: outcomeHeader.block,
    blockHash: outcomeHeader.hash,
    blockTimestamp: outcomeHeader.timestamp,
    observedAtMs,
    baselineObservationLeadSeconds: Math.floor(
      (targetTimestamp * 1000 - baseline.observedAtMs) / 1000,
    ),
    poolCodeHash,
    poolCodeChanged: poolCodeHash === null ? null : poolCodeHash !== baseline.poolCodeHash,
    poolImplementation,
    baselineImplementation,
    poolImplementationChanged,
    markets: marketRows,
  }
}

function save(out, baselinePath, payload, checkDisk) {
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ payload, sha256: hash(payload) }))
    closeSync(fd)
    fd = undefined
    checkDisk(out)
    renameSync(temp, out)
    readCheckpoint(out, baselinePath)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

export async function run({
  client,
  baselineBlock,
  horizon,
  baselinePath = DEFAULT_BASELINE,
  configPath = DEFAULT_CONFIG,
  out = DEFAULT_OUT,
  checkDisk = diskGuard,
  now,
}) {
  if (!Object.hasOwn(HORIZONS, horizon)) throw new Error('Unknown horizon')
  checkDisk(out)
  mkdirSync(dirname(out), { recursive: true })
  const lock = `${out}.lock`
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
    const baselines = readBaseline(baselinePath)
    const baseline = selectBaseline(baselines.baselines, baselineBlock)
    const configs =
      baselineBlock === FROZEN_BLOCK && existsSync(configPath)
        ? readConfig(configPath, baselinePath).records
        : []
    const baselineConfig = configs.find((row) => row.baselineBlock === baselineBlock) ?? null
    if (baselineConfig && baselineConfig.baselineSha256 !== baseline.rowSha256)
      throw new Error('Baseline configuration linkage mismatch')
    const saved = readCheckpoint(out, baselinePath)
    if (
      saved.outcomes.some((row) => row.baselineBlock === baselineBlock && row.horizon === horizon)
    )
      throw new Error('Horizon already recorded; no repeated outcome selection')
    if (saved.outcomes.length >= 384) throw new Error('Outcome cap reached')
    const result = await collectOutcome({
      client,
      baseline,
      baselineConfig,
      horizon,
      out,
      checkDisk,
      now,
    })
    // Verify the source has not changed between reading and committing the outcome.
    if (
      selectBaseline(readBaseline(baselinePath).baselines, baselineBlock).rowSha256 !==
      baseline.rowSha256
    )
      throw new Error('Baseline changed during outcome collection')
    const withoutHash = { ...result, previousSha256: saved.outcomes.at(-1)?.rowSha256 || null }
    const row = { ...withoutHash, rowSha256: hash(withoutHash) }
    save(out, baselinePath, { ...saved, outcomes: [...saved.outcomes, row] }, checkDisk)
    return {
      out,
      baselineBlock,
      horizon,
      block: row.block,
      witnesses: row.markets.map((market) => ({
        name: market.name,
        count: market.witnesses.length,
        cleanReverts: market.witnesses.filter(
          (w) => w.deterioration === 'baseline-success-to-unattributed-revert',
        ).length,
      })),
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
      unlinkSync(lock)
    }
  }
}

export function plan({ baselinePath = DEFAULT_BASELINE, out = DEFAULT_OUT } = {}) {
  const baselines = readBaseline(baselinePath)
  const saved = readCheckpoint(out, baselinePath)
  return {
    status: 'dry-only',
    diskFloorBytes: DISK_FLOOR_BYTES,
    baselines: baselines.baselines.map((baseline) => ({
      block: baseline.block,
      timestamp: baseline.blockTimestamp,
      horizonTargets: Object.fromEntries(
        Object.entries(HORIZONS).map(([h, seconds]) => [h, baseline.blockTimestamp + seconds]),
      ),
    })),
    recorded: saved.outcomes.map((row) => ({
      baselineBlock: row.baselineBlock,
      horizon: row.horizon,
      block: row.block,
    })),
    caveat:
      'No RPC or write. --run requires --baseline-block and --horizon; no early or repeated outcome.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    const flag = (name) => {
      const at = args.indexOf(name)
      return at < 0 ? undefined : args[at + 1]
    }
    const known = new Set(['--run', '--baseline', '--out', '--baseline-block', '--horizon'])
    for (let i = 0; i < args.length; i++) {
      if (!known.has(args[i])) throw new Error('Invalid argument')
      if (args[i] !== '--run' && (!args[i + 1] || args[i + 1].startsWith('--')))
        throw new Error('Missing argument value')
      if (args[i] !== '--run') i++
    }
    const baselinePath = flag('--baseline') || DEFAULT_BASELINE
    const out = flag('--out') || DEFAULT_OUT
    const result = args.includes('--run')
      ? await run({
          client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
          baselineBlock: Number(flag('--baseline-block')),
          horizon: flag('--horizon'),
          baselinePath,
          out,
        })
      : plan({ baselinePath, out })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    // RPC exceptions may contain credential-bearing URLs.
    process.stderr.write(
      'Holder outcome failed. Check horizon finality, RPC, disk, and checkpoint state.\n',
    )
    process.exitCode = 1
  }
}
