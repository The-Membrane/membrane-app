/** Public pilot projection. Never expose per-wallet debt/holding rows or receipt proofs. */
export function publicRouteData(kind: string, data: Record<string, unknown>) {
  if (kind === 'spread') {
    const leg =
      data.leg && typeof data.leg === 'object' && !Array.isArray(data.leg)
        ? (data.leg as Record<string, unknown>)
        : {}
    const lookback =
      data.lookback && typeof data.lookback === 'object' && !Array.isArray(data.lookback)
        ? (data.lookback as Record<string, unknown>)
        : {}
    return {
      key: data.key,
      status: data.status,
      leg: {
        chainId: leg.chainId,
        borrowProtocol: leg.borrowProtocol,
        borrowMarket: leg.borrowMarket,
        borrowAsset: leg.borrowAsset,
        destinationKind: leg.destinationKind,
        destination: leg.destination,
      },
      asOf: data.asOf,
      blockNumber: data.blockNumber,
      blockHash: data.blockHash,
      lookback: {
        seconds: lookback.seconds,
        priorAt: lookback.priorAt,
        priorBlockNumber: lookback.priorBlockNumber,
      },
      rateConvention: data.rateConvention,
      borrowSource: data.borrowSource,
      yieldSource: data.yieldSource,
      borrowApy: data.borrowApy,
      yieldApy: data.yieldApy,
      spread: data.spread,
    }
  }
  if (kind === 'destination_tvl' && 'vaultCashGho' in data) {
    return {
      ...data,
      vaultCashMeaning:
        'GHO cash is one vault-side bound; compare with totalAssets and paused status. It is not a wallet maxRedeem or execution guarantee.',
    }
  }
  if (kind === 'prospective_overlap') {
    const allowed = [
      'measurement',
      'caveat',
      'fromBlock',
      'throughBlock',
      'segmentCount',
      'latestSourceObservedAt',
      'throughBlockTime',
      'sourceManifestSha256',
      'variableBorrowEvents',
      'peerWitnessedSegments',
      'singleProviderNoVariableBorrowSegments',
      'excludedAugustWalletCount',
      'blockHash',
      'borrowAsset',
      'destination',
      'variableDebtToken',
      'candidateWalletCount',
      'completeWalletCount',
      'unknownWalletCount',
      'matchedRaw',
      'matchedGho',
    ] as const
    return {
      ...Object.fromEntries(allowed.filter((key) => key in data).map((key) => [key, data[key]])),
      ...(typeof data.qualification === 'string'
        ? {
            qualification:
              'Two distinct RPC hosts returned matching logs in the sealed window; independent providers are not established, and this is not a borrower census.',
          }
        : {}),
    }
  }
  if (kind !== 'matched_capital') return { ...data }
  const allowed = [
    'measurement',
    'caveat',
    'sourceSha256',
    'seedHash',
    'blockHash',
    'borrowMarket',
    'borrowAsset',
    'variableDebtToken',
    'destination',
    'receiptProofCount',
    'observedWalletCount',
    'completeWalletCount',
    'unknownWalletCount',
    'matchedRaw',
    'matchedGho',
  ] as const
  return Object.fromEntries(allowed.filter((key) => key in data).map((key) => [key, data[key]]))
}

/** USDe pilot projection is intentionally aggregate-only, including future stored fields. */
export function publicUsdePilotData(kind: string, data: Record<string, unknown>) {
  const decimal = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  if (
    (kind === 'matched_capital' &&
      (data.claim !== 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit' ||
        !decimal(data.matchedUsde) ||
        data.completeWalletCount !== 25)) ||
    (kind === 'destination_tvl' &&
      (data.claim !== 'all_depositor_vault_assets_not_route_tvl' ||
        !decimal(data.totalAssetsUsde))) ||
    (kind === 'spread' &&
      (data.claim !== 'modeled_two_leg_spread_not_cohort_realized_return' ||
        ![data.borrowApy, data.yieldApy, data.spread].every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        ))) ||
    !['matched_capital', 'destination_tvl', 'spread'].includes(kind)
  )
    return null
  const allowed =
    kind === 'matched_capital'
      ? [
          'claim',
          'measurement',
          'matchedUsde',
          'completeWalletCount',
          'observedWalletCount',
          'caveat',
        ]
      : kind === 'destination_tvl'
        ? ['claim', 'measurement', 'totalAssetsUsde', 'caveat']
        : kind === 'spread'
          ? ['claim', 'measurement', 'borrowApy', 'yieldApy', 'spread', 'rateConvention']
          : []
  return Object.fromEntries(allowed.filter((key) => key in data).map((key) => [key, data[key]]))
}
