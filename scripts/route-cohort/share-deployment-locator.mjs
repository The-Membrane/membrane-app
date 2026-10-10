// Read-only diagnostic for the first code-present block of the known share tokens.
// This locates a code boundary; it does not attest deployed source or share accounting.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { TOKENS, selectRpcUrls } from './share-transfer-source.mjs'

export const MAX_RPC_CALLS = 128
export const DEFAULT_PACE_MS = 250
const HASH = /^0x[0-9a-f]{64}$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const fail = (reason) => {
  throw new Error(`share_deployment_${reason}`)
}
const number = (value) => {
  try {
    const n = Number(BigInt(value))
    if (Number.isSafeInteger(n) && n >= 0) return n
  } catch {
    // The caller sees only a non-sensitive diagnostic code.
  }
  fail('integer_invalid')
}
const hex = (value) => `0x${value.toString(16)}`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// Inspect provider errors only to choose a fixed diagnostic code. Never copy
// their message, details, URL, response body or cause into an emitted error.
function rpcFailureKind(error, stage) {
  let current = error
  let fallback = 'failure'
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    let message
    let status
    let code
    let name
    let cause
    let transportType
    try {
      message = [current.message, current.shortMessage, current.details]
        .filter((part) => typeof part === 'string')
        .join(' ')
        .toLowerCase()
      status = current.status
      code = current.code
      name = current.name
      cause = current.cause
      transportType = current instanceof TypeError
    } catch {
      return fallback
    }
    if (stage === 'code') {
      if (
        /missing trie node|historical state (?:is )?(?:unavailable|not available)|state (?:is )?(?:pruned|unavailable|not available)|archive (?:node|data) (?:is )?(?:required|unavailable)/.test(
          message,
        )
      )
        return 'historical_state_unavailable'
      if (
        /(?:blockhash|block hash).{0,80}(?:unsupported|not supported|invalid)|(?:unsupported|not supported|invalid).{0,80}(?:blockhash|block hash)|cannot unmarshal object.{0,80}block/.test(
          message,
        )
      )
        return 'block_reference_unsupported'
    }
    if (status === 429 || code === -32005) fallback = 'rate_limited'
    if (
      transportType ||
      /^(?:HttpRequestError|TimeoutError|NetworkError|SocketError)$/.test(name) ||
      /^(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)$/.test(
        code,
      )
    )
      if (fallback === 'failure') fallback = 'transport_failure'
    current = cause
  }
  return fallback
}

function header(raw, expected) {
  const result = {
    number: number(raw?.number),
    hash: String(raw?.hash).toLowerCase(),
    parentHash: String(raw?.parentHash).toLowerCase(),
  }
  if (
    (expected !== undefined && result.number !== expected) ||
    !HASH.test(result.hash) ||
    !HASH.test(result.parentHash)
  )
    fail('header_invalid')
  return result
}

function checkedHeader(raw, side, stage, expected) {
  try {
    return header(raw, expected)
  } catch {
    fail(`response_${side}_${stage}_invalid`)
  }
}

function checkedChain(raw, side) {
  try {
    return number(raw)
  } catch {
    fail(`response_${side}_chain_invalid`)
  }
}

function checkedCode(raw, side) {
  if (typeof raw !== 'string' || !CODE.test(raw.toLowerCase()))
    fail(`response_${side}_code_invalid`)
  return raw.toLowerCase()
}

