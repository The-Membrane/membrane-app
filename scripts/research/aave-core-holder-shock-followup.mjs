// Secondary, fixed-holder $50m exit follow-up. Dry by default; no holder reselection.
// Each eth_call is independent, never a cumulative bank-run simulation.
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
import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem'
import { ABI, DISK_FLOOR_BYTES, MARKETS, POOL, diskGuard } from './aave-core-forward-panel.mjs'
import { firstFinalizedBlock, HORIZONS } from './aave-core-holder-outcomes.mjs'
import {
  SOURCE as EXPOSURE_PATH,
  SOURCE_SHA256 as EXPOSURE_SHA256,
  readSource,
} from './aave-core-holder-shock.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'aave-core-holder-shock-followup-v1'
export const SHOCK_PATH = resolve(
  'data/research/venue-signals/aave-core-holder-shock-pilot-v1.json',
)
export const SHOCK_SHA256 = 'efe8e4ed588021adc91ef2bde26e62f77935f1a9a732874df8c1bb29bb296f84'
export const OUTPUT_ROOT = resolve('data/research/venue-signals')
export const SHOCK_RAW = 50_000_000n * 10n ** 6n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
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
const sha = (value) => createHash('sha256').update(value).digest('hex')
const digest = (value) => sha(JSON.stringify(value))
const hashOk = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value))
const addrOk = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value))
const decimal = (value) => /^[0-9]+$/.test(String(value))
const pin = (blockHash) => ({ blockHash, requireCanonical: true })
const io = {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
}
class DiskGuardError extends Error {
  constructor(cause) {
    super('Disk reserve reached during follow-up', { cause })
  }
}

export function outputPath(path) {
  if (!path) throw new Error('Explicit --out required with --run')
  const target = resolve(path)
  if (
    !target.startsWith(`${OUTPUT_ROOT}/`) ||
    !target.endsWith('.json') ||
    [SHOCK_PATH, EXPOSURE_PATH].includes(target)
  )
    throw new Error('Unique JSON output required under data/research/venue-signals')
  return target
}

function readPhysical(path, physicalSha) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== physicalSha) throw new Error('Frozen source physical SHA mismatch')
  const saved = JSON.parse(bytes.toString('utf8'))
  if (!saved?.payload || saved.sha256 !== digest(saved.payload))
    throw new Error('Frozen source payload seal mismatch')
  return saved
}

export function frozenSources({
  exposure = readSource(),
  exposureSaved = readPhysical(EXPOSURE_PATH, EXPOSURE_SHA256),
  shockSaved = readPhysical(SHOCK_PATH, SHOCK_SHA256),
} = {}) {
  const exposurePayload = exposureSaved.payload
  const shock = shockSaved.payload
  if (
    exposureSaved.sha256 !== exposure.sourcePayloadSha256 ||
    exposurePayload.block !== exposure.block ||
    lower(exposurePayload.blockHash) !== exposure.blockHash ||
    !Number.isSafeInteger(exposurePayload.blockTimestamp) ||
    !Number.isSafeInteger(exposurePayload.firstKnownAtMs) ||
    exposurePayload.firstKnownAtMs < exposurePayload.blockTimestamp * 1000 ||
    shockSaved.sha256 !== digest(shock) ||
    shock.study !== 'aave-core-holder-shock-v1' ||
    shock.chainId !== 1 ||
    shock.sourceSha256 !== EXPOSURE_SHA256 ||
    shock.sourcePayloadSha256 !== exposure.sourcePayloadSha256 ||
    lower(shock.pool) !== lower(POOL) ||
    shock.block !== exposure.block ||
    lower(shock.blockHash) !== exposure.blockHash ||
    shock.shockRaw !== SHOCK_RAW.toString() ||
    !Number.isSafeInteger(shock.observedAtMs) ||
    shock.observedAtMs < exposurePayload.firstKnownAtMs ||
    !Array.isArray(shock.markets) ||
    shock.markets.length !== MARKETS.length
  )
    throw new Error('Frozen shock linkage mismatch')
  const markets = shock.markets.map((row, index) => {
    const source = exposure.rows[index]
    if (
      row.name !== source.name ||
      lower(row.base) !== source.base ||
      lower(row.aToken) !== source.aToken ||
      !Array.isArray(row.holders) ||
      row.holders.length !== source.holders.length
    )
      throw new Error('Frozen shock market mismatch')
    const holders = row.holders.map((holder, i) => {
      const expected = source.holders[i]
      if (
        !addrOk(holder.address) ||
        lower(holder.address) !== expected.address ||
        !decimal(holder.balanceRaw) ||
        holder.balanceRaw !== expected.balanceRaw ||
        holder.call !== 'success' ||
        holder.returnedRaw !== SHOCK_RAW.toString() ||
        holder.revertData !== null ||
        holder.revertSelector !== null
      )
        throw new Error('Frozen shock holder mismatch')
      return { address: expected.address, baselineClaimRaw: expected.balanceRaw }
    })
    return { ...source, holders }
  })
  return {
    exposurePhysicalSha256: EXPOSURE_SHA256,
    exposurePayloadSha256: exposure.sourcePayloadSha256,
    shockPhysicalSha256: SHOCK_SHA256,
    shockPayloadSha256: shockSaved.sha256,
    block: exposure.block,
    blockHash: exposure.blockHash,
    blockTimestamp: exposurePayload.blockTimestamp,
    exposureFirstKnownAtMs: exposurePayload.firstKnownAtMs,
    firstKnownAtMs: shock.observedAtMs,
    poolCodeHash: exposure.poolCodeHash,
    poolImplementation: exposure.poolImplementation,
    poolImplementationCodeHash: exposure.poolImplementationCodeHash,
    markets,
  }
}

