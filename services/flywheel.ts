import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import contracts from '@/config/contracts.json'

export interface DiscoTotalInsuranceResponse {
    with_oracle?: {
        total_insurance: string
    }
    without_oracle?: {
        pending_cdt: string
        mbrn_deposit_totals: Array<[string, string]>
    }
}

/**
 * Get total insurance from Disco contract
 * Returns total in CDT if oracle available, otherwise returns separate values
 */
export const getDiscoTotalInsurance = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<string> => {
    if (!client) return "0"

    const discoContract = contractAddr || (contracts as any).ltv_disco
    if (!discoContract || discoContract === "") return "0"

    try {
        const response = await client.queryContractSmart(discoContract, {
            get_total_insurance: {}
        }) as DiscoTotalInsuranceResponse

        if (response.with_oracle) {
            return response.with_oracle.total_insurance
        } else if (response.without_oracle) {
            // Return pending CDT as fallback
            return response.without_oracle.pending_cdt
        }
        return "0"
    } catch (error) {
        console.error("Error querying Disco total insurance:", error)
        return "0"
    }
}

/**
 * Get Transmuter TVL (total deposit value)
 */
export const getTransmuterTVL = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<string> => {
    if (!client) return "0"

    const transmuterContract = contractAddr || (contracts as any).transmuter
    if (!transmuterContract || transmuterContract === "") return "0"

    try {
        const response = await client.queryContractSmart(transmuterContract, {
            vault_info: {}
        })

        return response.total_deposit_value || "0"
    } catch (error) {
        console.error("Error querying Transmuter TVL:", error)
        return "0"
    }
}

/**
 * Get Manic (Yield-Arb) TVL from latest snapshot
 */
export const getManicTVL = async (
    client: CosmWasmClient | null,
    contractAddr?: string
): Promise<string> => {
    if (!client) return "0"

    const yieldArbContract = contractAddr || (contracts as any).yield_arb
    if (!yieldArbContract || yieldArbContract === "") return "0"

    try {
        const response = await client.queryContractSmart(yieldArbContract, {
            get_tvl_history: {
                limit: 1
            }
        })

        // Response should be an array of TVL snapshots
        if (Array.isArray(response) && response.length > 0) {
            return response[0].tvl || "0"
        }
        return "0"
    } catch (error) {
        console.error("Error querying Manic TVL:", error)
        return "0"
    }
}

