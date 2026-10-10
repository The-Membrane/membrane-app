import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALCHEMY_ORIGIN,
  DRPC_ORIGIN,
  QUICKNODE_ORIGIN,
  OUT,
  archiveLogChunkBlocks,
  archiveFailureCode,
  tick,
  tickWithConfiguredFallback,
  verifyArchive,
  verifyPair,
} from './aave-usdc-market-cash-archive.mjs'

const first = 26_079_860
const last = first + 128
const firstHash = `0x${'1'.repeat(64)}`
const lastHash = `0x${'2'.repeat(64)}`

function receipt(origin = 'infura') {
  return {
    sha256: `sealed-source-${origin}`,
    market: 'USDC',
    chainId: 1,
    pool: 'pool',
    underlying: 'usdc',
    aToken: 'atoken',
    from: { blockNumber: first, blockHash: firstHash, cashRaw: '100' },
    to: { blockNumber: last, blockHash: lastHash, cashRaw: '90' },
    identities: [{ blockNumber: first }, { blockNumber: last }],
    chunks: {
      poolOperations: [
        {
          fromBlock: first + 1,
          toBlock: last,
          firstHash,
          lastHash,
          queries: [
            {
              logs: [
                {
                  blockNumber: first + 1,
                  blockHash: lastHash,
                  logIndex: 0,
                  transactionHash: 'supply',
                },
              ],
            },
          ],
        },
      ],
      underlyingTransfers: [
        {
          fromBlock: first + 1,
          toBlock: last,
          firstHash,
          lastHash,
          queries: [
            {
              logs: [
                {
                  blockNumber: first + 1,
                  blockHash: lastHash,
                  logIndex: 1,
                  transactionHash: 'cash-out',
                },
              ],
            },
          ],
        },
      ],
    },
    operations: [{ kind: 'Withdraw', amountRaw: '10' }],
    transfers: [{ amountRaw: '10' }],
    reconciliation: { endpointReconciled: true },
  }
}

test('accepts matching independently sealed economic observations', () => {
  const paired = verifyPair(receipt(), receipt('ankr'), first, last, firstHash)
  assert.equal(paired.toHash, lastHash)
  assert.match(paired.projectionSha256, /^[a-f0-9]{64}$/)
})

test('archive fallback changes the actual left origin only after Infura capture fails', async () => {
  const calls = []
  const run = async ({ rpcUrls }) => {
    const leftOrigin = new URL(rpcUrls.split(',')[0]).origin
    calls.push(leftOrigin)
    if (leftOrigin === 'https://mainnet.infura.io') throw new Error('archive_capture_infura')
    return { acceptedSlices: 24 }
  }
  const result = await tickWithConfiguredFallback({
    rpcUrls:
      'https://eth-mainnet.g.alchemy.com/v2/test,https://mainnet.infura.io/v3/test,https://rpc.ankr.com/eth/test',
    run,
  })
  assert.equal(result.acceptedSlices, 24)
  assert.deepEqual(calls, ['https://mainnet.infura.io', ALCHEMY_ORIGIN])
  await assert.rejects(
    tickWithConfiguredFallback({
      rpcUrls:
        'https://eth-mainnet.g.alchemy.com/v2/test,https://mainnet.infura.io/v3/test,https://rpc.ankr.com/eth/test',
      run: async () => {
        throw new Error('archive_capture_ankr')
      },
    }),
    /archive_capture_ankr/,
  )
  assert.equal(
    archiveFailureCode(new Error('archive_capture_alchemy', { cause: { code: 'ETIMEDOUT' } })),
    'archive_capture_alchemy:rpc_etimedout',
  )
  await assert.rejects(
    tickWithConfiguredFallback({
      rpcUrls:
        'https://eth-mainnet.g.alchemy.com/v2/test,https://mainnet.infura.io/v3/test,https://rpc.ankr.com/eth/test',
      run: async ({ rpcUrls }) => {
        const origin = new URL(rpcUrls.split(',')[0]).origin
        const stage = origin === ALCHEMY_ORIGIN ? 'alchemy' : 'infura'
        throw new Error(`archive_capture_${stage}`, { cause: { status: 429 } })
      },
    }),
    (error) =>
      archiveFailureCode(error) ===
      'archive_two_origin_capture_failed:archive_capture_infura:http_429:archive_capture_alchemy:http_429',
  )
})

