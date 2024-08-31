import { getUnderlyingUSDC, getVaultAPRResponse } from "@/services/earn"
import { useQuery } from "@tanstack/react-query"

export const useVaultTokenUnderlying = (vtAmount: string) => {
    return useQuery({
        queryKey: ['useVaultTokenUnderlying', vtAmount],
        queryFn: async () => {
        return getUnderlyingUSDC(vtAmount)
        },
    })
}

export const useAPR = () => {
    return useQuery({
        queryKey: ['useAPR'],
        queryFn: async () => {
        return getVaultAPRResponse()
        },
    })
}
