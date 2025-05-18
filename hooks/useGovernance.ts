import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { getDelegatorInfo, useStakingClient } from '@/services/staking'
import { getProposal, useGovernanceClient } from '@/services/governance'
import { getUserDelegations } from '@/services/staking'
import { getUserVotingPower } from '@/services/governance'
import { getProposals } from '@/services/governance'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'
import { useChainRoute } from './useChainRoute'

export const useProposalById = (proposalId: number) => {
    const { data: client } = useGovernanceClient()
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)
    const router = useRouter()

    return useQuery({
        queryKey: ['proposal', client, proposalId, address, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            return getProposal(proposalId, client, address)
        },
        enabled: !!proposalId,
    })
}


export const useDelegator = (address: string, enabled = false) => {
    const { data: client } = useStakingClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['delegator', client, address, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            if (!address) return Promise.reject('No address found')

            return getDelegatorInfo(address, client)
        },
        enabled: !!address && enabled,
    })
}


export const useVotingPower = (proposalId: number) => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)

    const { data: client } = useGovernanceClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['user voting power', client, address, proposalId, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            if (!address) return Promise.reject('No address found')

            return getUserVotingPower(address, proposalId, client)
        },
        enabled: !!address && !!proposalId,
    })
}


export const useProposals = () => {
    const { data: client } = useGovernanceClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['proposals', client, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            return getProposals(client)
        },
    })
}


export const useDelegations = () => {
    const { address } = useWallet()
    const { data: client } = useStakingClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['delegations', address, client, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            if (!address) return Promise.reject('No address found')

            return getUserDelegations(address, client)
        },
        enabled: !!address,
    })
}