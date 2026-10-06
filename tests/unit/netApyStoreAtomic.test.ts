import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import { loadParamBaseline, saveParamBaseline } from '@/lib/netApy/store'
import type { VenueSnapshot } from '@/lib/netApy/types'

// Store writes are atomic: a crash mid-write must leave the previous file whole. The
// crash is simulated in fs.writeFileSync: half the bytes reach the disk, then it throws.

const crash = vi.hoisted(() => ({ armed: false }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (!crash.armed) return actual.writeFileSync(file, data, options)
    crash.armed = false
    const s = String(data)
    actual.writeFileSync(file, s.slice(0, Math.floor(s.length / 2)))
    throw new Error('simulated crash mid-write')
  }
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync }
})

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'),
  bigintReviver,
) as { snapshots: VenueSnapshot[] }
const at = (blockNumber: bigint) => ({
  observedAt: 1,
  snapshots: fx.snapshots.map((s) => ({ ...s, anchor: { ...s.anchor, blockNumber } })),
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'net-apy-atomic-'))
  process.env.NET_APY_STORE_DIR = dir
})
afterEach(() => {
  crash.armed = false
  delete process.env.NET_APY_STORE_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('atomic store writes', () => {
  it('a crash mid-write keeps the previous baseline readable and leaves no temp file', () => {
    expect(saveParamBaseline(at(1n))).toBe(true)
    crash.armed = true
    expect(saveParamBaseline(at(2n))).toBe(false)
    expect(loadParamBaseline()?.snapshots[0].anchor.blockNumber).toBe(1n)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('a completed write replaces the file', () => {
    expect(saveParamBaseline(at(1n))).toBe(true)
    expect(saveParamBaseline(at(2n))).toBe(true)
    expect(loadParamBaseline()?.snapshots[0].anchor.blockNumber).toBe(2n)
    expect(readdirSync(dir)).toEqual(['params-baseline.json'])
  })
})
