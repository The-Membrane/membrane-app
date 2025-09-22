import { useQuery } from '@tanstack/react-query'
import useAppState from '@/persisted-state/useAppState'
import contracts from '@/config/contracts.json'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'

// Tournament query types based on the Rust structs
export interface TournamentState {
    tournament_id: string
    status: 'NotStarted' | 'InProgress' | 'Completed'
    current_round: number
    total_rounds: number
    participants: number[]
    track_id: string
    allow_free_registration: boolean
}

export interface Registration {
    car_id: number
    registered_at: number
    payment_option?: {
        denom: string
        amount: string
    }
}

export interface TournamentMatch {
    match_id: string
    car1: number
    car2: number
    winner?: number
    completed: boolean
}

export interface CurrentBracket {
    round: number
    matches: TournamentMatch[]
    participants: number[]
}

export interface TournamentResults {
    tournament_id: string
    winner?: number
    final_rankings: Array<{
        car_id: number
        rank: number
        wins: number
        losses: number
    }>
    total_participants: number
}

export interface TournamentConfig {
    admin: string
    race_engine: string
    byte_minter: string
    car_contract: string
    tokenfactory_denom: string
    mint_amount_per_round_win: string
    reward_round_scalar: string
    allow_free_registration?: boolean
}

// Hook to get tournament state
export const useTournamentState = () => {
    const { appState } = useAppState()

    return useQuery<TournamentState>({
        queryKey: ['tournament', 'state', appState.rpcUrl],
        queryFn: async () => {
            const client = await CosmWasmClient.connect(appState.rpcUrl)
            const contractAddress = (contracts as any).tournament

            const result = await client.queryContractSmart(contractAddress, {
                get_tournament_state: {}
            })

            return result
        },
        enabled: !!appState.rpcUrl,
        // refetchInterval: 5000, // Refetch every 5 seconds
    })
}

// Hook to get registrations
export const useRegistrations = () => {
    const { appState } = useAppState()

    return useQuery<{ registrations: Registration[] }>({
        queryKey: ['tournament', 'registrations', appState.rpcUrl],
        queryFn: async () => {
            const client = await CosmWasmClient.connect(appState.rpcUrl)
            const contractAddress = (contracts as any).tournament

            const result = await client.queryContractSmart(contractAddress, {
                get_registrations: {}
            })

            return result
        },
        enabled: !!appState.rpcUrl,
        // refetchInterval: 5000,
    })
}

// Hook to get current bracket
export const useCurrentBracket = () => {
    const { appState } = useAppState()

    return useQuery<CurrentBracket>({
        queryKey: ['tournament', 'bracket', appState.rpcUrl],
        queryFn: async () => {
            const client = await CosmWasmClient.connect(appState.rpcUrl)
            const contractAddress = (contracts as any).tournament

            const result = await client.queryContractSmart(contractAddress, {
                get_current_bracket: {}
            })

            return result
        },
        enabled: !!appState.rpcUrl,
        // refetchInterval: 5000,
    })
}

// Hook to get tournament results
export const useTournamentResults = () => {
    const { appState } = useAppState()

    return useQuery<TournamentResults>({
        queryKey: ['tournament', 'results', appState.rpcUrl],
        queryFn: async () => {
            const client = await CosmWasmClient.connect(appState.rpcUrl)
            const contractAddress = (contracts as any).tournament

            const result = await client.queryContractSmart(contractAddress, {
                get_tournament_results: {}
            })

            return result
        },
        enabled: !!appState.rpcUrl,
    })
}

// Hook to check if a car is a participant
export const useIsParticipant = (carId: number) => {
    const { appState } = useAppState()

    return useQuery<{ car_id: number; is_participant: boolean }>({
        queryKey: ['tournament', 'participant', carId, appState.rpcUrl],
        queryFn: async () => {
            const client = await CosmWasmClient.connect(appState.rpcUrl)
            const contractAddress = (contracts as any).tournament

            const result = await client.queryContractSmart(contractAddress, {
                is_participant: { car_id: carId }
            })

            return result
        },
        enabled: !!appState.rpcUrl && !!carId,
    })
}

// Hook to get tournament config
export const useTournamentConfig = () => {
    const { appState } = useAppState()

    return useQuery<{ config: TournamentConfig }>({
        queryKey: ['tournament', 'config', appState.rpcUrl],
        queryFn: async () => {
            const client = await CosmWasmClient.connect(appState.rpcUrl)
            const contractAddress = (contracts as any).tournament

            const result = await client.queryContractSmart(contractAddress, {
                get_config: {}
            })

            return result
        },
        enabled: !!appState.rpcUrl,
        refetchInterval: 5000,
    })
}
