// Retrospective Ethereum state only. A cash/reserve point is aggregate route
// inventory at a pinned block, never a holder quote or expected future flow.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadConfig } from './venue-reads.mjs'

export const STUDY = 'three-venue-historical-inventory-v1'
export const ROOT = resolve('data/research/venue-signals/historical-three-venue-inventory-v1')
export const STEP_BLOCKS = 900n
export const MAX_ROWS = 5_000
export const MIN_FREE_BYTES = 1024 * 1024 * 1024
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const lower = (value) => String(value).toLowerCase()
const field = (type) => ({ type })
const fn = (name, inputTypes, outputType) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs: inputTypes.map(field),
  outputs: [field(outputType)],
})
const ABI = [
  fn('coins', ['uint256'], 'address'),
  fn('balances', ['uint256'], 'uint256'),
  fn('pocket', [], 'address'),
  fn('gem', [], 'address'),
  fn('asset', [], 'address'),
  fn('paused', [], 'bool'),
  fn('decimals', [], 'uint8'),
  fn('balanceOf', ['address'], 'uint256'),
]

export function manifestFromConfig(config = loadConfig()) {
  const venue = (name) => {
    const found = config.find((v) => v.enabled && v.name === name && v.chain !== 'other')
    if (!found) throw new Error(`historical_inventory_venue_disabled:${name}`)
    return found
  }
  const susde = venue('sUSDe')
  const susds = venue('sUSDS')
  const sgho = venue('sGHO')
  const curve = susde.depthMarkets?.filter((m) => m.enabled && m.kind === 'curve-stableswap')
  const psm = susds.depthMarkets?.filter((m) => m.enabled && m.kind === 'psm-buffer')
  if (curve?.length !== 1 || psm?.length !== 1 || sgho.kind !== 'erc4626-vault-cash')
    throw new Error('historical_inventory_route_shape_changed')
  const [c] = curve
  const [p] = psm
  const addresses = [
    susde.address,
    c.address,
    c.token0,
    c.token1,
    c.exitFrom,
    susds.address,
    susds.underlying,
    p.address,
    p.buffer,
    p.bufferToken,
    p.exitFrom,
    sgho.address,
    sgho.underlying,
  ]
  if (addresses.some((value) => !ADDRESS.test(value)))
    throw new Error('historical_inventory_bad_address')
  if (
    lower(c.token1) !== lower(susde.address) ||
    lower(c.exitFrom) !== lower(susde.address) ||
    lower(p.exitFrom) !== lower(susds.underlying) ||
    susde.decimals !== 18 ||
    susds.decimals !== 18 ||
    sgho.decimals !== 18
  )
    throw new Error('historical_inventory_route_identity_changed')
  return {
    chainId: 1,
    sUSDe: {
      vault: lower(susde.address),
      pool: lower(c.address),
      output: lower(c.token0),
      input: lower(c.token1),
      outputDecimals: 18,
    },
    sUSDS: {
      vault: lower(susds.address),
      underlying: lower(susds.underlying),
      psm: lower(p.address),
      pocket: lower(p.buffer),
      output: lower(p.bufferToken),
      outputDecimals: 6,
    },
    sGHO: { vault: lower(sgho.address), underlying: lower(sgho.underlying), outputDecimals: 18 },
  }
}

function contracts(m) {
  const call = (address, functionName, args = []) => ({ address, abi: ABI, functionName, args })
  return [
    call(m.sUSDe.pool, 'coins', [0n]),
    call(m.sUSDe.pool, 'coins', [1n]),
    call(m.sUSDe.output, 'decimals'),
    call(m.sUSDe.pool, 'balances', [0n]),
    call(m.sUSDS.psm, 'pocket'),
    call(m.sUSDS.psm, 'gem'),
    call(m.sUSDS.output, 'decimals'),
    call(m.sUSDS.output, 'balanceOf', [m.sUSDS.pocket]),
    call(m.sGHO.vault, 'asset'),
    call(m.sGHO.underlying, 'decimals'),
    call(m.sGHO.vault, 'decimals'),
    call(m.sGHO.vault, 'paused'),
    call(m.sGHO.underlying, 'balanceOf', [m.sGHO.vault]),
  ]
}

