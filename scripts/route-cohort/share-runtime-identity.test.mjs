import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionResult, parseAbiItem } from 'viem'
import { UNDERLYING } from './share-current-holder-certificate.mjs'
import { TOKENS } from './share-transfer-source.mjs'
import { capture, main, seal, verify, verifyRecord } from './share-runtime-identity.mjs'

const BLOCK = 26074729
const HASH = `0x${'1'.repeat(64)}`
const PARENT = `0x${'2'.repeat(64)}`
const HOSTS = ['mainnet.infura.io', 'rpc.ankr.com']
const SLOT_ZERO = `0x${'0'.repeat(64)}`
const abi = {
  asset: parseAbiItem('function asset() view returns (address)'),
  totalSupply: parseAbiItem('function totalSupply() view returns (uint256)'),
}
const root = () => mkdtempSync(join(tmpdir(), 'share-identity-test-'))
const space = () => ({ bavail: 2_000_000_000, bsize: 1 })
const lowSpace = () => ({ bavail: 10, bsize: 1 })
const opts = { token: 'sGHO', block: BLOCK, blockHash: HASH, hosts: HOSTS }

function mock({
  slot = SLOT_ZERO,
  code = '0x6001',
  hash = HASH,
  parentHash = PARENT,
  asset = UNDERLYING.sGHO,
  supply = 100n,
  error,
} = {}) {
  return async (method, params) => {
    if (error) throw new Error(`https://secret-rpc.invalid/key/sensitive ${error}`)
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized')
        return { number: `0x${(BLOCK + 100).toString(16)}`, hash: HASH }
      return { number: `0x${BLOCK.toString(16)}`, hash, parentHash, timestamp: '0x6a11e000' }
    }
    if (method === 'eth_getCode') {
      assert.deepEqual(params[1], { blockHash: HASH, requireCanonical: true })
      return code
    }
    if (method === 'eth_getStorageAt') return slot
    if (method === 'eth_call') {
      assert.deepEqual(params[1], { blockHash: HASH, requireCanonical: true })
      const selector = params[0].data.slice(0, 10)
      if (selector === '0x38d52e0f')
        return encodeFunctionResult({ abi: [abi.asset], functionName: 'asset', result: asset })
      return encodeFunctionResult({
        abi: [abi.totalSupply],
        functionName: 'totalSupply',
        result: supply,
      })
    }
    throw new Error(`unexpected ${method}`)
  }
}

test('two exact-block hosts, zero slot remains unknown dispatch; seal and offline replay', async () => {
  const record = await capture({ ...opts, rpcRead: mock(), peerRpcRead: mock() })
  assert.equal(record.primary.dispatch, 'unknown_zero_eip1967_slot')
  assert.equal(record.primary.implementationCode, null)
  assert.equal(record.primary.asset, UNDERLYING.sGHO)
  assert.equal(record.config.vault, TOKENS.sGHO)
  assert.equal(record.calls, 16)
  const out = join(root(), 'receipt')
  seal(out, record, space)
  assert.equal(verify(out).block, BLOCK)
  assert.equal(verifyRecord(record).dispatch, 'unknown_zero_eip1967_slot')
})

test('nonzero slot reads and stores implementation runtime on both hosts', async () => {
  const slot = `0x${'0'.repeat(24)}${'a'.repeat(40)}`
  const record = await capture({ ...opts, rpcRead: mock({ slot }), peerRpcRead: mock({ slot }) })
  assert.equal(record.calls, 18)
  assert.equal(record.primary.implementationCode, '0x6001')
  assert.equal(record.primary.implementation, `0x${'a'.repeat(40)}`)
  assert.equal(record.primary.dispatch, 'eip1967_slot_nonzero_unattested')
})

test('sUSDe uses its own vault and underlying at the same exact block', async () => {
  const config = { ...opts, token: 'sUSDe' }
  const reader = mock({ asset: UNDERLYING.sUSDe })
  const record = await capture({ ...config, rpcRead: reader, peerRpcRead: reader })
  assert.equal(record.config.vault, TOKENS.sUSDe)
  assert.equal(record.primary.asset, UNDERLYING.sUSDe)
  assert.equal(verifyRecord(record).token, 'sUSDe')
})

