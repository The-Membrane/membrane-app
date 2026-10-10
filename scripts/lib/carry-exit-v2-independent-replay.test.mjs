import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES, resolveCarryExitV2Route } from './carry-exit-v2-rpc-proof.mjs'
import {
  validateIdentityPlan,
  verifyCarryExitV2IndependentReplay,
} from './carry-exit-v2-independent-replay.mjs'

const holder = '0x1111111111111111111111111111111111111111'
const blockHash = `0x${'a'.repeat(64)}`
const blockNumber = '26086000'
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addressWord = (address) => address.slice(2).padStart(64, '0')
const stableJson = (value) =>
  JSON.stringify(value, (_, entry) =>
    entry && !Array.isArray(entry) && typeof entry === 'object'
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  )

function envelope(target, data, result, id) {
  return {
    provider: 'synthetic',
    source: 'synthetic',
    callTarget: target,
    request: {
      jsonrpc: '2.0',
      id,
      method: 'eth_call',
      params: [
        { from: holder, to: target, data },
        { blockHash, requireCanonical: true },
      ],
    },
    response: { jsonrpc: '2.0', id, result },
  }
}

function fixture(kind = 'usd3', status = 'success') {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((candidate) => candidate.kind === kind)
  assert.ok(route)
  const { routeKey, destination, asset } = route
  const isVault = ['morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho'].includes(kind)
  const isPool = ['aave', 'spark'].includes(kind)
  const q = 100n
  const balance = 120n
  const required = kind === 'morpho' ? 110n : 80n
  const holderCoverageRpc = envelope(
    route.holderCoverageTarget,
    `0x70a08231${addressWord(holder)}`,
    `0x${word(balance)}`,
    1,
  )
  holderCoverageRpc.decodedRaw = balance.toString()
  const requiredCoverageRpc = isVault
    ? envelope(
        route.requiredCoverageTarget,
        `${kind === 'morpho' ? '0x4cdad506' : '0x0a28a477'}${word(kind === 'morpho' ? balance : q)}`,
        `0x${word(required)}`,
        2,
      )
    : null
  if (requiredCoverageRpc) requiredCoverageRpc.decodedRaw = required.toString()
  const withdrawData = isVault
    ? `0xb460af94${word(q)}${addressWord(holder)}${addressWord(holder)}`
    : isPool
      ? `0x69328dec${addressWord(asset)}${word(q)}${addressWord(holder)}`
      : `0xf3fef3a3${addressWord(asset)}${word(q)}`
  const withdrawRpc = envelope(
    route.withdrawTarget,
    withdrawData,
    isVault ? `0x${word(70)}` : isPool ? `0x${word(q)}` : '0x',
    3,
  )
  if (status === 'evm_revert') {
    withdrawRpc.response = {
      jsonrpc: '2.0',
      id: 3,
      error: { code: 3, message: 'execution reverted: synthetic' },
    }
  }
  withdrawRpc.decodedAssetsRaw = q.toString()
  withdrawRpc.decodedConsumedRaw = status === 'success' && isVault ? '70' : null
  const proof = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    routeKey,
    destination,
    asset,
    holder,
    caller: holder,
    assetsRaw: q.toString(),
    blockNumber,
    blockHash,
    coverageKind: kind === 'morpho' ? 'morpho_shares_claim' : isVault ? 'shares' : 'assets',
    holderCoverageRaw: balance.toString(),
    requiredCoverageRaw: isVault ? required.toString() : q.toString(),
    actualConsumedRaw: status === 'success' && isVault ? '70' : null,
    simulationStatus: status,
    holderCoverageRpc,
    requiredCoverageRpc,
    withdrawRpc,
  }
  const pin = { blockHash, requireCanonical: true }
  let nextIdentityId = 10
  const checks = []
  const addCode = (stage, address, empty = false) => {
    const raw = empty ? '0x' : '0x6000'
    checks.push({
      stage,
      method: 'eth_getCode',
      address,
      request: {
        jsonrpc: '2.0',
        id: nextIdentityId++,
        method: 'eth_getCode',
        params: [address, pin],
      },
      codeBytes: empty ? 0 : 2,
      codeSha256: createHash('sha256')
        .update(Buffer.from(raw.slice(2), 'hex'))
        .digest('hex'),
    })
  }
  const addAddress = (stage, to, data, decodedAddress, method = 'eth_call') => {
    const id = nextIdentityId++
    checks.push({
      stage,
      method,
      request: {
        jsonrpc: '2.0',
        id,
        method,
        params: method === 'eth_call' ? [{ from: holder, to, data }, pin] : [to, data, pin],
      },
      response: { jsonrpc: '2.0', id, result: `0x${addressWord(decodedAddress)}` },
      decodedAddress,
    })
  }
  addCode('holder_eoa', holder, true)
  addCode('destination_code', destination)
  if (route.withdrawTarget !== destination) addCode('withdraw_target_code', route.withdrawTarget)
  addCode('asset_code', asset)
  addAddress(
    isVault ? 'vault_asset' : isPool ? 'atoken_underlying' : 'comet_base_token',
    destination,
    isVault ? '0x38d52e0f' : isPool ? '0xb16a19de' : '0xc55dae63',
    asset,
  )
  if (isPool) {
    const id = nextIdentityId++
    const reserveWords = Array.from({ length: 15 }, (_, index) =>
      index === 8 ? addressWord(destination) : word(0),
    )
    checks.push({
      stage: 'pool_reserve',
      method: 'eth_call',
      request: {
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [
          { from: holder, to: route.withdrawTarget, data: `0x35ea6a75${addressWord(asset)}` },
          pin,
        ],
      },
      response: { jsonrpc: '2.0', id, result: `0x${reserveWords.join('')}` },
      decodedAToken: destination,
    })
  }
  if (kind === 'usd3') {
    addAddress(
      'usd3_implementation',
      destination,
      '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
      route.implementation,
      'eth_getStorageAt',
    )
    addCode('usd3_implementation_code', route.implementation)
  }
  const identityEvidence = {
    schema: 'carry_exit_v2_identity_v1',
    provider: 'synthetic',
    source: 'synthetic',
    chainId: '1',
    blockNumber,
    blockHash,
    routeKey,
    destination,
    asset,
    holder,
    kind,
    checks,
  }
  return {
    proof,
    identityEvidence,
    routeKey,
    destination,
    asset,
    holder,
    assetsRaw: q.toString(),
    blockNumber,
    blockHash,
  }
}

