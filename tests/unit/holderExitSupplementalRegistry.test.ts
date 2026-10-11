import { describe, expect, it } from 'vitest'

import {
  assessSupplementalHolderExitRegistry,
  assessSupplementalHolderExitSubject,
  SUPPLEMENTAL_HOLDER_EXIT_REGISTRY_VERSION,
  type SupplementalEvidenceVerifier,
  type SupplementalHolderExitSubject,
} from '@/lib/carry/holderExitSupplementalRegistry'

const USDE = '0x' + '1'.repeat(40)
const RECEIPT = '0x' + '2'.repeat(40)
const AAVE = '0x' + '3'.repeat(40)
const IMPLEMENTATION = '0x' + '4'.repeat(40)
const HASH = '0x' + 'a'.repeat(64)
const evidenceRef = () => ({ sourceId: 'rpc-primary', contentSha256: 'sha256:' + 'a'.repeat(64) })
const missing = () => ({ state: 'unavailable' as const, adapterId: null, evidenceRef: null })
const configured = (adapterId: string) => ({
  state: 'configured' as const,
  adapterId,
  evidenceRef: null,
})
const recorded = (adapterId: string) => ({
  state: 'evidence_recorded' as const,
  adapterId,
  evidenceRef: evidenceRef(),
})
const verifiedEvidence: SupplementalEvidenceVerifier = () => true

function subject(): SupplementalHolderExitSubject {
  return {
    subjectVersion: '1',
    protocolId: 'aave-v3',
    chainId: 1,
    routeKey: 'USDe → supply on Aave V3',
    routeVersion: '1',
    destinationAddress: AAVE,
    contractIdentity: {
      kind: 'direct',
      destinationCodeHash: HASH,
      receipt: {
        ...evidenceRef(),
        chainId: 1,
        blockNumber: 26000000,
        blockHash: HASH,
        destinationAddress: AAVE,
        destinationCodeHash: HASH,
        implementationAddress: null,
        implementationCodeHash: null,
      },
      implementationAddress: null,
      implementationCodeHash: null,
    },
    inputAsset: { address: USDE, decimals: 18 },
    finalPayoutAsset: { address: USDE, decimals: 18 },
    mechanism: 'atomic',
    stages: [
      {
        stageId: 'atomic',
        kind: 'atomic_exit',
        adapterId: 'aave-withdraw',
        adapterVersion: '1',
        inputAssetAddress: USDE,
        outputAssetAddress: USDE,
      },
    ],
    currentObservation: { ...configured('aave-holder-call'), kind: 'exact_holder_final_payout' },
    historicalAssay: {
      ...missing(),
      family: 'exact_target_ability',
      holderSelectionVersion: '1',
      fixedQRaw: ['1000000000000000000'],
      horizonSeconds: [3600, 86400],
    },
    grossFlow: {
      deposits: missing(),
      withdrawals: missing(),
      net: missing(),
      intervalMaximum: missing(),
      endpointReconciliation: missing(),
      intervalSeconds: 3600,
    },
    expectedFlow: { semantics: 'unavailable', unitAssetAddress: USDE },
    maximumFlow: { semantics: 'unavailable', unitAssetAddress: USDE },
    newsEventSources: { state: 'unavailable', sources: [] },
    validationState: 'not_started',
  }
}

function stagedSubject(): SupplementalHolderExitSubject {
  const value = subject()
  value.mechanism = 'staged'
  value.stages = [
    {
      stageId: 'request',
      kind: 'request',
      adapterId: 'request',
      adapterVersion: '1',
      inputAssetAddress: USDE,
      outputAssetAddress: RECEIPT,
    },
    {
      stageId: 'wait',
      kind: 'wait',
      adapterId: 'queue',
      adapterVersion: '1',
      inputAssetAddress: RECEIPT,
      outputAssetAddress: RECEIPT,
    },
    {
      stageId: 'claim',
      kind: 'claim',
      adapterId: 'claim',
      adapterVersion: '1',
      inputAssetAddress: RECEIPT,
      outputAssetAddress: RECEIPT,
    },
    {
      stageId: 'final',
      kind: 'final_asset_delivery',
      adapterId: 'payout',
      adapterVersion: '1',
      inputAssetAddress: RECEIPT,
      outputAssetAddress: USDE,
    },
  ]
  return value
}

