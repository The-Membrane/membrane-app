/** Future holder-exit subjects live outside the pinned August 25/67 catalog. */
export const SUPPLEMENTAL_HOLDER_EXIT_REGISTRY_VERSION = 'holder-exit-supplemental-v1' as const

export type SupplementalEvidenceRef = {
  sourceId: string
  contentSha256: string
}

export type SupplementalCapability = {
  state: 'unavailable' | 'configured' | 'evidence_recorded'
  /** An adapter is required once collection is configured. */
  adapterId: string | null
  /** A recorded capability needs a source that can be checked independently. */
  evidenceRef: SupplementalEvidenceRef | null
}

export type SupplementalStage = {
  stageId: string
  kind: 'atomic_exit' | 'request' | 'wait' | 'claim' | 'conversion' | 'final_asset_delivery'
  adapterId: string
  adapterVersion: string
  inputAssetAddress: string
  outputAssetAddress: string
}

export type SupplementalContractIdentity = {
  kind: 'direct' | 'proxy'
  destinationCodeHash: string
  receipt: SupplementalEvidenceRef & {
    chainId: number
    blockNumber: number
    blockHash: string
    destinationAddress: string
    destinationCodeHash: string
    implementationAddress: string | null
    implementationCodeHash: string | null
  }
  implementationAddress: string | null
  implementationCodeHash: string | null
}

export type SupplementalHolderExitSubject = {
  subjectVersion: string
  protocolId: string
  chainId: number
  routeKey: string
  routeVersion: string
  destinationAddress: string
  contractIdentity: SupplementalContractIdentity
  inputAsset: { address: string; decimals: number }
  finalPayoutAsset: { address: string; decimals: number }
  mechanism: 'atomic' | 'staged'
  /** Exact asset path. Staged routes start with request or immediate conversion, never wait. */
  stages: SupplementalStage[]
  currentObservation: SupplementalCapability & {
    kind: 'exact_holder_final_payout' | 'aggregate_proxy'
  }
  historicalAssay: SupplementalCapability & {
    family: 'loss_by_h' | 'exact_target_ability' | 'duration_after_loss'
    holderSelectionVersion: string
    fixedQRaw: string[]
    horizonSeconds: number[]
  }
  grossFlow: {
    deposits: SupplementalCapability
    withdrawals: SupplementalCapability
    net: SupplementalCapability
    intervalMaximum: SupplementalCapability
    endpointReconciliation: SupplementalCapability
    intervalSeconds: number
  }
  /** Expected flow is a distribution/estimate, never a holder withdrawal promise. */
  expectedFlow: {
    semantics: 'unavailable' | 'historical_distribution' | 'prospective_estimate'
    unitAssetAddress: string
  }
  /** Maximum flow is a completed historical interval, not executable holder capacity. */
  maximumFlow: {
    semantics: 'unavailable' | 'historical_observed_interval'
    unitAssetAddress: string
  }
  newsEventSources: {
    state: 'unavailable' | 'configured' | 'evidence_recorded'
    sources: Array<{
      id: string
      kind: 'governance' | 'protocol' | 'onchain_event'
      reference: string
      evidenceRef: SupplementalEvidenceRef | null
    }>
  }
  /** Descriptive only; this registry has no authority to validate a forecast. */
  validationState: 'not_started' | 'collecting' | 'holdout_pending' | 'external_review'
}

export type SupplementalHolderExitRegistry = {
  version: typeof SUPPLEMENTAL_HOLDER_EXIT_REGISTRY_VERSION
  subjects: SupplementalHolderExitSubject[]
}

export type SupplementalReadinessReason =
  | 'schema_version_invalid'
  | 'subjects_invalid'
  | 'duplicate_subject'
  | 'identity_incomplete'
  | 'contract_identity_invalid'
  | 'asset_identity_invalid'
  | 'mechanism_invalid'
  | 'stage_adapter_invalid'
  | 'current_observation_invalid'
  | 'historical_assay_invalid'
  | 'gross_flow_invalid'
  | 'flow_semantics_invalid'
  | 'flow_semantics_unverified'
  | 'news_event_sources_invalid'
  | 'validation_state_invalid'
  | 'current_exact_holder_observation_missing'
  | 'current_observation_only_proxy'
  | 'historical_assay_missing'
  | 'gross_flow_incomplete'
  | 'expected_flow_unavailable'
  | 'expected_flow_prospective_unvalidated'
  | 'maximum_flow_unavailable'
  | 'news_event_source_missing'
  | 'prospective_validation_missing'
  | 'contract_identity_unverified'
  | 'current_observation_evidence_unverified'
  | 'historical_assay_evidence_unverified'
  | 'gross_flow_evidence_unverified'
  | 'news_event_evidence_unverified'

