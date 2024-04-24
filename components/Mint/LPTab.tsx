import { useBalanceByAsset } from "@/hooks/useBalance"
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Card, HStack, Input, Stack, TabPanel, Text } from "@chakra-ui/react"
import { SliderWithState } from "./SliderWithState"
import useLPState from "./hooks/useLPState"
import ConfirmModal from "../ConfirmModal"
import { LPSummary } from "./LPSummary"
import useLP from "./hooks/useLP"
import { num } from "@/helpers/num"
import { ChangeEvent, useState } from "react"


const LPTab = () => {
    const cdt = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdt)

    const { LPState, setLPState } = useLPState()
    const [inputAmount, setInputAmount] = useState(0)
    
    const txSuccess = () => {
        setLPState({ newCDT: 0})
    }
    const LP = useLP({ txSuccess })

    const onCDTChange = (value: number) => {
        setLPState({ ...LPState, newCDT: value})
    }

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
      const newAmount = e.target.value
      if (num(newAmount).isGreaterThan(LPState?.newCDT)) setInputAmount(LPState?.newCDT)
      else setInputAmount(parseInt(e.target.value))
    }
    
    return (
        <TabPanel>
        <Card p="8" alignItems="center" gap={5}>
          <Text variant="title" fontSize="24px" >
            <a style={{textDecoration: "underline"}} href="https://app.osmosis.zone/pool/1268">USDC LP</a>
          </Text>
    
          <Stack py="5" w="full" gap="5">      
          <HStack justifyContent="space-between">
          <Input placeholder="0" value={LPState?.newCDT} onChange={handleInputChange} />
            {/* <Text fontSize="16px" fontWeight="700">
              {LPState?.newCDT}
            </Text> */}
            <Text fontSize="16px" fontWeight="700">
              CDT
            </Text>
          </HStack>      
          <SliderWithState
            value={LPState?.newCDT}
            onChange={onCDTChange}
            min={0}
            max={Number(cdtBalance)}
          />
          </Stack>

          <ConfirmModal label="Join LP" action={LP} isDisabled={LPState?.newCDT === 0}>
            <LPSummary />
        </ConfirmModal>
        </Card>
        </TabPanel>
      )
}

export default LPTab