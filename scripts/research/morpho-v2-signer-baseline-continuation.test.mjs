import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { holderPlan } from './morpho-v2-signer-baseline.mjs'
import {
  continueSigner,
  OUTPUT_PATH,
  SEED_PATH,
  SEED_SHA,
  V1_SOURCE_PATH,
} from './morpho-v2-signer-baseline-continuation.mjs'

const disk = () => ({ bavail: 100_000_000, bsize: 4096 })
const source = JSON.parse(readFileSync(V1_SOURCE_PATH, 'utf8'))
const fakeNoHolder = ({ prefix }) => {
  const plan = holderPlan(prefix.raw.logs)
  return {
    index: prefix.anchor.index,
    proposalIndex: prefix.anchor.proposalIndex,
    vault: prefix.anchor.vault,
    anchorBlock: prefix.anchor.anchorBlock,
    preBlock: prefix.anchor.preBlock,
    preBlockHash: prefix.old.preBlockHash,
    v1Status: prefix.old.status,
    excludedSentinels: plan.excluded,
    replayedSupply: plan.replayedSupply,
    examinedHolders: plan.candidates.map(({ holder, shares }) => ({
      holder,
      shares,
      status: 'contract-code-holder',
    })),
    status: 'no-non-sentinel-code-empty-holder',
    rpcCalls: 0,
  }
}

test('dry retains immutable 64-row seed and rejects uncollected source frontier', async () => {
  const out = join(tmpdir(), 'morpho-v2-signer-dry-test.json')
  const result = await continueSigner({ out, mode: 'dry', through: 64 })
  assert.equal(result.completed, 64)
  assert.equal(result.available, source.results.length)
  await assert.rejects(
    continueSigner({ out, mode: 'dry', through: source.results.length + 1 }),
    /V1 raw frontier/,
  )
  assert.equal(SEED_SHA.length, 64)
  assert.equal(OUTPUT_PATH.endsWith('-v3.json'), true)
})

test('run at seed frontier needs no RPC and does not create a checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-v2-signer-seed-'))
  try {
    const out = join(dir, 'continuation.json')
    const result = await continueSigner({
      mode: 'run',
      out,
      through: 64,
      stat: disk,
      client: {
        request: () => {
          throw new Error('Unexpected RPC')
        },
      },
    })
    assert.equal(result.completed, 64)
    assert.equal(result.checkpoint.rows.length, 64)
    assert.equal(readFileSync(SEED_PATH).length > 0, true)
    await assert.rejects(continueSigner({ mode: 'verify', out, through: 64 }), /missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bounded row append is source-pinned, resumable, and rejects tampering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-v2-signer-row-'))
  try {
    const out = join(dir, 'continuation.json')
    const next = source.results.length >= 65 ? 65 : 64
    assert.equal(next, 65, 'fixture requires at least one v1 continuation row')
    const manifest = JSON.parse(
      readFileSync('data/research/venue-signals/morpho-v2-full-cohort-manifest.json'),
    )
    const selected = source.results[64]
    const anchorHash = manifest.rows[64].anchorBlockHash
    const request = async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const number = Number(BigInt(params[0]))
        if (number === selected.preBlock) return { number: params[0], hash: selected.preBlockHash }
        if (number === selected.anchorBlock)
          return { number: params[0], hash: anchorHash, parentHash: selected.preBlockHash }
      }
      throw new Error('Unexpected RPC')
    }
    const probeSigner = async ({ prefix }) => fakeNoHolder({ prefix })
    const first = await continueSigner({
      mode: 'run',
      out,
      through: 65,
      maxRows: 1,
      stat: disk,
      client: { request },
      probeSigner,
    })
    assert.equal(first.completed, 65)
    assert.equal(first.checkpoint.rows[64].v1SourceRowSha256.length, 64)
    assert.equal((await continueSigner({ mode: 'verify', out, through: 65 })).completed, 65)
    assert.equal(
      (
        await continueSigner({
          mode: 'run',
          out,
          through: 65,
          client: {
            request: () => {
              throw new Error('Unexpected RPC')
            },
          },
        })
      ).completed,
      65,
    )
    const altered = JSON.parse(readFileSync(out, 'utf8'))
    altered.rows[64].status = 'baseline-success'
    writeFileSync(out, JSON.stringify(altered))
    await assert.rejects(continueSigner({ mode: 'verify', out, through: 65 }), /integrity|frontier/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrong chain and bounded cap reject before writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-v2-signer-chain-'))
  try {
    const out = join(dir, 'continuation.json')
    await assert.rejects(
      continueSigner({
        mode: 'run',
        out,
        through: 65,
        maxRows: 1,
        stat: disk,
        client: { request: async () => '0x89' },
      }),
      /Wrong chain ID/,
    )
    await assert.rejects(
      continueSigner({
        mode: 'run',
        out,
        through: 69,
        maxRows: 4,
        stat: disk,
        client: {
          request: async () => {
            throw new Error('Unexpected RPC')
          },
        },
      }),
      /bounded max-rows/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('row budget includes header rechecks and B parent must link to B-1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-v2-signer-integrity-'))
  try {
    const selected = source.results[64]
    const manifest = JSON.parse(
      readFileSync('data/research/venue-signals/morpho-v2-full-cohort-manifest.json'),
    )
    const anchorHash = manifest.rows[64].anchorBlockHash
    let rowCalls = 0
    const client = {
      request: async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        rowCalls++
        if (method === 'eth_getCode') return '0x'
        if (method === 'eth_getBlockByNumber') {
          const number = Number(BigInt(params[0]))
          if (number === selected.preBlock)
            return { number: params[0], hash: selected.preBlockHash }
          if (number === selected.anchorBlock)
            return {
              number: params[0],
              hash: anchorHash,
              parentHash: `0x${'f'.repeat(64)}`,
            }
        }
        throw new Error('Unexpected request')
      },
    }
    await assert.rejects(
      continueSigner({
        mode: 'run',
        out: join(dir, 'parent.json'),
        through: 65,
        maxRows: 1,
        stat: disk,
        client,
        probeSigner: async ({ prefix }) => fakeNoHolder({ prefix }),
      }),
      /Frozen source headers changed/,
    )
    assert.equal(rowCalls, 2)
    rowCalls = 0
    await assert.rejects(
      continueSigner({
        mode: 'run',
        out: join(dir, 'cap.json'),
        through: 65,
        maxRows: 1,
        stat: disk,
        client,
        probeSigner: async ({ client: boundedClient, prefix }) => {
          for (let i = 0; i < 4095; i++)
            await boundedClient.request({ method: 'eth_getCode', params: [] })
          return fakeNoHolder({ prefix })
        },
      }),
      /Per-row RPC cap reached/,
    )
    assert.equal(rowCalls, 4096)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
