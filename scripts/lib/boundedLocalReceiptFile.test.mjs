import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { boundedReceiptBudget, readBoundedReceiptFile } from './boundedLocalReceiptFile.mjs'
const fixture = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-receipt-'))
  try {
    const path = join(root, 'receipt.json')
    writeFileSync(path, '12345678')
    fn(path, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('lower-only primitive count/total limits; defaults retain existing bounds', () => {
  for (const limits of [
    { maxRecords: 0 },
    { maxRecords: null },
    { maxTotalBytes: null },
    { maxRecords: 11 },
    { maxRecords: [1] },
    { maxTotalBytes: 0 },
    { maxTotalBytes: 101 },
    { maxTotalBytes: '10' },
    { foreign: 1 },
    null,
  ])
    assert.throws(() => boundedReceiptBudget(limits, 10, 10), /limits_invalid/)
  assert.deepEqual(boundedReceiptBudget(undefined, 10, 10), {
    maxRecords: 10,
    maxTotalBytes: 100,
    maxFileBytes: 10,
    totalBytes: 0,
  })
})
test('fixed readcap+1 survives growth after opened-fd stat; no unbounded read occurs', () =>
  fixture((path) => {
    const budget = boundedReceiptBudget({}, 10, 8)
    let readBytes = 0,
      calls = 0
    assert.throws(
      () =>
        readBoundedReceiptFile(path, budget, {
          readSync(fd, b, offset, length, position) {
            calls++
            if (calls === 1) writeFileSync(path, 'x'.repeat(100000))
            assert.equal(b.length, 9)
            const n = readSync(fd, b, offset, length, position)
            readBytes += n
            return n
          },
        }),
      /oversize/,
    )
    assert.equal(readBytes, 9)
    assert.equal(budget.totalBytes, 0)
  }))
test('path replacement is rejected even when the opened original fd remains valid', () =>
  fixture((path, root) => {
    let once = false
    assert.throws(
      () =>
        readBoundedReceiptFile(path, boundedReceiptBudget({}, 10, 8), {
          readSync(fd, b, offset, length, position) {
            if (!once) {
              once = true
              renameSync(path, join(root, 'old'))
              writeFileSync(path, '12345678')
            }
            return readSync(fd, b, offset, length, position)
          },
        }),
      /changed_during_read/,
    )
  }))
test('no-follow rejects symlink and nonregular fd; aggregate bytes consumed across actual reads', () =>
  fixture((path, root) => {
    const link = join(root, 'link')
    symlinkSync(path, link)
    assert.throws(() => readBoundedReceiptFile(link, boundedReceiptBudget({}, 10, 8)))
    assert.throws(
      () => readBoundedReceiptFile(root, boundedReceiptBudget({}, 10, 8)),
      /not_regular/,
    )
    const budget = boundedReceiptBudget({ maxTotalBytes: 10 }, 10, 8)
    assert.equal(readBoundedReceiptFile(path, budget), '12345678')
    assert.equal(budget.totalBytes, 8)
    assert.throws(() => readBoundedReceiptFile(path, budget), /total_limit/)
  }))

test('physical UTF8 bytes cannot silently change through decoding', () =>
  fixture((path) => {
    writeFileSync(path, Buffer.from([0xff]))
    assert.throws(
      () => readBoundedReceiptFile(path, boundedReceiptBudget({}, 10, 8)),
      /utf8_invalid/,
    )
  }))