function transport(proof, identityEvidence, changes = {}) {
  const calls = []
  const responses = [proof.holderCoverageRpc, proof.requiredCoverageRpc, proof.withdrawRpc]
    .filter(Boolean)
    .map(({ request, response }) => [JSON.stringify(request), response])
  for (const check of identityEvidence.checks) {
    responses.push([
      JSON.stringify(check.request),
      check.method === 'eth_getCode'
        ? {
            jsonrpc: '2.0',
            id: check.request.id,
            result: check.stage === 'holder_eoa' ? '0x' : '0x6000',
          }
        : check.response,
    ])
  }
  return {
    calls,
    request: async (request) => {
      calls.push(request)
      if (changes.throw) throw new Error('synthetic transport failure')
      if (request.method === 'eth_getBlockByNumber') {
        const finalized = request.params[0] === 'finalized'
        const result = {
          number: finalized
            ? (changes.headNumber ?? '0x18e1150')
            : `0x${BigInt(blockNumber).toString(16)}`,
          hash: changes.hash ?? blockHash,
          parentHash: `0x${'c'.repeat(64)}`,
          timestamp: '0x65100000',
        }
        return { jsonrpc: '2.0', id: request.id, result }
      }
      const response = responses.find(([key]) => key === JSON.stringify(request))?.[1]
      if (!response) throw new Error('unexpected call')
      if (changes.response && request.id === changes.response.id) return changes.response
      if (changes.identityCode && request.id === 11)
        return { jsonrpc: '2.0', id: request.id, result: changes.identityCode }
      return structuredClone(response)
    },
  }
}

