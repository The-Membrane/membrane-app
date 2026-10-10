const GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'

export function summarizeGhoHolding(snapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot.asOf)
  const recent = Number.isFinite(age) && age >= -120_000 && age <= 7_200_000
  const allValid =
    snapshot.complete &&
    snapshot.positions.every(
      (position) =>
        position.status === 'ok' &&
        position.assetAddress?.toLowerCase() === GHO &&
        position.assetDecimals === 18 &&
        position.assetBalanceRaw !== null,
    )
  const status = recent && allValid ? 'ok' : 'incomplete'
  const totalRaw =
    status === 'ok'
      ? snapshot.positions.reduce((sum, position) => sum + BigInt(position.assetBalanceRaw), 0n)
      : null
  return {
    status,
    data: {
      cohortId: snapshot.cohortId,
      seedHash: snapshot.seedHash,
      source: snapshot.source,
      measurement: snapshot.measurement,
      cohortCoverage: snapshot.cohortCoverage,
      blockHash: snapshot.blockHash,
      holderCount: snapshot.positions.length,
      nonzeroHolderCount:
        status === 'ok'
          ? snapshot.positions.filter((position) => BigInt(position.assetBalanceRaw) > 0n).length
          : null,
      unknownCount: snapshot.unknownCount,
      asset: 'GHO',
      assetDecimals: 18,
      holderStockRaw: totalRaw?.toString() ?? null,
      // Deliberately not USD or route TVL: later deposits may be unrelated.
      holderStockGho: totalRaw === null ? null : Number(totalRaw) / 1e18,
    },
  }
}
