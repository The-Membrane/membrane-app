// Local, versioned assay of the deployed Hastra PRIME → wYLDS → USDC route.
// The frozen PYUSD board label remains a separate, unverified conversion leg.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'

export const STUDY = 'pyusd_staking_economic_exit_v1'
export const ROUTE = 'PYUSD → StakingVault [wYLDS]'
export const PRIME = '0x19ebb35279a16207ec4ba82799cc64715065f7f6'
export const WYLDS = '0x6ad038ca6c04e885630851278ca0a856ad9a66cc'
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
export const PYUSD = '0x6c3ea9036406852006290770bedfcaba0e23a0e8'
export const ROOT = resolve('data/research/venue-signals/pyusd-staking-economic-exit-v1')
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const IMPLEMENTATIONS = [
  '0x881fe0e5e91c54fabbf0198a1bb2fc6e5747d4c5',
  '0x06e0b9155a3cf07f41ac826ccfee7ef8413a9723',
]
const CODE_HASHES = [
  '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6',
  '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6',
  '0x0e8044f306a768cfd365491bfb983ed4415c56263156d9a1a40b1341e56c4cae',
  '0x38dcc95686d703a0a5fa9f9cd707c5cdcc077879b5c60c0d63e4ff9264067851',
]
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function paused() view returns (bool)',
  'function frozen(address) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
  'function pendingRedemptions(address) view returns (uint256 shares,uint256 assets,uint256 timestamp)',
  'function redeemVault() view returns (address)',
])
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase()
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const hex = (value) => `0x${BigInt(value).toString(16)}`
const call = async (origin, to, functionName, args, blockHash, from) => {
  const data = encodeFunctionData({ abi: ABI, functionName, args })
  const response = await origin.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data, ...(from ? { from } : {}) }, pin(blockHash)],
  })
  if (response.error) {
    if (response.error.message !== 'execution reverted') throw Error('pyusd_economic_rpc_retry')
    return { status: 'evm_revert', value: null }
  }
  return {
    status: 'success',
    value: decodeFunctionResult({ abi: ABI, functionName, data: response.result }),
  }
}
const value = async (...args) => {
  const result = await call(...args)
  if (result.status !== 'success') throw Error('pyusd_economic_state_unavailable')
  return result.value
}

export function classifyStage({ primeShares, q, simulatedAssets, maxRedeem, paused, frozen }) {
  if (primeShares < q) return 'insufficient_prime_shares'
  if (paused) return 'staking_paused'
  if (frozen) return 'holder_frozen'
  if (maxRedeem < q) return 'below_max_redeem'
  if (simulatedAssets === null) return 'redeem_reverted'
  if (simulatedAssets <= 0n) return 'zero_wylds_out'
  return 'prime_to_wylds_callable'
}

export async function attestHastraIdentity(origin, hash) {
  if ((await origin.request('eth_chainId', [])) !== '0x1')
    throw Error('pyusd_economic_chain_invalid')
  const addresses = [PRIME, WYLDS, ...IMPLEMENTATIONS]
  const [primeSlot, yieldSlot, ...codes] = await Promise.all([
    origin.request('eth_getStorageAt', [PRIME, SLOT, pin(hash)]),
    origin.request('eth_getStorageAt', [WYLDS, SLOT, pin(hash)]),
    ...addresses.map((address) => origin.request('eth_getCode', [address, pin(hash)])),
  ])
  if (
    !HASH.test(primeSlot) ||
    !HASH.test(yieldSlot) ||
    !same(`0x${primeSlot.slice(-40)}`, IMPLEMENTATIONS[0]) ||
    !same(`0x${yieldSlot.slice(-40)}`, IMPLEMENTATIONS[1]) ||
    codes.some((code, index) => !code || !same(keccak256(code), CODE_HASHES[index]))
  )
    throw Error('pyusd_economic_implementation_changed')
  const [primeAsset, yieldAsset, primeDecimals, yieldDecimals, usdcDecimals, pyusdDecimals] =
    await Promise.all([
      value(origin, PRIME, 'asset', [], hash),
      value(origin, WYLDS, 'asset', [], hash),
      value(origin, PRIME, 'decimals', [], hash),
      value(origin, WYLDS, 'decimals', [], hash),
      value(origin, USDC, 'decimals', [], hash),
      value(origin, PYUSD, 'decimals', [], hash),
    ])
  if (
    !same(primeAsset, WYLDS) ||
    !same(yieldAsset, USDC) ||
    [primeDecimals, yieldDecimals, usdcDecimals, pyusdDecimals].some((n) => n !== 6)
  )
    throw Error('pyusd_economic_asset_changed')
  return {
    implementations: IMPLEMENTATIONS,
    codeHashes: CODE_HASHES,
    primeAsset,
    yieldAsset,
    primeDecimals,
    yieldDecimals,
    usdcDecimals,
    pyusdDecimals,
  }
}

