import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { getDelegatorInfo } from '@/services/staking'
import { getProposal } from '@/services/governance'
import { getUserDelegations } from '@/services/staking'
import { getUserVotingPower } from '@/services/governance'
import { getProposals } from '@/services/governance'
import { useQuery } from '@tanstack/react-query'

export const useProposalById = (proposalId: number) => {
    const { appState } = useAppState()
    const { address } = useWallet()
    return useQuery({
        queryKey: ['proposal', proposalId, address],
        queryFn: async () => {
            return getProposal(proposalId, appState.rpcUrl, address)
        },
        enabled: !!proposalId,
    })
}


export const useDelegator = (address: string, enabled = false) => {
    const { appState } = useAppState()
    return useQuery({
        queryKey: ['delegator', address],
        queryFn: async () => {
            if (!address) return Promise.reject('No address found')

            return getDelegatorInfo(address, appState.rpcUrl)
        },
        enabled: !!address && enabled,
    })
}


export const useVotingPower = (proposalId: number) => {
    const { appState } = useAppState()
    const { address } = useWallet()
    return useQuery({
        queryKey: ['user voting power', address, proposalId],
        queryFn: async () => {
            if (!address) return Promise.reject('No address found')

            return getUserVotingPower(address, proposalId, appState.rpcUrl)
        },
        enabled: !!address && !!proposalId,
    })
}


export const useProposals = () => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['proposals'],
        queryFn: async () => {
            return getProposals(appState.rpcUrl)
        },
    })
}


export const useDelegations = () => {
    const { address } = useWallet()
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['delegations', address],
        queryFn: async () => {
            if (!address) return Promise.reject('No address found')

            return getUserDelegations(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}