export async function locate({ token, rpcRead, peerRpcRead, paceMs = 0 }) {
  if (
    !Object.hasOwn(TOKENS, token) ||
    typeof rpcRead !== 'function' ||
    typeof peerRpcRead !== 'function' ||
    !Number.isInteger(paceMs) ||
    paceMs < 0 ||
    paceMs > 5_000
  )
    fail('config_invalid')
  const address = TOKENS[token]
  let calls = 0
  const read = async (reader, side, stage, method, params) => {
    if (++calls > MAX_RPC_CALLS) fail('request_budget_exceeded')
    if (paceMs > 0 && calls > 1) await sleep(paceMs)
    try {
      return await reader(method, params)
    } catch (error) {
      fail(`rpc_${side}_${stage}_${rpcFailureKind(error, stage)}`)
    }
  }
  if (checkedChain(await read(rpcRead, 'primary', 'chain', 'eth_chainId', []), 'primary') !== 1)
    fail('response_primary_chain_wrong_network')
  if (checkedChain(await read(peerRpcRead, 'peer', 'chain', 'eth_chainId', []), 'peer') !== 1)
    fail('response_peer_chain_wrong_network')
  const head = checkedHeader(
    await read(rpcRead, 'primary', 'head', 'eth_getBlockByNumber', ['finalized', false]),
    'primary',
    'head',
  )
  const peerHead = checkedHeader(
    await read(peerRpcRead, 'peer', 'head', 'eth_getBlockByNumber', ['finalized', false]),
    'peer',
    'head',
  )
  const common = Math.min(head.number, peerHead.number)
  if (common < 1) fail('head_invalid')
  const at = async (reader, side, block) =>
    checkedHeader(
      await read(reader, side, 'header', 'eth_getBlockByNumber', [hex(block), false]),
      side,
      'header',
      block,
    )
  const commonHeader = await at(rpcRead, 'primary', common)
  if ((await at(peerRpcRead, 'peer', common)).hash !== commonHeader.hash) fail('head_mismatch')

  const probe = async (block) => {
    const primary = await at(rpcRead, 'primary', block)
    const peer = await at(peerRpcRead, 'peer', block)
    if (primary.hash !== peer.hash || primary.parentHash !== peer.parentHash)
      fail('header_mismatch')
    const pin = { blockHash: primary.hash, requireCanonical: true }
    const code = checkedCode(
      await read(rpcRead, 'primary', 'code', 'eth_getCode', [address, pin]),
      'primary',
    )
    const peerCode = checkedCode(
      await read(peerRpcRead, 'peer', 'code', 'eth_getCode', [address, pin]),
      'peer',
    )
    if (code !== peerCode) fail('code_mismatch')
    return { block, header: primary, hasCode: code !== '0x' }
  }

  let lower = await probe(0)
  let upper = await probe(common)
  if (lower.hasCode || !upper.hasCode) fail('boundary_missing')
  while (upper.block - lower.block > 1) {
    const middle = await probe(Math.floor((lower.block + upper.block) / 2))
    if (middle.hasCode) upper = middle
    else lower = middle
  }
  // Re-read both sides after search: the returned boundary must remain canonical.
  const prior = await probe(lower.block)
  const deployed = await probe(upper.block)
  if (
    prior.hasCode ||
    !deployed.hasCode ||
    deployed.block !== prior.block + 1 ||
    prior.header.hash !== lower.header.hash ||
    deployed.header.hash !== upper.header.hash ||
    deployed.header.parentHash !== prior.header.hash ||
    (await at(rpcRead, 'primary', common)).hash !== commonHeader.hash ||
    (await at(peerRpcRead, 'peer', common)).hash !== commonHeader.hash
  )
    fail('boundary_changed')
  return { token, deploymentBlock: deployed.block, deploymentHash: deployed.header.hash }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !['--token', '--rpc-hosts'].includes(argv[i]) ||
      options[argv[i]] !== undefined ||
      !argv[i + 1]
    )
      fail('cli_invalid')
    options[argv[i]] = argv[i + 1]
  }
  if (!Object.hasOwn(TOKENS, options['--token']) || argv.length !== Object.keys(options).length * 2)
    fail('cli_invalid')
  if (dependencies.rpcRead && dependencies.peerRpcRead)
    return locate({ token: options['--token'], ...dependencies })
  const env = dependencies.env ?? readEnv()
  const raw =
    dependencies.rpcUrls ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URLS) ??
    env.get('RECORDER_RPC_URLS') ??
    (dependencies.env ? undefined : process.env.RECORDER_RPC_URL) ??
    env.get('RECORDER_RPC_URL')
  let urls
  try {
    urls = selectRpcUrls(raw, options['--rpc-hosts'])
  } catch (error) {
    const reason = String(error?.message).replace(/^share_source_/, '')
    if (
      [
        'rpc_config_invalid',
        'rpc_host_ambiguous',
        'rpc_host_selection_invalid',
        'rpc_host_missing',
        'two_rpc_hosts_required',
      ].includes(reason)
    )
      fail(reason)
    fail('rpc_config_invalid')
  }
  const factory = dependencies.makeClient ?? makeClient
  const readers = urls.map((url) => {
    try {
      const client = factory(url)
      return (method, params) => client.request({ method, params })
    } catch {
      fail('rpc_config_invalid')
    }
  })
  return locate({
    token: options['--token'],
    rpcRead: readers[0],
    peerRpcRead: readers[1],
    paceMs: dependencies.paceMs ?? DEFAULT_PACE_MS,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${String(error.message).startsWith('share_deployment_') ? error.message : 'share_deployment_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