export async function assayHastraHolder(origin, hash, holder, q) {
  const [
    primeShares,
    maxRedeem,
    preview,
    stakingPaused,
    stakingFrozen,
    wyldsShares,
    pending,
    yieldPaused,
    yieldFrozen,
    redeemVault,
  ] = await Promise.all([
    value(origin, PRIME, 'balanceOf', [holder], hash),
    value(origin, PRIME, 'maxRedeem', [holder], hash),
    call(origin, PRIME, 'previewRedeem', [q], hash),
    value(origin, PRIME, 'paused', [], hash),
    value(origin, PRIME, 'frozen', [holder], hash),
    value(origin, WYLDS, 'balanceOf', [holder], hash),
    value(origin, WYLDS, 'pendingRedemptions', [holder], hash),
    value(origin, WYLDS, 'paused', [], hash),
    value(origin, WYLDS, 'frozen', [holder], hash),
    value(origin, WYLDS, 'redeemVault', [], hash),
  ])
  const simulated = await call(origin, PRIME, 'redeem', [q, holder, holder], hash, holder)
  const simulatedAssets = simulated.status === 'success' ? simulated.value : null
  const stage = classifyStage({
    primeShares,
    q,
    simulatedAssets,
    maxRedeem,
    paused: stakingPaused,
    frozen: stakingFrozen,
  })
  return {
    holder,
    qRaw: q.toString(),
    primeSharesRaw: primeShares.toString(),
    maxRedeemRaw: maxRedeem.toString(),
    previewWyldsRaw: preview.status === 'success' ? preview.value.toString() : null,
    simulatedWyldsRaw: simulatedAssets?.toString() ?? null,
    stakingPaused,
    stakingFrozen,
    stage,
    yieldStage: {
      existingWyldsSharesRaw: wyldsShares.toString(),
      pendingSharesRaw: pending[0].toString(),
      pendingUsdcRaw: pending[1].toString(),
      pendingSinceUnix: pending[2].toString(),
      yieldPaused,
      yieldFrozen,
      redeemVault: redeemVault.toLowerCase(),
      requestAssessed: false, // A separate eth_call cannot inherit simulated PRIME redemption state.
      completion: 'admin_gated_unassessed',
      usdcPayout: 'not_attested',
    },
    pyusdPayout: 'not_attested',
  }
}

