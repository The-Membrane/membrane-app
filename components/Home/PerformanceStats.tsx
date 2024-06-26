import React from 'react'
import { Text, Card, HStack, Image, Stack } from '@chakra-ui/react'
import { getCookie } from '@/helpers/cookies'
import { useUserPositions } from '@/hooks/useCDP'
import useInitialVaultSummary from '../Mint/hooks/useInitialVaultSummary'
import { getAssetByDenom } from '@/helpers/chain'
import Divider from '../Divider'
import ConfirmModal from '../ConfirmModal'
import useUnLoop from './hooks/useUnloop'
import { SWAP_SLIPPAGE } from '@/config/defaults'
import { num } from '@/helpers/num'

type Props = {
  positionIndex: number
}

const PerformanceStats = ({ positionIndex }: Props) => {
    const { action: unloop, newPositionValue, newLTV } = useUnLoop(positionIndex)
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
    const levAsset = getAssetByDenom(position.collateral_assets[0].asset.info.native_token.denom)

    //Get performance 
    const sign = parseFloat(initialTVL) > currentTVL ? "-" : "+"
    const performance = sign + num(Math.abs((parseFloat(initialTVL) - currentTVL) / parseFloat(initialTVL) * 100)).times(1-(SWAP_SLIPPAGE/100)).toFixed(4) + "%"
    const fontColor = parseFloat(initialTVL) > currentTVL ? "red" : "green"
  return (
    <Card w="256px" alignItems="center" justifyContent="space-between" p="8" gap="0">
      <Stack>
        <Text variant="body" textTransform={'uppercase'} fontWeight={"bold"}  fontSize="16px" textDecoration={"underline"} mb="2" justifyContent={"center"} display={"flex"}>
        Performance
        </Text>
        <HStack>
          <Text fontWeight="bold" fontSize="16px">
            {levAsset?.symbol??"N/A"} 
          </Text>
          <Image src={levAsset?.logo} w="24px" h="24px" />                 
          <Text fontWeight="bold" fontSize="16px">
            |
          </Text>
          <Stack>
            <Text fontWeight="bold" fontSize="16px" justifyContent={"center"} display={"flex"}>
            <span style={{ color: fontColor }}>{performance}</span>
            </Text>
            <Divider mx="0" mt="0" mb="0" width="100%"/>
            <Text fontWeight="bold" fontSize="16px" justifyContent={"center"} display={"flex"}>
            <span style={{ color: fontColor }}>{sign === "+" ? "+" : "-"}${Math.abs(currentTVL-parseInt(initialTVL)).toFixed(2)}</span>
            </Text>
          </Stack>   
        </HStack>    
        {/* Close Position Button */}
        <ConfirmModal 
        action={unloop}
        label={newLTV === 0 ? "Close" : "Partial Close"}
        // isDisabled={}
        >
          {/* <QASummary newPositionValue={parseInt(newPositionValue.toFixed(0))} swapRatio={swapRatio} summary={summary}/> */}
        </ConfirmModal>  
      </Stack>
    </Card>
  )
}

export default PerformanceStats
