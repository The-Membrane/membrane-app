// Pure deployment-runtime classifier. A template match establishes only a
// conditional math class, with no source equivalence or forecast qualification.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { encodeAbiParameters, keccak256 } = require('viem')

export const RUNTIME_BYTES = 11784
export const TEMPLATE_SHA256 = 'c32c2efa96dd945581a5dc1adec359563c26ca75bca38a62bff256fb4b074952'
export const IMMUTABLE_OPERAND_OFFSETS = Object.freeze({
  parentVault: Object.freeze([406, 3250, 4933, 5710, 5785, 8097]),
  asset: Object.freeze([3335, 4611, 5018]),
  adapterAllocationId: Object.freeze([2742, 10034]),
})
const ADDRESS = /^0x[0-9a-f]{40}$/
const ZERO_ADDRESS = '0x' + '0'.repeat(40)
const fail = (code) => { throw Error('morpho_adapter_template_' + code) }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function address(value, role) {
  if (typeof value !== 'string' || !ADDRESS.test(value) || value === ZERO_ADDRESS) fail('invalid_' + role)
  return value
}

export function classifyMorphoV2AdapterRuntime(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_input')
  const { runtimeCode } = input
  const parentVault = address(input.parentVault, 'parent_vault')
  const asset = address(input.asset, 'asset')
  const adapter = address(input.adapter, 'adapter')
  if (typeof runtimeCode !== 'string' || runtimeCode.length !== RUNTIME_BYTES * 2 + 2 || !/^0x[0-9a-f]+$/.test(runtimeCode)) fail('invalid_runtime_hex_or_length')
  const runtime = Buffer.from(runtimeCode.slice(2), 'hex')
  const adapterAllocationId = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'address' }], ['this', adapter]))
  const values = { parentVault: parentVault.slice(2).padStart(64, '0'), asset: asset.slice(2).padStart(64, '0'), adapterAllocationId: adapterAllocationId.slice(2) }
  const offsets = Object.values(IMMUTABLE_OPERAND_OFFSETS).flat()
  const end = Math.max(...offsets) + 32
  // Linear decoding skips PUSH1..PUSH32 operands. Merely finding 0x7f at the
  // preceding byte would also accept a fake opcode inside another PUSH payload.
  const instructionBoundaries = new Set()
  for (let pc = 0; pc < end;) {
    instructionBoundaries.add(pc)
    const opcode = runtime[pc]
    const payloadBytes = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0
    if (pc + 1 + payloadBytes > runtime.length) fail('truncated_push')
    pc += 1 + payloadBytes
  }
  const masked = Buffer.from(runtime)
  for (const [role, starts] of Object.entries(IMMUTABLE_OPERAND_OFFSETS)) for (const offset of starts) {
    if (!instructionBoundaries.has(offset - 1) || runtime[offset - 1] !== 0x7f) fail('immutable_instruction_boundary')
    if (runtime.subarray(offset, offset + 32).toString('hex') !== values[role]) fail('immutable_' + role)
    masked.fill(0, offset, offset + 32)
  }
  const templateSha256 = sha(masked)
  if (templateSha256 !== TEMPLATE_SHA256) fail('unknown_runtime_template')
  return {
    schema: 'morpho_v2_adapter_runtime_template_classification_v1',
    status: 'conditional_runtime_template_match',
    conditionalMathClass: 'retained_morpho_v2_adapter_immutable_template_v1',
    runtimeBytes: runtime.length,
    deploymentRuntimeSha256: sha(runtime),
    deploymentRuntimeKeccak256: keccak256(runtimeCode),
    templateSha256,
    templatePin: TEMPLATE_SHA256,
    parameters: { parentVault, asset, adapter, adapterAllocationId },
    parameterRoles: Object.entries(IMMUTABLE_OPERAND_OFFSETS).map(([role, operandOffsets]) => ({ role, operandOffsets, pushOpcode: '0x7f', operandBytes: 32 })),
    sourceImplementationEquivalence: false,
    forecastValidated: false,
    minedPaymentObserved: false,
    implementationSourceAttested: false,
  }
}
