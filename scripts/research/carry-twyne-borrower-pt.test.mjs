import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  COLLATERAL_VAULTS,
  HORIZONS,
  Q_RAW,
  ROUTE,
  SEED_SHA256,
  assayPair,
  issue,
  publicCounts,
  readChain,
  score,
  verifyLedgers,
} from './carry-twyne-borrower-pt.mjs'

const hash = `0x${'a'.repeat(64)}`
const nextHash = `0x${'b'.repeat(64)}`
const borrower = `0x${'1'.repeat(40)}`
const otherBorrower = `0x${'2'.repeat(40)}`
const cv = COLLATERAL_VAULTS[0]
const temp = () => mkdtempSync(join(tmpdir(), 'twyne-borrower-pt-'))
const start = Date.parse('2026-10-01T12:00:00.000Z')

function clientRef() {
  const current = { number: 100, hash, timestamp: start / 1000 - 60 }
  return {
    current,
    client: {
      getBlock: async () => ({
        number: BigInt(current.number),
        hash: current.hash,
        timestamp: BigInt(current.timestamp),
      }),
    },
  }
}

function measurement(block, controller = borrower, status = 'observed') {
  return {
    status,
    ...(status === 'observed' ? {} : { reason: 'credit_reserved' }),
    routeKey: ROUTE,
    collateralVault: cv,
    borrower: controller,
    requestedPtRaw: Q_RAW,
    evidence: {
      chainId: 1,
      blockNumber: block.number,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
      source: 'ethereum_finalized_eip1898_eth_call',
      firstLeg: 'twyne_cv_redeem_underlying_pt',
      receiver: 'borrower',
      borrowerKeyControl: 'unassessed',
      finalUsdePayout: 'unassessed',
      deploymentSourceEquivalence: 'unassessed',
      returnedPtRaw: status === 'observed' ? Q_RAW : null,
    },
  }
}

test('frozen 16 CVs and two origins bind one PT Q at a common finalized hash', async () => {
  assert.equal(COLLATERAL_VAULTS.length, 16)
  assert.equal(SEED_SHA256.length, 64)
  assert.deepEqual(HORIZONS, [1, 4, 24, 168])
  const { current, client } = clientRef()
  const read = async (pinned, request, deployment) => {
    assert.equal(request.collateralVault, cv)
    assert.equal(request.requestedPtRaw, Q_RAW)
    assert.equal(pinned.getBlock !== undefined, true)
    assert.equal(deployment.factory.toLowerCase(), '0xa1517cce0be75700a8838ea1cee0dc383cd3a332')
    return measurement(current)
  }
  const result = await assayPair([client, client], current, cv, read)
  assert.equal(result.borrower, borrower)
  assert.equal(result.evidence.blockHash, hash)
  let calls = 0
  await assert.rejects(
    assayPair([client, client], current, cv, async () => {
      calls++
      return measurement(current, calls === 2 ? otherBorrower : borrower)
    }),
    /assay_origin_disagreement/,
  )
})

