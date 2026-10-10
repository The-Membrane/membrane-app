import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tickCampaign } from './susde-public-pending-campaign.mjs'

test('campaign waits for complete archive and gives the final window a separate run', async () => {
  let attestations = 0
  const attest = async () => {
    attestations++
    return { status: 'attested' }
  }
  const incomplete = await tickCampaign({
    urls: [],
    tick: async () => ({ status: 'advanced', appended: 8, complete: false }),
    attest,
  })
  assert.equal(incomplete.stage, 'archive')
  const finalWindow = await tickCampaign({
    urls: [],
    tick: async () => ({ status: 'complete', appended: 2, complete: true }),
    attest,
  })
  assert.equal(finalWindow.stage, 'archive')
  assert.equal(attestations, 0)
  const done = await tickCampaign({
    urls: [],
    tick: async () => ({ status: 'complete', complete: true }),
    attest,
  })
  assert.deepEqual(done, { stage: 'episode', status: 'attested', archiveComplete: true })
  assert.equal(attestations, 1)
})
