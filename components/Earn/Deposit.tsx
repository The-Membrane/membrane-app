import React, { useEffect, useMemo } from 'react'
import { Card, HStack, Text } from '@chakra-ui/react'
import { TxButton } from '@/components/TxButton'
import useUnloop from '../Home/hooks/useUnloop'
import useStableYieldLoop from './hooks/useStableYieldLoop'
import { isGreaterThanZero } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import ActModal from './ActModal'
import useEarnState from './hooks/useEarnState'
import { useBasketPositions, useUserPositions } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { Asset } from '@/helpers/chain'
import { useOraclePrice } from '@/hooks/useOracle'
import { Price } from '@/services/oracle'
import { SliderWithState } from '../Mint/SliderWithState'


const DepositButton = ({ usdyAsset, usdyPrice, prices}: { usdyAsset: Asset | null, usdyPrice: number, prices: Price[] | undefined }) => {
  const { earnState, setEarnState } = useEarnState()
  const usdyBalance = useBalanceByAsset(usdyAsset)
  const { action: stableLooping } = useStableYieldLoop( { usdyAsset, usdyPrice, prices} )

  const onSliderChange = (value: number) => {
    setEarnState({ deposit: value })
  }

  return (
    <ActModal
      // px="5"
      // w="fit-content"
      // fontSize="sm"
      label="Deposit"
      isDisabled={!isGreaterThanZero(usdyBalance)}
      action={stableLooping}
    >
      <SliderWithState value={earnState.deposit} onChange={onSliderChange} min={0} max={parseFloat(usdyBalance)} walletCDT={1} summary={["empty"]}/>
    </ActModal>
  )
}

const WithdrawButton = ({ positionIndex, position }: { positionIndex: number, position: PositionResponse | undefined }) => {
    const { earnState, setEarnState } = useEarnState()
    //Find totalEarnDeposit by dividing the USDY collateral position by the leverage taken to get the yield
    const totalEarnDeposit = useMemo(() => {
      if (!position) return 0
      return shiftDigits( position.collateral_assets[0].asset.amount, -18).toNumber() / earnState.leverageMulti
    }, [position])

    //Unloop to the withdrawal amount
    const { action: stableUnLooping } = useUnloop(positionIndex, earnState.withdraw)

    const onSliderChange = (value: number) => {
      setEarnState({ withdraw: value })
    }

    return (
      <ActModal
        // px="5"
        // w="fit-content"
        // fontSize="sm"
        label="Withdraw"
        isDisabled={!isGreaterThanZero(totalEarnDeposit)}
        action={stableUnLooping}
      >
      <SliderWithState value={earnState.withdraw} onChange={onSliderChange} min={0} max={totalEarnDeposit} walletCDT={1} summary={["empty"]}/>
      </ActModal>
    )
}

const Deposit = () => {
  const { earnState } = useEarnState()
  const usdyAsset = useAssetBySymbol('USDY')
  const { data: prices } = useOraclePrice()
  const usdyPrice = parseFloat(prices?.find((price) => price.denom === usdyAsset?.base)?.price ?? "0")
  //Get the position data  
  const { data: basketPositions } = useUserPositions()
  const { position, positionIndex } = useMemo(() => {
    if (!basketPositions) return { position: undefined, positionIndex: 0 }
    //@ts-ignore
    let positionIndex = basketPositions?.[0].positions.findIndex((position) => position.collateral_assets.length === 1 && position.collateral_assets[0].asset.info.native_token.denom === 'ibc/23104D411A6EB6031FA92FB75F227422B84989969E91DCAD56A535DD7FF0A373')
    return { 
      position: basketPositions?.[0].positions[positionIndex],
      positionIndex
    }
  }, [basketPositions])
  
  //Calc its TVL
  const TVL = useMemo(() => {
    if (!position || !usdyAsset || !usdyPrice) return 0
    return shiftDigits(position?.collateral_assets[0].asset.amount, usdyAsset?.decimal).toNumber() * usdyPrice
  }, [position, usdyPrice, usdyAsset])

  //Dividing the TVL by the leverage taken to get the total deposit
  const totalDeposit = TVL / earnState.leverageMulti

  return (
    <Card p="8" gap={5}>
      <Text variant="title">Total Deposit</Text>
      <Text variant="body">{totalDeposit} USD</Text>  
      <HStack justifyContent="end" width={"100%"} gap={"1rem"}>
        <DepositButton usdyAsset={usdyAsset} usdyPrice={usdyPrice} prices={prices}/>
        <WithdrawButton positionIndex={positionIndex} position={position}/>
      </HStack>    

    </Card>
  )
}

export default Deposit