test('configured DRPC is the third independent left origin after two capture failures', async () => {
  const calls = []
  const rpcUrls =
    'https://mainnet.infura.io/v3/test,https://eth-mainnet.g.alchemy.com/v2/test,https://lb.drpc.live/test,https://rpc.ankr.com/eth/test'
  const run = async ({ rpcUrls: pair }) => {
    const leftOrigin = new URL(pair.split(',')[0]).origin
    calls.push(leftOrigin)
    if (leftOrigin !== DRPC_ORIGIN)
      throw new Error(`archive_capture_${leftOrigin === ALCHEMY_ORIGIN ? 'alchemy' : 'infura'}`, {
        cause: { status: 429 },
      })
    return { acceptedSlices: 40, leftOrigin }
  }
  const result = await tickWithConfiguredFallback({ rpcUrls, run })
  assert.equal(result.leftOrigin, DRPC_ORIGIN)
  assert.deepEqual(calls, ['https://mainnet.infura.io', ALCHEMY_ORIGIN, DRPC_ORIGIN])
  assert.equal(
    archiveFailureCode(
      Object.assign(new Error('archive_three_origin_capture_failed'), {
        infuraCode: 'archive_capture_infura:http_402',
        alchemyCode: 'archive_capture_alchemy:http_429',
        drpcCode: 'archive_capture_drpc:http_429',
      }),
    ),
    'archive_three_origin_capture_failed:archive_capture_infura:http_402:archive_capture_alchemy:http_429:archive_capture_drpc:http_429',
  )
  await assert.rejects(
    tickWithConfiguredFallback({
      rpcUrls,
      run: async ({ rpcUrls: pair }) => {
        const origin = new URL(pair.split(',')[0]).origin
        const label =
          origin === DRPC_ORIGIN ? 'drpc' : origin === ALCHEMY_ORIGIN ? 'alchemy' : 'infura'
        throw new Error(`archive_capture_${label}`, { cause: { status: 429 } })
      },
    }),
    (error) =>
      archiveFailureCode(error) ===
      'archive_three_origin_capture_failed:archive_capture_infura:http_429:archive_capture_alchemy:http_429:archive_capture_drpc:http_429',
  )
  calls.length = 0
  await assert.rejects(
    tickWithConfiguredFallback({
      rpcUrls,
      run: async ({ rpcUrls: pair }) => {
        calls.push(new URL(pair.split(',')[0]).origin)
        throw new Error('archive_two_origin_disagreement')
      },
    }),
    /archive_two_origin_disagreement/,
  )
  assert.deepEqual(calls, ['https://mainnet.infura.io'])
})

test('verified QuickNode is tried before staged Alchemy while failures stay redacted', async () => {
  const origins = []
  const rpcUrls = [
    'https://mainnet.infura.io/v3/test',
    'https://eth-mainnet.g.alchemy.com/v2/test',
    'https://lb.drpc.live/test',
    QUICKNODE_ORIGIN + '/private-test-token',
    'https://rpc.ankr.com/eth/test',
  ].join(',')
  const result = await tickWithConfiguredFallback({
    rpcUrls,
    run: async ({ rpcUrls: pair }) => {
      const origin = new URL(pair.split(',')[0]).origin
      origins.push(origin)
      if (origin === QUICKNODE_ORIGIN) return { leftOrigin: origin }
      const label =
        origin === DRPC_ORIGIN ? 'drpc' : origin === ALCHEMY_ORIGIN ? 'alchemy' : 'infura'
      throw new Error('archive_capture_' + label, { cause: { status: 429 } })
    },
  })
  assert.equal(result.leftOrigin, QUICKNODE_ORIGIN)
  assert.deepEqual(origins, ['https://mainnet.infura.io', QUICKNODE_ORIGIN])
  const failure = await tickWithConfiguredFallback({
    rpcUrls,
    run: async ({ rpcUrls: pair }) => {
      const origin = new URL(pair.split(',')[0]).origin
      const label =
        origin === QUICKNODE_ORIGIN
          ? 'quicknode'
          : origin === DRPC_ORIGIN
            ? 'drpc'
            : origin === ALCHEMY_ORIGIN
              ? 'alchemy'
              : 'infura'
      throw new Error('archive_capture_' + label, { cause: { status: 429 } })
    },
  }).catch((error) => error)
  assert.equal(
    archiveFailureCode(failure),
    'archive_four_origin_capture_failed:archive_capture_infura:http_429:archive_capture_alchemy:http_429:archive_capture_drpc:http_429:archive_capture_quicknode:http_429',
  )
  assert.equal(archiveFailureCode(failure).includes('private-test-token'), false)
})

