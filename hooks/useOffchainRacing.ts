// Client-side react-query surface for the offchain Q-Racing game loop
// (pages/api/game/*). Follows the repo's queryKey/staleTime conventions (hook-query-patterns):
// one durable state query + mutations that invalidate it.
//
// Auth is the httpOnly player cookie (same-origin), so every request just needs credentials —
// the cookie is set on first POST /api/game/player. `ensurePlayer` bootstraps it exactly once.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export const GAME_STATE_KEY = ['offchain-game', 'state'] as const

export type OffchainPet = {
  id: string
  name: string
  status: string
  attrSeed: number
  attributes: unknown
  createdAt: string
}

export type OffchainRaceRow = {
  id: string
  mazeSeed: number
  difficulty: number
  status: string
  verified: boolean
  timeTicks: number | null
  byteAwarded: string | null
  createdAt: string
}

export type OffchainGameState = {
  player: { id: string; username: string | null; createdAt: string }
  pet: OffchainPet | null
  byteBalance: string
  energy: { value: number; max: number; refillAt: string | null }
  races: OffchainRaceRow[]
}

export type StartRaceResult = { raceId: string; mazeSeed: number; difficulty: number }

export type SubmitRaceResult = {
  verified: boolean
  ticks: number
  byteAwarded: string
  newBalance: string
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = new Error(
      (data as { error?: string } | null)?.error || `request_failed_${res.status}`,
    ) as Error & { status?: number; payload?: unknown }
    err.status = res.status
    err.payload = data
    throw err
  }
  return data as T
}

// Memoized so the cookie is only minted once per page load, no matter how many hooks mount.
// Exported so other client-side game hooks (e.g. useSessionHeartbeat) share this same
// bootstrap instead of re-implementing/re-triggering it.
let playerBootstrap: Promise<void> | null = null
export function ensurePlayer(): Promise<void> {
  if (!playerBootstrap) {
    playerBootstrap = jsonFetch('/api/game/player', { method: 'POST' })
      .then(() => undefined)
      .catch((e) => {
        playerBootstrap = null // let a later render retry
        throw e
      })
  }
  return playerBootstrap
}

export function useOffchainRacing() {
  const queryClient = useQueryClient()
  const invalidateState = () => queryClient.invalidateQueries({ queryKey: GAME_STATE_KEY })

  const state = useQuery<OffchainGameState>({
    queryKey: GAME_STATE_KEY,
    queryFn: async () => {
      await ensurePlayer()
      return jsonFetch<OffchainGameState>('/api/game/state')
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })

  const createPet = useMutation<{ pet: OffchainPet }, Error, { name: string }>({
    mutationFn: async ({ name }) => {
      await ensurePlayer()
      return jsonFetch<{ pet: OffchainPet }>('/api/game/pet', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
    },
    onSuccess: invalidateState,
  })

  const startRace = useMutation<StartRaceResult, Error, { difficulty: number }>({
    mutationFn: async ({ difficulty }) => {
      await ensurePlayer()
      return jsonFetch<StartRaceResult>('/api/game/race/start', {
        method: 'POST',
        body: JSON.stringify({ difficulty }),
      })
    },
    // Energy was spent — refresh state immediately.
    onSuccess: invalidateState,
  })

  const submitRace = useMutation<SubmitRaceResult, Error, { raceId: string; moves: number[] }>({
    mutationFn: async ({ raceId, moves }) => {
      await ensurePlayer()
      return jsonFetch<SubmitRaceResult>('/api/game/race/submit', {
        method: 'POST',
        body: JSON.stringify({ raceId, moves }),
      })
    },
    onSuccess: invalidateState,
  })

  return { state, createPet, startRace, submitRace }
}

export default useOffchainRacing
