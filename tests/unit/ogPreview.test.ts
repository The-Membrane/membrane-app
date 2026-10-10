import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CORPUS_SCALE_LINE, OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'

const root = path.resolve(process.cwd())
const read = (file: string) => readFileSync(path.join(root, file))
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('default social preview', () => {
  it('is a 1200×630 PNG generated from the current landing-scale corpus', () => {
    const metadata = JSON.parse(read('public/og.meta.json').toString()) as {
      figure: string
      corpusSha256: string
      pngSha256: string
    }
    const png = read('public/og.png')
    const scale = CORPUS_SCALE_LINE.partial ? OCT10_SCALE_LINE : CORPUS_SCALE_LINE

    expect(metadata.figure).toBe(scale.figure)
    expect(metadata.corpusSha256).toBe(sha256(read('public/data/liquidation-corpus.json')))
    expect(metadata.pngSha256).toBe(sha256(png))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
  })
})