function codeHash(code) {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error('Missing deployed code')
  return lower(keccak256(code))
}

function revertData(error) {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const value = typeof current.data === 'string' ? current.data : current.data?.data
    if (typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,2048}$/.test(value))
      return { data: lower(value), selector: lower(value.slice(0, 10)) }
    current = current.cause
  }
  return { data: null, selector: null }
}

function callError(error) {
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if (
      ['ExecutionRevertedError', 'ContractFunctionRevertedError', 'RawContractError'].includes(
        current.name,
      ) ||
      current.code === 3 ||
      current.code === '3'
    )
      return 'revert'
    current = current.cause
  }
  return 'rpc-error'
}

async function identity(rpc, address, blockHash) {
  const out = { codeHash: null, implementation: null, implementationCodeHash: null, errors: [] }
  try {
    out.codeHash = codeHash(await rpc('eth_getCode', [address, pin(blockHash)]))
  } catch (error) {
    if (error instanceof DiskGuardError) throw error
    out.errors.push('runtime-code')
  }
  try {
    const word = await rpc('eth_getStorageAt', [address, SLOT, pin(blockHash)])
    if (typeof word !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(word)) throw new Error('slot')
    const implementation = lower(`0x${word.slice(26)}`)
    if (!addrOk(implementation) || /^0x0{40}$/.test(implementation)) throw new Error('slot')
    out.implementation = implementation
    out.implementationCodeHash = codeHash(
      await rpc('eth_getCode', [implementation, pin(blockHash)]),
    )
  } catch (error) {
    if (error instanceof DiskGuardError) throw error
    out.errors.push('implementation')
  }
  return out
}

async function tokenBalance(rpc, token, holder, blockHash) {
  const data = encodeFunctionData({ abi: ABI.token, functionName: 'balanceOf', args: [holder] })
  const result = await rpc('eth_call', [{ to: token, data }, pin(blockHash)])
  return BigInt(
    decodeFunctionResult({ abi: ABI.token, functionName: 'balanceOf', data: result }),
  ).toString()
}