describe('future supplemental holder-exit onboarding', () => {
  it('accepts an explicit future subject but abstains when only a reader is configured', () => {
    const result = assessSupplementalHolderExitSubject(subject())
    expect(result.accepted).toBe(true)
    expect(result.capabilities.current).toBe('configured')
    expect(result.forecast).toBe('abstain')
    expect(result.reasons).toContain('current_exact_holder_observation_missing')
    expect(result.reasons).toContain('historical_assay_missing')
    expect(result.reasons).toContain('gross_flow_incomplete')
    expect(result.reasons).toContain('prospective_validation_missing')
  })

  it('rejects missing exact route, asset, stage, flow, news, and validation definitions', () => {
    const draft = subject() as unknown as Record<string, unknown>
    delete draft.chainId
    delete draft.finalPayoutAsset
    delete draft.stages
    delete draft.grossFlow
    delete draft.newsEventSources
    delete draft.validationState
    expect(assessSupplementalHolderExitSubject(draft)).toMatchObject({
      accepted: false,
      forecast: 'abstain',
      reasons: expect.arrayContaining([
        'identity_incomplete',
        'asset_identity_invalid',
        'stage_adapter_invalid',
        'gross_flow_invalid',
        'news_event_sources_invalid',
        'validation_state_invalid',
      ]),
    })
  })

  it('preserves ordered staged payout and rejects an incomplete or misplaced terminal leg', () => {
    const staged = stagedSubject()
    expect(assessSupplementalHolderExitSubject(staged).accepted).toBe(true)
    staged.stages = [staged.stages[3], staged.stages[0]]
    expect(assessSupplementalHolderExitSubject(staged).reasons).toContain('stage_adapter_invalid')
  })

  it('requires nonzero contract and token identities plus a verifiable runtime-code receipt', () => {
    const zero = '0x' + '0'.repeat(40)
    for (const mutate of [
      (value: SupplementalHolderExitSubject) => {
        value.destinationAddress = zero
      },
      (value: SupplementalHolderExitSubject) => {
        value.inputAsset.address = zero
      },
      (value: SupplementalHolderExitSubject) => {
        value.finalPayoutAsset.address = zero
      },
    ]) {
      const value = subject()
      mutate(value)
      expect(assessSupplementalHolderExitSubject(value).accepted).toBe(false)
    }
    const badHash = subject()
    badHash.contractIdentity.destinationCodeHash = '0x1234'
    expect(assessSupplementalHolderExitSubject(badHash).reasons).toContain(
      'contract_identity_invalid',
    )
    const zeroHash = subject()
    zeroHash.contractIdentity.destinationCodeHash = '0x' + '0'.repeat(64)
    zeroHash.contractIdentity.receipt.destinationCodeHash =
      zeroHash.contractIdentity.destinationCodeHash
    expect(assessSupplementalHolderExitSubject(zeroHash).reasons).toContain(
      'contract_identity_invalid',
    )
    const badReceipt = subject()
    badReceipt.contractIdentity.receipt.contentSha256 = 'sha256:unpinned'
    expect(assessSupplementalHolderExitSubject(badReceipt).reasons).toContain(
      'contract_identity_invalid',
    )
    const wrongContractReceipt = subject()
    wrongContractReceipt.contractIdentity.receipt.destinationAddress = IMPLEMENTATION
    expect(assessSupplementalHolderExitSubject(wrongContractReceipt).reasons).toContain(
      'contract_identity_invalid',
    )
    const proxy = subject()
    proxy.contractIdentity.kind = 'proxy'
    expect(assessSupplementalHolderExitSubject(proxy).reasons).toContain(
      'contract_identity_invalid',
    )
    proxy.contractIdentity.implementationAddress = IMPLEMENTATION
    proxy.contractIdentity.implementationCodeHash = HASH
    proxy.contractIdentity.receipt.implementationAddress = IMPLEMENTATION
    proxy.contractIdentity.receipt.implementationCodeHash = HASH
    expect(assessSupplementalHolderExitSubject(proxy).accepted).toBe(true)
    proxy.contractIdentity.implementationAddress = zero
    expect(assessSupplementalHolderExitSubject(proxy).reasons).toContain(
      'contract_identity_invalid',
    )
  })

  it('binds each ordered stage asset and rejects backwards or duplicate singleton stages', () => {
    const mutations = [
      (value: SupplementalHolderExitSubject) => {
        value.stages[1].inputAssetAddress = USDE
      },
      (value: SupplementalHolderExitSubject) => {
        value.stages[3].outputAssetAddress = RECEIPT
      },
      (value: SupplementalHolderExitSubject) => {
        value.stages[1].kind = 'request'
      },
      (value: SupplementalHolderExitSubject) => {
        value.stages[2].kind = 'request'
      },
      (value: SupplementalHolderExitSubject) => {
        value.stages.splice(2, 0, {
          ...value.stages[1],
          stageId: 'conversion-before-claim',
          kind: 'conversion',
        })
      },
      (value: SupplementalHolderExitSubject) => {
        value.stages[2].stageId = 'wait'
      },
      (value: SupplementalHolderExitSubject) => {
        value.stages[2].kind = 'final_asset_delivery'
      },
    ]
    for (const mutate of mutations) {
      const value = stagedSubject()
      mutate(value)
      expect(assessSupplementalHolderExitSubject(value).reasons).toContain('stage_adapter_invalid')
    }
    const duplicateClaim = stagedSubject()
    duplicateClaim.stages.splice(3, 0, { ...duplicateClaim.stages[2], stageId: 'claim-again' })
    expect(assessSupplementalHolderExitSubject(duplicateClaim).reasons).toContain(
      'stage_adapter_invalid',
    )
  })

  it('rejects wait-first paths but permits a conversion-first immediate route', () => {
    const waitFirst = stagedSubject()
    waitFirst.stages[0].kind = 'wait'
    expect(assessSupplementalHolderExitSubject(waitFirst).reasons).toContain(
      'stage_adapter_invalid',
    )

    const immediate = stagedSubject()
    immediate.stages = [
      {
        stageId: 'convert-one',
        kind: 'conversion',
        adapterId: 'swap-one',
        adapterVersion: '1',
        inputAssetAddress: USDE,
        outputAssetAddress: RECEIPT,
      },
      {
        stageId: 'convert-two',
        kind: 'conversion',
        adapterId: 'swap-two',
        adapterVersion: '1',
        inputAssetAddress: RECEIPT,
        outputAssetAddress: RECEIPT,
      },
      {
        stageId: 'final',
        kind: 'final_asset_delivery',
        adapterId: 'payout',
        adapterVersion: '1',
        inputAssetAddress: RECEIPT,
        outputAssetAddress: USDE,
      },
    ]
    expect(assessSupplementalHolderExitSubject(immediate).accepted).toBe(true)
  })

  it('requires a claim after a request and rejects atomic stages inside staged paths', () => {
    const missingClaim = stagedSubject()
    missingClaim.stages = missingClaim.stages.filter((stage) => stage.kind !== 'claim')
    expect(assessSupplementalHolderExitSubject(missingClaim).reasons).toContain(
      'stage_adapter_invalid',
    )

    const atomicInsideStaged = stagedSubject()
    atomicInsideStaged.stages[1].kind = 'atomic_exit'
    expect(assessSupplementalHolderExitSubject(atomicInsideStaged).reasons).toContain(
      'stage_adapter_invalid',
    )
  })

  it('does not echo syntactically valid recorded evidence until an external verifier confirms it', () => {
    const value = subject()
    value.currentObservation = { ...recorded('holder'), kind: 'exact_holder_final_payout' }
    value.historicalAssay = { ...value.historicalAssay, ...recorded('assay') }
    value.grossFlow.deposits = recorded('deposits')
    value.newsEventSources = {
      state: 'evidence_recorded',
      sources: [
        {
          id: 'proposal',
          kind: 'governance',
          reference: 'https://example.org',
          evidenceRef: evidenceRef(),
        },
      ],
    }
    const absent = assessSupplementalHolderExitSubject(value)
    expect(absent.accepted).toBe(true)
    expect(absent.capabilities).toMatchObject({
      contractIdentity: 'unverified',
      current: 'configured',
      historicalAssay: 'configured',
      grossFlow: 'partial',
      newsEvents: 'configured',
    })
    expect(absent.subject).toEqual({
      chainId: 1,
      routeKey: value.routeKey,
      destinationAddress: AAVE,
    })
    expect(absent.reasons).toEqual(
      expect.arrayContaining([
        'contract_identity_unverified',
        'current_observation_evidence_unverified',
        'historical_assay_evidence_unverified',
        'gross_flow_evidence_unverified',
        'news_event_evidence_unverified',
      ]),
    )

    const failed = assessSupplementalHolderExitSubject(value, () => false)
    expect(failed.capabilities).toEqual(absent.capabilities)
    const identityFailed = assessSupplementalHolderExitSubject(
      value,
      (_ref, context) => context.role !== 'contract_identity',
    )
    expect(identityFailed.capabilities).toMatchObject({
      contractIdentity: 'unverified',
      current: 'configured',
      historicalAssay: 'configured',
      newsEvents: 'evidence_recorded',
    })
    const thrown = assessSupplementalHolderExitSubject(value, () => {
      throw new Error('source unavailable')
    })
    expect(thrown.capabilities).toEqual(absent.capabilities)
    const roles: string[] = []
    const passed = assessSupplementalHolderExitSubject(value, (ref, context) => {
      roles.push(context.role)
      return (
        ref.sourceId === 'rpc-primary' &&
        context.chainId === 1 &&
        context.destinationAddress === AAVE &&
        context.destinationCodeHash === HASH &&
        context.blockHash === HASH
      )
    })
    expect(passed.capabilities).toMatchObject({
      contractIdentity: 'verified',
      current: 'evidence_recorded',
      historicalAssay: 'evidence_recorded',
      newsEvents: 'evidence_recorded',
    })
    expect(roles).toContain('contract_identity')
    expect(roles).toContain('news_event.proposal')
    expect(passed.forecast).toBe('abstain')
  })

  it('requires source-bound content hashes for recorded capabilities and distinct news receipts', () => {
    const badCapability = subject()
    badCapability.currentObservation = { ...recorded('holder'), kind: 'exact_holder_final_payout' }
    badCapability.currentObservation.evidenceRef!.sourceId = ' '
    expect(assessSupplementalHolderExitSubject(badCapability).reasons).toContain(
      'current_observation_invalid',
    )
    const badAssay = subject()
    badAssay.historicalAssay = { ...badAssay.historicalAssay, ...recorded('assay') }
    badAssay.historicalAssay.evidenceRef!.contentSha256 = 'https://example.org/data'
    expect(assessSupplementalHolderExitSubject(badAssay).reasons).toContain(
      'historical_assay_invalid',
    )
    const badFlow = subject()
    badFlow.grossFlow.deposits = recorded('deposits')
    badFlow.grossFlow.deposits.evidenceRef!.contentSha256 = 'sha256:' + 'A'.repeat(64)
    expect(assessSupplementalHolderExitSubject(badFlow).reasons).toContain('gross_flow_invalid')
    const news = subject()
    news.newsEventSources = {
      state: 'configured',
      sources: [
        { id: 'source', kind: 'protocol', reference: 'https://example.org', evidenceRef: null },
      ],
    }
    expect(assessSupplementalHolderExitSubject(news).accepted).toBe(true)
    news.newsEventSources.state = 'evidence_recorded'
    expect(assessSupplementalHolderExitSubject(news).reasons).toContain(
      'news_event_sources_invalid',
    )
    news.newsEventSources.sources[0].evidenceRef = evidenceRef()
    expect(assessSupplementalHolderExitSubject(news).accepted).toBe(true)
    news.newsEventSources.state = 'configured'
    expect(assessSupplementalHolderExitSubject(news).reasons).toContain(
      'news_event_sources_invalid',
    )
    news.newsEventSources.state = 'evidence_recorded'
    news.newsEventSources.sources.push({ ...news.newsEventSources.sources[0] })
    expect(assessSupplementalHolderExitSubject(news).reasons).toContain(
      'news_event_sources_invalid',
    )
  })

  it('requires recorded gross-flow evidence before historical expected or maximum flow', () => {
    const value = subject()
    value.expectedFlow.semantics = 'historical_distribution'
    expect(assessSupplementalHolderExitSubject(value).reasons).toContain('flow_semantics_invalid')
    value.expectedFlow.semantics = 'unavailable'
    value.maximumFlow.semantics = 'historical_observed_interval'
    expect(assessSupplementalHolderExitSubject(value).reasons).toContain('flow_semantics_invalid')
    for (const key of [
      'deposits',
      'withdrawals',
      'net',
      'intervalMaximum',
      'endpointReconciliation',
    ] as const)
      value.grossFlow[key] = recorded(key)
    expect(assessSupplementalHolderExitSubject(value).accepted).toBe(false)
    expect(assessSupplementalHolderExitSubject(value).reasons).toContain(
      'flow_semantics_unverified',
    )
    expect(assessSupplementalHolderExitSubject(value, verifiedEvidence).accepted).toBe(true)
  })

  it('rejects padded identifiers and duplicate Qs or horizons', () => {
    for (const key of ['subjectVersion', 'protocolId', 'routeKey', 'routeVersion'] as const) {
      const value = subject()
      value[key] = ` ${value[key]}`
      expect(assessSupplementalHolderExitSubject(value).reasons).toContain('identity_incomplete')
    }
    const duplicateQ = subject()
    duplicateQ.historicalAssay.fixedQRaw.push(duplicateQ.historicalAssay.fixedQRaw[0])
    expect(assessSupplementalHolderExitSubject(duplicateQ).reasons).toContain(
      'historical_assay_invalid',
    )
    const duplicateH = subject()
    duplicateH.historicalAssay.horizonSeconds.push(3600)
    expect(assessSupplementalHolderExitSubject(duplicateH).reasons).toContain(
      'historical_assay_invalid',
    )
  })

  it('does not promote a proxy or recorded capabilities into a validated forecast', () => {
    const ready = subject()
    ready.currentObservation = { ...recorded('aggregate-cash'), kind: 'aggregate_proxy' }
    ready.historicalAssay = { ...ready.historicalAssay, ...recorded('fixed-q-assay') }
    for (const key of [
      'deposits',
      'withdrawals',
      'net',
      'intervalMaximum',
      'endpointReconciliation',
    ] as const)
      ready.grossFlow[key] = recorded(key)
    ready.expectedFlow.semantics = 'historical_distribution'
    ready.maximumFlow.semantics = 'historical_observed_interval'
    ready.newsEventSources = {
      state: 'evidence_recorded',
      sources: [
        {
          id: 'governance',
          kind: 'governance',
          reference: 'https://example.org/proposal',
          evidenceRef: evidenceRef(),
        },
      ],
    }
    ready.validationState = 'external_review'
    const result = assessSupplementalHolderExitSubject(ready, verifiedEvidence)
    expect(result.capabilities.current).toBe('proxy_only')
    expect(result.capabilities.grossFlow).toBe('evidence_recorded')
    expect(result.forecast).toBe('abstain')
    expect(result.reasons).toContain('current_observation_only_proxy')
    expect(result.reasons).toContain('prospective_validation_missing')
  })

  it('rejects maximum-flow promises, unit mismatches, duplicates and unsupported versions', () => {
    const invalid = subject()
    invalid.maximumFlow = {
      semantics: 'holder_executable_capacity' as 'historical_observed_interval',
      unitAssetAddress: RECEIPT,
    }
    expect(assessSupplementalHolderExitSubject(invalid).reasons).toContain('flow_semantics_invalid')
    const duplicate = {
      version: SUPPLEMENTAL_HOLDER_EXIT_REGISTRY_VERSION,
      subjects: [subject(), subject()],
    }
    expect(assessSupplementalHolderExitRegistry(duplicate)).toMatchObject({
      accepted: false,
      reasons: ['duplicate_subject'],
    })
    const caseAlias = subject()
    caseAlias.routeKey = caseAlias.routeKey.toLowerCase()
    expect(
      assessSupplementalHolderExitRegistry({
        version: SUPPLEMENTAL_HOLDER_EXIT_REGISTRY_VERSION,
        subjects: [subject(), caseAlias],
      }),
    ).toMatchObject({ accepted: false, reasons: ['duplicate_subject'] })
    expect(
      assessSupplementalHolderExitRegistry({ ...duplicate, version: 'future-v2' }),
    ).toMatchObject({
      accepted: false,
      reasons: ['schema_version_invalid'],
    })
  })
})