test('host code, header ancestry, reorg and asset disagreement fail', async () => {
  await assert.rejects(
    capture({ ...opts, rpcRead: mock(), peerRpcRead: mock({ code: '0x6002' }) }),
    /host_identity_disagreement/,
  )
  await assert.rejects(
    capture({ ...opts, rpcRead: mock(), peerRpcRead: mock({ parentHash: `0x${'3'.repeat(64)}` }) }),
    /host_header_disagreement/,
  )
  await assert.rejects(
    capture({ ...opts, rpcRead: mock({ hash: `0x${'3'.repeat(64)}` }), peerRpcRead: mock() }),
    /header_mismatch/,
  )
  await assert.rejects(
    capture({ ...opts, rpcRead: mock({ asset: UNDERLYING.sUSDe }), peerRpcRead: mock() }),
    /asset_mismatch/,
  )
  let headerReads = 0
  const reorg = async (method, params) => {
    const result = await mock()(method, params)
    if (method === 'eth_getBlockByNumber' && params[0] !== 'finalized') {
      headerReads++
      if (headerReads === 2) return { ...result, parentHash: `0x${'4'.repeat(64)}` }
    }
    return result
  }
  await assert.rejects(capture({ ...opts, rpcRead: reorg, peerRpcRead: mock() }), /header_changed/)
})

test('tampered receipt fails physical seal or semantic replay', async () => {
  const record = await capture({ ...opts, rpcRead: mock(), peerRpcRead: mock() })
  const out = join(root(), 'receipt')
  const artifact = seal(out, record, space)
  const path = join(out, artifact.name)
  writeFileSync(path, readFileSync(path, 'utf8').replace('0x6001', '0x6002'))
  assert.throws(() => verify(out), /receipt_hash_mismatch/)
  const changed = structuredClone(record)
  changed.primary.vaultCode = '0x6002'
  assert.throws(() => verifyRecord(changed), /identity_replay_mismatch/)
})

test('1 GiB guard and duplicate target reject before writing or RPC', async () => {
  const record = await capture({ ...opts, rpcRead: mock(), peerRpcRead: mock() })
  const out = join(root(), 'receipt')
  assert.throws(() => seal(out, record, lowSpace), /disk_reserve_reached/)
  seal(out, record, space)
  assert.throws(() => seal(out, record, space), /output_exists/)
  let calls = 0
  await assert.rejects(
    main(
      [
        '--run',
        '--out',
        out,
        '--token',
        'sGHO',
        '--block',
        String(BLOCK),
        '--hash',
        HASH,
        '--rpc-hosts',
        HOSTS.join(','),
      ],
      {
        stat: space,
        rpcRead: async () => {
          calls++
          return '0x1'
        },
        peerRpcRead: mock(),
      },
    ),
    /output_exists/,
  )
  assert.equal(calls, 0)
})

test('failed hardlink removes only its own empty new reservation', async () => {
  const record = await capture({ ...opts, rpcRead: mock(), peerRpcRead: mock() })
  const out = join(root(), 'receipt')
  assert.throws(
    () =>
      seal(out, record, space, () => {
        throw new Error('injected link failure')
      }),
    /share_identity_seal_failed/,
  )
  assert.equal(existsSync(out), false)
  seal(out, record, space)
  assert.equal(verify(out).block, BLOCK)
})

test('provider secrets are never emitted in diagnostics', async () => {
  await assert.rejects(
    capture({ ...opts, rpcRead: mock({ error: 'private-key' }), peerRpcRead: mock() }),
    (error) => {
      assert.equal(error.message, 'share_identity_rpc_primary_chain_failed')
      assert.doesNotMatch(error.message, /secret|private-key|https/)
      return true
    },
  )
})

test('dry mode needs no network and verify mode needs no RPC or env', async () => {
  const out = join(root(), 'receipt')
  const argv = [
    '--out',
    out,
    '--token',
    'sGHO',
    '--block',
    String(BLOCK),
    '--hash',
    HASH,
    '--rpc-hosts',
    HOSTS.join(','),
  ]
  const dry = await main(argv, { stat: space })
  assert.equal(dry.dryRun, true)
  await main([...argv, '--run'], { stat: space, rpcRead: mock(), peerRpcRead: mock() })
  assert.equal((await main(['--verify', '--out', out])).block, BLOCK)
  await assert.rejects(main(['--verify', '--out', out, '--token', 'sUSDe']), /cli_invalid/)
})