function args(kind, status, primaryChanges, secondaryChanges) {
  const frozen = fixture(kind, status)
  const primary = transport(frozen.proof, frozen.identityEvidence, primaryChanges)
  const secondary = transport(frozen.proof, frozen.identityEvidence, secondaryChanges)
  return {
    frozen,
    primary,
    secondary,
    input: {
      ...frozen,
      primary: { url: 'https://user:secret@rpc-primary.example/v1', request: primary.request },
      secondary: { url: 'https://rpc-secondary.example/v2', request: secondary.request },
    },
  }
}

test('replays every stored call at EIP-1898 hash and verifies a successful vault proof', async () => {
  const { input, primary, secondary } = args('usd3')
  input.now = () => new Date('2026-09-29T23:00:00.000Z')
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.deepEqual(
    { status: result.status, verdict: result.verdict },
    {
      status: 'verified',
      verdict: { simulationStatus: 'success', coveredRevert: false },
    },
  )
  assert.equal(result.replayEvidenceDoc.schema, 'carry_exit_v2_independent_replay_v1')
  assert.equal(result.replayEvidenceDoc.observedAt, '2026-09-29T23:00:00.000Z')
  assert.equal(result.replayEvidenceDoc.blockHash, blockHash)
  assert.equal(result.replayEvidenceDoc.origins.primary, 'https://rpc-primary.example')
  assert.equal(result.replayEvidenceDoc.origins.secondary, 'https://rpc-secondary.example')
  assert.match(result.replayEvidenceSha256, /^[0-9a-f]{64}$/)
  assert.equal(
    result.replayEvidenceSha256,
    createHash('sha256').update(stableJson(result.replayEvidenceDoc)).digest('hex'),
  )
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes(holder), false)
  assert.deepEqual(
    result.replayEvidenceDoc.responses.primary.holderCoverageRpc,
    input.proof.holderCoverageRpc.response,
  )
  assert.deepEqual(
    result.replayEvidenceDoc.responses.secondary.withdrawRpc,
    input.proof.withdrawRpc.response,
  )
  for (const provider of [primary, secondary]) {
    const calls = provider.calls.filter((call) => call.method === 'eth_call' && call.id < 10)
    assert.equal(calls.length, 3)
    for (const call of calls)
      assert.deepEqual(call.params[1], { blockHash, requireCanonical: true })
  }
})

test('sGHO replays original GHO asset and shares-burned withdrawal on both origins', async () => {
  const { input, primary, secondary } = args('sgho')
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'verified')
  assert.equal(input.proof.asset, '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f')
  assert.equal(result.replayEvidenceDoc.decoded.actualConsumedRaw, '70')
  for (const origin of [primary, secondary]) {
    const calls = origin.calls.filter((call) => call.method === 'eth_call' && call.id < 10)
    assert.deepEqual(
      calls.map((call) => call.params[0].data.slice(0, 10)),
      ['0x70a08231', '0x0a28a477', '0xb460af94'],
    )
  }
})

test('accepts a separately replayed covered Morpho revert', async () => {
  const { input } = args('morpho', 'evm_revert')
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.deepEqual(
    { status: result.status, verdict: result.verdict },
    {
      status: 'verified',
      verdict: { simulationStatus: 'evm_revert', coveredRevert: true },
    },
  )
})

test('rejects same-host origins even with different credentials, scheme, and port', async () => {
  const { input } = args('usd3')
  input.secondary.url = 'http://other:password@RPC-PRIMARY.EXAMPLE:8545/'
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
})

test('rejects one injected transport advertised as two origins', async () => {
  const { input } = args('usd3')
  input.secondary.request = input.primary.request
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
})

test('replays only the required calls for a direct asset route', async () => {
  const { input, secondary } = args('comet')
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'verified')
  assert.equal(
    secondary.calls.filter((call) => call.method === 'eth_call' && call.id < 10).length,
    2,
  )
})

