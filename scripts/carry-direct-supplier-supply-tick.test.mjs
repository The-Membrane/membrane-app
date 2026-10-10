import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const WRAPPER = 'scripts/carry-direct-supplier-supply-tick.sh'
const PLIST = 'scripts/launchd/com.membrane.carry-direct-supplier-supply.plist'

test('low disk skips before either collector binary starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-supply-guard-'))
  const marker = join(dir, 'child-started')
  const fake = join(dir, 'unexpected-child')
  const statusPath = join(dir, 'status.json')
  try {
    writeFileSync(fake, '#!/bin/sh\nprintf started > "$DIRECT_SUPPLY_CHILD_MARKER"\nexit 99\n', {
      mode: 0o700,
    })
    chmodSync(fake, 0o700)
    const child = spawnSync('/bin/sh', [WRAPPER], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        TMPDIR: dir,
        DIRECT_SUPPLY_TEST_MODE: '1',
        DIRECT_SUPPLY_TEST_FREE_BYTES: '0',
        DIRECT_SUPPLY_NODE_BIN: fake,
        DIRECT_SUPPLY_TIMEOUT_BIN: fake,
        DIRECT_SUPPLY_CHILD_MARKER: marker,
        DIRECT_SUPPLY_TEST_STATUS_PATH: statusPath,
      },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stderr, /direct-supplier-supply:disk-reserve/)
    assert.equal(child.stdout, '')
    assert.equal(existsSync(marker), false)
    const statusText = readFileSync(statusPath, 'utf8')
    const status = JSON.parse(statusText)
    assert.ok(statusText.length < 4096)
    assert.equal(statSync(statusPath).mode & 0o777, 0o600)
    assert.deepEqual(status, {
      completedAtUtc: status.completedAtUtc,
      disk: { afterSupply: 'not_checked', start: 'blocked' },
      exitStatus: 0,
      schema: 'carry-direct-supplier-supply-tick-status-v1',
      stages: {
        supply: { exitStatus: null, status: 'not_attempted' },
        withdrawal: { exitStatus: null, status: 'not_attempted' },
      },
      startedAtUtc: status.startedAtUtc,
      status: 'disk_reserve',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one native tick runs bounded Supply then capped Withdraw through its existing lock', (t) => {
  const space = statfsSync('data/research/venue-signals')
  if (space.bavail * space.bsize < 2 * 1024 ** 3) {
    t.skip('the production disk reserve is below the capture threshold')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'direct-gross-flow-'))
  const marker = join(dir, 'order')
  const fakeNode = join(dir, 'node')
  const fakeTimeout = join(dir, 'timeout')
  const statusPath = join(dir, 'status.json')
  try {
    writeFileSync(
      fakeNode,
      '#!/bin/sh\ncase "$*" in\n  *record-carry-direct-supplier-supply.mjs*) echo supply >> "$DIRECT_SUPPLY_CHILD_MARKER"; if [ "${DIRECT_SUPPLY_FAIL:-0}" = 1 ]; then exit 7; fi ;;\n  *record-carry-direct-supplier-flow.mjs*) echo "withdraw:$DIRECT_FLOW_MAX_SEGMENTS_PER_MARKET_TICK" >> "$DIRECT_SUPPLY_CHILD_MARKER" ;;\n  *) exit 99 ;;\nesac\n',
      { mode: 0o700 },
    )
    writeFileSync(fakeTimeout, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 })
    const child = spawnSync('/bin/sh', [WRAPPER], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        TMPDIR: dir,
        DIRECT_SUPPLY_TEST_MODE: '1',
        DIRECT_SUPPLY_TEST_FREE_BYTES: String(Math.floor(2.5 * 1024 ** 3)),
        DIRECT_SUPPLY_NODE_BIN: fakeNode,
        DIRECT_SUPPLY_TIMEOUT_BIN: fakeTimeout,
        DIRECT_SUPPLY_TEST_STATUS_PATH: statusPath,
        DIRECT_FLOW_NODE_BIN: fakeNode,
        DIRECT_FLOW_TIMEOUT_BIN: fakeTimeout,
        DIRECT_SUPPLY_CHILD_MARKER: marker,
        RECORDER_RPC_URLS: 'https://provider.invalid/private-test-key',
      },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['supply', 'withdraw:2'])
    assert.match(child.stdout, /direct-supplier-flow:supplemental-ok/)
    const successStatus = JSON.parse(readFileSync(statusPath, 'utf8'))
    assert.equal(successStatus.status, 'complete')
    assert.equal(successStatus.exitStatus, 0)
    assert.deepEqual(successStatus.disk, { start: 'supplemental', afterSupply: 'supplemental' })
    assert.deepEqual(successStatus.stages, {
      supply: { status: 'ok', exitStatus: 0 },
      withdrawal: { status: 'supplemental_ok', exitStatus: 0 },
    })
    assert.equal(JSON.stringify(successStatus).includes('private-test-key'), false)

    writeFileSync(marker, '')
    const failedSupply = spawnSync('/bin/sh', [WRAPPER], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        TMPDIR: dir,
        DIRECT_SUPPLY_TEST_MODE: '1',
        DIRECT_SUPPLY_TEST_FREE_BYTES: String(Math.floor(2.5 * 1024 ** 3)),
        DIRECT_SUPPLY_NODE_BIN: fakeNode,
        DIRECT_SUPPLY_TIMEOUT_BIN: fakeTimeout,
        DIRECT_SUPPLY_TEST_STATUS_PATH: statusPath,
        DIRECT_FLOW_NODE_BIN: fakeNode,
        DIRECT_FLOW_TIMEOUT_BIN: fakeTimeout,
        DIRECT_SUPPLY_CHILD_MARKER: marker,
        DIRECT_SUPPLY_FAIL: '1',
      },
    })
    assert.equal(failedSupply.status, 1)
    assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['supply', 'withdraw:2'])
    assert.match(failedSupply.stderr, /direct-supplier-supply:tick-failed/)
    const failedStatus = JSON.parse(readFileSync(statusPath, 'utf8'))
    assert.equal(failedStatus.status, 'failed')
    assert.equal(failedStatus.exitStatus, 1)
    assert.deepEqual(failedStatus.stages, {
      supply: { status: 'failed', exitStatus: 7 },
      withdrawal: { status: 'supplemental_ok', exitStatus: 0 },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrapper parses and native schedule stays bounded and quiet', () => {
  const shell = spawnSync('/bin/sh', ['-n', WRAPPER], { cwd: process.cwd() })
  assert.equal(shell.status, 0)
  const plistLint = spawnSync('/usr/bin/plutil', ['-lint', PLIST], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(plistLint.status, 0, plistLint.stderr)
  const plist = readFileSync(PLIST, 'utf8')
  const args = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1]
  assert.ok(args)
  assert.match(args, /<string>\/bin\/sh<\/string>/)
  assert.doesNotMatch(args, /timeout/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
  assert.equal((plist.match(/<dict><key>Minute<\/key>/g) ?? []).length, 4)
  assert.equal((plist.match(/<string>\/dev\/null<\/string>/g) ?? []).length, 2)
})
