import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validCurrentCapture } from './carryLocalCashTickGate.mjs'

const now = Date.parse('2026-09-30T23:30:00.000Z')
const capture = {
  mode: 'current',
  skipped: 0,
  captures: [
    {
      status: 'recorded',
      anchorAt: '2026-09-30T22:45:00.000Z',
      sha256: 'a'.repeat(64),
    },
  ],
}

test('allows only a newly recorded current receipt within one hour', () => {
  assert.equal(validCurrentCapture(capture, now), true)
  assert.equal(validCurrentCapture({ ...capture, skipped: 1, captures: [] }, now), false)
  assert.equal(validCurrentCapture({ ...capture, mode: 'history' }, now), false)
  assert.equal(
    validCurrentCapture(
      { ...capture, captures: [{ ...capture.captures[0], status: 'already_recorded' }] },
      now,
    ),
    false,
  )
  assert.equal(
    validCurrentCapture(
      { ...capture, captures: [{ ...capture.captures[0], anchorAt: '2026-09-30T22:29:59.999Z' }] },
      now,
    ),
    false,
  )
  assert.equal(
    validCurrentCapture(
      { ...capture, captures: [{ ...capture.captures[0], anchorAt: '2026-09-30T23:31:00.000Z' }] },
      now,
    ),
    false,
  )
  assert.equal(
    validCurrentCapture({ ...capture, captures: [{ ...capture.captures[0], sha256: 'bad' }] }, now),
    false,
  )
})
