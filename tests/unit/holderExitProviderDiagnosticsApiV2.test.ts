import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPublicClient, http } from 'viem'

import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { isCurrentHolderExitAssessment, readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import handler from '@/pages/api/carry/holder-exit-assessment'

const state = vi.hoisted(() => ({ configurationFailure: null as unknown }))
vi.mock('@/scripts/research/carry-depth-quote-archive.mjs', () => ({
  readProviderPolicy: () => {
    if (state.configurationFailure !== null) throw state.configurationFailure
    return { status: 'active' }
  },
  configuredProviders: () => [
    { url: 'https://one.example/PRIVATE_KEY_ONE' },
    { url: 'https://two.example/PRIVATE_KEY_TWO' },
  ],
}))
vi.mock('@/lib/carry/holderExitAssessment', async (original) => ({
  ...(await original<typeof import('@/lib/carry/holderExitAssessment')>()),
  readHolderExitAssessment: vi.fn(),
  isCurrentHolderExitAssessment: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...(await original<typeof import('viem')>()),
  createPublicClient: vi.fn(() => ({})),
  http: vi.fn((url, options) => ({ url, options })),
}))
vi.mock('@/lib/game/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '127.0.0.1',
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.configurationFailure = null
  vi.mocked(readHolderExitAssessment).mockReset().mockRejectedValue(Error('PRIVATE_KEY url owner'))
  vi.mocked(isCurrentHolderExitAssessment).mockReset().mockReturnValue(false)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

async function request() {
  let code = 0
  let body: unknown
  const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
  const response = {
    setHeader: vi.fn(),
    status(value: number) { code = value; return response },
    json(value: unknown) { body = value; return response },
  }
  await handler({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: {
    chainId: 1, routeKey: market.routeKey, destinationAddress: market.destination,
    owner: '0x' + '1'.repeat(40), assetsRaw: '1000000', horizonHours: 24,
  } } as never, response as never)
  return { code, body }
}
const unavailable = { code: 503, body: { error: 'holder_exit_assessment_unavailable' } }
const label = 'holder_exit_assessment_provider_failure'

it('logs exact configuration identifier while preserving generic 503 and zero clients', async () => {
  state.configurationFailure = Error('historical_depth_quote_provider_policy_binding_missing')
  expect(await request()).toEqual(unavailable)
  expect(console.error).toHaveBeenCalledTimes(1)
  expect(console.error).toHaveBeenCalledWith(label, {
    stage: 'provider_configuration', errorClass: 'Error',
    identifier: 'historical_depth_quote_provider_policy_binding_missing',
    httpStatus: null, causeCode: null, rpcMethod: null, attemptOrdinal: null,
  })
  expect(createPublicClient).not.toHaveBeenCalled()
  expect(readHolderExitAssessment).not.toHaveBeenCalled()
})
it('logs fixed exception class without module error text or private values', async () => {
  state.configurationFailure = TypeError('configuredProviders PRIVATE_KEY https://private.example/')
  expect(await request()).toEqual(unavailable)
  expect(console.error).toHaveBeenCalledTimes(1)
  expect(console.error).toHaveBeenCalledWith(label, {
    stage: 'provider_configuration', errorClass: 'TypeError', identifier: null,
    httpStatus: null, causeCode: null, rpcMethod: null, attemptOrdinal: null,
  })
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE_KEY')
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private.example')
})
it.each([
  'morpho_chain_mismatch', 'morpho_finalized_block_unavailable', 'morpho_block_hash_changed',
  'morpho_contract_holder_path_unavailable', 'morpho_simulation_result_invalid',
])('records fixed holder read identifier %s and preserves two independent attempts', async (identifier) => {
  vi.mocked(readHolderExitAssessment).mockRejectedValue(Error(identifier))
  expect(await request()).toEqual(unavailable)
  expect(console.error).toHaveBeenCalledTimes(2)
  for (const [index, call] of vi.mocked(console.error).mock.calls.entries()) expect(call).toEqual([
    label, { stage: 'holder_read', errorClass: 'Error', identifier,
      httpStatus: null, causeCode: null, rpcMethod: null, attemptOrdinal: index + 1 },
  ])
  expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
  expect(vi.mocked(http).mock.calls).toEqual([
    ['https://one.example/PRIVATE_KEY_ONE', { timeout: 8000, retryCount: 0 }],
    ['https://two.example/PRIVATE_KEY_TWO', { timeout: 8000, retryCount: 0 }],
  ])
})
it('requires exact identifier and closed exception name, never a matching prefix', async () => {
  const failure = Error('morpho_block_hash_changed PRIVATE_KEY https://private.example/')
  failure.name = 'PRIVATE_NAME https://private.example/'
  vi.mocked(readHolderExitAssessment).mockRejectedValue(failure)
  expect(await request()).toEqual(unavailable)
  for (const [index, call] of vi.mocked(console.error).mock.calls.entries()) expect(call).toEqual([
    label, { stage: 'holder_read', errorClass: 'other_error', identifier: null,
      httpStatus: null, causeCode: null, rpcMethod: null, attemptOrdinal: index + 1 },
  ])
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE')
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('https:')
})
it('labels post-reader failures as holder evidence without changing the catch response', async () => {
  vi.mocked(readHolderExitAssessment).mockResolvedValue({} as never)
  vi.mocked(isCurrentHolderExitAssessment).mockImplementation(() => { throw Error('morpho_block_hash_changed') })
  expect(await request()).toEqual(unavailable)
  expect(console.error).toHaveBeenCalledTimes(2)
  for (const [index, call] of vi.mocked(console.error).mock.calls.entries()) expect(call).toEqual([
    label, { stage: 'holder_evidence', errorClass: 'Error', identifier: 'morpho_block_hash_changed',
      httpStatus: null, causeCode: null, rpcMethod: null, attemptOrdinal: index + 1 },
  ])
})
it('exception getters cannot change the original unavailable response', async () => {
  state.configurationFailure = Object.defineProperty({}, 'name', { get() { throw Error('PRIVATE_GETTER') } })
  expect(await request()).toEqual(unavailable)
  expect(createPublicClient).not.toHaveBeenCalled()
})
it('logger exceptions cannot change the original catch or provider loop', async () => {
  vi.mocked(console.error).mockImplementation(() => { throw Error('PRIVATE_LOGGER_FAILURE') })
  expect(await request()).toEqual(unavailable)
  expect(readHolderExitAssessment).toHaveBeenCalledTimes(2)
})

function httpFailure(method = 'eth_call') {
  return Object.assign(Error('PRIVATE_URL https://private.example/PRIVATE_KEY'), {
    name: 'HttpRequestError', status: 502, code: 'ECONNRESET',
    body: { method, params: [{ to: 'PRIVATE_ADDRESS', data: 'PRIVATE_CALLDATA' }] },
  })
}
function expectReadLogs(fields: {
  httpStatus: number | null; causeCode: string | null; rpcMethod: string | null;
  errorClass?: string;
}) {
  expect(console.error).toHaveBeenCalledTimes(2)
  for (const [index, call] of vi.mocked(console.error).mock.calls.entries()) expect(call).toEqual([
    label, { stage: 'holder_read', errorClass: fields.errorClass ?? 'HttpRequestError', identifier: null,
      httpStatus: fields.httpStatus, causeCode: fields.causeCode, rpcMethod: fields.rpcMethod,
      attemptOrdinal: index + 1 },
  ])
  const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
  expect(logged).not.toContain('PRIVATE')
  expect(logged).not.toContain('https:')
  expect(logged).not.toContain('params')
}
it.each(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'])(
  'reports fixed RPC method %s without request params or provider URL', async (method) => {
    vi.mocked(readHolderExitAssessment).mockRejectedValue(httpFailure(method))
    expect(await request()).toEqual(unavailable)
    expectReadLogs({ httpStatus: 502, causeCode: 'ECONNRESET', rpcMethod: method })
  },
)
it('reads safe status/code/method through bounded wrapped causes', async () => {
  const failure = Object.assign(Error('PRIVATE_WRAPPER'), { cause: httpFailure('eth_getCode') })
  vi.mocked(readHolderExitAssessment).mockRejectedValue(failure)
  expect(await request()).toEqual(unavailable)
  expectReadLogs({ errorClass: 'Error', httpStatus: 502, causeCode: 'ECONNRESET', rpcMethod: 'eth_getCode' })
})
it.each([99, 600, 429.5, '429', Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects unsafe HTTP status %s and unlisted cause code/method', async (status) => {
    const failure = Object.assign(httpFailure('PRIVATE_METHOD eth_call'), { status, code: 'PRIVATE_CODE ECONNRESET' })
    vi.mocked(readHolderExitAssessment).mockRejectedValue(failure)
    expect(await request()).toEqual(unavailable)
    expectReadLogs({ httpStatus: null, causeCode: null, rpcMethod: null })
  },
)
it('does not inspect fifth cause node', async () => {
  const statusGetter = vi.fn(() => 502)
  let failure: unknown = Object.defineProperty(httpFailure(), 'status', { get: statusGetter })
  for (let i = 0; i < 4; i += 1) failure = Object.assign(Error('PRIVATE_WRAPPER'), { cause: failure })
  vi.mocked(readHolderExitAssessment).mockRejectedValue(failure)
  expect(await request()).toEqual(unavailable)
  expectReadLogs({ errorClass: 'Error', httpStatus: null, causeCode: null, rpcMethod: null })
  expect(statusGetter).not.toHaveBeenCalled()
})
it.each(['status', 'code', 'body'] as const)(
  'malicious %s getter cannot change catch or leak error text', async (key) => {
    const getter = vi.fn(() => { throw Error('PRIVATE_GETTER_FAILURE https://private.example/') })
    const failure = Object.defineProperty(httpFailure(), key, { get: getter })
    vi.mocked(readHolderExitAssessment).mockRejectedValue(failure)
    expect(await request()).toEqual(unavailable)
    expectReadLogs({ httpStatus: key === 'status' ? null : 502,
      causeCode: key === 'code' ? null : 'ECONNRESET', rpcMethod: key === 'body' ? null : 'eth_call' })
    expect(getter).toHaveBeenCalledTimes(2)
  },
)
it('malicious method getter is isolated and params getter is never inspected', async () => {
  const methodGetter = vi.fn(() => { throw Error('PRIVATE_METHOD_GETTER') })
  const paramsGetter = vi.fn(() => { throw Error('PRIVATE_PARAMS_GETTER') })
  const body = Object.defineProperties({}, { method: { get: methodGetter }, params: { get: paramsGetter } })
  vi.mocked(readHolderExitAssessment).mockRejectedValue(Object.assign(httpFailure(), { body }))
  expect(await request()).toEqual(unavailable)
  expectReadLogs({ httpStatus: 502, causeCode: 'ECONNRESET', rpcMethod: null })
  expect(methodGetter).toHaveBeenCalledTimes(2)
  expect(paramsGetter).not.toHaveBeenCalled()
})
it('only HttpRequestError body may identify RPC method', async () => {
  vi.mocked(readHolderExitAssessment).mockRejectedValue(Object.assign(httpFailure(), { name: 'Error' }))
  expect(await request()).toEqual(unavailable)
  expectReadLogs({ errorClass: 'Error', httpStatus: 502, causeCode: 'ECONNRESET', rpcMethod: null })
})
