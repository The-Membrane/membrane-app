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
    //Find the asset in the position that is not the stable asset
    const levAsset = getAssetByDenom(position.collateral_assets.find(asset => !stableDenoms.includes(asset.asset.info.denom))?.asset.info.denom??"N/A")?.symbol??"N/A"

    //Get performance 
    const sign = parseFloat(initialTVL) > currentTVL ? "-" : "+"
    const performance = sign + Math.abs((parseFloat(initialTVL) - currentTVL) / parseFloat(initialTVL) * 100).toFixed(4) + "%"

  return (
    <Card w="256px" alignItems="center" justifyContent="space-between" p="8" gap="0">
      <Text variant="title" fontSize="16px">
      {levAsset} {performance}
      </Text>
    </Card>
  )
}

export default PerformanceStats