const asRaw = (value) => {
  if (typeof value !== 'bigint' || value < 0n)
    throw new Error('historical_inventory_invalid_balance')
  return value.toString()
}
function quantity(raw, decimals) {
  const n = Number(BigInt(raw)) / 10 ** decimals
  if (!Number.isFinite(n) || n < 0) throw new Error('historical_inventory_invalid_quantity')
  return n
}
export function decodeInventory(values, m) {
  if (!Array.isArray(values) || values.length !== 13)
    throw new Error('historical_inventory_incomplete_reads')
  const [
    coin0,
    coin1,
    dolaDecimals,
    dolaBalance,
    pocket,
    gem,
    usdcDecimals,
    usdcBalance,
    asset,
    ghoDecimals,
    vaultDecimals,
    paused,
    ghoBalance,
  ] = values
  if (
    lower(coin0) !== m.sUSDe.output ||
    lower(coin1) !== m.sUSDe.input ||
    Number(dolaDecimals) !== m.sUSDe.outputDecimals ||
    lower(pocket) !== m.sUSDS.pocket ||
    lower(gem) !== m.sUSDS.output ||
    Number(usdcDecimals) !== m.sUSDS.outputDecimals ||
    lower(asset) !== m.sGHO.underlying ||
    Number(ghoDecimals) !== m.sGHO.outputDecimals ||
    Number(vaultDecimals) !== 18 ||
    typeof paused !== 'boolean'
  )
    throw new Error('historical_inventory_pinned_identity_mismatch')
  const dolaRaw = asRaw(dolaBalance)
  const usdcRaw = asRaw(usdcBalance)
  const ghoRaw = asRaw(ghoBalance)
  return {
    sUSDe: {
      kind: 'curve_output_reserve',
      pool: m.sUSDe.pool,
      output: m.sUSDe.output,
      coinsOnchain: [lower(coin0), lower(coin1)],
      outputDecimals: Number(dolaDecimals),
      raw: dolaRaw,
      inventoryUsdAssumingPeg: quantity(dolaRaw, 18),
    },
    sUSDS: {
      kind: 'shared_psm_pocket',
      psm: m.sUSDS.psm,
      pocket: m.sUSDS.pocket,
      output: m.sUSDS.output,
      pocketOnchain: lower(pocket),
      gemOnchain: lower(gem),
      outputDecimals: Number(usdcDecimals),
      raw: usdcRaw,
      inventoryUsdAssumingPeg: quantity(usdcRaw, 6),
      holderAttribution: 'unavailable',
    },
    sGHO: {
      kind: 'vault_cash',
      vault: m.sGHO.vault,
      underlying: m.sGHO.underlying,
      assetOnchain: lower(asset),
      underlyingDecimals: Number(ghoDecimals),
      vaultDecimals: Number(vaultDecimals),
      paused,
      raw: ghoRaw,
      inventoryUsdAssumingPeg: paused ? 0 : quantity(ghoRaw, 18),
      rawCashUsdAssumingPeg: quantity(ghoRaw, 18),
    },
  }
}

export async function readHistoricalInventoryAt(client, block, m) {
  if ((await client.getChainId()) !== 1) throw new Error('historical_inventory_wrong_chain')
  const before = await client.getBlock({ blockNumber: block })
  if (
    before.number !== block ||
    !HASH.test(before.hash ?? '') ||
    typeof before.timestamp !== 'bigint'
  )
    throw new Error('historical_inventory_invalid_header')
  const values = await client.multicall({
    contracts: contracts(m),
    blockNumber: block,
    allowFailure: false,
  })
  const inventory = decodeInventory(values, m)
  const after = await client.getBlock({ blockNumber: block })
  if (after.number !== block || after.hash !== before.hash || after.timestamp !== before.timestamp)
    throw new Error('historical_inventory_source_changed')
  return {
    source: {
      block: block.toString(),
      hash: lower(before.hash),
      timestamp: Number(before.timestamp),
      pinned: true,
      finalizedAtCapture: true,
    },
    inventory,
  }
}

