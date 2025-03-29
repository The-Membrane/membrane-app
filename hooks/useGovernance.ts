import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { getDelegatorInfo } from '@/services/staking'
import { getProposal } from '@/services/governance'
import { getUserDelegations } from '@/services/staking'
import { getUserVotingPower } from '@/services/governance'
import { getProposals } from '@/services/governance'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/router'

export const useProposalById = (proposalId: number) => {
    const { appState } = useAppState()
    const { address } = useWallet()
    const router = useRouter()

    return useQuery({
        queryKey: ['proposal', appState.rpcUrl, proposalId, address, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            return getProposal(proposalId, appState.rpcUrl, address)
        },
        enabled: !!proposalId,
    })
}


export const useDelegator = (address: string, enabled = false) => {
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['delegator', appState.rpcUrl, address, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            if (!address) return Promise.reject('No address found')

            return getDelegatorInfo(address, appState.rpcUrl)
        },
        enabled: !!address && enabled,
    })
}


export const useVotingPower = (proposalId: number) => {
    const { appState } = useAppState()
    const { address } = useWallet()
    const router = useRouter()

    return useQuery({
        queryKey: ['user voting power', appState.rpcUrl, address, proposalId, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            if (!address) return Promise.reject('No address found')

            return getUserVotingPower(address, proposalId, appState.rpcUrl)
        },
        enabled: !!address && !!proposalId,
    })
}


export const useProposals = () => {
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['proposals', appState.rpcUrl, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            return getProposals(appState.rpcUrl)
        },
    })
}


export const useDelegations = () => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['delegations', address, appState.rpcUrl, router.pathname],
        queryFn: async () => {
            if (router.pathname != "/stake") return
            if (!address) return Promise.reject('No address found')

            return getUserDelegations(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}