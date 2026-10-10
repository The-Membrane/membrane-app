// Private, bounded public-chain evidence for the apxUSD receipt-initiation leg.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toFunctionSelector,
} from 'viem'

import { publicRpcClients } from './carry-public-direct-exit-issue.mjs'

export const ROUTE = 'apxUSD → ApyUSD [apxUSD]'
export const VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a'
export const ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665'
export const RECEIPT = '0x9bf51f33955ec70f87c4b5c49441815589043237'
const VAULT_IMPL = '0xfd616567ecc1607f61073951a1e822f7315bb112'
const RECEIPT_IMPL = '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
const CODE_HASHES = [
  '0x748fde5d195af5984cc16c81df36137e6599c6f50f9f5113d05994c1b90ebad7',
  '0x76f9f10f52a301cd5472850a4ac1f5421c8bb57f126e7bd171bd9d3ae70dc30b',
  '0x7427a665f82e79f9e1e3a5592339de70bffab25517bbad2f7127549874fbf670',
  '0xae89d4b99f8590a5045c314350c7e1a0a7fdd69fd1adeb11aa554d6e2edeb1eb',
]
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ABI = parseAbi([
  'function withdrawForReceipt(uint256,address,address) returns (uint256,uint256)',
])
export const HORIZONS = Object.freeze([1, 4, 24, 48, 168])
export const OUT_ROOT = resolve('data/research/venue-signals')
export const ADDRESS = /^0x[0-9a-f]{40}$/
export const HEX = /^0x[0-9a-f]{64}$/
export const DECIMAL = /^(0|[1-9][0-9]*)$/
export const sha = (value) => createHash('sha256').update(value).digest('hex')
export const canonical = (value) => JSON.stringify(value)
const name = (n) => `${String(n).padStart(8, '0')}.json`
const unseal = ({ sha256: _seal, ...body }) => body
export const utc = (value) => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw Error('apyusd_clock_invalid')
  return ms
}
export const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const word = (value) => HEX.test(value ?? '')
const addr = (value) => `0x${value.slice(-40)}`
const numeric = (value) => {
  if (!word(value)) throw Error('apyusd_state_word_invalid')
  return BigInt(value)
}
const call = (origin, to, data, hash, from) =>
  origin.request('eth_call', [{ to, data, ...(from ? { from } : {}) }, pin(hash)])

export async function readHeader(origin, tag = 'finalized') {
  if ((await origin.request('eth_chainId', [])) !== '0x1') throw Error('apyusd_chain_invalid')
  const block = await origin.request('eth_getBlockByNumber', [tag, false])
  if (!HEX.test(block?.hash ?? '') || !HEX.test(block?.parentHash ?? '') || !block?.number)
    throw Error('apyusd_header_invalid')
  return {
    number: BigInt(block.number).toString(),
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
    timestamp: Number(BigInt(block.timestamp)),
  }
}

export async function attestIdentity(origin, blockHash) {
  const targets = [VAULT, RECEIPT, VAULT_IMPL, RECEIPT_IMPL]
  const [vaultSlot, receiptSlot, ...codes] = await Promise.all([
    origin.request('eth_getStorageAt', [VAULT, SLOT, pin(blockHash)]),
    origin.request('eth_getStorageAt', [RECEIPT, SLOT, pin(blockHash)]),
    ...targets.map((target) => origin.request('eth_getCode', [target, pin(blockHash)])),
  ])
  if (
    !word(vaultSlot) ||
    !word(receiptSlot) ||
    addr(vaultSlot) !== VAULT_IMPL ||
    addr(receiptSlot) !== RECEIPT_IMPL ||
    codes.some((code, index) => !code || keccak256(code).toLowerCase() !== CODE_HASHES[index])
  )
    throw Error('apyusd_implementation_identity_invalid')
  const [vaultAsset, vaultReceipt, receiptAsset, decimals] = await Promise.all([
    call(origin, VAULT, '0x38d52e0f', blockHash),
    call(origin, VAULT, toFunctionSelector('receipt()'), blockHash),
    call(origin, RECEIPT, '0x38d52e0f', blockHash),
    call(origin, ASSET, '0x313ce567', blockHash),
  ])
  if (
    !word(vaultAsset) ||
    !word(vaultReceipt) ||
    !word(receiptAsset) ||
    addr(vaultAsset) !== ASSET ||
    addr(vaultReceipt) !== RECEIPT ||
    addr(receiptAsset) !== ASSET ||
    numeric(decimals) !== 18n
  )
    throw Error('apyusd_asset_identity_invalid')
  return { vaultImpl: VAULT_IMPL, receiptImpl: RECEIPT_IMPL, codeHashes: CODE_HASHES }
}