async function reserveState(rpc, market, blockHash) {
  const out = { flags: null, reserveAToken: null, decimals: null, cashRaw: null, errors: [] }
  try {
    const data = encodeFunctionData({
      abi: ABI.reserve,
      functionName: 'getReserveData',
      args: [market.base],
    })
    const result = await rpc('eth_call', [{ to: POOL, data }, pin(blockHash)])
    const reserve = decodeFunctionResult({
      abi: ABI.reserve,
      functionName: 'getReserveData',
      data: result,
    })
    const config = BigInt(reserve.configuration.data)
    out.flags = {
      active: ((config >> 56n) & 1n) === 1n,
      frozen: ((config >> 57n) & 1n) === 1n,
      paused: ((config >> 60n) & 1n) === 1n,
    }
    out.decimals = Number((config >> 48n) & 255n)
    if (!addrOk(reserve.aTokenAddress)) throw new Error('aToken')
    out.reserveAToken = lower(reserve.aTokenAddress)
  } catch (error) {
    if (error instanceof DiskGuardError) throw error
    out.errors.push('reserve')
  }
  if (out.reserveAToken) {
    try {
      out.cashRaw = await tokenBalance(rpc, market.base, out.reserveAToken, blockHash)
    } catch (error) {
      if (error instanceof DiskGuardError) throw error
      out.errors.push('reserve-cash')
    }
  } else out.errors.push('reserve-cash')
  return out
}

function expectedCensoring(row, market, blockGasLimit) {
  const reasons = []
  if (row.claimRaw === null) reasons.push('holder-claim-unavailable')
  else if (BigInt(row.claimRaw) < SHOCK_RAW) reasons.push('holder-claim-attrition')
  if (row.holderCode === null) reasons.push('holder-code-unavailable')
  else if (row.holderCode !== 'code-empty') reasons.push('holder-code-changed')
  if (row.call === 'success') {
    if (row.gasStatus !== 'observed') reasons.push('gas-estimate-unavailable')
    else if (blockGasLimit === null) reasons.push('block-gas-limit-unavailable')
    else if (BigInt(row.gasEstimate) > BigInt(blockGasLimit))
      reasons.push('gas-estimate-above-block-limit')
  }
  if (market.poolDrift.runtime !== false || market.poolDrift.implementation !== false)
    reasons.push('pool-identity-changed-or-unavailable')
  if (market.aTokenDrift.runtime !== false || market.aTokenDrift.implementation !== false)
    reasons.push('aToken-identity-changed-or-unavailable')
  if (market.reserve.errors.length) reasons.push('reserve-unavailable')
  if (market.reserve.reserveAToken && market.reserve.reserveAToken !== market.aToken)
    reasons.push('reserve-aToken-changed')
  if (market.reserve.decimals !== null && market.reserve.decimals !== 6)
    reasons.push('reserve-decimals-changed')
  if (market.reserve.flags && (!market.reserve.flags.active || market.reserve.flags.paused))
    reasons.push('reserve-inactive-or-paused')
  if (['rpc-error', 'malformed-return', 'unexpected-return'].includes(row.call))
    reasons.push('call-unresolved')
  return reasons
}

