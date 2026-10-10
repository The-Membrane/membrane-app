// Exact public-only USDe -> sUSDe cooldown initiation, never a completed claim.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

import { publicRpcClients } from './carry-public-direct-exit-issue.mjs'

export const ROUTE = Object.freeze({
  chainId: 1,
  routeKey: 'USDe → Staked USDe [USDe]',
  vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  silo: '0x7fc7c91d556b400afa565013e3f32055a0713425',
})
export const HORIZONS_HOURS = Object.freeze([1, 4, 24, 48, 168])
export const DEADLINE_HOURS = 2
export const HASH = /^[0-9a-f]{64}$/
export const BLOCK_HASH = /^0x[0-9a-f]{64}$/
export const ADDRESS = /^0x[0-9a-f]{40}$/
export const DECIMAL = /^(0|[1-9][0-9]*)$/
const WORD = /^0x[0-9a-f]{64}$/
const DELEGATION_CODE = /^0xef0100[0-9a-f]{40}$/
const MAX_BYTES = 512 * 1024
const DISK_RESERVE = 1_073_741_824
const RUN_MS = 8 * 60_000
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function silo() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function cooldownDuration() view returns (uint24)',
  'function cooldowns(address) view returns (uint104 cooldownEnd,uint256 underlyingAmount)',
  'function cooldownAssets(uint256) returns (uint256)',
])
const LEGACY_COOLDOWN_ABI = parseAbi(['function cooldownAssets(uint256,address) returns (uint256)'])
const TOKEN_ABI = parseAbi(['function decimals() view returns (uint8)'])
export const sha = (value) => createHash('sha256').update(value).digest('hex')
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const nameFor = (sequence) => `${String(sequence).padStart(8, '0')}.json`
export const seal = (row) => ({ ...row, sha256: sha(JSON.stringify(row)) })
export const utc = (value) => {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw Error('susde_clock_invalid')
  return milliseconds
}
const hex = (n) => `0x${BigInt(n).toString(16)}`
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const withoutSeal = ({ sha256: _sha, ...row }) => row

export function rotatingSusdeOriginPairs(urls, makeClients = publicRpcClients, clock = Date.now) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 8)
    throw Error('susde_origins_invalid')
  const deadline = clock() + RUN_MS
  const pairs = []
  for (let offset = 1; offset < urls.length && pairs.length < 24; offset++) {
    for (let i = 0; i < urls.length && pairs.length < 24; i++) {
      let clients
      try {
        clients = makeClients([urls[i], urls[(i + offset) % urls.length]])
      } catch {
        continue
      }
      if (clients?.length !== 2 || clients[0].provider === clients[1].provider) continue
      pairs.push(
        clients.map((client) => ({
          provider: client.provider,
          async request(method, params) {
            if (clock() >= deadline) throw Error('susde_rpc_budget_exhausted')
            return client.request(method, params)
          },
          async send(envelope) {
            if (clock() >= deadline) throw Error('susde_rpc_budget_exhausted')
            return client.send(envelope)
          },
        })),
      )
    }
  }
  if (!pairs.length) throw Error('susde_origins_invalid')
  return pairs
}