test('three configured left origins preserve distinct replay identities', () => {
  assert.notEqual(DRPC_ORIGIN, ALCHEMY_ORIGIN)
  assert.notEqual(DRPC_ORIGIN, 'https://mainnet.infura.io')
  assert.equal(
    archiveFailureCode(new Error('archive_capture_drpc', { cause: { status: 429 } })),
    'archive_capture_drpc:http_429',
  )
})

test('V1 tick binds a configured DRPC left origin before any source can be published', async () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-drpc-')))
  try {
    await assert.rejects(
      tick({
        out,
        rpcUrls: 'https://lb.drpc.live/test,https://rpc.ankr.com/eth/test',
        clientFactory: () => ({ request: async () => null }),
        capture: async ({ out: directory }) => {
          assert.equal(directory, join(out, 'drpc'))
          throw new Error('provider_rate_limited')
        },
      }),
      /archive_capture_drpc/,
    )
    assert.deepEqual(
      readdirSync(out).filter((entry) => entry.startsWith('slice-')),
      [],
    )
    assert.equal(verifyArchive({ out }).acceptedSlices, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('V1 QuickNode capture uses the verified five-block log limit without sealing on failure', async () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-quicknode-')))
  try {
    await assert.rejects(
      tick({
        out,
        rpcUrls: QUICKNODE_ORIGIN + '/private-test-token,https://rpc.ankr.com/eth/test',
        clientFactory: () => ({ request: async () => null }),
        capture: async ({ out: directory, fromBlock, toBlock, chunkBlocks }) => {
          assert.equal(directory, join(out, 'quicknode'))
          assert.equal(toBlock - fromBlock, 64)
          assert.equal(chunkBlocks, 5)
          throw new Error('provider_rate_limited')
        },
      }),
      /archive_capture_quicknode/,
    )
    assert.equal(
      readdirSync(out).some((entry) => entry.startsWith('slice-')),
      false,
    )
    assert.equal(verifyArchive({ out }).acceptedSlices, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('both collectors use the selected left origin chunk policy for exact pair replay', () => {
  assert.equal(archiveLogChunkBlocks(QUICKNODE_ORIGIN), 5)
  assert.equal(archiveLogChunkBlocks(ALCHEMY_ORIGIN), 10)
  assert.equal(archiveLogChunkBlocks(DRPC_ORIGIN), undefined)
  assert.equal(archiveLogChunkBlocks('https://rpc.ankr.com'), undefined)
})

test('matching event totals do not erase a raw-query chunk topology disagreement', () => {
  const left = receipt()
  const right = receipt('ankr')
  for (const kind of ['poolOperations', 'underlyingTransfers']) {
    const original = right.chunks[kind][0]
    right.chunks[kind] = [
      { ...original, toBlock: first + 64 },
      {
        ...original,
        fromBlock: first + 65,
        queries: original.queries.map((query) => ({ ...query, logs: [] })),
      },
    ]
  }
  assert.deepEqual(left.operations, right.operations)
  assert.deepEqual(left.transfers, right.transfers)
  assert.throws(
    () => verifyPair(left, right, first, last, firstHash),
    /archive_two_origin_disagreement/,
  )
})

test('rejects a source with omitted cash-transfer log despite matching endpoint fields', () => {
  const left = receipt()
  const right = receipt('ankr')
  right.chunks.underlyingTransfers[0].queries[0].logs = []
  assert.throws(
    () => verifyPair(left, right, first, last, firstHash),
    /archive_two_origin_disagreement/,
  )
})

test('rejects incorrect boundary and cash-reconciliation status', () => {
  assert.throws(
    () => verifyPair(receipt(), receipt('ankr'), first, last, `0x${'3'.repeat(64)}`),
    /archive_boundary_hash/,
  )
  const left = receipt()
  left.reconciliation.endpointReconciled = false
  const right = structuredClone(left)
  right.sha256 = 'sealed-source-ankr'
  assert.throws(
    () => verifyPair(left, right, first, last, firstHash),
    /archive_cash_not_reconciled/,
  )
})

test('rejects two agreeing out-of-range logs before a success pair can be sealed', () => {
  const malformed = receipt()
  malformed.chunks.poolOperations[0].queries[0].logs[0].blockNumber = last + 1
  const right = structuredClone(malformed)
  right.sha256 = 'sealed-source-ankr'
  assert.throws(
    () => verifyPair(malformed, right, first, last, firstHash),
    /archive_out_of_range_or_invalid_log/,
  )
})

test('rejects two agreeing duplicate logs before a success pair can be sealed', () => {
  const malformed = receipt()
  const logs = malformed.chunks.poolOperations[0].queries[0].logs
  logs.push(structuredClone(logs[0]))
  const right = structuredClone(malformed)
  right.sha256 = 'sealed-source-ankr'
  assert.throws(() => verifyPair(malformed, right, first, last, firstHash), /archive_duplicate_log/)
})

test('rejects identical source receipt bytes across both alleged origins', () => {
  assert.throws(
    () => verifyPair(receipt(), receipt(), first, last, firstHash),
    /archive_duplicate_source_bytes/,
  )
})

test('native failures report only a bounded code or HTTP status', () => {
  assert.equal(
    archiveFailureCode({ status: 429, message: 'provider URL and response' }),
    'http_429',
  )
  assert.equal(
    archiveFailureCode({ code: -32600, details: 'plan does not allow this block range' }),
    'rpc_plan_range',
  )
  assert.equal(archiveFailureCode({ message: 'secret response body' }), 'unknown')
  assert.equal(
    archiveFailureCode({ message: 'archive_capture_ankr', cause: { status: 429 } }),
    'archive_capture_ankr:http_429',
  )
})

test(
  'archive verification ignores Finder metadata and still parses intended sidecars',
  { skip: !existsSync(OUT) },
  () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-metadata-')))
    try {
      cpSync(OUT, out, { recursive: true })
      writeFileSync(join(out, '.DS_Store'), 'finder metadata')
      const verified = verifyArchive({ out })
      assert.ok(verified.acceptedSlices > 0)
      const sidecars = readdirSync(out)
        .filter((name) => /^slice-[0-9]+-[0-9]+\.json$/.test(name))
        .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
      const tail = sidecars.at(-1)
      assert.ok(tail)
      renameSync(join(out, tail), join(out, `.hidden-${tail}`))
      assert.throws(() => verifyArchive({ out }), /archive_unexpected_entry/)
      renameSync(join(out, `.hidden-${tail}`), join(out, tail))
      renameSync(join(out, tail), join(out, `._${tail}`))
      assert.throws(() => verifyArchive({ out }), /archive_unexpected_entry/)
      renameSync(join(out, `._${tail}`), join(out, tail))
      const intended = sidecars[0]
      assert.ok(intended)
      const intendedPath = join(out, intended)
      chmodSync(intendedPath, 0o600)
      writeFileSync(intendedPath, '{not-json')
      assert.throws(() => verifyArchive({ out }), SyntaxError)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  },
)

test('mixed Infura and Alchemy slices remain source-bound', { skip: !existsSync(OUT) }, () => {
  const mixed = join(OUT, 'slice-26080116-26080126.json')
  if (!existsSync(mixed)) return
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-mixed-origin-')))
  try {
    cpSync(OUT, out, { recursive: true })
    assert.equal(verifyArchive({ out }).acceptedSlices >= 3, true)
    const path = join(out, 'slice-26080116-26080126.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(saved.originSha256[0], createHash('sha256').update(ALCHEMY_ORIGIN).digest('hex'))
    saved.originSha256[0] = createHash('sha256').update('https://mainnet.infura.io').digest('hex')
    const { sha256: _seal, ...body } = saved
    saved.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    chmodSync(path, 0o600)
    writeFileSync(path, `${JSON.stringify(saved)}\n`)
    assert.throws(() => verifyArchive({ out }), /ENOENT|archive_origin_witness_mismatch/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test(
  'resealed overlong QuickNode sidecar fails before source lookup',
  { skip: !existsSync(OUT) },
  () => {
    const file = readdirSync(OUT).find((entry) => {
      const match = /^slice-([0-9]+)-([0-9]+)\.json$/.exec(entry)
      return match && Number(match[2]) - Number(match[1]) === 256
    })
    if (!file) return
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-quicknode-span-')))
    try {
      cpSync(OUT, out, { recursive: true })
      const path = join(out, file)
      const sidecar = JSON.parse(readFileSync(path, 'utf8'))
      sidecar.originSha256[0] = createHash('sha256').update(QUICKNODE_ORIGIN).digest('hex')
      const { sha256: oldSeal, ...body } = sidecar
      assert.match(oldSeal, /^[0-9a-f]{64}$/)
      sidecar.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      chmodSync(path, 0o600)
      writeFileSync(path, JSON.stringify(sidecar))
      assert.throws(() => verifyArchive({ out }), /archive_quicknode_slice_size/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  },
)

test('later V1 slices reject a resealed late-bound witness', { skip: !existsSync(OUT) }, () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-late-witness-')))
  try {
    cpSync(OUT, out, { recursive: true })
    const sidecarPath = join(out, 'slice-26080116-26080126.json')
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    const witnessPath = join(out, 'origin-alchemy-26080116-26080126.json')
    const witness = JSON.parse(readFileSync(witnessPath, 'utf8'))
    witness.mode = 'existing_live_receipt_bound_later'
    const { sha256: _oldWitnessSeal, ...witnessBody } = witness
    witness.sha256 = createHash('sha256').update(JSON.stringify(witnessBody)).digest('hex')
    sidecar.leftWitnessSha256 = witness.sha256
    const { sha256: _oldSidecarSeal, ...sidecarBody } = sidecar
    sidecar.sha256 = createHash('sha256').update(JSON.stringify(sidecarBody)).digest('hex')
    chmodSync(witnessPath, 0o600)
    chmodSync(sidecarPath, 0o600)
    writeFileSync(witnessPath, `${JSON.stringify(witness)}\n`)
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`)
    assert.throws(() => verifyArchive({ out }), /archive_origin_witness_mismatch/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test(
  'offline origin witness rejects copied source bytes even if joint sidecar is recomputed',
  { skip: !existsSync(OUT) },
  () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-origin-swap-')))
    try {
      cpSync(OUT, out, { recursive: true })
      assert.equal(verifyArchive({ out }).acceptedSlices >= 1, true)
      const left = join(out, 'infura', readdirSync(join(out, 'infura'))[0])
      const right = join(out, 'ankr', readdirSync(join(out, 'ankr'))[0])
      copyFileSync(right, left)
      const sidecarPath = join(out, `slice-26079860-26079988.json`)
      const saved = JSON.parse(readFileSync(sidecarPath, 'utf8'))
      const copied = JSON.parse(readFileSync(left, 'utf8'))
      saved.leftSha256 = copied.sha256
      const { sha256: _prior, ...body } = saved
      saved.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      chmodSync(sidecarPath, 0o600)
      writeFileSync(sidecarPath, `${JSON.stringify(saved)}\n`)
      assert.throws(
        () => verifyArchive({ out }),
        /archive_origin_witness_mismatch|Receipt SHA mismatch/,
      )
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  },
)

test(
  'oversized source is rejected by bounded preflight before legacy replay',
  { skip: !existsSync(OUT) },
  () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-oversize-')))
    try {
      cpSync(OUT, out, { recursive: true })
      const candidate = join(out, 'infura', `USDC-000026080116-000026080244-${'a'.repeat(64)}.json`)
      writeFileSync(candidate, Buffer.alloc(4 * 1024 * 1024 + 1))
      assert.throws(() => verifyArchive({ out }), /archive_file_size/)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  },
)

test('does not publish a joint slice when both mocked source receipts fail full offline validation', async () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-prepublish-')))
  const file = `USDC-000026079860-000026079988-${'a'.repeat(64)}.json`
  try {
    await assert.rejects(
      tick({
        out,
        rpcUrls: 'https://mainnet.infura.io/test,https://rpc.ankr.com/test',
        clientFactory: () => ({ request: async () => null }),
        capture: async ({ out: directory }) => {
          const path = join(directory, file)
          writeFileSync(path, `${JSON.stringify({ ...receipt(), sha256: 'counterfeit' })}\n`)
          return { path }
        },
      }),
    )
    assert.deepEqual(
      readdirSync(out).filter((entry) => entry.startsWith('slice-')),
      [],
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

function seedRealOrphan(out) {
  cpSync(OUT, out, { recursive: true })
  const fromBlock = 26_080_466
  const toBlock = 26_080_722
  const sidecar = JSON.parse(readFileSync(join(OUT, `slice-${fromBlock}-${toBlock}.json`)))
  for (const file of readdirSync(out)) {
    const range = /^(?:slice|origin-(?:infura|alchemy|ankr))-(\d+)-/.exec(file)
    if (range && Number(range[1]) >= fromBlock) rmSync(join(out, file))
  }
  for (const origin of ['infura', 'alchemy', 'ankr']) {
    for (const file of readdirSync(join(out, origin))) {
      const range = /^USDC-0*(\d+)-/.exec(file)
      if (
        range &&
        Number(range[1]) >= fromBlock &&
        !(origin === 'alchemy' && file === sidecar.leftFile)
      )
        rmSync(join(out, origin, file))
    }
  }
  return { fromBlock, toBlock, file: sidecar.leftFile }
}

test(
  'quarantines a real sealed source without a witness and recaptures before pairing',
  { skip: !existsSync(OUT) },
  async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-cash-orphan-')))
    const quarantine = `${out}-unwitnessed-sources`
    let captures = 0
    try {
      const { file } = seedRealOrphan(out)
      await assert.rejects(
        tick({
          out,
          rpcUrls: 'https://eth-mainnet.g.alchemy.com/test,https://rpc.ankr.com/test',
          clientFactory: () => ({ request: async () => null }),
          capture: async ({ out: directory }) => {
            captures += 1
            copyFileSync(join(OUT, 'alchemy', file), join(directory, file))
            throw new Error('simulated_second_crash_before_witness')
          },
        }),
        /archive_capture_alchemy/,
      )
      assert.equal(verifyArchive({ out }).acceptedSlices, 8)
      const result = await tick({
        out,
        rpcUrls: 'https://eth-mainnet.g.alchemy.com/test,https://rpc.ankr.com/test',
        clientFactory: () => ({ request: async () => null }),
        capture: async ({ out: directory }) => {
          captures += 1
          const origin = directory.endsWith('/alchemy') ? 'alchemy' : 'ankr'
          copyFileSync(join(OUT, origin, file), join(directory, file))
          return { path: join(directory, file) }
        },
      })
      assert.equal(result.acceptedSlices, 9)
      assert.equal(captures, 3)
      assert.equal(verifyArchive({ out }).acceptedSlices, 9)
      assert.deepEqual(readdirSync(quarantine).sort(), [
        `alchemy-${file}`,
        `alchemy-${file}.attempt-1`,
        `alchemy-${file}.attempt-1.orphan.json`,
        `alchemy-${file}.orphan.json`,
      ])
      const orphan = JSON.parse(readFileSync(join(quarantine, `alchemy-${file}.orphan.json`)))
      assert.equal(orphan.reason, 'capture_sealed_before_origin_witness')
      assert.equal(
        orphan.sourceSha256,
        JSON.parse(readFileSync(join(quarantine, `alchemy-${file}`))).sha256,
      )
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(quarantine, { recursive: true, force: true })
    }
  },
)

test(
  'tampered source or existing witness is never treated as a recoverable orphan',
  { skip: !existsSync(OUT) },
  async () => {
    for (const tamper of ['source', 'witness', 'quarantine_link']) {
      const out = realpathSync(mkdtempSync(join(tmpdir(), `aave-cash-${tamper}-`)))
      const quarantine = `${out}-unwitnessed-sources`
      try {
        const { fromBlock, toBlock, file } = seedRealOrphan(out)
        const sourcePath = join(out, 'alchemy', file)
        if (tamper === 'source') {
          const saved = JSON.parse(readFileSync(sourcePath))
          saved.sha256 = 'tampered'
          writeFileSync(sourcePath, `${JSON.stringify(saved)}\n`)
        } else if (tamper === 'witness') {
          writeFileSync(join(out, `origin-alchemy-${fromBlock}-${toBlock}.json`), '{}\n')
        } else {
          mkdirSync(quarantine)
          symlinkSync(sourcePath, join(quarantine, `alchemy-${file}`))
        }
        let captures = 0
        await assert.rejects(
          tick({
            out,
            rpcUrls: 'https://eth-mainnet.g.alchemy.com/test,https://rpc.ankr.com/test',
            clientFactory: () => ({ request: async () => null }),
            capture: async () => {
              captures += 1
              throw new Error('must_not_capture')
            },
          }),
          tamper === 'source'
            ? /Receipt SHA mismatch/
            : tamper === 'witness'
              ? /archive_origin_witness_sha/
              : /archive_orphan_collision/,
        )
        assert.equal(captures, 0)
        assert.equal(existsSync(sourcePath), true)
        if (tamper !== 'quarantine_link') assert.equal(existsSync(quarantine), false)
      } finally {
        rmSync(out, { recursive: true, force: true })
        rmSync(quarantine, { recursive: true, force: true })
      }
    }
  },
)
