// Local campaign: finish bounded issue-3 continuity before one same-episode assay.
import { pathToFileURL } from 'node:url'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  tickContinuity,
  verifyContinuityArchive,
} from './susde-public-pending-continuity-archive.mjs'
import { attestSameEpisode, verifyEpisodes } from './susde-public-pending-payout-v2.mjs'

export async function tickCampaign({ urls, tick = tickContinuity, attest = attestSameEpisode }) {
  const archive = await tick({ issueSequence: 3, urls })
  if (archive.status !== 'complete') return { stage: 'archive', ...archive }
  // Give the last archival window its own bounded run; the next tick starts
  // the attribution assay with a fresh RPC and wall-clock budget.
  if (archive.appended > 0) return { stage: 'archive', ...archive }
  const episode = await attest({ urls })
  return { stage: 'episode', status: episode.status, archiveComplete: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--verify') {
      const [archive, episodes] = await Promise.all([verifyContinuityArchive(), verifyEpisodes()])
      console.log(JSON.stringify({ archive: archive.summary, episodes: episodes.length }))
    } else if (process.argv[2] === '--tick') {
      const result = await tickCampaign({ urls: configuredPublicRpcUrls(readEnv()) })
      console.log(JSON.stringify(result))
      if (
        !['advanced', 'complete', 'attested', 'susde_episode_already_attested'].includes(
          result.status,
        )
      )
        process.exitCode = 1
    } else throw Error('susde_campaign_usage')
  } catch {
    console.error('susde_campaign_failed')
    process.exitCode = 1
  }
}
