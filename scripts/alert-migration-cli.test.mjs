import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scripts = ['apply-user-alerts-ddl.mjs', 'apply-personal-alert-outbox-ddl.mjs']
const sentinel = 'secret-do-not-print'

function invoke(script, args, dedicatedUrl = '') {
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://${sentinel}@invalid.example/test`,
    DATABASE_URL_UNPOOLED: `postgresql://${sentinel}@invalid.example/test`,
    USER_ALERT_MIGRATION_DATABASE_URL: dedicatedUrl,
  }
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

for (const script of scripts) {
  test(`${script} is inert without --run, even with generic database URLs`, () => {
    for (const args of [[], ['--help'], ['--dry-run']]) {
      const result = invoke(script, args, `postgresql://${sentinel}@invalid.example/dedicated`)
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /No database connection or SQL executed/)
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel))
    }
  })

  test(`${script} rejects --run without its dedicated URL before connecting`, () => {
    const result = invoke(script, ['--run'])
    assert.equal(result.error, undefined)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /USER_ALERT_MIGRATION_DATABASE_URL is required/)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel))
  })

  test(`${script} rejects unknown and combined flags before connecting`, () => {
    for (const args of [['--apply'], ['--run', '--dry-run']]) {
      const result = invoke(script, args)
      assert.equal(result.error, undefined)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /Usage:/)
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel))
    }
  })
}
