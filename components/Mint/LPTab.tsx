import { useBalanceByAsset } from "@/hooks/useBalance"
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Card, HStack, Stack, Text } from "@chakra-ui/react"
import { SliderWithState } from "./SliderWithState"
import useLPState from "./hooks/useLPState"
import ConfirmModal from "../ConfirmModal"
import { Summary } from "./Summary"

const LPSlider = () => {
}

const LPTab = () => {
    const cdt = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdt)

    const { LPState, setLPState } = useLPState()
    
    const bid = useBid({ txSuccess })

    const onCDTChange = (value: number) => {
        setLPState({ ...LPState, newCDT: value})
      }
    
    return (
        <Card p="8" alignItems="center" gap={5}>
          <Text variant="title" fontSize="24px" >
            <a href="https://app.osmosis.zone/pool/1268">USDC Stableswap LP</a>.
          </Text>
    
          <Stack py="5" w="full" gap="5">      
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              {LPState.newCDT}
            </Text>
            <Text fontSize="16px" fontWeight="700">
              CDT
            </Text>
          </HStack>      
          <SliderWithState
            value={LPState.newCDT}
            onChange={onCDTChange}
            min={0}
            max={Number(cdtBalance)}
          />
          </Stack>

          <ConfirmModal label="Join LP" action={} isDisabled={LPState.newCDT === 0}>
            <Summary />
        </ConfirmModal>
        </Card>
      )
}

export default LPTab