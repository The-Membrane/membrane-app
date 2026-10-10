import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPOCH_BLOCKS,
  MAX_EPOCHS,
  SLICE_BLOCKS,
  tick,
  tickAfterV1,
  verifyArchive,
} from './aave-usdc-market-cash-archive-v2.mjs'
import {
  FROM_BLOCK,
  QUICKNODE_ORIGIN,
  QUICKNODE_SLICE_BLOCKS,
  TO_BLOCK,
} from './aave-usdc-market-cash-archive.mjs'
import { STUDY as COLLECTOR_STUDY } from './aave-core-operation-collector.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const h = (n) => `0x${n.toString(16).padStart(64, '0')}`
const urls =
  'https://mainnet.infura.io/v3/test,https://eth-mainnet.g.alchemy.com/v2/test,https://lb.drpc.live/test,https://rpc.ankr.com/eth/test'
const noOpVerify = () => ({ count: 1 })

function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aave-v2-')))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'v2'),
    v1Out = join(home, 'v1')
  const sidecar = `slice-${FROM_BLOCK}-${TO_BLOCK}.json`
  const body = {
    study: 'aave-usdc-market-cash-archive-v1',
    fromBlock: FROM_BLOCK,
    toBlock: TO_BLOCK,
    toHash: h(TO_BLOCK),
  }
  mkdirSync(v1Out)
  writeFileSync(
    join(v1Out, sidecar),
    `${JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) })}\n`,
  )
  const verifyV1Archive = () => ({
    complete: true,
    fromBlock: FROM_BLOCK,
    throughBlock: TO_BLOCK,
    lastHash: h(TO_BLOCK),
  })
  const clientFactory = () => ({
    request: async () => ({
      number: `0x${(TO_BLOCK + EPOCH_BLOCKS * (MAX_EPOCHS + 1)).toString(16)}`,
      hash: h(123),
    }),
  })
  let captures = 0
  const capture = async ({ client, fromBlock, toBlock, out }) => {
    captures += 1
    const origin = out.endsWith('/ankr')
      ? 'ankr'
      : out.endsWith('/alchemy')
        ? 'alchemy'
        : out.endsWith('/drpc')
          ? 'drpc'
          : 'infura'
    const row = {
      study: COLLECTOR_STUDY,
      captureId: `${origin}-${captures}`,
      market: 'USDC',
      chainId: 1,
      pool: 'pool',
      underlying: 'usdc',
      aToken: 'atoken',
      captureStartedAt: '2026-10-01T00:00:00.000Z',
      captureEndedAt: '2026-10-01T00:00:01.000Z',
      from: { blockNumber: fromBlock, blockHash: h(fromBlock), cashRaw: '100' },
      to: { blockNumber: toBlock, blockHash: h(toBlock), cashRaw: '100' },
      identities: [],
      chunks: { poolOperations: [], underlyingTransfers: [] },
      operations: [],
      transfers: [],
      reconciliation: { endpointReconciled: true },
    }
    row.sha256 = sha(JSON.stringify(row))
    const path = join(out, `USDC-${fromBlock}-${toBlock}-${h(toBlock).slice(2)}.json`)
    writeFileSync(path, JSON.stringify(row))
    return { path }
  }
  const options = {
    root,
    v1Out,
    verifyV1Archive,
    verifySourceArchive: noOpVerify,
    rpcUrls: urls,
    clientFactory,
    capture,
  }
  return { root, v1Out, sidecar, options, captures: () => captures }
}
test('V2 stays dormant until the complete V1 tip is verified', (t) => {
  const env = setup(t)
  const result = verifyArchive({ ...env.options, verifyV1Archive: () => ({ complete: false }) })
  assert.equal(result.status, 'waiting_v1')
  assert.equal(existsSync(env.root), false)
})

test('the shared runner continues V1 until its fixed archive is complete', async (t) => {
  const env = setup(t)
  let calls = 0
  const result = await tickAfterV1({
    ...env.options,
    verifyV1Archive: () => ({ complete: false }),
    runV1: async ({ rpcUrls }) => {
      calls += 1
      assert.equal(rpcUrls, urls)
      return { study: 'v1', acceptedSlices: 29 }
    },
  })
  assert.equal(result.study, 'v1')
  assert.equal(calls, 1)
  assert.equal(existsSync(env.root), false)
})

