import { getAddress, isAddress, keccak256, parseAbi, type PublicClient } from 'viem'

import {
  decodeCandidateCuratorVaultAction,
  type CandidateCuratorVaultAction,
  type RawCuratorVaultLog,
} from './curatorVaultEvents'

const HASH = /^0x[0-9a-fA-F]{64}$/
const CODE = /^0x(?:[0-9a-fA-F]{2})+$/
const FACTORY_ABI = parseAbi(['function isFactoryVault(address vault) view returns (bool)'])

// A caller must nominate a separately reviewed factory deployment and the
// *instance-specific* vault runtime hash. Constructor immutables make a shared
// CuratorVault hash insufficient. This reader never chooses an alert recipient.
export type CuratorVaultSourceReads = {
  chainId: () => Promise<number>
  finalizedBlockNumber: () => Promise<bigint>
  block: (number: bigint) => Promise<{ hash: string; timestamp: bigint } | null>
  receipt: (hash: string) => Promise<{
    status: 'success' | 'reverted'
    blockNumber: bigint
    blockHash: string
    logs: RawCuratorVaultLog[]
  } | null>
  code: (address: string, blockNumber: bigint) => Promise<string | null | undefined>
  factoryRecognizesVault: (factory: string, vault: string, blockNumber: bigint) => Promise<boolean>
}

export type VerifiedCuratorVaultAction = Omit<CandidateCuratorVaultAction, 'status'> & {
  status: 'verified_finalized'
  occurredAt: string
}

/** Read-only viem adapter. RPC/finality trust and reviewed hashes come from the caller. */
export function viemCuratorVaultSourceReads(client: PublicClient): CuratorVaultSourceReads {
  return {
    chainId: () => client.getChainId(),
    finalizedBlockNumber: async () => {
      const block = await client.getBlock({ blockTag: 'finalized' })
      if (block.number === null) throw new Error('finalized height unavailable')
      return block.number
    },
    block: async (number) => {
      const block = await client.getBlock({ blockNumber: number })
      return { hash: block.hash, timestamp: block.timestamp }
    },
    receipt: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` })
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        logs: receipt.logs.map((log) => ({
          ...log,
          topics: 'topics' in log ? log.topics : undefined,
          chainId: 1,
        })),
      }
    },
    code: (address, blockNumber) =>
      client.getCode({ address: address as `0x${string}`, blockNumber }),
    factoryRecognizesVault: (factory, vault, blockNumber) =>
      client.readContract({
        address: factory as `0x${string}`,
        abi: FACTORY_ABI,
        functionName: 'isFactoryVault',
        args: [vault as `0x${string}`],
        blockNumber,
        authorizationList: undefined,
      }),
  }
}

function codeMatches(code: string | null | undefined, expectedHash: string): boolean {
  return (
    !!code &&
    CODE.test(code) &&
    keccak256(code as `0x${string}`).toLowerCase() === expectedHash.toLowerCase()
  )
}

/** Fail closed before any candidate can be used as a notification source. */
export async function verifyFinalizedCuratorVaultSource(
  claimed: CandidateCuratorVaultAction,
  expectedFactory: string,
  expectedFactoryRuntimeHash: string,
  expectedVaultRuntimeHash: string,
  reads: CuratorVaultSourceReads,
): Promise<VerifiedCuratorVaultAction> {
  if (
    !isAddress(expectedFactory) ||
    !HASH.test(expectedFactoryRuntimeHash) ||
    !HASH.test(expectedVaultRuntimeHash) ||
    !claimed ||
    claimed.status !== 'candidate_unfinalized' ||
    claimed.chainId !== 1 ||
    !isAddress(claimed.vault) ||
    !HASH.test(claimed.transactionHash) ||
    !HASH.test(claimed.blockHash) ||
    !Number.isSafeInteger(claimed.blockNumber) ||
    claimed.blockNumber <= 0 ||
    !Number.isSafeInteger(claimed.logIndex) ||
    claimed.logIndex < 0
  )
    throw new Error('invalid curator vault source claim or deployment configuration')

  const number = BigInt(claimed.blockNumber)
  if ((await reads.chainId()) !== 1 || (await reads.finalizedBlockNumber()) < number)
    throw new Error('curator vault source is not finalized on chain 1')
  const block = await reads.block(number)
  const receipt = await reads.receipt(claimed.transactionHash)
  if (
    !block ||
    !HASH.test(block.hash) ||
    block.hash.toLowerCase() !== claimed.blockHash.toLowerCase() ||
    block.timestamp < 0n ||
    block.timestamp > 8_640_000_000_000n ||
    !receipt ||
    receipt.status !== 'success' ||
    receipt.blockNumber !== number ||
    receipt.blockHash.toLowerCase() !== claimed.blockHash.toLowerCase() ||
    !Array.isArray(receipt.logs)
  )
    throw new Error('curator vault block or receipt mismatch')

  const factory = getAddress(expectedFactory).toLowerCase()
  const vault = getAddress(claimed.vault).toLowerCase()
  const [factoryCode, vaultCode, recognized] = await Promise.all([
    reads.code(factory, number),
    reads.code(vault, number),
    reads.factoryRecognizesVault(factory, vault, number),
  ])
  if (
    !codeMatches(factoryCode, expectedFactoryRuntimeHash) ||
    !codeMatches(vaultCode, expectedVaultRuntimeHash) ||
    recognized !== true
  )
    throw new Error('curator vault factory or instance provenance mismatch')

  const matches = receipt.logs.filter((log) => log.logIndex === claimed.logIndex)
  if (matches.length !== 1) throw new Error('curator vault log index missing or duplicated')
  const actual = decodeCandidateCuratorVaultAction({ ...matches[0], chainId: 1 }, vault)
  if (
    !actual ||
    actual.action !== claimed.action ||
    actual.transactionHash !== claimed.transactionHash.toLowerCase() ||
    actual.blockNumber !== claimed.blockNumber ||
    actual.blockHash !== claimed.blockHash.toLowerCase()
  )
    throw new Error('curator vault log provenance mismatch')
  return {
    ...actual,
    status: 'verified_finalized',
    occurredAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  }
}
