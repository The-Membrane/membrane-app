import type { PublicClient } from 'viem'
import { governanceAbi } from '@/contracts/abis/governance'
import { getContractAddress, type Address } from '@/config/evm/contracts'

/**
 * Governance.sol read service. Migration counterpart: services/governance.ts
 * (queryContractSmart against the CosmWasm governance contract).
 *
 * Follows the service contract (see .claude/skills/hook-query-patterns and
 * services/chain/cdp.ts): return null on failure, never throw; optional address
 * override with config fallback; reads work with no wallet connected.
 *
 * Business logic that lived in the Cosmos service (parseProposal / ratio /
 * result / quorum / days-left math) stays in the hooks & components that consume
 * these primitives — only the chain access changes here.
 */

function govAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'governance') : undefined)
}

/**
 * Global governance config (public — no wallet required).
 * Cosmos: client.config().  Solidity: Governance.config() view.
 */
export async function getConfig(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: governanceAbi, functionName: 'config' })
  } catch (error) {
    console.error('Error querying Governance config:', error)
    return null
  }
}

/**
 * Total number of proposals ever created (monotonic counter).
 * Cosmos: implicit (paginated list).  Solidity: Governance.proposal_count() view.
 */
export async function getProposalCount(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({ address, abi: governanceAbi, functionName: 'proposal_count' })
  } catch (error) {
    console.error('Error querying Governance proposal_count:', error)
    return null
  }
}

/** Full Active-proposal struct (reverts ProposalNotFound if not active → null). */
export async function getActiveProposal(
  client: PublicClient | null,
  proposalId: number | bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: governanceAbi,
      functionName: 'getActiveProposal',
      args: [BigInt(proposalId)],
    })
  } catch (error) {
    console.error('Error querying Governance getActiveProposal:', error)
    return null
  }
}

/** Full Pending-proposal struct (reverts ProposalNotFound if not pending → null). */
export async function getPendingProposal(
  client: PublicClient | null,
  proposalId: number | bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: governanceAbi,
      functionName: 'getPendingProposal',
      args: [BigInt(proposalId)],
    })
  } catch (error) {
    console.error('Error querying Governance getPendingProposal:', error)
    return null
  }
}

/**
 * Resolve a single proposal whether it lives in the Active or Pending map.
 * Cosmos: client.proposal({ proposalId }) (one combined store).
 * Solidity: split Active/Pending maps, gated by isActive()/isPending() so a
 * missing proposal returns null instead of a revert.
 */
export async function getProposal(
  client: PublicClient | null,
  proposalId: number | bigint,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    const id = BigInt(proposalId)
    const [active, pending] = await Promise.all([
      client.readContract({ address, abi: governanceAbi, functionName: 'isActive', args: [id] }),
      client.readContract({ address, abi: governanceAbi, functionName: 'isPending', args: [id] }),
    ])
    if (active) {
      return await client.readContract({
        address,
        abi: governanceAbi,
        functionName: 'getActiveProposal',
        args: [id],
      })
    }
    if (pending) {
      return await client.readContract({
        address,
        abi: governanceAbi,
        functionName: 'getPendingProposal',
        args: [id],
      })
    }
    return null
  } catch (error) {
    console.error('Error querying Governance proposal:', error)
    return null
  }
}

/**
 * Full proposals list. Cosmos exposed activeProposals({start,limit}) +
 * pendingProposals() pagination endpoints; Solidity has NO list view, so we
 * reconstruct it by walking 1..proposal_count and reading each live
 * (Active or Pending) proposal. Reads batch through the client's multicall.
 */
export async function getProposals(client: PublicClient | null, contractAddr?: Address) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    const count = await client.readContract({
      address,
      abi: governanceAbi,
      functionName: 'proposal_count',
    })
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1))
    const proposals = await Promise.all(
      ids.map(async (id) => {
        const [active, pending] = await Promise.all([
          client.readContract({ address, abi: governanceAbi, functionName: 'isActive', args: [id] }),
          client.readContract({ address, abi: governanceAbi, functionName: 'isPending', args: [id] }),
        ])
        if (active) {
          return client.readContract({
            address,
            abi: governanceAbi,
            functionName: 'getActiveProposal',
            args: [id],
          })
        }
        if (pending) {
          return client.readContract({
            address,
            abi: governanceAbi,
            functionName: 'getPendingProposal',
            args: [id],
          })
        }
        return null
      }),
    )
    return proposals.filter((p): p is NonNullable<typeof p> => p !== null)
  } catch (error) {
    console.error('Error querying Governance proposals:', error)
    return null
  }
}

/**
 * Whether `voter` has already voted on `proposalId`.
 * Cosmos: derived from the proposal's per-option voter arrays (for_voters,
 * against_voters, …).  Solidity: Governance.hasVoted(id, voter) view — a single
 * bool. NOTE: the port does not store which option was chosen, so the per-option
 * breakdown (votedFor / votedAgainst / … from the old checkIfVoted) is not
 * recoverable on-chain; consumers get the boolean only.
 */
export async function hasVoted(
  client: PublicClient | null,
  proposalId: number | bigint,
  voter: Address,
  contractAddr?: Address,
) {
  if (!client) return null
  const address = govAddress(client, contractAddr)
  if (!address) return null
  try {
    return await client.readContract({
      address,
      abi: governanceAbi,
      functionName: 'hasVoted',
      args: [BigInt(proposalId), voter],
    })
  } catch (error) {
    console.error('Error querying Governance hasVoted:', error)
    return null
  }
}

/**
 * Cosmos: client.userVotingPower({ user, proposalId, vesting }).
 * Governance.sol has no user-voting-power view — voting power is a Staking-organ
 * concern (IStakingVotingPower.votingPowerOf on the staking contract) that
 * callers pass INTO castVote/submitProposal by design. There is nothing to read
 * on the Governance contract itself.
 */
export async function getUserVotingPower(
  _client: PublicClient | null,
  _voter: Address,
  _proposalId: number | bigint,
  _contractAddr?: Address,
) {
  // TODO(evm-migration): no Governance.sol equivalent — read live power from the
  // Staking contract (IStakingVotingPower.votingPowerOf) once the staking read
  // service exists; Governance never exposed this.
  return null
}

/**
 * Cosmos: client.totalVotingPower({ proposalId }) — used to compute quorum.
 * Governance.sol takes total_voting_power as a caller-supplied argument to
 * endProposal (see IStakingVotingPower note in the contract) and exposes no view
 * for it; the global staked total is a Staking-organ figure.
 */
export async function getTotalVotingPower(
  _client: PublicClient | null,
  _proposalId: number | bigint,
  _contractAddr?: Address,
) {
  // TODO(evm-migration): no Governance.sol equivalent — total system voting power
  // comes from the Staking contract; wire it through the staking read service.
  return null
}