async function discoverHolder(origin, hash, blockNumber, excludedHolders = new Set()) {
  const end = BigInt(blockNumber) - 1n
  const start = end > 4999n ? end - 4999n : 0n
  const candidates = []
  let windows
  try {
    windows = [
      await origin.request('eth_getLogs', [
        { address: PRIME, topics: [TRANSFER], fromBlock: hex(start), toBlock: hex(end) },
      ]),
    ]
  } catch {
    // Bounded provider-cap fallback. A quiet 320-block tail stays inconclusive.
    windows = []
    const fallback = end > 319n ? end - 319n : 0n
    for (let low = fallback; low <= end; low += 10n) {
      const high = low + 9n < end ? low + 9n : end
      windows.push(
        await origin.request('eth_getLogs', [
          { address: PRIME, topics: [TRANSFER], fromBlock: hex(low), toBlock: hex(high) },
        ]),
      )
    }
  }
  for (const logs of windows) {
    if (!Array.isArray(logs) || logs.length > 256) throw Error('pyusd_economic_logs_invalid')
    for (const log of logs) {
      if (
        log.address?.toLowerCase() !== PRIME ||
        log.topics?.[0]?.toLowerCase() !== TRANSFER ||
        !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics?.[2] ?? '')
      )
        continue
      const candidate = `0x${log.topics[2].slice(-40)}`.toLowerCase()
      if (candidate !== PRIME && candidate !== WYLDS && !candidates.includes(candidate))
        candidates.push(candidate)
    }
  }
  for (const holder of candidates.slice(-64).reverse()) {
    const [code, shares] = await Promise.all([
      origin.request('eth_getCode', [holder, pin(hash)]),
      value(origin, PRIME, 'balanceOf', [holder], hash),
    ])
    if (code === '0x' && shares >= 10n && !excludedHolders.has(holder)) return { holder, shares }
  }
  return null
}

export async function collectSnapshot(
  origins,
  holderOverride = null,
  qOverride = null,
  excludedHolders = new Set(),
) {
  if (origins.length !== 2 || origins[0].provider === origins[1].provider)
    throw Error('pyusd_economic_two_origins_required')
  const primaryFinal = await origins[0].request('eth_getBlockByNumber', ['finalized', false])
  if (!HASH.test(primaryFinal?.hash ?? '') || !primaryFinal?.number)
    throw Error('pyusd_economic_finalized_unavailable')
  const number = BigInt(primaryFinal.number)
  const secondaryFinal = await origins[1].request('eth_getBlockByNumber', ['finalized', false])
  if (BigInt(secondaryFinal?.number ?? -1) < number)
    throw Error('pyusd_economic_secondary_not_finalized')
  const block = await origins[1].request('eth_getBlockByNumber', [hex(number), false])
  if (!same(block?.hash, primaryFinal.hash) || block?.number !== primaryFinal.number)
    throw Error('pyusd_economic_header_disagreement')
  const firstIdentity = await attestHastraIdentity(origins[0], primaryFinal.hash)
  const secondIdentity = await attestHastraIdentity(origins[1], primaryFinal.hash)
  if (JSON.stringify(firstIdentity) !== JSON.stringify(secondIdentity))
    throw Error('pyusd_economic_identity_disagreement')
  let holder = holderOverride?.toLowerCase()
  if (holder && !ADDRESS.test(holder)) throw Error('pyusd_economic_holder_invalid')
  const discovered = holder
    ? null
    : await discoverHolder(origins[0], primaryFinal.hash, number, excludedHolders)
  holder ??= discovered?.holder
  if (!holder) throw Error('pyusd_economic_no_holder_discovered')
  const shares =
    discovered?.shares ?? (await value(origins[0], PRIME, 'balanceOf', [holder], primaryFinal.hash))
  const q = qOverride === null ? shares / 10n : BigInt(qOverride)
  if (q <= 0n || q > shares || q > 10n ** 18n) throw Error('pyusd_economic_q_invalid')
  const first = await assayHastraHolder(origins[0], primaryFinal.hash, holder, q)
  const second = await assayHastraHolder(origins[1], primaryFinal.hash, holder, q)
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw Error('pyusd_economic_assay_disagreement')
  return {
    study: STUDY,
    routeKey: ROUTE,
    destination: PRIME,
    chainId: 1,
    blockNumber: number.toString(),
    blockHash: primaryFinal.hash.toLowerCase(),
    blockTimestamp: Number(BigInt(primaryFinal.timestamp)),
    origins: origins.map((origin) => origin.provider),
    identity: firstIdentity,
    holderSelection: holderOverride ? 'operator_supplied' : 'recent_prime_transfer_eoa',
    assay: first,
    finalPayout: 'unassessed',
    pyusdConversion: 'not_attested',
  }
}