test('both finalized heads must cover the full next slice before capture', async (t) => {
  const env = setup(t)
  const clientFactory = (url) => ({
    request: async () => ({
      number: `0x${(url.includes('ankr') ? TO_BLOCK + SLICE_BLOCKS - 1 : TO_BLOCK + SLICE_BLOCKS).toString(16)}`,
      hash: h(123),
    }),
  })
  const result = await tick({ ...env.options, clientFactory })
  assert.equal(result.status, 'waiting_finality')
  assert.equal(env.captures(), 0)
  assert.equal(existsSync(env.root), false)
})

test('epoch zero binds the V1 final sidecar content and returns exact replay descriptors', async (t) => {
  const env = setup(t)
  const result = await tick(env.options)
  assert.equal(result.acceptedSlices, 1)
  assert.equal(result.slices[0].fromBlock, TO_BLOCK)
  assert.equal(result.slices[0].toBlock, TO_BLOCK + SLICE_BLOCKS)
  const genesis = JSON.parse(readFileSync(join(env.root, 'epoch-000', 'genesis.json'), 'utf8'))
  assert.equal(genesis.priorHash, h(TO_BLOCK))
  assert.equal(genesis.priorSidecarSha256, sha(readFileSync(join(env.v1Out, env.sidecar))))
  const replay = verifyArchive(env.options)
  assert.equal(replay.slices[0].sidecarSha256.length, 64)
  writeFileSync(join(env.v1Out, env.sidecar), '{}')
  assert.throws(() => verifyArchive(env.options), /archive_v2_seal_sha/)
})

test('economic mismatch never seals a joint slice', async (t) => {
  const env = setup(t)
  const original = env.options.capture
  env.options.capture = async (input) => {
    const result = await original(input)
    if (input.out.endsWith('/ankr')) {
      const row = JSON.parse(readFileSync(result.path, 'utf8'))
      row.transfers = [{ amountRaw: '1' }]
      writeFileSync(result.path, JSON.stringify(row))
    }
    return result
  }
  await assert.rejects(tick(env.options), /archive_two_origin_disagreement/)
  assert.equal(
    readdirSync(join(env.root, 'epoch-000')).filter((name) => name.startsWith('slice-')).length,
    0,
  )
})

test('DRPC captures the left source after Infura and Alchemy RPC failure, with its own witness', async (t) => {
  const env = setup(t)
  const original = env.options.capture
  env.options.capture = async (input) => {
    if (input.out.endsWith('/infura') || input.out.endsWith('/alchemy'))
      throw new Error('provider_rate_limited')
    return original(input)
  }
  const result = await tick(env.options)
  assert.equal(result.acceptedSlices, 1)
  assert.equal(result.slices[0].leftOrigin, 'drpc')
  assert.equal(result.slices[0].rightOrigin, 'ankr')
  assert.equal(env.captures(), 2)
  const dir = join(env.root, 'epoch-000')
  const witness = join(dir, `origin-drpc-${TO_BLOCK}-${TO_BLOCK + SLICE_BLOCKS}.json`)
  assert.equal(existsSync(witness), true)
  assert.equal(verifyArchive(env.options).slices[0].leftOrigin, 'drpc')
  const row = JSON.parse(readFileSync(witness, 'utf8'))
  row.originSha256 = sha('https://mainnet.infura.io')
  const { sha256: previousSha, ...body } = row
  assert.equal(previousSha.length, 64)
  row.sha256 = sha(JSON.stringify(body))
  chmodSync(witness, 0o600)
  writeFileSync(witness, JSON.stringify(row))
  assert.throws(() => verifyArchive(env.options), /archive_v2_origin_witness/)
})