export async function collect({
  client,
  horizon,
  out,
  checkDisk = diskGuard,
  now = Date.now,
  sources = frozenSources,
}) {
  const target = outputPath(out)
  if (!Object.hasOwn(HORIZONS, horizon)) throw new Error('Unknown horizon')
  if (existsSync(target)) throw new Error('Refusing to overwrite follow-up output')
  const ensureDisk = () => {
    try {
      checkDisk(target)
    } catch (error) {
      throw new DiskGuardError(error)
    }
  }
  ensureDisk()
  const frozen = sources()
  let calls = 0
  const rpc = async (method, params) => {
    if (++calls > 200) throw new Error('RPC call cap reached')
    ensureDisk()
    return client.request({ method, params })
  }
  const getBlock = async (args) => {
    if (++calls > 200) throw new Error('RPC call cap reached')
    ensureDisk()
    return client.getBlock(args)
  }
  if (Number(await client.getChainId()) !== 1) throw new Error('Ethereum mainnet required')
  const base = await getBlock({ blockNumber: BigInt(frozen.block) })
  if (lower(base?.hash) !== frozen.blockHash || Number(base?.timestamp) !== frozen.blockTimestamp)
    throw new Error('Frozen source header mismatch')
  const targetTimestamp = Number(base.timestamp) + HORIZONS[horizon]
  if (frozen.firstKnownAtMs >= targetTimestamp * 1000)
    throw new Error('Shock source not prospective')
  const head = await firstFinalizedBlock({
    client,
    targetTimestamp,
    anchorBlock: frozen.block,
    rpc: (method, args) => {
      if (method !== 'getBlock') throw new Error('Unexpected header method')
      return getBlock(args)
    },
  })
  if (head.timestamp < targetTimestamp) throw new Error('Outcome not finalized')
  const targetHeader = await getBlock({ blockNumber: BigInt(head.block) })
  if (lower(targetHeader?.hash) !== head.hash || Number(targetHeader?.timestamp) !== head.timestamp)
    throw new Error('Finalized target header changed')
  const blockGasLimit =
    targetHeader.gasLimit === undefined || targetHeader.gasLimit === null
      ? null
      : BigInt(targetHeader.gasLimit)
  const pool = await identity(rpc, POOL, head.hash)
  const poolDrift = {
    runtime: pool.codeHash === null ? null : pool.codeHash !== frozen.poolCodeHash,
    implementation:
      pool.implementation === null || pool.implementationCodeHash === null
        ? null
        : pool.implementation !== frozen.poolImplementation ||
          pool.implementationCodeHash !== frozen.poolImplementationCodeHash,
  }
  const markets = []
  for (const market of frozen.markets) {
    const aToken = await identity(rpc, market.aToken, head.hash)
    const aTokenDrift = {
      runtime: aToken.codeHash === null ? null : aToken.codeHash !== market.aTokenCodeHash,
      implementation:
        aToken.implementation === null || aToken.implementationCodeHash === null
          ? null
          : aToken.implementation !== market.aTokenImplementation ||
            aToken.implementationCodeHash !== market.aTokenImplementationCodeHash,
    }
    const reserve = await reserveState(rpc, market, head.hash)
    const holders = []
    for (const holder of market.holders) {
      const row = {
        address: holder.address,
        baselineClaimRaw: holder.baselineClaimRaw,
        claimRaw: null,
        claimBelowShock: null,
        holderCode: null,
        call: null,
        returnedRaw: null,
        revertData: null,
        revertSelector: null,
        gasEstimate: null,
        gasStatus: null,
        censoring: [],
      }
      try {
        row.claimRaw = await tokenBalance(rpc, market.aToken, holder.address, head.hash)
        row.claimBelowShock = BigInt(row.claimRaw) < SHOCK_RAW
      } catch (error) {
        if (error instanceof DiskGuardError) throw error
      }
      try {
        const code = await rpc('eth_getCode', [holder.address, pin(head.hash)])
        row.holderCode = code === '0x' ? 'code-empty' : codeHash(code)
      } catch (error) {
        if (error instanceof DiskGuardError) throw error
      }
      const tx = {
        from: holder.address,
        to: POOL,
        data: encodeFunctionData({
          abi: WITHDRAW,
          functionName: 'withdraw',
          args: [market.base, SHOCK_RAW, holder.address],
        }),
      }
      try {
        const result = await rpc('eth_call', [tx, pin(head.hash)])
        if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result))
          row.call = 'malformed-return'
        else {
          row.returnedRaw = BigInt(result).toString()
          row.call = BigInt(result) === SHOCK_RAW ? 'success' : 'unexpected-return'
        }
      } catch (error) {
        if (error instanceof DiskGuardError) throw error
        ensureDisk()
        row.call = callError(error)
        if (row.call === 'revert')
          Object.assign(row, {
            revertData: revertData(error).data,
            revertSelector: revertData(error).selector,
          })
      }
      try {
        const gas = await rpc('eth_estimateGas', [tx, pin(head.hash)])
        if (typeof gas !== 'string' || !/^0x[0-9a-fA-F]+$/.test(gas)) throw new Error('gas')
        row.gasEstimate = BigInt(gas).toString()
        row.gasStatus = 'observed'
      } catch (error) {
        if (error instanceof DiskGuardError) throw error
        ensureDisk()
        row.gasStatus = 'unavailable'
      }
      row.censoring = expectedCensoring(
        row,
        { aToken: market.aToken, poolDrift, aTokenDrift, reserve },
        blockGasLimit,
      )
      row.deterioration = row.censoring.length
        ? 'censored'
        : row.call === 'revert'
          ? 'baseline-success-to-revert-unattributed'
          : 'no-observed-revert'
      holders.push(row)
    }
    markets.push({
      name: market.name,
      base: market.base,
      aToken: market.aToken,
      aTokenIdentity: aToken,
      aTokenDrift,
      reserve,
      cashBelowShock: reserve.cashRaw === null ? null : BigInt(reserve.cashRaw) < SHOCK_RAW,
      holders,
    })
  }
  const finalBase = await getBlock({ blockNumber: BigInt(frozen.block) })
  const finalHead = await getBlock({ blockNumber: BigInt(head.block) })
  if (
    lower(finalBase?.hash) !== frozen.blockHash ||
    lower(finalHead?.hash) !== head.hash ||
    Number(finalHead?.timestamp) !== head.timestamp
  )
    throw new Error('Pinned headers changed during collection')
  const observedAtMs = now()
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < head.timestamp * 1000)
    throw new Error('Invalid observation time')
  const payload = {
    study: STUDY,
    chainId: 1,
    pool: lower(POOL),
    horizon,
    targetTimestamp,
    exposurePhysicalSha256: frozen.exposurePhysicalSha256,
    exposurePayloadSha256: frozen.exposurePayloadSha256,
    shockPhysicalSha256: frozen.shockPhysicalSha256,
    shockPayloadSha256: frozen.shockPayloadSha256,
    baselineBlock: frozen.block,
    baselineBlockHash: frozen.blockHash,
    baselineTimestamp: frozen.blockTimestamp,
    exposureFirstKnownAtMs: frozen.exposureFirstKnownAtMs,
    localFirstKnownAtMs: frozen.firstKnownAtMs,
    leadSeconds: Math.floor((targetTimestamp * 1000 - frozen.firstKnownAtMs) / 1000),
    block: head.block,
    blockHash: head.hash,
    blockTimestamp: head.timestamp,
    blockGasLimit: blockGasLimit?.toString() ?? null,
    observedAtMs,
    shockRaw: SHOCK_RAW.toString(),
    poolIdentity: pool,
    poolDrift,
    markets,
    caveat:
      'Ten frozen sampled-holder $50m calls are independent, not cumulative; code-empty and eth_call do not prove signing control, intent, causation, or predictive alert performance. Gas estimates are separate same-state simulations.',
  }
  const serialized = JSON.stringify({ payload, sha256: digest(payload) })
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('Follow-up output cap exceeded')
  return { payload, sha256: digest(payload) }
}

