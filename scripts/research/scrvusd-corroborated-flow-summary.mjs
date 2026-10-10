// Read-only historical vault flow context. A URL-bound second RPC comparison
// supports event-set agreement; it does not attest provider ownership, exit
// executability, or a future withdrawal runway.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  HISTORICAL_OUT as PRIMARY_OUT,
  readValidatedReceipts,
  sourceIdentity,
} from './curve-vault-flow-ledger.mjs'
import { summarizeReceipts } from './curve-vault-flow-summary.mjs'
import { auditSidecars, OUT as SIDECAR_OUT } from './scrvusd-flow-second-provider.mjs'

export const STUDY = 'scrvusd-corroborated-historical-flow-summary-v1'

const unavailable = (reason, detail = null) => ({ status: 'unavailable', reason, detail })

export function summarizeCorroboratedFlow({
  primaryOut = PRIMARY_OUT,
  sidecarOut = SIDECAR_OUT,
  source = sourceIdentity(),
} = {}) {
  const receipts = readValidatedReceipts({ out: primaryOut, source })
  if (!receipts.length)
    return {
      study: STUDY,
      source,
      historical: unavailable('no_primary_receipts'),
      current: unavailable('no_current_contiguous_coverage'),
    }

  // auditSidecars rereads the *entire* primary directory and checks the exact
  // physical receipts. Never pass a hand-picked historical subset here.
  const audit = auditSidecars({ receipts, out: sidecarOut, primaryOut, source })
  if (!audit.certified)
    return {
      study: STUDY,
      source,
      historical: unavailable(audit.reason, audit),
      current: unavailable('uncorroborated_current_coverage'),
    }

  const observed = summarizeReceipts({ receipts, source })
  return {
    study: STUDY,
    source,
    corroboration: audit,
    operatorIndependence: 'unverified',
    historical: {
      status: 'research_only',
      evidenceLevel: 'local_event_agreement_without_provider_attestation',
      publishable: false,
      forecastEligible: false,
      scope: 'complete_contiguous_primary_directory_with_distinct_https_rpc_url_event_agreement',
      coverage: observed.coverage,
      totals: observed.totals,
      maximumObservedCompleteWindow: observed.maximumObservedCompleteWindow,
      maximumObservedCompleteWindowNetDepletion: observed.maximumObservedCompleteWindowNetDepletion,
      meaning: 'past_vault_event_flow_only_no_exit_capacity_or_duration',
    },
    // Even a contiguous event history cannot establish holder-executable exit
    // ability now. The archive ends before the separate live ledger starts.
    current: unavailable('archive_to_live_bridge_or_holder_executability_unproven'),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error('Corroborated flow summary takes no CLI options')
    process.exitCode = 1
  } else {
    try {
      console.log(JSON.stringify(summarizeCorroboratedFlow()))
    } catch {
      console.error('Corroborated flow summary unavailable')
      process.exitCode = 1
    }
  }
}
