import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256 } from 'viem'
import { UNDERLYING } from './share-current-holder-certificate.mjs'
import { TOKENS } from './share-transfer-source.mjs'
import {
  ATTESTATION,
  main,
  MAX_RESPONSE_BYTES,
  sourceUrl,
  verify,
} from './verified-runtime-source.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const ADDRESS = {
  sGHO: '0xff229a0bbb614a284de8ae0e41e5974878fd7c04',
  sGHOProxy: TOKENS.sGHO,
  sUSDe: TOKENS.sUSDe,
}
const CODE = '0x6001600055'
const PROXY_IMPLEMENTATION_CODE = '0x6002600055'
const ZERO = `0x${'0'.repeat(64)}`

function fixture(token) {
  const dir = mkdtempSync(join(tmpdir(), 'verified-source-test-'))
  const address = ADDRESS[token]
  const receiptToken = token === 'sGHOProxy' ? 'sGHO' : token
  const hasImplementation = receiptToken === 'sGHO'
  const implementation = hasImplementation ? ADDRESS.sGHO : `0x${'0'.repeat(40)}`
  const slot = hasImplementation ? `0x${'0'.repeat(24)}${implementation.slice(2)}` : ZERO
  const implementationCode =
    token === 'sGHOProxy' ? PROXY_IMPLEMENTATION_CODE : hasImplementation ? CODE : null
  const identity = {
    finalizedHead: 100,
    header: {
      number: 100,
      hash: `0x${'a'.repeat(64)}`,
      parentHash: `0x${'b'.repeat(64)}`,
      timestamp: 1_800_000_000,
    },
    vaultCode: CODE,
    vaultCodeKeccak256: keccak256(CODE),
    implementationSlotRaw: slot,
    implementation,
    implementationCode,
    implementationCodeKeccak256: implementationCode ? keccak256(implementationCode) : null,
    dispatch: hasImplementation ? 'eip1967_slot_nonzero_unattested' : 'unknown_zero_eip1967_slot',
    asset: UNDERLYING[receiptToken],
    totalSupplyRaw: '10',
  }
  const receipt = {
    schema: 1,
    kind: 'share_runtime_identity_only',
    config: {
      chainId: 1,
      token: receiptToken,
      vault: TOKENS[receiptToken],
      block: 100,
      blockHash: identity.header.hash,
      hosts: ['mainnet.infura.io', 'rpc.ankr.com'],
    },
    capturedAt: '2026-09-28T00:00:00.000Z',
    calls: 18,
    agreement: 'two_hosts_same_exact_block_and_identity',
    primary: identity,
    peer: { ...identity },
  }
  const bytes = Buffer.from(JSON.stringify(receipt))
  const identityPath = join(dir, `identity-${sha(bytes)}.json`)
  writeFileSync(identityPath, bytes)
  const out = join(dir, 'source')
  const url = sourceUrl(address)
  const response = {
    chainId: '1',
    address,
    runtimeMatch: 'match',
    runtimeBytecode: { onchainBytecode: CODE },
    sources: { 'contracts/Token.sol': { content: 'contract Token {}' } },
    compilation: { fullyQualifiedName: 'contracts/Token.sol:Token' },
  }
  const args = [
    '--run',
    '--token',
    token,
    '--address',
    address,
    '--url',
    url,
    '--identity',
    identityPath,
    '--out',
    out,
  ]
  return { dir, out, args, identityPath, response, url, address }
}

