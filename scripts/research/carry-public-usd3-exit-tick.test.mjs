import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const wrapper = resolve('scripts/carry-public-usd3-exit-tick.sh')

test('a busy USD3 campaign score is reported as unmeasured, while a standalone tick preserves its old no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usd3-campaign-lock-'))
  const env = { ...process.env, TMPDIR: dir }
  const lockHolder = spawn(
    '/usr/bin/python3',
    [
      '-c',
      'import fcntl, os, time; fd=os.open(os.path.join(os.environ["TMPDIR"], "membrane-public-usd3-exit.lock"), os.O_CREAT|os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print("ready", flush=True); time.sleep(10)',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    await new Promise((resolveReady, rejectReady) => {
      lockHolder.once('error', rejectReady)
      lockHolder.once('exit', (code) => rejectReady(Error(`lock holder exited ${code}`)))
      lockHolder.stdout.once('data', (chunk) => {
        if (chunk.toString().includes('ready')) resolveReady()
        else rejectReady(Error('lock holder did not become ready'))
      })
    })
    const campaign = spawnSync('/bin/sh', [wrapper, 'score-campaign'], { env, timeout: 3000 })
    assert.equal(campaign.status, 75)
    assert.match(campaign.stderr.toString(), /public-usd3-exit:busy/)
    assert.doesNotMatch(campaign.stdout.toString(), /score:ok/)

    const standalone = spawnSync('/bin/sh', [wrapper, 'issue'], { env, timeout: 3000 })
    assert.equal(standalone.status, 0)
    assert.match(standalone.stderr.toString(), /public-usd3-exit:busy/)
  } finally {
    lockHolder.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
