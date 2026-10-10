import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))

test('the scheduled minute-37 ApyUSD score runs instead of being deferred', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apyusd-score-tick-'))
  try {
    const timeout = join(directory, 'timeout')
    const date = join(directory, 'date')
    const call = join(directory, 'call')
    writeFileSync(timeout, '#!/bin/sh\nprintf "%s\\n" "$*" > "$PUBLIC_APYUSD_TEST_CALL"\n', {
      mode: 0o700,
    })
    writeFileSync(date, '#!/bin/sh\nprintf "37\\n"\n', { mode: 0o700 })
    const result = spawnSync(
      '/bin/sh',
      [join(scripts, 'carry-public-apyusd-exit-tick.sh'), 'score', '--locked'],
      {
        cwd: dirname(scripts),
        env: {
          ...process.env,
          PUBLIC_APYUSD_DATE_BIN: date,
          PUBLIC_APYUSD_TIMEOUT_BIN: timeout,
          PUBLIC_APYUSD_NODE_BIN: '/usr/bin/true',
          PUBLIC_APYUSD_TEST_CALL: call,
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /public-apyusd-exit:score:ok/)
    assert.match(readFileSync(call, 'utf8'), /--score/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