export async function assay(origin, holder, assetsRaw, blockHash) {
  if (!ADDRESS.test(holder) || !DECIMAL.test(assetsRaw) || BigInt(assetsRaw) === 0n)
    throw Error('apyusd_assay_input_invalid')
  const data = encodeFunctionData({
    abi: ABI,
    functionName: 'withdrawForReceipt',
    args: [BigInt(assetsRaw), holder, holder],
  })
  const response = await origin.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: VAULT, data, from: holder }, pin(blockHash)],
  })
  if (Object.hasOwn(response, 'error')) {
    // The shared RPC wrapper reduces vendor text to these two categories.
    if (response.error?.message !== 'execution reverted') throw Error('apyusd_assay_rpc_retry')
    return { status: 'evm_revert', sharesRaw: null, simulatedReceiptId: null }
  }
  const raw = response.result
  if (!raw || !/^0x[0-9a-f]+$/i.test(raw)) throw Error('apyusd_assay_empty')
  const [shares, id] = decodeFunctionResult({
    abi: ABI,
    functionName: 'withdrawForReceipt',
    data: raw,
  })
  return {
    status: 'initiation_success',
    sharesRaw: shares.toString(),
    simulatedReceiptId: id.toString(),
  }
}

export function independentPairs(urls, clientsFor = publicRpcClients) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 8)
    throw Error('apyusd_origins_invalid')
  const pairs = []
  for (let i = 0; i < urls.length && pairs.length < 24; i++)
    for (let j = i + 1; j < urls.length && pairs.length < 24; j++) {
      try {
        const pair = clientsFor([urls[i], urls[j]])
        if (pair[0].provider !== pair[1].provider) pairs.push(pair)
      } catch {
        /* try the next independently hosted pair */
      }
    }
  if (!pairs.length) throw Error('apyusd_two_origins_required')
  return pairs
}

export async function readChain(out) {
  let files
  try {
    files = (await readdir(out)).filter((entry) => entry.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const file of files) {
    if (file !== name(rows.length + 1)) throw Error('apyusd_chain_gap')
    const handle = await open(join(out, file), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const st = await handle.stat()
      if (!st.isFile() || st.size > 262_144) throw Error('apyusd_record_size_invalid')
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    const row = JSON.parse(bytes.toString('utf8'))
    if (
      bytes.toString('utf8') !== `${canonical(row)}\n` ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (rows.at(-1)?.sha256 ?? null) ||
      row.sha256 !== sha(canonical(unseal(row)))
    )
      throw Error('apyusd_chain_invalid')
    rows.push(row)
  }
  return rows
}

export async function appendChain(row, out, verify) {
  await mkdir(out, { recursive: true })
  const previous = await verify(out)
  if (
    row.sequence !== previous.length + 1 ||
    row.previousSha256 !== (previous.at(-1)?.sha256 ?? null) ||
    row.sha256 !== sha(canonical(unseal(row)))
  )
    throw Error('apyusd_chain_changed')
  const body = `${canonical(row)}\n`
  if (Buffer.byteLength(body) > 262_144) throw Error('apyusd_record_size_invalid')
  const disk = statfsSync(out)
  if (Number(disk.bavail) * Number(disk.bsize) < 1_073_741_824 + Buffer.byteLength(body))
    throw Error('apyusd_disk_reserve')
  const tmp = join(out, `.apyusd-${randomUUID()}.tmp`)
  try {
    const fd = await open(tmp, 'wx', 0o600)
    try {
      await fd.writeFile(body)
      await fd.sync()
    } finally {
      await fd.close()
    }
    await link(tmp, join(out, name(row.sequence)))
    const dir = await open(out, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await rm(tmp, { force: true })
  }
  return row
}

export function seal(row) {
  row.sha256 = sha(canonical(row))
  return row
}
