import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyMorphoV2AdapterRuntime, IMMUTABLE_OPERAND_OFFSETS, RUNTIME_BYTES, TEMPLATE_SHA256 } from '../../scripts/lib/morpho-v2-adapter-runtime-template.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function fixture(path, hash) {
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    assert.ok(before.isFile() && before.size > 0 && before.size <= 2 * 1024 * 1024 && before.nlink === 1)
    const bytes = readFileSync(fd), after = fstatSync(fd)
    assert.equal(bytes.length, before.size)
    assert.equal(before.size, after.size)
    assert.equal(before.ino, after.ino)
    assert.equal(before.mtimeMs, after.mtimeMs)
    assert.equal(before.ctimeMs, after.ctimeMs)
    assert.equal(sha(bytes), hash)
    return JSON.parse(bytes)
  } finally { closeSync(fd) }
}
const usdt = fixture('data/research/venue-signals/morpho-usdt-source-discovery-evidence-2026-10-08/00-actual-1.json', 'e9c736624510e9dd594c90b94cee625441cc0b4b32481dc4cec7bb37a6e1cdda')
const pilot = fixture('data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json', 'ddf285e8d5209390ce2b8c42867b092fa36ddaf0a8759e2a83dd92805740f970')
const a = { runtimeCode: usdt.discovery.origins[0].facts.code_adapter.runtimeCode, parentVault: usdt.plan.subject.destination, asset: usdt.plan.subject.asset, adapter: usdt.discovery.origins[0].facts.adapter }
const pilotCodeTraces = pilot.traces.filter((t) => t.key === 'code_adapter')
const b = { runtimeCode: pilotCodeTraces[0].response.result, parentVault: pilot.plan.subject.destination, asset: pilot.plan.subject.asset, adapter: pilotCodeTraces[0].request.params[0] }
function replaceByte(code, offset, byte) {
  return code.slice(0, 2 + offset * 2) + byte.toString(16).padStart(2, '0') + code.slice(4 + offset * 2)
}

test('both retained deployments match only the known conditional class', () => {
  for (const input of [a, b]) {
    const result = classifyMorphoV2AdapterRuntime(input)
    assert.equal(result.status, 'conditional_runtime_template_match')
    assert.equal(result.templatePin, TEMPLATE_SHA256)
    assert.equal(result.runtimeBytes, RUNTIME_BYTES)
    assert.equal(result.deploymentRuntimeSha256, sha(Buffer.from(input.runtimeCode.slice(2), 'hex')))
    assert.match(result.deploymentRuntimeKeccak256, /^0x[0-9a-f]{64}$/)
    assert.equal(result.sourceImplementationEquivalence, false)
    assert.equal(result.forecastValidated, false)
    assert.equal(result.minedPaymentObserved, false)
  }
  assert.equal(classifyMorphoV2AdapterRuntime(a).deploymentRuntimeKeccak256, usdt.discovery.origins[0].facts.code_adapter.keccak256)
  assert.notEqual(classifyMorphoV2AdapterRuntime(a).deploymentRuntimeSha256, classifyMorphoV2AdapterRuntime(b).deploymentRuntimeSha256)
})

test('actual two-origin fixtures agree on runtime bytes for every retained frame', () => {
  assert.equal(usdt.discovery.origins.length, 2)
  assert.equal(usdt.discovery.origins[1].facts.code_adapter.runtimeCode, a.runtimeCode)
  for (const origin of usdt.discovery.origins) assert.equal(origin.rows.find((r) => r.key === 'code_adapter').result, a.runtimeCode)
  assert.equal(pilotCodeTraces.length, 6)
  for (const anchor of [0, 1, 2]) {
    const traces = pilotCodeTraces.filter((t) => t.anchor === anchor)
    assert.equal(traces.length, 2)
    assert.notEqual(traces[0].origin, traces[1].origin)
    assert.equal(traces[0].response.result, traces[1].response.result)
    assert.equal(traces[0].response.result, b.runtimeCode)
  }
})