export function save(out, snapshot, checkDisk = diskGuard, fsIo = io) {
  const target = outputPath(out)
  verifySnapshot(snapshot)
  const bytes = JSON.stringify(snapshot)
  if (Buffer.byteLength(bytes) > 256 * 1024 || snapshot?.sha256 !== digest(snapshot.payload))
    throw new Error('Invalid or oversized follow-up snapshot')
  checkDisk(target)
  if (fsIo.existsSync(target)) throw new Error('Refusing to overwrite follow-up output')
  fsIo.mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  let fd
  let published = false
  try {
    fd = fsIo.openSync(temp, 'wx', 0o600)
    fsIo.writeFileSync(fd, bytes)
    fsIo.closeSync(fd)
    fd = undefined
    checkDisk(target)
    fsIo.linkSync(temp, target)
    published = true
    const readback = fsIo.readFileSync(target)
    if (sha(readback) !== sha(bytes)) throw new Error('Follow-up saved bytes mismatch')
    verifySnapshot(JSON.parse(readback.toString('utf8')))
  } catch (error) {
    if (fd !== undefined) fsIo.closeSync(fd)
    if (published) fsIo.unlinkSync(target)
    throw error
  } finally {
    if (fsIo.existsSync(temp)) fsIo.unlinkSync(temp)
  }
}

