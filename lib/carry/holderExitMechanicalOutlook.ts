import type { Address } from 'viem'
import type { HolderExitAssessment } from './holderExitAssessment'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'
import {
  projectResolvedHolderExitMechanicalOutlook,
  type HolderExitMechanicalRequest,
  type HolderExitMechanicalOutlook,
} from './holderExitMechanicalProjection'
import {
  assessSupplementalHolderExitSubject,
  type SupplementalHolderExitSubject,
  type SupplementalEvidenceVerifier,
} from './holderExitSupplementalRegistry'

export * from './holderExitMechanicalProjection'

/** Server boundary: supplemental subjects need independently verified evidence. */
export function projectHolderExitMechanicalOutlook(
  assessment: HolderExitAssessment,
  request: HolderExitMechanicalRequest,
  supplemental?: {
    subject: SupplementalHolderExitSubject
    verifyEvidence: SupplementalEvidenceVerifier
  },
): HolderExitMechanicalOutlook {
  let subject: { kind: string; payoutAsset: Address } | null = null
  try {
    subject = resolveHolderExitSubject(request.routeKey, request.destinationAddress)
  } catch {
    if (supplemental) {
      const checked = assessSupplementalHolderExitSubject(
        supplemental.subject,
        supplemental.verifyEvidence,
      )
      const descriptor = supplemental.subject
      const same = (a: unknown, b: unknown) =>
        typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
      if (
        checked.accepted &&
        checked.capabilities.contractIdentity === 'verified' &&
        checked.capabilities.current === 'evidence_recorded' &&
        descriptor.currentObservation.kind === 'exact_holder_final_payout' &&
        descriptor.chainId === 1 &&
        descriptor.routeKey === request.routeKey &&
        descriptor.contractIdentity.receipt.blockNumber === assessment.source.blockNumber &&
        same(descriptor.contractIdentity.receipt.blockHash, assessment.source.blockHash) &&
        same(descriptor.destinationAddress, request.destinationAddress)
      ) {
        subject = {
          kind: descriptor.mechanism,
          payoutAsset: descriptor.finalPayoutAsset.address as Address,
        }
      }
    }
  }
  return projectResolvedHolderExitMechanicalOutlook(assessment, request, subject)
}
