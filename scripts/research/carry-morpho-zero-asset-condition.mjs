// Explicit historical samples of Morpho V2 vault assets and shares. A sample
// does not establish the condition between blocks or predict its recovery.
import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'

export const STUDY = 'carry_morpho_zero_asset_condition_v1'
export const OUT = resolve('data/research/venue-signals/carry-morpho-zero-asset-condition-v1')
export const RESERVE_BYTES = 1_073_741_824
export const MAX_ROUTES = 8
export const MAX_BLOCKS = 16
const MAX_RECORD_BYTES = 16_384
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const WORD = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const withoutSeal = ({ sha256: _sha256, ...body }) => body
const filename = (routeIndex, blockNumber) =>
  `${String(routeIndex).padStart(2, '0')}-${String(blockNumber).padStart(12, '0')}.json`
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })
const hex = (n) => `0x${n.toString(16)}`

function positiveInteger(value, code) {
  if (!DECIMAL.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 0)
    throw Error(code)
  return Number(value)
}

function parseHeader(raw, expected) {
  if (!raw || !HASH.test(raw.hash ?? '') || !HASH.test(raw.parentHash ?? ''))
    throw Error('condition_header_invalid')
  const number = positiveInteger(BigInt(raw.number).toString(), 'condition_header_invalid')
  const timestamp = positiveInteger(BigInt(raw.timestamp).toString(), 'condition_header_invalid')
  if (number !== expected || timestamp === 0) throw Error('condition_header_invalid')
  return { number, hash: raw.hash, parentHash: raw.parentHash, timestamp }
}

function parseWord(value) {
  if (!WORD.test(value ?? '')) throw Error('condition_pinned_call_invalid')
  return BigInt(value).toString()
}

function origin(client) {
  const parsed = new URL(client.url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('condition_origin_invalid')
  return parsed.hostname.toLowerCase().replace(/\.$/, '')
}

export function validateSelection({ routeIndices, blocks }) {
  if (
    !Array.isArray(routeIndices) ||
    !Array.isArray(blocks) ||
    !routeIndices.length ||
    !blocks.length ||
    routeIndices.length > MAX_ROUTES ||
    blocks.length > MAX_BLOCKS ||
    new Set(routeIndices).size !== routeIndices.length ||
    new Set(blocks).size !== blocks.length ||
    routeIndices.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value >= BOARD_ROUTES.length,
    ) ||
    blocks.some((value) => !Number.isSafeInteger(value) || value <= 0)
  )
    throw Error('condition_selection_invalid')
  return { routeIndices, blocks }
}

export function validateRecord(record) {
  if (
    !record ||
    !SHA.test(record.sha256 ?? '') ||
    record.sha256 !== sha(JSON.stringify(withoutSeal(record)))
  )
    throw Error('condition_seal_invalid')
  const route = BOARD_ROUTES[record.routeIndex]
  if (
    !route ||
    record.study !== STUDY ||
    record.chainId !== '1' ||
    record.routeKey !== route.routeKey ||
    record.destination !== route.destination ||
    record.asset !== route.asset ||
    !Number.isSafeInteger(record.blockNumber) ||
    record.blockNumber <= 0 ||
    !Number.isFinite(Date.parse(record.capturedAtUtc)) ||
    !Array.isArray(record.witnesses) ||
    record.witnesses.length !== 2
  )
    throw Error('condition_identity_invalid')
  const [a, b] = record.witnesses
  if (
    !a ||
    !b ||
    !a.origin ||
    !b.origin ||
    a.origin === b.origin ||
    !/^[a-z0-9.\-:[\]]+$/.test(a.origin) ||
    !/^[a-z0-9.\-:[\]]+$/.test(b.origin)
  )
    throw Error('condition_origins_invalid')
  for (const witness of record.witnesses) {
    const h = witness.header
    if (
      !h ||
      h.number !== record.blockNumber ||
      !HASH.test(h.hash ?? '') ||
      !HASH.test(h.parentHash ?? '') ||
      !Number.isSafeInteger(h.timestamp) ||
      h.timestamp <= 0 ||
      !DECIMAL.test(witness.totalAssetsRaw ?? '') ||
      !DECIMAL.test(witness.totalSupplyRaw ?? '') ||
      !Number.isSafeInteger(witness.finalizedNumber) ||
      witness.finalizedNumber < record.blockNumber
    )
      throw Error('condition_witness_invalid')
  }
  if (Date.parse(record.capturedAtUtc) < a.header.timestamp * 1000)
    throw Error('condition_capture_before_block')
  if (
    JSON.stringify(a.header) !== JSON.stringify(b.header) ||
    a.totalAssetsRaw !== b.totalAssetsRaw ||
    a.totalSupplyRaw !== b.totalSupplyRaw ||
    record.status !==
      (a.totalAssetsRaw === '0' && a.totalSupplyRaw !== '0'
        ? 'zero_assets_positive_shares'
        : a.totalSupplyRaw === '0'
          ? 'zero_supply'
          : 'nonzero_assets')
  )
    throw Error('condition_host_disagreement')
  return record
}

