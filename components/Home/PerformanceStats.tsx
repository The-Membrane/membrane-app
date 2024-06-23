import React from 'react'
import { Text, Card } from '@chakra-ui/react'
import { getCookie } from '@/helpers/cookies'
import { useUserPositions } from '@/hooks/useCDP'
import useInitialVaultSummary from '../Mint/hooks/useInitialVaultSummary'
import { stableDenoms } from '@/config/defaults'
import { getAssetByDenom } from '@/helpers/chain'

type Props = {
  positionIndex: number
}

const PerformanceStats = ({ positionIndex }: Props) => {
    const { data: basketPositions } = useUserPositions()
    //Get the current position's value
    const { initialTVL: currentTVL } = useInitialVaultSummary( positionIndex )

    if (!basketPositions) return null
    if (!basketPositions[0].positions[positionIndex]) return null

    //Set positionID
    const position = basketPositions[0].positions[positionIndex]
    const positionID = position.position_id
    //Get the position value saved in le cookie
    console.log("attempting to get cookie: no liq leverage " + positionID)
    const initialTVL = getCookie("no liq leverage " + positionID)
    if (initialTVL == null) return null

    //Get the volatile asset being leveraged
    //We know its the first asset bc we deposit the stable second
    const levAsset = getAssetByDenom(position.collateral_assets[0].asset.info.denom)?.symbol??"N/Symbol"

    //Get performance 
    const sign = parseFloat(initialTVL) > currentTVL ? "-" : "+"
    const performance = sign + Math.abs((parseFloat(initialTVL) - currentTVL) / parseFloat(initialTVL) * 100).toFixed(4) + "%"
    const fontColor = parseFloat(initialTVL) > currentTVL ? "red" : "green"
  return (
    <Card w="256px" alignItems="center" justifyContent="space-between" p="8" gap="0">
      <Text fontWeight="bold" fontSize="16px">
      {levAsset} <span style={{ color: fontColor }}>{performance}</span> | {parseInt(initialTVL)} {"->"} {currentTVL.toFixed(0)}
      </Text>
    </Card>
  )
}

export default PerformanceStats
