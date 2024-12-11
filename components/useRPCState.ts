import { create } from 'zustand'
import { devtools } from 'zustand/middleware'


export type RPCState = {
  rpcURLs: string[],
  urlIndex: number
}

type Store = {
  rpcState: RPCState
  setRPCState: (partialState: Partial<RPCState>) => void
}

const initialState: RPCState = {  
    rpcURLs: ['https://g.w.lavanet.xyz:443/gateway/osmosis/rpc-http/c6667993e9a0fac0a9c98d29502aa0a7', 'https://rpc.cosmos.directory/osmosis', 'https://rpc.osmosis.zone/', 'https://osmosis-rpc.polkachu.com/'],
    urlIndex: 0
}

// @ts-ignore
const store = (set) => ({
    rpcState: initialState,
  setRPCState: (partialState: Partial<RPCState>) =>
    set(
      (state: Store) => ({ rpcState: { ...state.rpcState, ...partialState } }),
      false,
      `@update/${Object.keys(partialState).join(',')}`,
    ),
})

// @ts-ignore
const useRPCState = create<Store>(devtools(store, { name: 'rpcState' }))

export default useRPCState