test('all 244 deployment differences fall within precisely eleven immutable operands', () => {
  const left = Buffer.from(a.runtimeCode.slice(2), 'hex'), right = Buffer.from(b.runtimeCode.slice(2), 'hex')
  const offsets = Object.values(IMMUTABLE_OPERAND_OFFSETS).flat()
  assert.equal(offsets.length, 11)
  let differences = 0
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) {
    differences++
    assert.ok(offsets.some((offset) => i >= offset && i < offset + 32))
  }
  assert.equal(differences, 244)
  for (const offset of offsets) { left.fill(0, offset, offset + 32); right.fill(0, offset, offset + 32) }
  assert.deepEqual(left, right)
  assert.equal(sha(left), TEMPLATE_SHA256)
})

test('addresses require canonical nonzero native 20-byte identities', () => {
  for (const role of ['parentVault', 'asset', 'adapter']) for (const bad of [null, '', '0x' + '0'.repeat(40), '0x12', a[role].toUpperCase()]) {
    assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, [role]: bad }), /invalid_/)
  }
})

test('runtime length, hex syntax and prefix are strict', () => {
  for (const runtimeCode of [null, a.runtimeCode.slice(0, -2), a.runtimeCode + '00', a.runtimeCode.slice(2), a.runtimeCode.slice(0, -1) + 'g', a.runtimeCode.toUpperCase()]) {
    assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, runtimeCode }), /invalid_runtime_hex_or_length/)
  }
})

test('each immutable role must match its exact deployment identity', () => {
  for (const role of ['parentVault', 'asset', 'adapter']) {
    assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, [role]: '0x' + '1'.repeat(40) }), /immutable_/)
  }
  for (const offsets of Object.values(IMMUTABLE_OPERAND_OFFSETS)) for (const offset of offsets) {
    assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, runtimeCode: replaceByte(a.runtimeCode, offset + 31, 0) }), /immutable_/)
  }
})

test('PUSH32 must be an actual instruction rather than a coincidental payload byte', () => {
  assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, runtimeCode: replaceByte(a.runtimeCode, 405, 0x7e) }), /immutable_instruction_boundary/)
  // A PUSH32 at the preceding instruction hides byte 405 while leaving
  // that byte's literal 0x7f intact. Local preceding-byte checks would miss it.
  const bytes = Buffer.from(a.runtimeCode.slice(2), 'hex')
  let pc = 0, prior = 0
  while (pc < 405) {
    prior = pc
    const n = bytes[pc] >= 0x60 && bytes[pc] <= 0x7f ? bytes[pc] - 0x5f : 0
    pc += 1 + n
  }
  assert.ok(prior < 405 && 405 - prior <= 32)
  assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, runtimeCode: replaceByte(a.runtimeCode, prior, 0x7f) }), /immutable_instruction_boundary/)
})

test('opcode, unrelated PUSH32 operand and metadata changes cannot enter the class', () => {
  const bytes = Buffer.from(a.runtimeCode.slice(2), 'hex')
  const offsets = Object.values(IMMUTABLE_OPERAND_OFFSETS).flat()
  let unrelatedPush = null
  for (let pc = 0; pc < 10066;) {
    const n = bytes[pc] >= 0x60 && bytes[pc] <= 0x7f ? bytes[pc] - 0x5f : 0
    if (n === 32 && !offsets.includes(pc + 1)) { unrelatedPush = pc + 1; break }
    pc += 1 + n
  }
  assert.notEqual(unrelatedPush, null)
  for (const offset of [0, unrelatedPush, RUNTIME_BYTES - 1]) {
    assert.throws(() => classifyMorphoV2AdapterRuntime({ ...a, runtimeCode: replaceByte(a.runtimeCode, offset, bytes[offset] ^ 1) }), /unknown_runtime_template|immutable_instruction_boundary/)
  }
})

test('classification has no dependency on Q or future outcome parameters', () => {
  const expected = classifyMorphoV2AdapterRuntime(a)
  assert.deepEqual(classifyMorphoV2AdapterRuntime({ ...a, assetsRaw: '1', Q: '1', targetOutcome: 'success' }), expected)
  assert.deepEqual(classifyMorphoV2AdapterRuntime({ ...a, assetsRaw: '999999999999999999', Q: '0', targetOutcome: 'revert' }), expected)
  assert.equal(expected.parameterRoles.flatMap((r) => r.operandOffsets).length, 11)
  assert.equal(expected.parameters.parentVault, a.parentVault)
  assert.equal(expected.parameters.asset, a.asset)
})
