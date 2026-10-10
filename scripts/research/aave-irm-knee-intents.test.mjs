import test from 'node:test'
import assert from 'node:assert/strict'
import { extractRows, extractIntents } from './aave-irm-knee-intents.mjs'

const table = `| Instance | Asset | Current Optimal Utilization | Recommended Optimal Utilization |
|----------|-------|----------------------------:|--------------------------------:|
| Aave V3 Core | USDC | 92\\.00% | 94\\.00% |
| Aave V3 Core | USDT | 94\\.00% | 93\\.00% |
| Aave V3 Base | WETH | 90\\.00% | 92\\.00% |`

test('extracts explicit multi-instance up and down recommendations', () => {
  const rows = extractRows(table)
  assert.deepEqual(
    rows.map(({ instance, asset, changePp, direction }) => [instance, asset, changePp, direction]),
    [
      ['Aave V3 Core', 'USDC', 2, 'up'],
      ['Aave V3 Core', 'USDT', -1, 'down'],
      ['Aave V3 Base', 'WETH', 2, 'up'],
    ],
  )
})

test('accepts the alternate Optimal Usage Ratio heading', () => {
  const rows = extractRows(table.replaceAll('Optimal Utilization', 'Optimal Usage Ratio'))
  assert.equal(rows.length, 3)
  assert.equal(rows[1].direction, 'down')
})

test('does not infer intent from prose or ambiguous table rows', () => {
  assert.deepEqual(extractRows('Increase optimalUsageRatio for USDC from 92% to 94%.'), [])
  const rows = extractRows(
    `${table}\n| Aave V3 Core | USDC | 92% | 95% |\n| Aave V3 Core | USDC | 92% | 94% |`,
  )
  assert.equal(rows[0].kind, 'ambiguous')
  assert.equal(rows.at(-1).kind, 'ambiguous')
})

test('keeps each version and uses local fetch time, not forum creation time', () => {
  const posts = [1, 2].map((version) => ({
    topicId: 7,
    postId: 8,
    version,
    raw: table.replace('94\\.00%', version === 1 ? '94\\.00%' : '95\\.00%'),
    rawSha256: `hash-${version}`,
    fetchedAt: `2026-09-25T22:33:0${version}.000Z`,
    createdAt: '2026-08-31T00:00:00.000Z',
  }))
  const rows = extractIntents({ postSnapshots: posts })
  assert.equal(rows.length, 6)
  assert.equal(rows[0].firstEvidenceAt, '2026-09-25T22:33:01.000Z')
  assert.equal(rows[0].forumCreatedAtNotEvidence, '2026-08-31T00:00:00.000Z')
  assert.equal(rows[3].version, 2)
})