const file = (n) => `${String(n).padStart(6, '0')}.json`
function read(path) {
  const bytes = readFileSync(path, 'utf8')
  const record = JSON.parse(bytes)
  if (bytes !== `${JSON.stringify(record)}\n`) throw new Error('historical_inventory_bytes_changed')
  const { sha256, ...body } = record
  if (sha(JSON.stringify(body)) !== sha256) throw new Error('historical_inventory_sha_changed')
  return record
}
function validateRecord(record, previous, manifest) {
  const receipt = record.firstLocalReceiptAtUtc
  if (
    typeof receipt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt) ||
    !Number.isFinite(Date.parse(receipt)) ||
    new Date(receipt).toISOString() !== receipt
  )
    throw new Error('historical_inventory_invalid_receipt_time')
  if (
    record.study !== STUDY ||
    record.sequence !== (previous?.sequence ?? 0) + 1 ||
    record.previousSha256 !== (previous?.sha256 ?? null) ||
    record.manifestSha256 !== sha(JSON.stringify(manifest)) ||
    !HASH.test(record.source?.hash ?? '') ||
    record.source.pinned !== true ||
    record.source.finalizedAtCapture !== true ||
    !RAW.test(record.source.block) ||
    BigInt(record.source.block) < 1n ||
    !Number.isSafeInteger(record.source.timestamp) ||
    record.source.timestamp <= 0 ||
    Date.parse(receipt) < record.source.timestamp * 1000 ||
    (previous &&
      (BigInt(record.source.block) !== BigInt(previous.source.block) - STEP_BLOCKS ||
        record.source.timestamp >= previous.source.timestamp ||
        Date.parse(receipt) < Date.parse(previous.firstLocalReceiptAtUtc)))
  )
    throw new Error('historical_inventory_chain_invalid')
  const v = record.inventory
  if (
    v?.sUSDe?.kind !== 'curve_output_reserve' ||
    v?.sUSDe?.pool !== manifest.sUSDe.pool ||
    v.sUSDe.output !== manifest.sUSDe.output ||
    JSON.stringify(v.sUSDe.coinsOnchain) !==
      JSON.stringify([manifest.sUSDe.output, manifest.sUSDe.input]) ||
    v.sUSDe.outputDecimals !== 18 ||
    !RAW.test(v.sUSDe.raw) ||
    v?.sUSDS?.kind !== 'shared_psm_pocket' ||
    v?.sUSDS?.psm !== manifest.sUSDS.psm ||
    v.sUSDS.pocket !== manifest.sUSDS.pocket ||
    v.sUSDS.output !== manifest.sUSDS.output ||
    v.sUSDS.pocketOnchain !== manifest.sUSDS.pocket ||
    v.sUSDS.gemOnchain !== manifest.sUSDS.output ||
    v.sUSDS.outputDecimals !== 6 ||
    v.sUSDS.holderAttribution !== 'unavailable' ||
    !RAW.test(v.sUSDS.raw) ||
    v?.sGHO?.kind !== 'vault_cash' ||
    v?.sGHO?.vault !== manifest.sGHO.vault ||
    v.sGHO.underlying !== manifest.sGHO.underlying ||
    v.sGHO.assetOnchain !== manifest.sGHO.underlying ||
    v.sGHO.underlyingDecimals !== 18 ||
    v.sGHO.vaultDecimals !== 18 ||
    typeof v.sGHO.paused !== 'boolean' ||
    !RAW.test(v.sGHO.raw)
  )
    throw new Error('historical_inventory_identity_invalid')
  if (
    v.sUSDe.inventoryUsdAssumingPeg !== quantity(v.sUSDe.raw, 18) ||
    v.sUSDS.inventoryUsdAssumingPeg !== quantity(v.sUSDS.raw, 6) ||
    v.sGHO.rawCashUsdAssumingPeg !== quantity(v.sGHO.raw, 18) ||
    v.sGHO.inventoryUsdAssumingPeg !== (v.sGHO.paused ? 0 : quantity(v.sGHO.raw, 18))
  )
    throw new Error('historical_inventory_amount_invalid')
}

function replayHistoricalThreeVenueInventory(out, manifest, includeRows) {
  const names = existsSync(out)
    ? readdirSync(out)
        .filter((x) => x.endsWith('.json'))
        .sort()
    : []
  if (names.length > MAX_ROWS) throw new Error('historical_inventory_count_limit')
  let previous = null
  const rows = includeRows ? [] : null
  for (const [index, name] of names.entries()) {
    if (name !== file(index + 1)) throw new Error('historical_inventory_sequence_gap')
    const record = read(join(out, name))
    validateRecord(record, previous, manifest)
    if (rows) rows.push(record)
    previous = record
  }
  return rows
    ? { count: names.length, last: previous, rows }
    : { count: names.length, last: previous }
}

export function verifyHistoricalThreeVenueInventory(out = ROOT, manifest = manifestFromConfig()) {
  return replayHistoricalThreeVenueInventory(out, manifest, false)
}

export function readHistoricalThreeVenueInventory(out = ROOT, manifest = manifestFromConfig()) {
  return replayHistoricalThreeVenueInventory(out, manifest, true)
}

export function appendHistoricalThreeVenueInventory(
  point,
  {
    out = ROOT,
    manifest = manifestFromConfig(),
    now = () => new Date(),
    stat = statfsSync,
    publish = linkSync,
  } = {},
) {
  const { count, last } = verifyHistoricalThreeVenueInventory(out, manifest)
  if (count >= MAX_ROWS) throw new Error('historical_inventory_count_limit')
  const body = {
    study: STUDY,
    sequence: count + 1,
    previousSha256: last?.sha256 ?? null,
    manifestSha256: sha(JSON.stringify(manifest)),
    source: point.source,
    firstLocalReceiptAtUtc: now().toISOString(),
    inventory: point.inventory,
  }
  validateRecord(body, last, manifest)
  const record = { ...body, sha256: sha(JSON.stringify(body)) }
  const bytes = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(bytes) > 16 * 1024) throw new Error('historical_inventory_row_too_large')
  let ancestor = out
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const space = stat(ancestor)
  if (Number(space.bavail) * Number(space.bsize) - Buffer.byteLength(bytes) < MIN_FREE_BYTES)
    throw new Error('historical_inventory_disk_reserve')
  mkdirSync(out, { recursive: true })
  const target = join(out, file(record.sequence))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    publish(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return record
}

export function nextHistoricalBlock(finalizedNumber, last) {
  if (last) return BigInt(last.source.block) - STEP_BLOCKS
  if (finalizedNumber < 1n) throw new Error('historical_inventory_invalid_finalized')
  return finalizedNumber
}
