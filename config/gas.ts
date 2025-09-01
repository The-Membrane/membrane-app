// Gas configuration for different chains
export const GAS_CONFIG = {
    osmosis: {
        gasPrice: 0.01, // uosmo per gas unit
        gasLimit: undefined, // Let wallet estimate
        denom: 'uosmo'
    },
    osmosistestnet5: {
        gasPrice: 0.01, // uosmo per gas unit
        gasLimit: undefined, // Let wallet estimate
        denom: 'uosmo'
    },
    neutron: {
        gasPrice: 0.05, // untrn per gas unit (5x higher than default)
        gasLimit: '10000000', // 10M gas units
        denom: 'untrn'
    },
    neutrontestnet: {
        gasPrice: 0.05, // untrn per gas unit (5x higher than default)
        gasLimit: '10000000', // 10M gas units
        denom: 'untrn'
    }
} as const

// Helper function to calculate gas fee
export const calculateGasFee = (chainName: string, gas: string): string => {
    const config = GAS_CONFIG[chainName as keyof typeof GAS_CONFIG]
    if (!config || !config.gasLimit) return '0'

    // gas is in units, gasPrice is in tokens per gas unit
    // Convert to micro units (1 token = 1,000,000 micro units)
    const gasUnits = parseInt(gas)
    const feeInTokens = gasUnits * config.gasPrice
    const feeInMicroUnits = Math.ceil(feeInTokens * 1000000)
    return feeInMicroUnits.toString()
}

// Helper function to get gas config for a chain
export const getGasConfig = (chainName: string) => {
    return GAS_CONFIG[chainName as keyof typeof GAS_CONFIG] || null
}
