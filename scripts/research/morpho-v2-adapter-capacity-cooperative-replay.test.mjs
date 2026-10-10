import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  prepareMorphoV2AdapterCapacityPlan,
  replayMorphoV2AdapterCapacity,
  replayMorphoV2AdapterCapacityCooperatively,
  writeMorphoV2AdapterCapacityCapture,
} from './morpho-v2-adapter-capacity-capture.mjs'

const file = 'data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json'
const receipt = () => JSON.parse(readFileSync(file, 'utf8'))
const reseal = (value) => {
  const { sha256: _old, ...body } = value
  value.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return value
}

test('cooperative full190 replay equals sync proof and owns both inputs before its first handoff', async () => {
  // This saved capture keeps its original clocks. It is not current holder evidence.
  const original = receipt(),
    plan = structuredClone(prepareMorphoV2AdapterCapacityPlan()),
    expected = replayMorphoV2AdapterCapacity(original, plan),
    suppliedReceipt = structuredClone(original),
    suppliedPlan = structuredClone(plan)
  let timerServed = false,
    completed = false
  const pending = replayMorphoV2AdapterCapacityCooperatively(suppliedReceipt, suppliedPlan).then(
    (value) => {
      completed = true
      return value
    },
  )
  // Even immediate caller mutation cannot alter the privately owned proof graphs.
  suppliedReceipt.traces[0].request.method = 'caller_mutated'
  suppliedReceipt.sources[0].blockHash = '0x' + 'f'.repeat(64)
  suppliedPlan.subject.assetDecimals = 18
  await new Promise((resolve) =>
    setImmediate(() => {
      timerServed = true
      assert.equal(completed, false)
      suppliedReceipt.traces.splice(0)
      suppliedPlan.anchors.splice(0)
      resolve()
    }),
  )
  const actual = await pending
  assert.equal(timerServed, true)
  assert.deepEqual(actual, expected)
  assert.equal(actual.historyRegimeMatch, true)
  assert.equal(actual.sourceImplementationEquivalence, false)
  assert.equal(original.physicalStarts, 190)
  assert.equal(Object.isFrozen(actual), true)
  assert.equal(Object.isFrozen(actual.history.points[0].facts), true)
})

test('cooperative replay preserves seal and native setup request rejection', async () => {
  const plan = prepareMorphoV2AdapterCapacityPlan()
  const invalidSeal = receipt()
  invalidSeal.traces[0].request.method = 'caller_mutated'
  assert.throws(() => replayMorphoV2AdapterCapacity(invalidSeal, plan), /seal_policy/)
  await assert.rejects(replayMorphoV2AdapterCapacityCooperatively(invalidSeal, plan), /seal_policy/)
  const invalidRequest = receipt()
  invalidRequest.traces.find((trace) => trace.key === 'chain').request.params.push('0x')
  reseal(invalidRequest)
  assert.throws(() => replayMorphoV2AdapterCapacity(invalidRequest, plan), /chain_request/)
  await assert.rejects(
    replayMorphoV2AdapterCapacityCooperatively(invalidRequest, plan),
    /chain_request/,
  )
})

test('artifact URL rejection preserves unanchored ASCII semantics without rescanning large hex code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'morpho-cooperative-urls-'))
  try {
    const cases = [
      'https://origin.example',
      'WWW.origin.example',
      'prefixwww.suffix',
      '123://none',
      'a!123://none',
      '123a://origin',
      'a!b://origin',
      'a+.-123://origin',
      'a_1://none',
      'a_b://origin',
      'é://none',
      '123://none then 456://none',
      '123://none then 456b://origin',
      'https ://none',
      'a!123://none!b://origin',
    ]
    for (const [i, value] of cases.entries()) {
      const output = join(directory, String(i) + '.json'),
        input = { value },
        shouldReject = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(JSON.stringify(input)),
        write = () =>
          writeMorphoV2AdapterCapacityCapture(output, input, {
            statfs: () => ({ bavail: 2 ** 32, bsize: 1 }),
          })
      if (shouldReject) assert.throws(write, /artifact_url/)
      else assert.doesNotThrow(write)
    }
    // The former scheme regex repeatedly scanned this marker-free code suffix.
    const start = performance.now()
    writeMorphoV2AdapterCapacityCapture(
      join(directory, 'large-code.json'),
      {
        runtimeCode: '0x' + 'abcdef0123456789'.repeat(8000),
      },
      { statfs: () => ({ bavail: 2 ** 32, bsize: 1 }) },
    )
    assert.ok(performance.now() - start < 250, 'bounded marker-free code serialization')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
