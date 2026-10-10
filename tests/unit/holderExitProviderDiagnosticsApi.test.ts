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
  expect(console.error).toHaveBeenCalledWith(label, expect.objectContaining({
    stage: 'provider_configuration', errorClass: 'Error',
    identifier: 'historical_depth_quote_provider_policy_binding_missing',
  }))
  expect(createPublicClient).not.toHaveBeenCalled()
  expect(readHolderExitAssessment).not.toHaveBeenCalled()
})
it('logs fixed exception class without module error text or private values', async () => {
  state.configurationFailure = TypeError('configuredProviders PRIVATE_KEY https://private.example/')
  expect(await request()).toEqual(unavailable)
  expect(console.error).toHaveBeenCalledTimes(1)
  expect(console.error).toHaveBeenCalledWith(label, expect.objectContaining({
    stage: 'provider_configuration', errorClass: 'TypeError', identifier: null,
  }))
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
  for (const call of vi.mocked(console.error).mock.calls) expect(call).toEqual([
    label, expect.objectContaining({ stage: 'holder_read', errorClass: 'Error', identifier }),
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
  for (const call of vi.mocked(console.error).mock.calls) expect(call).toEqual([
    label, expect.objectContaining({ stage: 'holder_read', errorClass: 'other_error', identifier: null }),
  ])
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE')
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('https:')
})
it('labels post-reader failures as holder evidence without changing the catch response', async () => {
  vi.mocked(readHolderExitAssessment).mockResolvedValue({} as never)
  vi.mocked(isCurrentHolderExitAssessment).mockImplementation(() => { throw Error('morpho_block_hash_changed') })
  expect(await request()).toEqual(unavailable)
  expect(console.error).toHaveBeenCalledTimes(2)
  for (const call of vi.mocked(console.error).mock.calls) expect(call).toEqual([
    label, expect.objectContaining({ stage: 'holder_evidence', errorClass: 'Error', identifier: 'morpho_block_hash_changed' }),
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