test('issue and future score preserve exact CV, borrower, Q and seed binding', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    const clients = [client, client]
    const read = async () => measurement(current)
    const issued = await issue({
      clients,
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read,
    })
    assert.equal(issued.status, 'issued')
    assert.equal(
      (await issue({ clients, root, nowMs: start, clock: () => start, collateralVault: cv, read }))
        .status,
      'already_issued',
    )
    const later = start + 1_800_000
    assert.equal(
      (await issue({ clients, root, nowMs: later, clock: () => later, collateralVault: cv, read }))
        .status,
      'already_issued_on_block',
    )
    assert.equal(readChain('issues', root).length, 1)
    const first = readChain('issues', root)[0]
    assert.equal(first.seedSha256, SEED_SHA256)
    assert.equal(first.collateralVault, cv)
    assert.equal(first.borrower, borrower)
    assert.equal(first.qRaw, Q_RAW)
    assert.equal(first.baseline.hash, hash)
    assert.equal(first.targets.length, 4)
    assert.equal(publicCounts(root).holderExitForecastValidated, false)

    current.number = 110
    current.hash = nextHash
    current.timestamp = (start + 3_660_000) / 1000
    const at = start + 3_720_000
    const scored = await score({ clients, root, nowMs: at, clock: () => at, read })
    assert.equal(scored.status, 'measured')
    assert.equal(scored.outcome, 'pt_first_leg_simulated')
    const row = readChain('scores', root)[0]
    assert.equal(row.issueKey, first.issueKey)
    assert.equal(row.issueSha256, first.sha256)
    assert.equal(row.collateralVault, cv)
    assert.equal(row.borrower, borrower)
    assert.equal(row.qRaw, Q_RAW)
    assert.equal(row.measurement.evidence.blockHash, nextHash)
    assert.equal(verifyLedgers(root).scores.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('controller changes are a separate measured outcome, not same-actor success', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    const clients = [client, client]
    await issue({
      clients,
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    current.number = 110
    current.hash = nextHash
    current.timestamp = (start + 3_660_000) / 1000
    const at = start + 3_720_000
    const result = await score({
      clients,
      root,
      nowMs: at,
      clock: () => at,
      read: async () => measurement(current, otherBorrower),
    })
    assert.equal(result.outcome, 'controller_changed')
    assert.equal(publicCounts(root).controllerChanges, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('zero-share CV can issue a restricted first-leg baseline without claiming exit', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    const result = await issue({
      clients: [client, client],
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => {
        const row = measurement(current, borrower, 'restricted')
        row.reason = 'position_insufficient'
        row.evidence.wrapperBalanceRaw = '0'
        row.evidence.previewSharesRaw = Q_RAW
        return row
      },
    })
    assert.equal(result.status, 'issued')
    const saved = readChain('issues', root)[0]
    assert.equal(saved.measurement.status, 'restricted')
    assert.equal(saved.measurement.reason, 'position_insufficient')
    assert.equal(saved.measurement.evidence.wrapperBalanceRaw, '0')
    assert.equal(publicCounts(root).holderExitForecastValidated, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('physical outcome after deadline is censored, not a failed exit', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    const clients = [client, client]
    await issue({
      clients,
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    current.number = 200
    current.hash = nextHash
    current.timestamp = (start + 3 * 3_600_000 + 60_000) / 1000
    const at = current.timestamp * 1000 + 60_000
    const result = await score({
      clients,
      root,
      nowMs: at,
      clock: () => at,
      read: async () => {
        throw Error('should_not_assay')
      },
    })
    assert.equal(result.status, 'censored')
    const row = readChain('scores', root)[0]
    assert.equal(row.reason, 'missed_physical_window')
    assert.equal(row.measurement, null)
    assert.equal(Object.hasOwn(row, 'outcome'), false)
    assert.equal(publicCounts(root).censored, 1)
    const path = join(root, 'scores', '00000001.json')
    const forgedBody = { ...row, outcome: 'controller_changed' }
    delete forgedBody.sha256
    writeFileSync(
      path,
      `${JSON.stringify({
        ...forgedBody,
        sha256: createHash('sha256').update(JSON.stringify(forgedBody)).digest('hex'),
      })}\n`,
    )
    assert.equal(readChain('scores', root)[0].outcome, 'controller_changed')
    assert.throws(() => verifyLedgers(root), /score_censor/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chain time slightly ahead cannot censor before local deadline', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    const clients = [client, client]
    await issue({
      clients,
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    current.number = 200
    current.hash = nextHash
    current.timestamp = (start + 3 * 3_600_000 + 60_000) / 1000
    const at = start + 3 * 3_600_000 - 30_000
    const result = await score({
      clients,
      root,
      nowMs: at,
      clock: () => at,
      read: async () => {
        throw Error('should_not_assay')
      },
    })
    assert.equal(result.status, 'target_not_finalized')
    assert.equal(readChain('scores', root).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ledger replay rejects altered issue binding', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    await issue({
      clients: [client, client],
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    const path = join(root, 'issues', '00000001.json')
    const row = JSON.parse(readFileSync(path, 'utf8'))
    row.qRaw = '2'
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    assert.throws(() => verifyLedgers(root), /ledger_chain/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('interrupted append temp does not brick ledger replay', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    await issue({
      clients: [client, client],
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    const path = join(root, 'issues', '.twyne-borrower-11111111-1111-4111-8111-111111111111.tmp')
    writeFileSync(path, 'incomplete append')
    assert.equal(verifyLedgers(root).issues.length, 1)
    writeFileSync(join(root, 'issues', 'unknown.tmp'), 'unexpected')
    assert.throws(() => verifyLedgers(root), /ledger_filename/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('open score window takes priority over expired backlog', async () => {
  const root = temp()
  try {
    const { current, client } = clientRef()
    const clients = [client, client]
    await issue({
      clients,
      root,
      nowMs: start,
      clock: () => start,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    const secondAt = start + 6 * 3_600_000
    current.number = 110
    current.hash = nextHash
    current.timestamp = secondAt / 1000 - 60
    await issue({
      clients,
      root,
      nowMs: secondAt,
      clock: () => secondAt,
      collateralVault: cv,
      read: async () => measurement(current),
    })
    const scoreAt = start + 7 * 3_600_000 + 120_000
    current.number = 120
    current.hash = `0x${'c'.repeat(64)}`
    current.timestamp = scoreAt / 1000 - 60
    const result = await score({
      clients,
      root,
      nowMs: scoreAt,
      clock: () => scoreAt,
      read: async () => measurement(current),
    })
    assert.equal(result.status, 'measured')
    assert.equal(readChain('scores', root)[0].issueSequence, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
