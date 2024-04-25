import { useBalanceByAsset } from "@/hooks/useBalance"
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Card, HStack, Input, Stack, TabPanel, Text } from "@chakra-ui/react"
import { SliderWithState } from "./SliderWithState"
import useLPState from "./hooks/useLPState"
import ConfirmModal from "../ConfirmModal"
import { LPSummary } from "./LPSummary"
import useLP from "./hooks/useLP"
import { num } from "@/helpers/num"
import { ChangeEvent, KeyboardEventHandler, useState } from "react"
import { useOraclePrice } from "@/hooks/useOracle"
import debounce from 'lodash/debounce';



const ErrorMessage = ({ outsidePriceRange = false}: { outsidePriceRange?: boolean }) => {
  return (
    <Text fontSize="sm" color="red.500" mt="2" minH="21px">
      {outsidePriceRange ? "CDT price is below 0.98 & we don't want to provide you a bad swap rate" : ' '}
    </Text>
  )
}

const LPTab = () => {
    const cdt = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdt)
    const { LPState, setLPState } = useLPState()
    const { data: prices } = useOraclePrice()
    const cdtPrice = prices?.find((price) => price.denom === cdt?.base)
    
    const txSuccess = () => {
        setLPState({ newCDT: 0})
    }
    const LP = useLP({ txSuccess })

    const onCDTChange = (value: number) => {
        setLPState({ ...LPState, newCDT: value})
    }
    
    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
      e.preventDefault();
      const newAmount = e.target.value

      if (num(newAmount).isGreaterThan(cdtBalance)) setLPState({newCDT: parseInt(cdtBalance)})
      else if (num(LPState?.newCDT).isGreaterThan(num(newAmount))) return 
      else setLPState({newCDT: parseInt(e.target.value)})
    }
      
    
    return (
        <TabPanel>
        <Card p="8" alignItems="center" gap={7}>
          <Text variant="title" fontSize="24px" >
            <a style={{textDecoration: "underline"}} href="https://app.osmosis.zone/pool/1268">USDC LP</a>
          </Text>
    
          <Stack py="5" w="full" gap="5">      
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              CDT
            </Text>
            <Input 
              width={"38%"} 
              textAlign={"center"} 
              placeholder="0" 
              type="number" 
              value={LPState?.newCDT} 
              onChange={handleInputChange}
              onBlur={(e: ChangeEvent<HTMLInputElement>)=>{
                e.preventDefault();
                const newAmount = e.target.value
                if (num(newAmount).isGreaterThan(cdtBalance)) setLPState({newCDT: parseInt(cdtBalance)})
                else setLPState({newCDT: parseInt(e.target.value)})
              }}
             />
          </HStack>      
          <SliderWithState
            value={LPState?.newCDT}
            onChange={onCDTChange}
            min={0}
            max={Number(cdtBalance)}
          />
          </Stack>

          <ConfirmModal label="Join LP" action={LP} isDisabled={LPState?.newCDT === 0 || parseFloat(cdtPrice?.price ?? '0') < 0.98}>
            <LPSummary />
          </ConfirmModal>            
          <ErrorMessage outsidePriceRange={parseFloat(cdtPrice?.price ?? "0") < 0.98}/>
        </Card>
        </TabPanel>
      )
}

export default LPTab