test('QuickNode captures after three failures with exact replay witness', async (t) => {
  const env = setup(t)
  env.options.rpcUrls = urls.replace(
    'https://rpc.ankr.com/eth/test',
    QUICKNODE_ORIGIN + '/private-test-token,https://rpc.ankr.com/eth/test',
  )
  const original = env.options.capture
  env.options.capture = async (input) => {
    if (!input.out.endsWith('/quicknode') && !input.out.endsWith('/ankr'))
      throw new Error('provider_rate_limited')
    if (input.out.endsWith('/quicknode')) assert.equal(input.chunkBlocks, 5)
    if (input.out.endsWith('/ankr')) assert.equal(input.chunkBlocks, 5)
    return original(input)
  }
  const result = await tick(env.options)
  assert.equal(result.slices[0].leftOrigin, 'quicknode')
  assert.equal(result.slices[0].rightOrigin, 'ankr')
  assert.equal(result.slices[0].toBlock - result.slices[0].fromBlock, QUICKNODE_SLICE_BLOCKS)
  const witness = join(
    env.root,
    'epoch-000',
    'origin-quicknode-' + TO_BLOCK + '-' + (TO_BLOCK + QUICKNODE_SLICE_BLOCKS) + '.json',
  )
  assert.equal(existsSync(witness), true)
  assert.equal(verifyArchive(env.options).slices[0].leftOrigin, 'quicknode')
  const row = JSON.parse(readFileSync(witness, 'utf8'))
  row.originSha256 = sha('https://lb.drpc.live')
  const { sha256: previousSha, ...body } = row
  assert.equal(previousSha.length, 64)
  row.sha256 = sha(JSON.stringify(body))
  chmodSync(witness, 0o600)
  writeFileSync(witness, JSON.stringify(row))
  assert.throws(() => verifyArchive(env.options), /archive_v2_origin_witness/)
})

test('Alchemy and Ankr capture identical ten-block query windows', async (t) => {
  const env = setup(t)
  const original = env.options.capture
  const chunks = []
  env.options.capture = async (input) => {
    if (input.out.endsWith('/infura')) throw new Error('provider_rate_limited')
    chunks.push({ origin: input.out.split('/').at(-1), blocks: input.chunkBlocks })
    return original(input)
  }
  const result = await tick(env.options)
  assert.equal(result.slices[0].leftOrigin, 'alchemy')
  assert.deepEqual(chunks, [
    { origin: 'alchemy', blocks: 10 },
    { origin: 'ankr', blocks: 10 },
  ])
})

test('a failed DRPC attempt leaves the slice unsealed', async (t) => {
  const env = setup(t)
  env.options.capture = async () => {
    throw new Error('provider_rate_limited')
  }
  await assert.rejects(tick(env.options), /archive_v2_capture_drpc/)
  assert.equal(env.captures(), 0)
  assert.equal(
    readdirSync(join(env.root, 'epoch-000')).filter((name) => name.startsWith('slice-')).length,
    0,
  )
})

test('after QuickNode enters an epoch, recovered Infura keeps bounded contiguous slices', async (t) => {
  const env = setup(t)
  env.options.rpcUrls = urls.replace(
    'https://rpc.ankr.com/eth/test',
    QUICKNODE_ORIGIN + '/private-test-token,https://rpc.ankr.com/eth/test',
  )
  const original = env.options.capture
  env.options.capture = async (input) => {
    if (!input.out.endsWith('/quicknode') && !input.out.endsWith('/ankr'))
      throw new Error('provider_rate_limited')
    return original(input)
  }
  const first = await tick(env.options)
  assert.equal(first.slices[0].leftOrigin, 'quicknode')
  env.options.capture = original
  const second = await tick(env.options)
  assert.deepEqual(
    second.slices.map((slice) => slice.leftOrigin),
    ['quicknode', 'infura'],
  )
  assert.deepEqual(
    second.slices.map((slice) => slice.toBlock - slice.fromBlock),
    [QUICKNODE_SLICE_BLOCKS, QUICKNODE_SLICE_BLOCKS],
  )
  assert.equal(verifyArchive(env.options).throughBlock, TO_BLOCK + 2 * QUICKNODE_SLICE_BLOCKS)
})

test('a DRPC fallback preserves an earlier Infura slice and mixed-origin replay', async (t) => {
  const env = setup(t)
  const first = await tick(env.options)
  assert.equal(first.slices[0].leftOrigin, 'infura')
  const original = env.options.capture
  env.options.capture = async (input) => {
    if (input.out.endsWith('/infura') || input.out.endsWith('/alchemy'))
      throw new Error('provider_rate_limited')
    return original(input)
  }
  const second = await tick(env.options)
  assert.deepEqual(
    second.slices.map((slice) => slice.leftOrigin),
    ['infura', 'drpc'],
  )
  assert.deepEqual(
    verifyArchive(env.options).slices.map((slice) => slice.leftOrigin),
    ['infura', 'drpc'],
  )
})