async function observe(client, route, blockNumber) {
  const request = (method, params) => client.request(method, params)
  if ((await request('eth_chainId', [])) !== '0x1') throw Error('condition_wrong_chain')
  const raw = await request('eth_getBlockByNumber', [hex(blockNumber), false])
  const header = parseHeader(raw, blockNumber)
  const finalized = await request('eth_getBlockByNumber', ['finalized', false])
  const finalizedNumber = positiveInteger(
    BigInt(finalized?.number).toString(),
    'condition_finality_invalid',
  )
  if (finalizedNumber < blockNumber) throw Error('condition_not_finalized')
  const code = await request('eth_getCode', [route.destination, pin(header.hash)])
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code))
    throw Error('condition_vault_code_missing')
  const asset = await request('eth_call', [
    { to: route.destination, data: '0x38d52e0f' },
    pin(header.hash),
  ])
  if (!WORD.test(asset ?? '') || `0x${asset.slice(-40)}` !== route.asset)
    throw Error('condition_asset_mismatch')
  const totalAssetsRaw = parseWord(
    await request('eth_call', [{ to: route.destination, data: '0x01e1d114' }, pin(header.hash)]),
  )
  const totalSupplyRaw = parseWord(
    await request('eth_call', [{ to: route.destination, data: '0x18160ddd' }, pin(header.hash)]),
  )
  const again = parseHeader(
    await request('eth_getBlockByNumber', [hex(blockNumber), false]),
    blockNumber,
  )
  if (JSON.stringify(header) !== JSON.stringify(again)) throw Error('condition_reorg')
  return { origin: origin(client), header, finalizedNumber, totalAssetsRaw, totalSupplyRaw }
}

export async function capture({ routeIndices, blocks, clients, now = () => new Date() }) {
  validateSelection({ routeIndices, blocks })
  if (!Array.isArray(clients) || clients.length !== 2 || origin(clients[0]) === origin(clients[1]))
    throw Error('condition_two_hosts_required')
  const records = []
  for (const routeIndex of routeIndices) {
    const route = BOARD_ROUTES[routeIndex]
    for (const blockNumber of blocks) {
      const witnesses = []
      for (const client of clients) witnesses.push(await observe(client, route, blockNumber))
      const [a, b] = witnesses
      if (
        JSON.stringify(a.header) !== JSON.stringify(b.header) ||
        a.totalAssetsRaw !== b.totalAssetsRaw ||
        a.totalSupplyRaw !== b.totalSupplyRaw
      )
        throw Error('condition_host_disagreement')
      const body = {
        study: STUDY,
        chainId: '1',
        routeIndex,
        routeKey: route.routeKey,
        destination: route.destination,
        asset: route.asset,
        blockNumber,
        capturedAtUtc: now().toISOString(),
        witnesses,
        status:
          a.totalAssetsRaw === '0' && a.totalSupplyRaw !== '0'
            ? 'zero_assets_positive_shares'
            : a.totalSupplyRaw === '0'
              ? 'zero_supply'
              : 'nonzero_assets',
      }
      records.push(validateRecord({ ...body, sha256: sha(JSON.stringify(body)) }))
    }
  }
  return records
}

async function verifiedFile(path, file) {
  const bytes = await readFile(path)
  if (bytes.length > MAX_RECORD_BYTES) throw Error('condition_record_oversize')
  const record = JSON.parse(bytes.toString('utf8'))
  if (
    bytes.toString('utf8') !== `${JSON.stringify(record)}\n` ||
    file !== filename(record.routeIndex, record.blockNumber)
  )
    throw Error('condition_physical_mismatch')
  return validateRecord(record)
}

export async function verify({ out = OUT } = {}) {
  let files
  try {
    files = (await readdir(out)).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return { count: 0, zeroAssetsPositiveShares: 0 }
    throw error
  }
  let zeroAssetsPositiveShares = 0
  const seen = new Set()
  for (const file of files) {
    if (!/^\d{2}-\d{12}\.json$/.test(file)) throw Error('condition_unknown_file')
    const record = await verifiedFile(join(out, file), file)
    const key = `${record.routeIndex}/${record.blockNumber}`
    if (seen.has(key)) throw Error('condition_duplicate')
    seen.add(key)
    if (record.status === 'zero_assets_positive_shares') zeroAssetsPositiveShares++
  }
  return { count: files.length, zeroAssetsPositiveShares }
}

