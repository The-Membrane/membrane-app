// Exact resolver ABI retained from the already used native capacity collector.
import { parseAbi } from 'viem'

export const FLUID_USDC_BRIDGE_BASE_ABI = parseAbi([
  'function asset() view returns(address)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function previewRedeem(uint256) view returns(uint256)',
  'function maxWithdraw(address) view returns(uint256)',
  'function getFUSDC() view returns(address)',
  'function getWithdrawalFeeBPS() view returns(uint256)',
  'function isWithdrawalsPaused() view returns(bool)',
  'function LIQUIDITY() view returns(address)',
  'function getData() view returns(address liquidity,address factory,address rewards,address permit2,address rebalancer,bool rewardsActive,uint256 liquidityBalance,uint256 liquidityExchangePrice,uint256 tokenExchangePrice)',
])
export const FLUID_RESOLVER_ABI = [
  {
    inputs: [],
    name: 'LIQUIDITY',
    outputs: [
      {
        internalType: 'contract IFluidLiquidity',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'address',
        name: 'user_',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'token_',
        type: 'address',
      },
    ],
    name: 'getUserSupplyData',
    outputs: [
      {
        components: [
          {
            internalType: 'bool',
            name: 'modeWithInterest',
            type: 'bool',
          },
          {
            internalType: 'uint256',
            name: 'supply',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'withdrawalLimit',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'lastUpdateTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expandPercent',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'expandDuration',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'baseWithdrawalLimit',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'withdrawableUntilLimit',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'withdrawable',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'decayEndTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'decayAmount',
            type: 'uint256',
          },
        ],
        internalType: 'struct Structs.UserSupplyData',
        name: 'userSupplyData_',
        type: 'tuple',
      },
      {
        components: [
          {
            internalType: 'uint256',
            name: 'borrowRate',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyRate',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'fee',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'lastStoredUtilization',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'storageUpdateThreshold',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'lastUpdateTimestamp',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyExchangePrice',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'borrowExchangePrice',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyRawInterest',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'supplyInterestFree',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'borrowRawInterest',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'borrowInterestFree',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'totalSupply',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'totalBorrow',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'revenue',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'maxUtilization',
            type: 'uint256',
          },
          {
            components: [
              {
                internalType: 'uint256',
                name: 'version',
                type: 'uint256',
              },
              {
                components: [
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'kink',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationZero',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationKink',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationMax',
                    type: 'uint256',
                  },
                ],
                internalType: 'struct Structs.RateDataV1Params',
                name: 'rateDataV1',
                type: 'tuple',
              },
              {
                components: [
                  {
                    internalType: 'address',
                    name: 'token',
                    type: 'address',
                  },
                  {
                    internalType: 'uint256',
                    name: 'kink1',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'kink2',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationZero',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationKink1',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationKink2',
                    type: 'uint256',
                  },
                  {
                    internalType: 'uint256',
                    name: 'rateAtUtilizationMax',
                    type: 'uint256',
                  },
                ],
                internalType: 'struct Structs.RateDataV2Params',
                name: 'rateDataV2',
                type: 'tuple',
              },
            ],
            internalType: 'struct Structs.RateData',
            name: 'rateData',
            type: 'tuple',
          },
        ],
        internalType: 'struct Structs.OverallTokenData',
        name: 'overallTokenData_',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const FLUID_USDC_BRIDGE_NATIVE_ABI = [
  ...FLUID_USDC_BRIDGE_BASE_ABI,
  ...FLUID_RESOLVER_ABI,
] as const