/** The caller must check the referenced source bytes and content hash out of band. */
export type SupplementalEvidenceVerifier = (
  reference: SupplementalEvidenceRef,
  context: {
    role: string
    chainId: number
    routeKey: string
    destinationAddress: string
    destinationCodeHash: string
    implementationAddress: string | null
    implementationCodeHash: string | null
    blockNumber: number
    blockHash: string
  },
) => boolean

export type SupplementalSubjectAssessment = {
  accepted: boolean
  /** Identity only: a declared recorded state is never echoed as verified evidence. */
  subject: Pick<SupplementalHolderExitSubject, 'chainId' | 'routeKey' | 'destinationAddress'> | null
  reasons: SupplementalReadinessReason[]
  capabilities: {
    contractIdentity: 'unverified' | 'verified'
    current: 'unavailable' | 'proxy_only' | 'configured' | 'evidence_recorded'
    historicalAssay: 'unavailable' | 'configured' | 'evidence_recorded'
    grossFlow: 'unavailable' | 'partial' | 'configured' | 'evidence_recorded'
    newsEvents: 'unavailable' | 'configured' | 'evidence_recorded'
  }
  /** Forecast eligibility is decided by a separate prospective evidence verifier. */
  forecast: 'abstain'
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const CONTENT_SHA256 = /^sha256:[0-9a-f]{64}$/
const RAW_AMOUNT = /^(0|[1-9][0-9]*)$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const named = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value
const address = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS.test(value) && value !== '0x' + '0'.repeat(40)
const nonzeroHash = (value: unknown): value is string =>
  typeof value === 'string' && HASH.test(value) && value !== '0x' + '0'.repeat(64)
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0
const oneOf = (value: unknown, values: readonly string[]): boolean =>
  typeof value === 'string' && values.includes(value)

function validEvidenceRef(value: unknown): boolean {
  return (
    object(value) &&
    named(value.sourceId) &&
    typeof value.contentSha256 === 'string' &&
    CONTENT_SHA256.test(value.contentSha256)
  )
}

function validContractIdentity(
  value: unknown,
  chainId: unknown,
  destinationAddress: unknown,
): boolean {
  if (
    !object(value) ||
    !oneOf(value.kind, ['direct', 'proxy']) ||
    !nonzeroHash(value.destinationCodeHash) ||
    !object(value.receipt) ||
    !validEvidenceRef(value.receipt) ||
    value.receipt.chainId !== chainId ||
    !positive(value.receipt.blockNumber) ||
    !nonzeroHash(value.receipt.blockHash) ||
    value.receipt.destinationAddress !== destinationAddress ||
    value.receipt.destinationCodeHash !== value.destinationCodeHash ||
    value.receipt.implementationAddress !== value.implementationAddress ||
    value.receipt.implementationCodeHash !== value.implementationCodeHash
  )
    return false
  return value.kind === 'proxy'
    ? address(value.implementationAddress) && nonzeroHash(value.implementationCodeHash)
    : value.implementationAddress === null && value.implementationCodeHash === null
}

function validAsset(value: unknown): boolean {
  return (
    object(value) &&
    address(value.address) &&
    Number.isInteger(value.decimals) &&
    Number(value.decimals) >= 0 &&
    Number(value.decimals) <= 36
  )
}

function validCapability(value: unknown): boolean {
  if (!object(value) || !oneOf(value.state, ['unavailable', 'configured', 'evidence_recorded']))
    return false
  if (value.state === 'unavailable') return value.adapterId === null && value.evidenceRef === null
  if (!named(value.adapterId)) return false
  return value.state === 'configured'
    ? value.evidenceRef === null
    : validEvidenceRef(value.evidenceRef)
}

const STAGE_ORDER: Record<SupplementalStage['kind'], number> = {
  atomic_exit: 0,
  request: 0,
  wait: 1,
  claim: 2,
  conversion: 3,
  final_asset_delivery: 4,
}

function validStagePath(
  stages: unknown,
  mechanism: unknown,
  inputAsset: unknown,
  finalPayoutAsset: unknown,
): boolean {
  if (!Array.isArray(stages) || !stages.length || !object(inputAsset) || !object(finalPayoutAsset))
    return false
  if (
    stages.some(
      (stage) =>
        !object(stage) ||
        !named(stage.stageId) ||
        !oneOf(stage.kind, Object.keys(STAGE_ORDER)) ||
        !named(stage.adapterId) ||
        !named(stage.adapterVersion) ||
        !address(stage.inputAssetAddress) ||
        !address(stage.outputAssetAddress),
    )
  )
    return false
  const path = stages as SupplementalStage[]
  if (new Set(path.map((stage) => stage.stageId)).size !== path.length) return false
  if (
    path[0].inputAssetAddress !== inputAsset.address ||
    path.at(-1)?.outputAssetAddress !== finalPayoutAsset.address
  )
    return false
  if (
    path.some(
      (stage, index) =>
        index > 0 &&
        (stage.inputAssetAddress !== path[index - 1].outputAssetAddress ||
          STAGE_ORDER[stage.kind] < STAGE_ORDER[path[index - 1].kind]),
    )
  )
    return false
  if (mechanism === 'atomic') return path.length === 1 && path[0].kind === 'atomic_exit'
  if (
    mechanism !== 'staged' ||
    path.length < 2 ||
    (path[0].kind !== 'request' && path[0].kind !== 'conversion') ||
    path.at(-1)?.kind !== 'final_asset_delivery'
  )
    return false
  if (path.some((stage) => stage.kind === 'atomic_exit')) return false
  const count = (kind: SupplementalStage['kind']) =>
    path.filter((stage) => stage.kind === kind).length
  if (count('final_asset_delivery') !== 1) return false
  if (path[0].kind === 'conversion') {
    return path.slice(0, -1).every((stage) => stage.kind === 'conversion')
  }
  return (
    count('request') === 1 &&
    count('claim') === 1 &&
    count('wait') <= 1 &&
    path.slice(1, -1).every((stage) => ['wait', 'claim', 'conversion'].includes(stage.kind))
  )
}

const EMPTY_CAPABILITIES: SupplementalSubjectAssessment['capabilities'] = {
  contractIdentity: 'unverified',
  current: 'unavailable',
  historicalAssay: 'unavailable',
  grossFlow: 'unavailable',
  newsEvents: 'unavailable',
}

function externallyVerified(
  reference: SupplementalEvidenceRef,
  role: string,
  subject: SupplementalHolderExitSubject,
  verifier?: SupplementalEvidenceVerifier,
): boolean {
  if (!verifier) return false
  try {
    return (
      verifier(reference, {
        role,
        chainId: subject.chainId,
        routeKey: subject.routeKey,
        destinationAddress: subject.destinationAddress,
        destinationCodeHash: subject.contractIdentity.destinationCodeHash,
        implementationAddress: subject.contractIdentity.implementationAddress,
        implementationCodeHash: subject.contractIdentity.implementationCodeHash,
        blockNumber: subject.contractIdentity.receipt.blockNumber,
        blockHash: subject.contractIdentity.receipt.blockHash,
      }) === true
    )
  } catch {
    return false
  }
}

/** Validate one explicit route × destination definition, then report available evidence. */
export function assessSupplementalHolderExitSubject(
  input: unknown,
  verifyEvidence?: SupplementalEvidenceVerifier,
): SupplementalSubjectAssessment {
  const reasons: SupplementalReadinessReason[] = []
  if (
    !object(input) ||
    !named(input.subjectVersion) ||
    !named(input.protocolId) ||
    !positive(input.chainId) ||
    !named(input.routeKey) ||
    !named(input.routeVersion) ||
    !address(input.destinationAddress)
  )
    reasons.push('identity_incomplete')
  if (!object(input) || !validAsset(input.inputAsset) || !validAsset(input.finalPayoutAsset))
    reasons.push('asset_identity_invalid')
  if (
    !object(input) ||
    !validContractIdentity(input.contractIdentity, input.chainId, input.destinationAddress)
  )
    reasons.push('contract_identity_invalid')

  const stages = object(input) ? input.stages : null
  const mechanism = object(input) ? input.mechanism : null
  if (!oneOf(mechanism, ['atomic', 'staged'])) reasons.push('mechanism_invalid')
  if (
    !validStagePath(
      stages,
      mechanism,
      object(input) ? input.inputAsset : null,
      object(input) ? input.finalPayoutAsset : null,
    )
  )
    reasons.push('stage_adapter_invalid')

  const current = object(input) ? input.currentObservation : null
  if (
    !validCapability(current) ||
    !object(current) ||
    !oneOf(current.kind, ['exact_holder_final_payout', 'aggregate_proxy'])
  )
    reasons.push('current_observation_invalid')
  const historical = object(input) ? input.historicalAssay : null
  if (
    !validCapability(historical) ||
    !object(historical) ||
    !oneOf(historical.family, ['loss_by_h', 'exact_target_ability', 'duration_after_loss']) ||
    !named(historical.holderSelectionVersion) ||
    !Array.isArray(historical.fixedQRaw) ||
    !historical.fixedQRaw.length ||
    historical.fixedQRaw.some((q) => typeof q !== 'string' || !RAW_AMOUNT.test(q) || q === '0') ||
    new Set(historical.fixedQRaw).size !== historical.fixedQRaw.length ||
    !Array.isArray(historical.horizonSeconds) ||
    !historical.horizonSeconds.length ||
    historical.horizonSeconds.some((h) => !positive(h)) ||
    new Set(historical.horizonSeconds).size !== historical.horizonSeconds.length
  )
    reasons.push('historical_assay_invalid')

  const flow = object(input) ? input.grossFlow : null
  const flowKeys = [
    'deposits',
    'withdrawals',
    'net',
    'intervalMaximum',
    'endpointReconciliation',
  ] as const
  if (
    !object(flow) ||
    !positive(flow.intervalSeconds) ||
    flowKeys.some((key) => !validCapability(flow[key]))
  )
    reasons.push('gross_flow_invalid')
  const expected = object(input) ? input.expectedFlow : null
  const maximum = object(input) ? input.maximumFlow : null
  if (
    !object(expected) ||
    !object(maximum) ||
    !oneOf(expected.semantics, [
      'unavailable',
      'historical_distribution',
      'prospective_estimate',
    ]) ||
    !oneOf(maximum.semantics, ['unavailable', 'historical_observed_interval']) ||
    !address(expected.unitAssetAddress) ||
    !address(maximum.unitAssetAddress) ||
    !object(input) ||
    !object(input.finalPayoutAsset) ||
    !object(input.inputAsset) ||
    ![input.inputAsset.address, input.finalPayoutAsset.address].includes(
      expected.unitAssetAddress,
    ) ||
    ![input.inputAsset.address, input.finalPayoutAsset.address].includes(maximum.unitAssetAddress)
  )
    reasons.push('flow_semantics_invalid')
  if (
    object(expected) &&
    object(maximum) &&
    object(flow) &&
    (expected.semantics === 'historical_distribution' ||
      maximum.semantics === 'historical_observed_interval') &&
    flowKeys.some((key) => !object(flow[key]) || flow[key].state !== 'evidence_recorded')
  )
    reasons.push('flow_semantics_invalid')
  const news = object(input) ? input.newsEventSources : null
  if (
    !object(news) ||
    !oneOf(news.state, ['unavailable', 'configured', 'evidence_recorded']) ||
    !Array.isArray(news.sources) ||
    (news.state === 'unavailable' && news.sources.length !== 0) ||
    (news.state !== 'unavailable' && news.sources.length === 0) ||
    news.sources.some(
      (source) =>
        !object(source) ||
        !named(source.id) ||
        !named(source.reference) ||
        !oneOf(source.kind, ['governance', 'protocol', 'onchain_event']) ||
        (news.state === 'evidence_recorded' && !validEvidenceRef(source.evidenceRef)) ||
        (news.state !== 'evidence_recorded' && source.evidenceRef !== null),
    ) ||
    new Set(news.sources.map((source) => (object(source) ? source.id : null))).size !==
      news.sources.length
  )
    reasons.push('news_event_sources_invalid')
  if (
    !object(input) ||
    !oneOf(input.validationState, [
      'not_started',
      'collecting',
      'holdout_pending',
      'external_review',
    ])
  )
    reasons.push('validation_state_invalid')

  if (reasons.length) {
    return {
      accepted: false,
      subject: null,
      reasons: [...new Set(reasons)],
      capabilities: EMPTY_CAPABILITIES,
      forecast: 'abstain',
    }
  }
  const subject = input as SupplementalHolderExitSubject
  const verified = (reference: SupplementalEvidenceRef, role: string): boolean =>
    externallyVerified(reference, role, subject, verifyEvidence)
  const contractVerified = verified(subject.contractIdentity.receipt, 'contract_identity')
  const effectiveState = (capability: SupplementalCapability, role: string) =>
    capability.state === 'evidence_recorded' &&
    (!contractVerified || !verified(capability.evidenceRef!, role))
      ? 'configured'
      : capability.state
  const currentState = effectiveState(subject.currentObservation, 'current_observation')
  const historicalState = effectiveState(subject.historicalAssay, 'historical_assay')
  const flowStates = flowKeys.map((key) =>
    effectiveState(subject.grossFlow[key], `gross_flow.${key}`),
  )
  const newsState =
    subject.newsEventSources.state === 'evidence_recorded' &&
    !subject.newsEventSources.sources.every((source) =>
      verified(source.evidenceRef!, `news_event.${source.id}`),
    )
      ? 'configured'
      : subject.newsEventSources.state
  const capabilities: SupplementalSubjectAssessment['capabilities'] = {
    contractIdentity: contractVerified ? 'verified' : 'unverified',
    current:
      currentState === 'unavailable'
        ? 'unavailable'
        : subject.currentObservation.kind === 'aggregate_proxy'
          ? 'proxy_only'
          : currentState,
    historicalAssay: historicalState,
    grossFlow:
      flowStates[0] === 'unavailable' && flowStates[1] === 'unavailable'
        ? 'unavailable'
        : flowStates.every((state) => state === 'evidence_recorded')
          ? 'evidence_recorded'
          : flowStates.every((state) => state !== 'unavailable')
            ? 'configured'
            : 'partial',
    newsEvents: newsState,
  }
  if (!contractVerified) reasons.push('contract_identity_unverified')
  if (
    subject.currentObservation.state === 'evidence_recorded' &&
    currentState !== 'evidence_recorded'
  )
    reasons.push('current_observation_evidence_unverified')
  if (
    subject.historicalAssay.state === 'evidence_recorded' &&
    historicalState !== 'evidence_recorded'
  )
    reasons.push('historical_assay_evidence_unverified')
  if (
    flowKeys.some(
      (key, index) =>
        subject.grossFlow[key].state === 'evidence_recorded' &&
        flowStates[index] !== 'evidence_recorded',
    )
  )
    reasons.push('gross_flow_evidence_unverified')
  if (subject.newsEventSources.state === 'evidence_recorded' && newsState !== 'evidence_recorded')
    reasons.push('news_event_evidence_unverified')
  if (capabilities.current === 'unavailable' || capabilities.current === 'configured')
    reasons.push('current_exact_holder_observation_missing')
  if (capabilities.current === 'proxy_only') reasons.push('current_observation_only_proxy')
  if (capabilities.historicalAssay !== 'evidence_recorded') reasons.push('historical_assay_missing')
  if (capabilities.grossFlow !== 'evidence_recorded') reasons.push('gross_flow_incomplete')
  if (subject.expectedFlow.semantics === 'unavailable') reasons.push('expected_flow_unavailable')
  if (subject.expectedFlow.semantics === 'prospective_estimate')
    reasons.push('expected_flow_prospective_unvalidated')
  if (subject.maximumFlow.semantics === 'unavailable') reasons.push('maximum_flow_unavailable')
  if (capabilities.newsEvents === 'unavailable') reasons.push('news_event_source_missing')
  const flowClaimUnverified =
    (subject.expectedFlow.semantics === 'historical_distribution' ||
      subject.maximumFlow.semantics === 'historical_observed_interval') &&
    capabilities.grossFlow !== 'evidence_recorded'
  if (flowClaimUnverified) reasons.push('flow_semantics_unverified')
  reasons.push('prospective_validation_missing')
  return {
    accepted: !flowClaimUnverified,
    subject: flowClaimUnverified
      ? null
      : {
          chainId: subject.chainId,
          routeKey: subject.routeKey,
          destinationAddress: subject.destinationAddress,
        },
    reasons,
    capabilities,
    forecast: 'abstain',
  }
}

export function assessSupplementalHolderExitRegistry(
  input: unknown,
  verifyEvidence?: SupplementalEvidenceVerifier,
): {
  accepted: boolean
  reasons: SupplementalReadinessReason[]
  subjects: SupplementalSubjectAssessment[]
} {
  if (!object(input) || input.version !== SUPPLEMENTAL_HOLDER_EXIT_REGISTRY_VERSION)
    return { accepted: false, reasons: ['schema_version_invalid'], subjects: [] }
  if (!Array.isArray(input.subjects))
    return { accepted: false, reasons: ['subjects_invalid'], subjects: [] }
  const subjects = input.subjects.map((subject) =>
    assessSupplementalHolderExitSubject(subject, verifyEvidence),
  )
  const seen = new Set<string>()
  const reasons: SupplementalReadinessReason[] = []
  for (const rawSubject of input.subjects) {
    if (
      !object(rawSubject) ||
      !positive(rawSubject.chainId) ||
      !named(rawSubject.routeKey) ||
      !address(rawSubject.destinationAddress)
    )
      continue
    const identity = [
      rawSubject.chainId,
      rawSubject.routeKey.toLowerCase(),
      rawSubject.destinationAddress,
    ].join('\0')
    if (seen.has(identity)) reasons.push('duplicate_subject')
    seen.add(identity)
  }
  return {
    accepted: subjects.every((subject) => subject.accepted) && !reasons.length,
    reasons,
    subjects,
  }
}
