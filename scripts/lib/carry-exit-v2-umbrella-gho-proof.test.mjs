import assert from 'node:assert/strict'
import test from 'node:test'
import { collectCarryExitV2RpcProof } from './carry-exit-v2-rpc-collector.mjs'
import { validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'
import {
  UMBRELLA_GHO_STATE_FIELDS,
  umbrellaGhoCalldata,
} from './carry-exit-v2-umbrella-gho-proof.mjs'
import { umbrellaGhoFixture, umbrellaWord } from './carry-exit-v2-umbrella-gho-fixture.mjs'
import { collectUmbrellaGhoV2RpcProof } from './carry-exit-v2-umbrella-gho-collector.mjs'
import { classifyUmbrellaGhoScore } from './carry-exit-v2-umbrella-gho-classifier.mjs'
import { freezeUmbrellaGhoGateTargets } from './carry-exit-v2-umbrella-gho-policy.mjs'
const decode = (f, proof) =>
  validateCarryExitV2RpcProof({
    proof,
    ...f.args,
    blockNumber: '400',
    blockHash: f.target.targetHash,
  })
test('original GHO Q uses rounded required shares and returns exact original asset payout', async () => {
  const f = umbrellaGhoFixture({ q: 2n, required: 3n, slashable: 900n })
  const collected = await collectCarryExitV2RpcProof(f.args),
    d = decode(f, collected.proof)
  assert.equal(d.actualConsumedRaw, '3')
  assert.equal(d.payoutAssetsRaw, '2')
  assert.equal(d.slashableAssetsRaw, '900')
  assert.equal(
    collected.proof.withdrawRpc.request.params[0].data,
    umbrellaGhoCalldata('redeem', [3n, f.args.holder, f.args.holder]),
  )
  for (const field of UMBRELLA_GHO_STATE_FIELDS)
    assert.deepEqual(collected.proof[field].request.params[1], {
      blockHash: f.target.targetHash,
      requireCanonical: true,
    })
})
test('target recalculates shares while original GHO Q remains fixed through slashing conversion', async () => {
  for (const required of [3n, 7n]) {
    const f = umbrellaGhoFixture({ q: 2n, required })
    const c = await collectCarryExitV2RpcProof(f.args)
    assert.equal(c.proof.assetsRaw, '2')
    assert.equal(decode(f, c.proof).requiredCoverageRaw, required.toString())
  }
})
test('successful payout below original Q cannot be verified', async () => {
  const f = umbrellaGhoFixture({ payout: 1n })
  await assert.rejects(collectCarryExitV2RpcProof(f.args), { code: 'decoder_rejected' })
})
test('inclusive snapshot gate boundaries distinguish waiting, eligible revert and expiry', async () => {
  for (const [seconds, gate] of [
    [99, 'waiting'],
    [100, 'window_open'],
    [102, 'window_open'],
    [103, 'window_expired'],
  ]) {
    const f = umbrellaGhoFixture({ seconds, end: 100, window: 2, revert: true })
    const c = await collectCarryExitV2RpcProof(f.args),
      d = decode(f, c.proof)
    assert.equal(d.gate, gate)
    assert.equal(d.coveredRevert, gate === 'window_open')
  }
})
test('paused, unstarted cooldown and insufficient covered Q are not unexplained eligible reverts', async () => {
  for (const [options, gate] of [
    [{ paused: true }, 'paused'],
    [{ end: 0, covered: 0n }, 'cooldown_not_started'],
    [{ required: 102n }, 'insufficient_covered_q'],
  ]) {
    const f = umbrellaGhoFixture({ ...options, revert: true }),
      c = await collectCarryExitV2RpcProof(f.args)
    assert.equal(decode(f, c.proof).gate, gate)
    assert.equal(decode(f, c.proof).coveredRevert, false)
  }
})
test('implementation drift is typed unavailable and mutated raw calls are rejected', async () => {
  const drift = umbrellaGhoFixture({ implementation: `0x${'e'.repeat(40)}` })
  await assert.rejects(collectCarryExitV2RpcProof(drift.args), {
    code: 'implementation_identity_mismatch',
  })
  const f = umbrellaGhoFixture(),
    c = await collectCarryExitV2RpcProof(f.args)
  for (const field of UMBRELLA_GHO_STATE_FIELDS) {
    const proof = structuredClone(c.proof)
    proof[field].request.params[1].requireCanonical = false
    assert.throws(() => decode(f, proof))
  }
  const proof = structuredClone(c.proof)
  proof.withdrawRpc.decodedAssetsRaw = '1'
  assert.throws(() => decode(f, proof))
})
test('both independent origins replay all state and enforce raw/header identity', async () => {
  const f = umbrellaGhoFixture(),
    secondary = []
  const input = {
    ...f.args,
    primary: { url: 'https://one.example', request: f.reply },
    secondary: {
      url: 'https://two.example',
      request: async (r) => {
        secondary.push(r)
        return f.reply(r)
      },
    },
  }
  const result = await measureCarryExitV2Verified(input)
  assert.equal(result.status, 'verified')
  for (const field of UMBRELLA_GHO_STATE_FIELDS)
    assert(result.callEvidenceDoc.replayEvidenceDoc.responses.secondary[field])
  assert(secondary.length >= 20)
  assert.equal(
    (
      await measureCarryExitV2Verified({
        ...input,
        secondary: { url: 'https://www.one.example', request: async (r) => f.reply(r) },
      })
    ).status,
    'unavailable',
  )
  const changed = await measureCarryExitV2Verified({
    ...input,
    secondary: {
      url: 'https://two.example',
      request: async (r) => {
        const response = await f.reply(r)
        if (
          r.method === 'eth_call' &&
          r.params[0].data === umbrellaGhoCalldata('getMaxSlashableAssets')
        )
          response.result = umbrellaWord(999n)
        return response
      },
    },
  })
  assert.equal(changed.status, 'unavailable')
})
test('old one-share inputs cannot enter the original-GHO proof path', () => {
  const f = umbrellaGhoFixture()
  assert.throws(() => collectUmbrellaGhoV2RpcProof({ ...f.args, sharesRaw: '1000000000000000000' }))
})
test('holder attrition is original-Q claim loss, while eligible unexplained revert stays covered', async () => {
  for (const [options, wanted] of [
    [{ balance: 2n, covered: 2n, required: 3n, claim: 1n, revert: true }, 'holder_attrition'],
    [{ revert: true }, 'covered_revert'],
  ]) {
    const f = umbrellaGhoFixture(options),
      verified = await measureCarryExitV2Verified({
        ...f.args,
        primary: { url: 'https://one.example', request: f.reply },
        secondary: { url: 'https://two.example', request: async (r) => f.reply(r) },
      })
    assert.equal(verified.status, 'verified')
    const score = classifyUmbrellaGhoScore({
      core: {},
      target: f.target,
      verified,
      row: f.args,
      capturedAt: f.args.now().toISOString(),
    })
    assert.equal(score.status, wanted)
    assert.equal(score.simulationStatus, wanted === 'holder_attrition' ? null : 'evm_revert')
  }
})
test('known snapshot opening after 168h and post-expiry get sealed conditional targets', async () => {
  const f = umbrellaGhoFixture({ end: 1791331212 + 20 * 86400, revert: true }),
    collected = await collectCarryExitV2RpcProof(f.args),
    decoded = decode(f, collected.proof)
  const projection = freezeUmbrellaGhoGateTargets(decoded, f.args.now().toISOString())
  assert.equal(projection.insideWindowH, 481)
  assert.equal(projection.afterExpiryH, 528)
  assert.deepEqual(projection.horizons, [1, 4, 24, 48, 168, 481, 528])
  assert.equal(decoded.cooldownSeconds, '1728000')
  assert.equal(decoded.unstakeWindowSeconds, '172800')
  const noCooldown = freezeUmbrellaGhoGateTargets(
    { ...decoded, cooldownEndSeconds: '0', windowEndInclusiveSeconds: '0' },
    f.args.now().toISOString(),
  )
  assert.equal(noCooldown.insideWindowH, null)
  assert.equal(noCooldown.afterExpiryH, null)
})
test('a fabricated target timestamp cannot pass two-origin header replay', async () => {
  const f = umbrellaGhoFixture(),
    bad = structuredClone(f.target)
  bad.targetBlockAt = new Date(Date.parse(bad.targetBlockAt) + 1000).toISOString()
  bad.canonicalityEvidenceDoc.targetHeader.timestamp = bad.targetBlockAt
  const result = await measureCarryExitV2Verified({
    ...f.args,
    target: bad,
    primary: { url: 'https://one.example', request: f.reply },
    secondary: { url: 'https://two.example', request: async (r) => f.reply(r) },
  })
  assert.equal(result.status, 'unavailable')
})