test('replays pool reserve identity and rejects a wrong aToken', async () => {
  const { input } = args('aave')
  const valid = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(valid.status, 'verified')
  input.identityEvidence.checks.find((check) => check.stage === 'pool_reserve').decodedAToken =
    holder
  assert.equal((await verifyCarryExitV2IndependentReplay(input)).status, 'unavailable')
})

test('requires collector identity evidence and rejects omitted or extra stages', async () => {
  const { input } = args('usd3')
  const missing = { ...input, identityEvidence: undefined }
  assert.equal((await verifyCarryExitV2IndependentReplay(missing)).status, 'unavailable')
  input.identityEvidence.checks.push(structuredClone(input.identityEvidence.checks[0]))
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
})

test('offline identity validation rejects wrong Aave underlying and reserve aToken results', () => {
  const { input } = args('aave')
  const route = resolveCarryExitV2Route(input.routeKey, input.destination, input.asset)
  const valid = structuredClone(input.identityEvidence)
  assert.doesNotThrow(() => validateIdentityPlan(valid, input, route))

  const wrongUnderlying = structuredClone(valid)
  const underlying = wrongUnderlying.checks.find((row) => row.stage === 'atoken_underlying')
  const wrongAddress = `0x${'f'.repeat(40)}`
  underlying.response.result = `0x${addressWord(wrongAddress)}`
  underlying.decodedAddress = wrongAddress
  assert.throws(
    () => validateIdentityPlan(wrongUnderlying, input, route),
    /identity_address_disagreement/,
  )

  const wrongReserve = structuredClone(valid)
  const reserve = wrongReserve.checks.find((row) => row.stage === 'pool_reserve')
  const reserveWords = Array.from({ length: 15 }, (_, index) =>
    index === 8 ? addressWord(wrongAddress) : word(0),
  )
  reserve.response.result = `0x${reserveWords.join('')}`
  reserve.decodedAToken = wrongAddress
  assert.throws(
    () => validateIdentityPlan(wrongReserve, input, route),
    /identity_address_disagreement/,
  )
})

test('rejects secondary identity code mismatch at the frozen block', async () => {
  const { input } = args('usd3', 'success', {}, { identityCode: '0x6001' })
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
})

test('rejects a secondary decoded amount disagreement', async () => {
  const { input } = args(
    'usd3',
    'success',
    {},
    {
      response: { jsonrpc: '2.0', id: 1, result: `0x${word(121)}` },
    },
  )
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
})

test('rejects a fabricated stored primary value despite matching primary headers', async () => {
  const { input } = args('usd3', 'success', {
    response: { jsonrpc: '2.0', id: 1, result: `0x${word(121)}` },
  })
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
})

test('rejects disagreement in withdraw success versus revert semantics', async () => {
  const { input } = args(
    'usd3',
    'success',
    {},
    {
      response: { jsonrpc: '2.0', id: 3, error: { code: 3, message: 'execution reverted' } },
    },
  )
  assert.equal((await verifyCarryExitV2IndependentReplay(input)).status, 'unavailable')
})

test('rejects stale finality, changed canonical hash, and provider failure', async () => {
  for (const changes of [{ headNumber: '0x1' }, { hash: `0x${'b'.repeat(64)}` }, { throw: true }]) {
    const { input } = args('usd3', 'success', {}, changes)
    const result = await verifyCarryExitV2IndependentReplay(input)
    assert.equal(result.status, 'unavailable')
    assert.equal('verdict' in result, false)
  }
})

test('withholds verdict and evidence when replay exceeds its 12 KiB sub-budget', async () => {
  const { input } = args(
    'morpho',
    'evm_revert',
    {},
    {
      response: {
        jsonrpc: '2.0',
        id: 3,
        error: { code: 3, message: `execution reverted: ${'x'.repeat(13 * 1024)}` },
      },
    },
  )
  const result = await verifyCarryExitV2IndependentReplay(input)
  assert.equal(result.status, 'unavailable')
  assert.equal('verdict' in result, false)
  assert.equal('replayEvidenceDoc' in result, false)
})
