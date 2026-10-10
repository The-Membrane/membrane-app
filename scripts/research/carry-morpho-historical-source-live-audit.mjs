// Independent, read-only RPC recheck of one sealed historical Transfer candidate.
// This authenticates its source at audit time; the offline issue replay is structural.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  MORPHO_HISTORICAL_TRANSFER_SCHEMA,
  auditMorphoHistoricalTransferCandidateLive,
} from '../lib/carry-exit-v2-morpho-historical-transfer-candidate.mjs'
import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { readV2Issues } from './carry-local-morpho-holder-v2.mjs'

export async function auditHistoricalIssue(
  sequence,
  { urls = null, readIssues = readV2Issues } = {},
) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw Error('historical_issue_invalid')
  const issue = (await readIssues())[sequence - 1]
  if (
    issue?.sequence !== sequence ||
    issue.candidate?.evidenceDoc?.schema !== MORPHO_HISTORICAL_TRANSFER_SCHEMA
  )
    throw Error('historical_issue_missing')
  const configured = urls ?? configuredPublicRpcUrls({ get: readEnv().get })
  const alchemy = configured.find((url) => new URL(url).hostname.includes('alchemy'))
  const ankr = configured.find((url) => new URL(url).hostname.includes('ankr'))
  if (!alchemy || !ankr) throw Error('historical_audit_origins_missing')
  const [primary, secondary] = publicRpcClients([alchemy, ankr])
  const result = await auditMorphoHistoricalTransferCandidateLive(
    issue.candidate.evidenceDoc,
    primary,
    secondary,
  )
  return { issueSequence: sequence, ...result }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  auditHistoricalIssue(Number(process.argv[2]))
    .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch((error) => {
      const code = /^[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'unavailable'
      process.stderr.write(`historical_source_audit_failed:${code}\n`)
      process.exitCode = 1
    })