export function verifySnapshot(snapshot, frozen = frozenSources()) {
  const p = snapshot?.payload
  if (
    !p ||
    snapshot.sha256 !== digest(p) ||
    p.study !== STUDY ||
    p.chainId !== 1 ||
    lower(p.pool) !== lower(POOL) ||
    !Object.hasOwn(HORIZONS, p.horizon) ||
    p.targetTimestamp !== frozen.blockTimestamp + HORIZONS[p.horizon] ||
    p.baselineBlock !== frozen.block ||
    lower(p.baselineBlockHash) !== frozen.blockHash ||
    p.baselineTimestamp !== frozen.blockTimestamp ||
    p.exposurePhysicalSha256 !== frozen.exposurePhysicalSha256 ||
    p.exposurePayloadSha256 !== frozen.exposurePayloadSha256 ||
    p.shockPhysicalSha256 !== frozen.shockPhysicalSha256 ||
    p.shockPayloadSha256 !== frozen.shockPayloadSha256 ||
    p.localFirstKnownAtMs !== frozen.firstKnownAtMs ||
    p.shockRaw !== SHOCK_RAW.toString() ||
    p.leadSeconds !== Math.floor((p.targetTimestamp * 1000 - frozen.firstKnownAtMs) / 1000) ||
    !Number.isSafeInteger(p.block) ||
    p.block <= frozen.block ||
    !hashOk(p.blockHash) ||
    !Number.isSafeInteger(p.blockTimestamp) ||
    p.blockTimestamp < p.targetTimestamp ||
    !Number.isSafeInteger(p.observedAtMs) ||
    p.observedAtMs < p.blockTimestamp * 1000 ||
    (p.blockGasLimit !== null && !decimal(p.blockGasLimit)) ||
    !Array.isArray(p.markets) ||
    p.markets.length !== frozen.markets.length
  )
    throw new Error('Follow-up checkpoint identity mismatch')
  const expectedPoolDrift = {
    runtime:
      p.poolIdentity?.codeHash === null ? null : p.poolIdentity?.codeHash !== frozen.poolCodeHash,
    implementation:
      p.poolIdentity?.implementation === null || p.poolIdentity?.implementationCodeHash === null
        ? null
        : p.poolIdentity?.implementation !== frozen.poolImplementation ||
          p.poolIdentity?.implementationCodeHash !== frozen.poolImplementationCodeHash,
  }
  if (JSON.stringify(p.poolDrift) !== JSON.stringify(expectedPoolDrift))
    throw new Error('Follow-up pool drift mismatch')
  for (let i = 0; i < frozen.markets.length; i++) {
    const source = frozen.markets[i]
    const market = p.markets[i]
    if (
      market?.name !== source.name ||
      lower(market.base) !== source.base ||
      lower(market.aToken) !== source.aToken ||
      !Array.isArray(market.holders) ||
      market.holders.length !== source.holders.length
    )
      throw new Error('Follow-up market frontier mismatch')
    const expectedATokenDrift = {
      runtime:
        market.aTokenIdentity?.codeHash === null
          ? null
          : market.aTokenIdentity?.codeHash !== source.aTokenCodeHash,
      implementation:
        market.aTokenIdentity?.implementation === null ||
        market.aTokenIdentity?.implementationCodeHash === null
          ? null
          : market.aTokenIdentity?.implementation !== source.aTokenImplementation ||
            market.aTokenIdentity?.implementationCodeHash !== source.aTokenImplementationCodeHash,
    }
    if (
      JSON.stringify(market.aTokenDrift) !== JSON.stringify(expectedATokenDrift) ||
      !market.reserve ||
      !Array.isArray(market.reserve.errors) ||
      market.cashBelowShock !==
        (market.reserve.cashRaw === null ? null : BigInt(market.reserve.cashRaw) < SHOCK_RAW)
    )
      throw new Error('Follow-up market observation mismatch')
    for (let j = 0; j < source.holders.length; j++) {
      const holder = market.holders[j]
      const expected = source.holders[j]
      if (
        lower(holder?.address) !== expected.address ||
        holder.baselineClaimRaw !== expected.baselineClaimRaw ||
        !Array.isArray(holder.censoring) ||
        (holder.claimRaw !== null && !decimal(holder.claimRaw)) ||
        holder.claimBelowShock !==
          (holder.claimRaw === null ? null : BigInt(holder.claimRaw) < SHOCK_RAW) ||
        !['observed', 'unavailable'].includes(holder.gasStatus) ||
        (holder.gasStatus === 'observed' && !decimal(holder.gasEstimate)) ||
        (holder.gasStatus === 'unavailable' && holder.gasEstimate !== null) ||
        !['success', 'revert', 'rpc-error', 'malformed-return', 'unexpected-return'].includes(
          holder.call,
        ) ||
        (holder.call === 'success' && holder.returnedRaw !== SHOCK_RAW.toString()) ||
        (holder.call === 'revert' && holder.returnedRaw !== null) ||
        JSON.stringify(holder.censoring) !==
          JSON.stringify(
            expectedCensoring(holder, { ...market, poolDrift: p.poolDrift }, p.blockGasLimit),
          ) ||
        holder.deterioration !==
          (holder.censoring.length
            ? 'censored'
            : holder.call === 'revert'
              ? 'baseline-success-to-revert-unattributed'
              : 'no-observed-revert')
      )
        throw new Error('Follow-up holder frontier mismatch')
    }
  }
  return snapshot
}

