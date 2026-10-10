import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyVaultFlowError } from './curve-vault-flow-error-class.mjs'

test('classifies nested HTTP 429 without repeating request details', () => {
  const secret = 'https://alice:top-secret@archive.example/credential?api_key=private'
  const response = Object.assign(new Error(`Request to ${secret} failed`), {
    response: { status: 429 },
    request: { url: secret, body: 'private-body' },
  })
  const viem = new Error(`HTTP request failed. URL: ${secret}`, { cause: response })
  const label = classifyVaultFlowError(viem)
  assert.equal(label, 'rate_limited')
  assert.equal(label.includes('secret'), false)
  assert.equal(label.includes('archive.example'), false)
})

test('classifies structured statusCode 429 through a bounded cause chain', () => {
  const inner = Object.assign(new Error('provider URL with key'), { statusCode: '429' })
  const outer = new Error('viem wrapper', {
    cause: new Error('transport wrapper', { cause: inner }),
  })
  assert.equal(classifyVaultFlowError(outer), 'rate_limited')
})

test('classifies transport failures and timeouts from structured codes and names', () => {
  assert.equal(
    classifyVaultFlowError(
      new Error('private rpc url', {
        cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      }),
    ),
    'transport_or_timeout',
  )
  assert.equal(
    classifyVaultFlowError(Object.assign(new Error('request timed out'), { name: 'TimeoutError' })),
    'transport_or_timeout',
  )
  assert.equal(
    classifyVaultFlowError(new TypeError('fetch failed', { cause: new Error('private URL') })),
    'transport_or_timeout',
  )
})

test('classifies exact local configuration, block, receipt and reserve invariants', () => {
  assert.equal(
    classifyVaultFlowError(new Error('Exactly one RPC URL required')),
    'configured_rpc_missing',
  )
  assert.equal(
    classifyVaultFlowError(new Error('Quote block is not finalized on flow RPC')),
    'block_identity_or_finality',
  )
  assert.equal(
    classifyVaultFlowError(new Error('Near-live boundary witness mismatch')),
    'receipt_or_plan_invariant',
  )
  assert.equal(classifyVaultFlowError(new Error('Vault flow disk reserve reached')), 'disk_reserve')
})

test('unknown and URL-bearing messages never become output', () => {
  const secret = 'https://alice:top-secret@archive.example/credential?api_key=private'
  assert.equal(classifyVaultFlowError(new Error(`error 429 from ${secret}`)), 'unknown')
  assert.equal(classifyVaultFlowError(new Error(secret)), 'unknown')
  assert.equal(classifyVaultFlowError({ message: secret, code: 'arbitrary-secret' }), 'unknown')
})

test('cause cycles and hostile getters cannot print or hang', () => {
  const cyc = { message: 'unknown' }
  cyc.cause = cyc
  assert.equal(classifyVaultFlowError(cyc), 'unknown')
  const hostile = {
    get cause() {
      throw new Error('https://secret.example/')
    },
    get message() {
      throw new Error('private')
    },
  }
  assert.equal(classifyVaultFlowError(hostile), 'unknown')
  const hostilePrototype = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('https://user:secret@rpc.example')
      },
    },
  )
  assert.equal(classifyVaultFlowError(hostilePrototype), 'unknown')
})