function fetchResponse(value, { status = 200, url } = {}) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  return {
    ok: status === 200,
    status,
    url,
    headers: { get: () => String(bytes.length) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

for (const token of ['sGHO', 'sGHOProxy', 'sUSDe']) {
  test(`${token}: seal and replay raw verified source without network`, async (t) => {
    const f = fixture(token)
    t.after(() => rmSync(f.dir, { recursive: true, force: true }))
    let calls = 0
    const result = await main(f.args, {
      fetch: async (url, opts) => {
        calls++
        assert.equal(url, f.url)
        assert.equal(opts.redirect, 'error')
        return fetchResponse(f.response, { url })
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.block, 100)
    assert.equal(result.runtimeMatch, 'match')
    assert.equal(result.attestation, ATTESTATION)
    assert.equal(readdirSync(f.out).length, 1)
    assert.equal(verify(f.out, f.identityPath).sha256, result.sha256)
    const saved = JSON.parse(readFileSync(join(f.out, result.name)))
    assert.equal(
      JSON.parse(saved.responseRaw).sources['contracts/Token.sol'].content,
      'contract Token {}',
    )
    assert.equal(saved.identitySha256, sha(readFileSync(f.identityPath)))
    assert.equal(saved.attestation, ATTESTATION)
  })
}

test('wrong runtime bytes fail closed before output', async (t) => {
  const f = fixture('sGHO')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  f.response.runtimeBytecode.onchainBytecode = '0x6002'
  await assert.rejects(
    main(f.args, { fetch: async () => fetchResponse(f.response) }),
    /runtime_mismatch/,
  )
  assert.equal(
    readdirSync(f.dir).some((name) => name === 'source'),
    false,
  )
})

test('sGHO proxy rejects implementation bytes when vault runtime differs', async (t) => {
  const f = fixture('sGHOProxy')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  f.response.runtimeBytecode.onchainBytecode = PROXY_IMPLEMENTATION_CODE
  await assert.rejects(
    main(f.args, { fetch: async () => fetchResponse(f.response) }),
    /runtime_mismatch/,
  )
  assert.equal(readdirSync(f.dir).includes('source'), false)
})

test('missing runtime match, chain, source, or address fails closed', async (t) => {
  const f = fixture('sUSDe')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  for (const change of [
    { runtimeMatch: 'none' },
    { chainId: '10' },
    { address: TOKENS.sGHO },
    { sources: {} },
  ]) {
    await assert.rejects(
      main(f.args, { fetch: async () => fetchResponse({ ...f.response, ...change }) }),
    )
  }
})

test('HTTP failure, wrong URL, absent receipt, and output collision fail', async (t) => {
  const f = fixture('sGHO')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  await assert.rejects(
    main(f.args, { fetch: async () => fetchResponse('{}', { status: 404 }) }),
    /http_failed/,
  )
  await assert.rejects(
    main(
      f.args.map((value) => (value === f.url ? 'https://example.com/' : value)),
      {
        fetch: async () => {
          throw new Error('must not call')
        },
      },
    ),
    /url_invalid/,
  )
  await assert.rejects(
    main(
      f.args.map((value) => (value === f.identityPath ? join(f.dir, 'absent.json') : value)),
      {
        fetch: async () => {
          throw new Error('must not call')
        },
      },
    ),
  )
  await main(f.args, { fetch: async () => fetchResponse(f.response) })
  await assert.rejects(
    main(f.args, {
      fetch: async () => {
        throw new Error('must not call')
      },
    }),
    /output_exists/,
  )
})

test('declared oversized response and physical identity tampering fail', async (t) => {
  const f = fixture('sGHO')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const big = fetchResponse(f.response)
  big.headers.get = () => String(MAX_RESPONSE_BYTES + 1)
  await assert.rejects(main(f.args, { fetch: async () => big }), /response_size_cap/)
  await main(f.args, { fetch: async () => fetchResponse(f.response) })
  writeFileSync(f.identityPath, '{}')
  assert.throws(() => verify(f.out, f.identityPath), /identity_hash_mismatch/)
})

test('streamed oversized response fails without an artifact', async (t) => {
  const f = fixture('sGHO')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const tooLarge = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 32)
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(tooLarge)
        controller.close()
      },
    }),
  }
  await assert.rejects(main(f.args, { fetch: async () => response }), /response_size_cap/)
  assert.equal(readdirSync(f.dir).includes('source'), false)
})

test('verification rejects mutated source seal', async (t) => {
  const f = fixture('sGHO')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  const result = await main(f.args, { fetch: async () => fetchResponse(f.response) })
  writeFileSync(join(f.out, result.name), '{}')
  assert.throws(() => verify(f.out, f.identityPath), /receipt_hash_mismatch/)
})

test('matching bytes with arbitrary source remain only a limited Sourcify response attestation', async (t) => {
  const f = fixture('sGHO')
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))
  f.response.sources['contracts/Token.sol'].content = 'this is not compilable Solidity'
  const result = await main(f.args, { fetch: async () => fetchResponse(f.response) })
  assert.equal(result.attestation, ATTESTATION)
  const path = join(f.out, result.name)
  const record = JSON.parse(readFileSync(path))
  assert.equal(record.attestation, ATTESTATION)
  record.attestation = 'independently_compiled'
  const forged = Buffer.from(JSON.stringify(record))
  unlinkSync(path)
  writeFileSync(join(f.out, `source-${sha(forged)}.json`), forged)
  assert.throws(() => verify(f.out, f.identityPath), /receipt_invalid/)
})