export async function readLedger(root = ROOT) {
  let names
  try {
    if (!(await lstat(root)).isDirectory()) throw Error('pyusd_economic_root_invalid')
    names = await readdir(root)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const jsonNames = names.filter((name) => name.endsWith('.json')).sort()
  if (names.some((name) => !/^\d{8}\.json$/.test(name))) throw Error('pyusd_economic_stray_file')
  const rows = []
  for (const name of jsonNames) {
    if (name !== `${String(rows.length + 1).padStart(8, '0')}.json`)
      throw Error('pyusd_economic_gap')
    const fd = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const st = await fd.stat()
      if (!st.isFile() || st.size < 1 || st.size > 64_000) throw Error('pyusd_economic_file_size')
      bytes = await fd.readFile()
      if ((await fd.stat()).size !== st.size) throw Error('pyusd_economic_file_changed')
    } finally {
      await fd.close()
    }
    const row = JSON.parse(bytes.toString('utf8'))
    const { sha256, ...body } = row
    if (
      bytes.toString('utf8') !== `${JSON.stringify(row)}\n` ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (rows.at(-1)?.sha256 ?? null) ||
      row.study !== STUDY ||
      row.routeKey !== ROUTE ||
      row.destination !== PRIME ||
      row.assay?.pyusdPayout !== 'not_attested' ||
      row.finalPayout !== 'unassessed' ||
      row.pyusdConversion !== 'not_attested' ||
      sha256 !== sha(JSON.stringify(body))
    )
      throw Error('pyusd_economic_ledger_invalid')
    rows.push(row)
  }
  return rows
}

export async function appendSnapshot(snapshot, root = ROOT) {
  await mkdir(root, { recursive: true })
  if (!(await lstat(root)).isDirectory()) throw Error('pyusd_economic_root_invalid')
  const previous = await readLedger(root)
  const body = {
    ...snapshot,
    sequence: previous.length + 1,
    previousSha256: previous.at(-1)?.sha256 ?? null,
  }
  const row = { ...body, sha256: sha(JSON.stringify(body)) }
  const data = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(data) > 64_000) throw Error('pyusd_economic_file_size')
  const fs = statfsSync(root)
  if (Number(fs.bavail) * Number(fs.bsize) < 1_073_741_824 + Buffer.byteLength(data))
    throw Error('pyusd_economic_disk_reserve')
  const temp = join(root, `.pyusd-economic-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', 0o600)
    try {
      await fd.writeFile(data)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await link(temp, join(root, `${String(row.sequence).padStart(8, '0')}.json`))
    const dir = await open(root, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(temp, { force: true })
  }
  return row
}

async function main() {
  if (process.argv[2] === '--verify') {
    const rows = await readLedger()
    console.log(
      JSON.stringify({
        study: STUDY,
        snapshots: rows.length,
        tipSha256: rows.at(-1)?.sha256 ?? null,
      }),
    )
    return
  }
  if (process.argv.length > 4 || (process.argv[2] && process.argv[2] !== '--holder'))
    throw Error('usage: node pyusd-staking-economic-exit.mjs [--holder 0x…] | --verify')
  const holder = process.argv[2] === '--holder' ? process.argv[3] : null
  const urls = configuredPublicRpcUrls(readEnv())
  let lastError
  for (let i = 0; i < urls.length; i++)
    for (let j = i + 1; j < urls.length; j++) {
      try {
        const origins = publicRpcClients([urls[i], urls[j]])
        const row = await appendSnapshot(await collectSnapshot(origins, holder))
        console.log(
          JSON.stringify({
            study: STUDY,
            sequence: row.sequence,
            blockNumber: row.blockNumber,
            stage: row.assay.stage,
            finalPayout: row.finalPayout,
            pyusdConversion: row.pyusdConversion,
            sha256: row.sha256,
          }),
        )
        return
      } catch (error) {
        lastError = error
        console.error(
          `pair ${new URL(urls[i]).hostname}/${new URL(urls[j]).hostname}: ${error.message}`,
        )
      }
    }
  throw lastError ?? Error('pyusd_economic_two_origins_unavailable')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