test('a crashed source before origin witness is quarantined and recaptured', async (t) => {
  const env = setup(t)
  const original = env.options.capture
  let once = true
  env.options.capture = async (input) => {
    const result = await original(input)
    if (input.out.endsWith('/ankr') && once) {
      once = false
      throw new Error('simulated_crash')
    }
    return result
  }
  await assert.rejects(tick(env.options), /archive_v2_capture_ankr/)
  const result = await tick(env.options)
  assert.equal(result.acceptedSlices, 1)
  assert.equal(
    readdirSync(`${env.root}-unwitnessed-sources`).some((name) => name.endsWith('.orphan.json')),
    true,
  )
})

for (const stage of ['empty epoch directory', 'genesis only', 'genesis and one empty origin']) {
  test(`repairs a crash during ${stage} bootstrap`, async (t) => {
    const env = setup(t)
    const first = await tick(env.options)
    assert.equal(first.acceptedSlices, 1)
    const dir = join(env.root, 'epoch-000')
    const genesis = readFileSync(join(dir, 'genesis.json'))
    rmSync(dir, { recursive: true })
    mkdirSync(dir)
    if (stage !== 'empty epoch directory') writeFileSync(join(dir, 'genesis.json'), genesis)
    if (stage === 'genesis and one empty origin') mkdirSync(join(dir, 'infura'))
    const replay = await tick(env.options)
    assert.equal(replay.acceptedSlices, 1)
    assert.equal(replay.slices[0].fromBlock, TO_BLOCK)
  })
}

test('missing genesis with a source present fails closed', async (t) => {
  const env = setup(t)
  await tick(env.options)
  const dir = join(env.root, 'epoch-000')
  rmSync(join(dir, 'genesis.json'))
  await assert.rejects(tick(env.options), /archive_v2_nonempty_bootstrap/)
})

test('partial collector temp is preserved in quarantine before a fresh slice capture', async (t) => {
  const env = setup(t)
  await tick(env.options)
  const sourceDir = join(env.root, 'epoch-000', 'infura')
  const a = TO_BLOCK + SLICE_BLOCKS,
    b = a + SLICE_BLOCKS
  const temp = `USDC-${a}-${b}-${h(b).slice(2)}.json.${randomUUID()}.tmp`
  writeFileSync(join(sourceDir, temp), '{')
  const result = await tick(env.options)
  assert.equal(result.acceptedSlices, 2)
  const quarantine = `${env.root}-unwitnessed-sources`
  assert.equal(existsSync(join(quarantine, `temp-infura-${temp}`)), true)
  const manifest = JSON.parse(
    readFileSync(join(quarantine, `temp-infura-${temp}.orphan.json`), 'utf8'),
  )
  assert.equal(manifest.classification, 'partial_unsealed_receipt')
  assert.equal(existsSync(join(sourceDir, temp)), false)
})

test('post-link collector temp is quarantined without replacing its sealed receipt', async (t) => {
  const env = setup(t)
  const first = await tick(env.options)
  const source = first.slices[0].leftFile
  const temp = `${source}.${randomUUID()}.tmp`
  linkSync(source, temp)
  const result = await tick(env.options)
  assert.equal(result.acceptedSlices, 2)
  assert.equal(existsSync(source), true)
  assert.equal(existsSync(temp), false)
  assert.equal(
    existsSync(join(`${env.root}-unwitnessed-sources`, `temp-infura-${temp.split('/').at(-1)}`)),
    true,
  )
})

test('64 exact slices complete epoch zero and the next tick rolls into epoch one', async (t) => {
  const env = setup(t)
  let result
  for (let i = 0; i < EPOCH_BLOCKS / SLICE_BLOCKS; i += 1) result = await tick(env.options)
  assert.equal(result.epochs[0].complete, true)
  assert.equal(result.throughBlock, TO_BLOCK + EPOCH_BLOCKS)
  result = await tick(env.options)
  assert.equal(result.epochs[1].acceptedSlices, 1)
  assert.equal(result.slices.at(-1).fromBlock, TO_BLOCK + EPOCH_BLOCKS)
  const genesis = JSON.parse(readFileSync(join(env.root, 'epoch-001', 'genesis.json'), 'utf8'))
  assert.equal(genesis.priorHash, h(TO_BLOCK + EPOCH_BLOCKS))
  assert.equal(genesis.priorSidecarSha256, sha(readFileSync(result.slices.at(-2).file)))
})
