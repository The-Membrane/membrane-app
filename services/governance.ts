import contracts from '@/config/contracts.json'
import { GovernanceQueryClient } from '@/contracts/codegen/governance/Governance.client'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { coin } from '@cosmjs/amino'

export const getGovernanceClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new GovernanceQueryClient(cosmWasmClient, contracts.governance)
}

// export const getSigningStakingClient = (signingClient: SigningCosmWasmClient, address: Addr) => {
//   return new StakingClient(signingClient, address, contracts.staking)
// }

// export type StakingParams = {
//   signingClient: SigningCosmWasmClient
//   address: Addr
//   denom: string
//   amount: string
// }

export const getProposals = async () => {
  const client = await getGovernanceClient()

  const start = 0
  const limit = 30

  const activeProposals = client.activeProposals({ start, limit }).then((res) => res.proposal_list)
  const pendingProposals = client.pendingProposals({}).then((res) => res.proposal_list)

  const statusOrder: Record<string, number> = {
    active: 0,
    pending: 1,
    rejected: 2,
    executed: 3,
  }

  return Promise.all([activeProposals, pendingProposals])
    .then(([active, pending]) => [...active, ...pending])
    .then((proposals) =>
      proposals.sort((a, b) => {
        return statusOrder[a.status] - statusOrder[b.status]
      }),
    )
}
