import { encodeFunctionData, encodeFunctionResult, parseAbi, type Address } from 'viem'

import type {
  MorphoHolderPositionObservation,
  MorphoHolderPositionSource,
} from '@/lib/carry/morphoV2HolderPositionEvidence'

const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
])
export const transportSharesRaw = '9000000000000000000000'

/** Synthetic retained native reads, independent of requested withdrawal Q. */
export function holderPositionTransportObservation(
  source: MorphoHolderPositionSource,
  asOfMs: number,
  owner: Address = '0x0000000000000000000000000000000000000001',
): MorphoHolderPositionObservation {
  const destination = '0x0026038a7fefef439d94bd99b4a10017e839d3a7' as const
  const startedAtUtc = new Date(asOfMs - 4).toISOString()
  const firstEnd = new Date(asOfMs - 3).toISOString()
  const secondStart = new Date(asOfMs - 2).toISOString()
  const readAtUtc = new Date(asOfMs - 1).toISOString()
  const pin = { blockHash: source.blockHash, requireCanonical: true as const }
  return {
    schemaVersion: 1,
    kind: 'morpho_v2_holder_position_origin_v1',
    routeKey: 'USDC → VaultV2 [USDC]',
    destination,
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    shareDecimals: 18,
    source: { ...source, blockTime: new Date(source.blockTime).toISOString() },
    startedAtUtc,
    readAtUtc,
    deadlineMs: 8000,
    traces: [
      {
        key: 'balanceOf',
        method: 'eth_call',
        params: [
          {
            to: destination,
            data: encodeFunctionData({ abi, functionName: 'balanceOf', args: [owner] }),
          },
          { ...pin },
        ],
        result: encodeFunctionResult({
          abi,
          functionName: 'balanceOf',
          result: BigInt(transportSharesRaw),
        }),
        startedAtUtc,
        completedAtUtc: firstEnd,
      },
      {
        key: 'previewRedeem',
        method: 'eth_call',
        params: [
          {
            to: destination,
            data: encodeFunctionData({
              abi,
              functionName: 'previewRedeem',
              args: [BigInt(transportSharesRaw)],
            }),
          },
          { ...pin },
        ],
        result: encodeFunctionResult({ abi, functionName: 'previewRedeem', result: 9000000000n }),
        startedAtUtc: secondStart,
        completedAtUtc: readAtUtc,
      },
    ],
  }
}