export function readSnapshot(out, frozen = frozenSources()) {
  const bytes = readFileSync(outputPath(out))
  if (bytes.length > 256 * 1024) throw new Error('Follow-up checkpoint size cap')
  return verifySnapshot(JSON.parse(bytes.toString('utf8')), frozen)
}

export function plan({ horizon, out } = {}) {
  if (horizon !== undefined && !Object.hasOwn(HORIZONS, horizon)) throw new Error('Unknown horizon')
  const frozen = frozenSources()
  return {
    status: 'dry-only',
    study: STUDY,
    diskFloorBytes: DISK_FLOOR_BYTES,
    exposure: EXPOSURE_PATH,
    exposurePhysicalSha256: EXPOSURE_SHA256,
    shock: SHOCK_PATH,
    shockPhysicalSha256: SHOCK_SHA256,
    horizonTargets: Object.fromEntries(
      Object.entries(HORIZONS).map(([key, seconds]) => [key, frozen.blockTimestamp + seconds]),
    ),
    horizon: horizon ?? null,
    output: out ? outputPath(out) : null,
    action:
      'After target finality, pass --run --horizon 6h|24h|7d --out data/research/venue-signals/<unique>.json. No RPC in dry mode.',
  }
}

export async function run({ client, horizon, out, checkDisk = diskGuard, now = Date.now }) {
  const snapshot = await collect({ client, horizon, out, checkDisk, now })
  const stillFrozen = frozenSources()
  if (
    stillFrozen.exposurePhysicalSha256 !== snapshot.payload.exposurePhysicalSha256 ||
    stillFrozen.shockPhysicalSha256 !== snapshot.payload.shockPhysicalSha256 ||
    stillFrozen.exposurePayloadSha256 !== snapshot.payload.exposurePayloadSha256 ||
    stillFrozen.shockPayloadSha256 !== snapshot.payload.shockPayloadSha256
  )
    throw new Error('Frozen source changed during follow-up')
  save(out, snapshot, checkDisk)
  return {
    status: 'saved',
    output: outputPath(out),
    horizon,
    block: snapshot.payload.block,
    sha256: snapshot.sha256,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const at = args.indexOf(name)
    return at < 0 ? undefined : args[at + 1]
  }
  try {
    if (
      args.some(
        (arg) => !['--run', '--horizon', '--out', flag('--horizon'), flag('--out')].includes(arg),
      )
    )
      throw new Error('Unknown argument')
    if (!args.includes('--run'))
      process.stdout.write(
        `${JSON.stringify(plan({ horizon: flag('--horizon'), out: flag('--out') }))}\n`,
      )
    else {
      const result = await run({
        client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')),
        horizon: flag('--horizon'),
        out: flag('--out'),
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch {
    // RPC error text may contain credentials. Do not print it.
    process.stderr.write('Shock follow-up failed; no final output saved.\n')
    process.exitCode = 1
  }
}