export async function readVerifiedMorphoZeroAssetConditions({ out = OUT } = {}) {
  await verify({ out })
  let files
  try {
    files = (await readdir(out)).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const byRoute = new Map()
  for (const file of files) {
    const row = await verifiedFile(join(out, file), file)
    if (!byRoute.has(row.routeIndex))
      byRoute.set(row.routeIndex, {
        routeIndex: row.routeIndex,
        routeKey: row.routeKey,
        destination: row.destination,
        asset: row.asset,
        observations: [],
      })
    byRoute.get(row.routeIndex).observations.push({
      block: row.blockNumber,
      blockHash: row.witnesses[0].header.hash,
      blockTime: new Date(row.witnesses[0].header.timestamp * 1000).toISOString(),
      assetsRaw: row.witnesses[0].totalAssetsRaw,
      supplyRaw: row.witnesses[0].totalSupplyRaw,
      status: row.status,
      evidenceSha256: row.sha256,
    })
  }
  return [...byRoute.values()]
    .sort((a, b) => a.routeIndex - b.routeIndex)
    .map((row) => ({
      ...row,
      observations: row.observations.sort((a, b) => a.block - b.block),
      allObservedZeroAssetsPositiveShares: row.observations.every(
        (item) => item.status === 'zero_assets_positive_shares',
      ),
    }))
}

export async function save({ records, out = OUT, stat = statfsSync }) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_ROUTES * MAX_BLOCKS)
    throw Error('condition_save_selection_invalid')
  await verify({ out })
  await mkdir(out, { recursive: true })
  const seen = new Set()
  const existing = new Set(await readdir(out))
  const prepared = []
  for (const record of records) {
    validateRecord(record)
    const file = filename(record.routeIndex, record.blockNumber)
    if (seen.has(file)) throw Error('condition_duplicate')
    if (existing.has(file)) throw Error('condition_already_recorded')
    seen.add(file)
    const bytes = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw Error('condition_record_oversize')
    prepared.push({ file, bytes })
  }
  const requiredBytes = prepared.reduce((total, row) => total + Buffer.byteLength(row.bytes), 0)
  const fs = stat(out)
  if (Number(fs.bavail) * Number(fs.bsize) < RESERVE_BYTES + requiredBytes)
    throw Error('condition_disk_reserve')
  const paths = []
  for (const { file, bytes } of prepared) {
    const temp = join(out, `.condition-${randomUUID()}.tmp`)
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const path = join(out, file)
      await link(temp, path)
      paths.push(path)
    } finally {
      await rm(temp, { force: true })
    }
  }
  return paths
}

export function parseCli(args) {
  if (args.length === 1 && args[0] === '--verify') return { mode: 'verify' }
  if (
    args.length !== 5 ||
    args[0] !== '--capture' ||
    args[1] !== '--routes' ||
    args[3] !== '--blocks'
  )
    throw Error('usage: --verify | --capture --routes INDEX[,INDEX] --blocks NUMBER[,NUMBER]')
  const parseList = (raw) => {
    if (!/^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/.test(raw))
      throw Error('condition_selection_invalid')
    return raw.split(',').map(Number)
  }
  const routeIndices = parseList(args[2])
  const blocks = parseList(args[4])
  validateSelection({ routeIndices, blocks })
  return { mode: 'capture', routeIndices, blocks }
}

export function selectRpcUrls(urls, hosts = '') {
  if (!hosts) return urls.slice(0, 2)
  const names = hosts.split(',').map((name) => name.trim().toLowerCase())
  if (names.length !== 2 || names[0] === names[1] || names.some((name) => !name))
    throw Error('condition_two_hosts_required')
  const selected = names.map((name) =>
    urls.find((url) => new URL(url).hostname.toLowerCase() === name),
  )
  if (selected.some((url) => !url)) throw Error('condition_origin_not_configured')
  return selected
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseCli(process.argv.slice(2))
    if (command.mode === 'verify') console.log(JSON.stringify(await verify()))
    else {
      const env = readEnv()
      const urls = configuredPublicRpcUrls(env)
      const clients = publicRpcClients(
        selectRpcUrls(urls, process.env.CARRY_MORPHO_CONDITION_ORIGINS),
      )
      await verify()
      const records = await capture({ ...command, clients })
      await save({ records })
      console.log(
        JSON.stringify({
          captured: records.length,
          zeroAssetsPositiveShares: records.filter(
            (row) => row.status === 'zero_assets_positive_shares',
          ).length,
        }),
      )
    }
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exitCode = 1
  }
}