export async function readNumbered(out) {
  let names
  try {
    names = (await readdir(out)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const name of names) {
    if (name !== nameFor(rows.length + 1)) throw Error('susde_ledger_gap')
    const bytes = await readFile(join(out, name))
    if (bytes.length > MAX_BYTES) throw Error('susde_record_too_large')
    const row = JSON.parse(bytes.toString('utf8'))
    if (
      bytes.toString('utf8') !== `${JSON.stringify(row)}\n` ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (rows.at(-1)?.sha256 ?? null) ||
      row.sha256 !== sha(JSON.stringify(withoutSeal(row)))
    )
      throw Error('susde_ledger_invalid')
    rows.push(row)
  }
  return rows
}

export async function appendNumbered(row, out, verify, stat = statfsSync, linkFile = link) {
  await mkdir(out, { recursive: true })
  const prior = await verify(out)
  if (
    row.sequence !== prior.length + 1 ||
    row.previousSha256 !== (prior.at(-1)?.sha256 ?? null) ||
    row.sha256 !== sha(JSON.stringify(withoutSeal(row)))
  )
    throw Error('susde_ledger_changed')
  const content = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(content) > MAX_BYTES) throw Error('susde_record_too_large')
  const disk = stat(out)
  if (Number(disk.bavail) * Number(disk.bsize) < DISK_RESERVE + Buffer.byteLength(content))
    throw Error('susde_disk_reserve')
  const temp = join(out, `.susde-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await linkFile(temp, join(out, nameFor(row.sequence)))
    const directory = await open(out, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
  return { sequence: row.sequence, sha256: row.sha256 }
}

export async function header(client, number = 'finalized') {
  const raw = await client.request('eth_getBlockByNumber', [
    typeof number === 'bigint' ? hex(number) : number,
    false,
  ])
  if (
    !BLOCK_HASH.test(raw?.hash ?? '') ||
    !BLOCK_HASH.test(raw?.parentHash ?? '') ||
    !/^0x[0-9a-f]+$/.test(raw?.number ?? '') ||
    !/^0x[0-9a-f]+$/.test(raw?.timestamp ?? '') ||
    (typeof number === 'bigint' && BigInt(raw.number) !== number)
  )
    throw Error('susde_header_invalid')
  const seconds = Number(BigInt(raw.timestamp))
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw Error('susde_header_invalid')
  return {
    number: BigInt(raw.number).toString(),
    hash: raw.hash,
    parentHash: raw.parentHash,
    at: new Date(seconds * 1000).toISOString(),
  }
}

export async function witnessBlock(pair, block, now = () => new Date()) {
  if (pair.length !== 2 || pair[0].provider === pair[1].provider)
    throw Error('susde_independent_origins_required')
  const witnesses = []
  for (const client of pair) {
    if ((await client.request('eth_chainId', [])) !== '0x1') throw Error('susde_chain_invalid')
    const observed = await header(client, BigInt(block.number))
    const finalized = await header(client)
    if (
      !same(observed, block) ||
      BigInt(finalized.number) < BigInt(block.number) ||
      (finalized.number === block.number && finalized.hash !== block.hash)
    )
      throw Error('susde_origin_disagreement')
    witnesses.push({
      provider: client.provider,
      observed,
      finalized,
      observedAtUtc: now().toISOString(),
    })
  }
  return witnesses
}

function decodeWord(functionName, raw, args = [], abi = ABI) {
  if (!WORD.test(raw ?? '')) throw Error('susde_call_word_invalid')
  return decodeFunctionResult({ abi, functionName, data: raw, args })
}
async function rawCall(client, address, name, args, blockHash, from = null, abi = ABI) {
  const data = encodeFunctionData({ abi, functionName: name, args })
  const tx = { to: address, data }
  if (from) {
    tx.from = from
    tx.gas = hex(20_000_000n)
  }
  const response = await client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [tx, pin(blockHash)],
  })
  if (Object.hasOwn(response, 'error')) {
    const message = response.error?.message
    if (
      from &&
      response.jsonrpc === '2.0' &&
      response.id === 1 &&
      !Object.hasOwn(response, 'result') &&
      Number.isSafeInteger(response.error?.code) &&
      typeof message === 'string' &&
      /\b(?:execution reverted|revert(?:ed)?)\b/i.test(message) &&
      !/gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit/i.test(
        message,
      )
    )
      return { status: 'evm_revert', code: response.error.code }
    throw Error('susde_rpc_unavailable')
  }
  if (typeof response.result !== 'string') throw Error('susde_call_result_invalid')
  return { status: 'success', raw: response.result }
}

export async function readVaultTotals(pair, block) {
  const values = []
  for (const client of pair) {
    const state = {}
    for (const name of [
      'asset',
      'silo',
      'decimals',
      'totalAssets',
      'totalSupply',
      'cooldownDuration',
    ]) {
      const response = await rawCall(client, ROUTE.vault, name, [], block.hash)
      state[name] = decodeWord(name, response.raw).toString()
    }
    const assetDecimals = await rawCall(
      client,
      ROUTE.asset,
      'decimals',
      [],
      block.hash,
      null,
      TOKEN_ABI,
    )
    state.assetDecimals = decodeWord('decimals', assetDecimals.raw, [], TOKEN_ABI).toString()
    values.push(state)
  }
  if (
    !same(values[0], values[1]) ||
    values[0].asset.toLowerCase() !== ROUTE.asset ||
    values[0].silo.toLowerCase() !== ROUTE.silo ||
    values[0].decimals !== '18' ||
    values[0].assetDecimals !== '18' ||
    BigInt(values[0].cooldownDuration) < 1n ||
    BigInt(values[0].cooldownDuration) > 90n * 24n * 3600n ||
    BigInt(values[0].totalAssets) === 0n ||
    BigInt(values[0].totalSupply) === 0n
  )
    throw Error('susde_baseline_state_invalid')
  return { totalAssetsRaw: values[0].totalAssets, totalSupplyRaw: values[0].totalSupply }
}

async function code(client, address, hash) {
  const value = await client.request('eth_getCode', [address, pin(hash)])
  if (value === '0x' || value === undefined) return 'empty'
  if (!/^0x(?:[0-9a-f]{2})+$/.test(value)) throw Error('susde_code_invalid')
  return sha(value)
}

async function ownerOriginCode(client, holder, hash) {
  const raw = await client.request('eth_getCode', [holder, pin(hash)])
  if (raw === '0x') return 'empty'
  if (typeof raw === 'string' && DELEGATION_CODE.test(raw.toLowerCase())) return raw.toLowerCase()
  throw Error('susde_identity_or_eoa_invalid')
}

/** All state and the exact call use EIP-1898 on each independent origin. */
export async function measureInitiation({
  pair,
  block,
  holder,
  assetsRaw,
  now = () => new Date(),
}) {
  if (!ADDRESS.test(holder ?? '') || !DECIMAL.test(assetsRaw ?? '') || BigInt(assetsRaw) === 0n)
    throw Error('susde_measurement_input_invalid')
  const witnessesBefore = await witnessBlock(pair, block, now)
  const perOrigin = []
  for (const client of pair) {
    const hash = block.hash
    const vaultCodeHash = await code(client, ROUTE.vault, hash)
    const assetCodeHash = await code(client, ROUTE.asset, hash)
    const ownerCode = await ownerOriginCode(client, holder, hash)
    if (vaultCodeHash === 'empty' || assetCodeHash === 'empty')
      throw Error('susde_identity_or_eoa_invalid')
    const reads = {}
    const rawReads = {}
    for (const [key, address, name, args, abi] of [
      ['asset', ROUTE.vault, 'asset', [], ABI],
      ['silo', ROUTE.vault, 'silo', [], ABI],
      ['shareDecimals', ROUTE.vault, 'decimals', [], ABI],
      ['assetDecimals', ROUTE.asset, 'decimals', [], TOKEN_ABI],
      ['totalAssets', ROUTE.vault, 'totalAssets', [], ABI],
      ['totalSupply', ROUTE.vault, 'totalSupply', [], ABI],
      ['shares', ROUTE.vault, 'balanceOf', [holder], ABI],
      ['maxWithdraw', ROUTE.vault, 'maxWithdraw', [holder], ABI],
      ['preview', ROUTE.vault, 'previewWithdraw', [BigInt(assetsRaw)], ABI],
      ['duration', ROUTE.vault, 'cooldownDuration', [], ABI],
    ]) {
      const call = await rawCall(client, address, name, args, hash, null, abi)
      rawReads[key] = call.raw
      reads[key] = decodeWord(name, call.raw, args, abi).toString()
    }
    const cooldown = await rawCall(client, ROUTE.vault, 'cooldowns', [holder], hash)
    if (!/^0x[0-9a-f]{128}$/.test(cooldown.raw ?? '')) throw Error('susde_cooldown_invalid')
    const [cooldownEnd, pendingAssets] = decodeFunctionResult({
      abi: ABI,
      functionName: 'cooldowns',
      data: cooldown.raw,
    })
    reads.cooldownEnd = cooldownEnd.toString()
    reads.pendingAssets = pendingAssets.toString()
    rawReads.cooldowns = cooldown.raw
    const result = await rawCall(
      client,
      ROUTE.vault,
      'cooldownAssets',
      [BigInt(assetsRaw)],
      hash,
      holder,
    )
    const sharesBurned =
      result.status === 'success'
        ? decodeWord('cooldownAssets', result.raw, [BigInt(assetsRaw)]).toString()
        : null
    perOrigin.push({
      provider: client.provider,
      vaultCodeHash,
      assetCodeHash,
      ownerCode,
      reads,
      rawReads,
      call: result,
      callData: encodeFunctionData({
        abi: ABI,
        functionName: 'cooldownAssets',
        args: [BigInt(assetsRaw)],
      }),
      sharesBurned,
    })
  }
  const witnessesAfter = await witnessBlock(pair, block, now)
  const left = perOrigin[0]
  const right = perOrigin[1]
  const normalized = (origin) => ({
    ...origin,
    provider: null,
    call: origin.call.status === 'evm_revert' ? { status: 'evm_revert' } : origin.call,
  })
  if (
    !same(normalized(left), normalized(right)) ||
    left.reads.asset.toLowerCase() !== ROUTE.asset ||
    left.reads.silo.toLowerCase() !== ROUTE.silo ||
    left.reads.shareDecimals !== '18' ||
    left.reads.assetDecimals !== '18' ||
    BigInt(left.reads.duration) < 1n ||
    BigInt(left.reads.duration) > 90n * 24n * 3600n ||
    (BigInt(left.reads.pendingAssets) > 0n && BigInt(left.reads.cooldownEnd) === 0n)
  )
    throw Error('susde_state_disagreement')
  const success = left.call.status === 'success'
  if (
    success &&
    (BigInt(left.sharesBurned) === 0n ||
      left.sharesBurned !== left.reads.preview ||
      BigInt(left.sharesBurned) > BigInt(left.reads.shares) ||
      BigInt(assetsRaw) > BigInt(left.reads.maxWithdraw))
  )
    throw Error('susde_success_inconsistent')
  const coveredRevert =
    !success &&
    BigInt(left.reads.preview) > 0n &&
    BigInt(left.reads.shares) >= BigInt(left.reads.preview) &&
    BigInt(left.reads.maxWithdraw) >= BigInt(assetsRaw)
  const measuredAtUtc = now().toISOString()
  const evidence = {
    schema: 'susde_public_cooldown_initiation_measurement_v2',
    routeKey: ROUTE.routeKey,
    vault: ROUTE.vault,
    asset: ROUTE.asset,
    silo: ROUTE.silo,
    holder,
    assetsRaw,
    block,
    before: witnessesBefore,
    after: witnessesAfter,
    origins: perOrigin,
    measuredAtUtc,
  }
  return {
    status: success ? 'simulated_initiation_success' : 'initiation_revert_cause_unknown',
    sharesBurnedRaw: left.sharesBurned,
    holderSharesRaw: left.reads.shares,
    previewSharesRaw: left.reads.preview,
    maxWithdrawAssetsRaw: left.reads.maxWithdraw,
    pendingAssetsRaw: left.reads.pendingAssets,
    cooldownEndRaw: left.reads.cooldownEnd,
    cooldownDurationSeconds: Number(left.reads.duration),
    coveredRevert,
    wouldResetPending: success && BigInt(left.reads.pendingAssets) > 0n,
    hypotheticalEarliestEligibilityUtc: success
      ? new Date(utc(block.at) + Number(left.reads.duration) * 1000).toISOString()
      : null,
    evidence,
    evidenceSha256: sha(JSON.stringify(evidence)),
  }
}

export function verifyMeasurement(
  row,
  { block, holder, assetsRaw, earliestUtc, latestUtc, allowLegacy = false },
) {
  const evidence = row?.evidence
  const legacy = evidence?.schema === 'susde_public_cooldown_initiation_measurement_v1'
  if (
    (legacy
      ? !allowLegacy
      : evidence?.schema !== 'susde_public_cooldown_initiation_measurement_v2') ||
    evidence.routeKey !== ROUTE.routeKey ||
    evidence.vault !== ROUTE.vault ||
    evidence.asset !== ROUTE.asset ||
    evidence.silo !== ROUTE.silo ||
    evidence.holder !== holder ||
    evidence.assetsRaw !== assetsRaw ||
    !same(evidence.block, block) ||
    row.evidenceSha256 !== sha(JSON.stringify(evidence)) ||
    !Array.isArray(evidence.origins) ||
    evidence.origins.length !== 2 ||
    evidence.origins[0].provider === evidence.origins[1].provider ||
    utc(evidence.measuredAtUtc) < utc(earliestUtc) ||
    utc(evidence.measuredAtUtc) > utc(latestUtc)
  )
    throw Error('susde_measurement_binding_invalid')
  for (const witnesses of [evidence.before, evidence.after]) {
    if (!Array.isArray(witnesses) || witnesses.length !== 2) throw Error('susde_header_missing')
    for (let i = 0; i < 2; i++) {
      const witness = witnesses[i]
      if (
        witness.provider !== evidence.origins[i].provider ||
        !same(witness.observed, block) ||
        !DECIMAL.test(witness.finalized?.number ?? '') ||
        BigInt(witness.finalized.number) < BigInt(block.number) ||
        (witness.finalized.number === block.number && witness.finalized.hash !== block.hash) ||
        utc(witness.observedAtUtc) < utc(earliestUtc) ||
        utc(witness.observedAtUtc) > utc(latestUtc)
      )
        throw Error('susde_header_invalid')
    }
  }
  const [left, right] = evidence.origins
  const normalized = (origin) => ({
    ...origin,
    provider: null,
    call: origin.call.status === 'evm_revert' ? { status: 'evm_revert' } : origin.call,
  })
  if (!same(normalized(left), normalized(right))) throw Error('susde_origin_disagreement')
  const reads = left.reads
  const rawReads = left.rawReads
  for (const [key, name, args, abi] of [
    ['asset', 'asset', [], ABI],
    ['silo', 'silo', [], ABI],
    ['shareDecimals', 'decimals', [], ABI],
    ['assetDecimals', 'decimals', [], TOKEN_ABI],
    ['totalAssets', 'totalAssets', [], ABI],
    ['totalSupply', 'totalSupply', [], ABI],
    ['shares', 'balanceOf', [holder], ABI],
    ['maxWithdraw', 'maxWithdraw', [holder], ABI],
    ['preview', 'previewWithdraw', [BigInt(assetsRaw)], ABI],
    ['duration', 'cooldownDuration', [], ABI],
  ]) {
    if (decodeWord(name, rawReads?.[key], args, abi).toString() !== reads[key])
      throw Error('susde_measurement_raw_read_invalid')
  }
  if (!/^0x[0-9a-f]{128}$/.test(rawReads?.cooldowns ?? ''))
    throw Error('susde_measurement_cooldown_raw_invalid')
  const [cooldownEnd, pendingAssets] = decodeFunctionResult({
    abi: ABI,
    functionName: 'cooldowns',
    data: rawReads.cooldowns,
  })
  if (
    cooldownEnd.toString() !== reads.cooldownEnd ||
    pendingAssets.toString() !== reads.pendingAssets ||
    left.callData !==
      encodeFunctionData({
        abi: legacy ? LEGACY_COOLDOWN_ABI : ABI,
        functionName: 'cooldownAssets',
        args: legacy ? [BigInt(assetsRaw), holder] : [BigInt(assetsRaw)],
      })
  )
    throw Error('susde_measurement_raw_binding_invalid')
  if (
    (legacy
      ? left.ownerCode !== 'empty'
      : left.ownerCode !== 'empty' && !DELEGATION_CODE.test(left.ownerCode ?? '')) ||
    left.vaultCodeHash === 'empty' ||
    left.assetCodeHash === 'empty' ||
    reads.asset?.toLowerCase() !== ROUTE.asset ||
    reads.silo?.toLowerCase() !== ROUTE.silo ||
    reads.shareDecimals !== '18' ||
    reads.assetDecimals !== '18' ||
    !DECIMAL.test(reads.shares ?? '') ||
    !DECIMAL.test(reads.maxWithdraw ?? '') ||
    !DECIMAL.test(reads.preview ?? '') ||
    !DECIMAL.test(reads.pendingAssets ?? '') ||
    !DECIMAL.test(reads.cooldownEnd ?? '') ||
    !DECIMAL.test(reads.duration ?? '') ||
    BigInt(reads.duration) < 1n ||
    BigInt(reads.duration) > 90n * 24n * 3600n
  )
    throw Error('susde_measurement_state_invalid')
  const success = left.call?.status === 'success'
  if (success) {
    if (
      !WORD.test(left.call.raw ?? '') ||
      BigInt(left.call.raw).toString() !== left.sharesBurned ||
      BigInt(left.sharesBurned) === 0n ||
      left.sharesBurned !== reads.preview ||
      BigInt(left.sharesBurned) > BigInt(reads.shares) ||
      BigInt(assetsRaw) > BigInt(reads.maxWithdraw)
    )
      throw Error('susde_measurement_success_invalid')
  } else if (left.call?.status !== 'evm_revert' || left.sharesBurned !== null)
    throw Error('susde_measurement_revert_invalid')
  const covered =
    !success &&
    BigInt(reads.preview) > 0n &&
    BigInt(reads.shares) >= BigInt(reads.preview) &&
    BigInt(reads.maxWithdraw) >= BigInt(assetsRaw)
  const expected = {
    status: success ? 'simulated_initiation_success' : 'initiation_revert_cause_unknown',
    sharesBurnedRaw: left.sharesBurned,
    holderSharesRaw: reads.shares,
    previewSharesRaw: reads.preview,
    maxWithdrawAssetsRaw: reads.maxWithdraw,
    pendingAssetsRaw: reads.pendingAssets,
    cooldownEndRaw: reads.cooldownEnd,
    cooldownDurationSeconds: Number(reads.duration),
    coveredRevert: covered,
    wouldResetPending: success && BigInt(reads.pendingAssets) > 0n,
    hypotheticalEarliestEligibilityUtc: success
      ? new Date(utc(block.at) + Number(reads.duration) * 1000).toISOString()
      : null,
    evidence,
    evidenceSha256: row.evidenceSha256,
  }
  if (!same(row, expected)) throw Error('susde_measurement_derived_invalid')
  // This marker is derived and never added to the immutable evidence row.
  return {
    ...expected,
    selectorCompatibility: legacy ? 'legacy_absent_selector' : 'deployed_selector',
  }
}
