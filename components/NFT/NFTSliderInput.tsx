import { HStack, Input, Stack, Text} from "@chakra-ui/react"
import { ChangeEvent, useEffect } from "react"
import { num } from "@/helpers/num"
import { delayTime } from "@/config/defaults"
import QASelect from "../QuickActionSelect"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import Divider from "../Divider"
import React from "react"
import { NFTAssetSlider } from "../NFT/NFTAssetSlider"
import { NFTState } from "./hooks/useNFTState"

type Props = {
    value: string
    onChange: (value: string) => void
    assets: AssetWithBalance[]
  }
  
  const AssetsWithBalanceMenu = ({ value, onChange, assets }: Props) => {
      return <QASelect options={assets} onChange={onChange} value={value} />
  }
  
  type SliderWithInputProps = {
    max: number
    inputBoxWidth?: string
    NFTState: NFTState
    setNFTState: (partialState: Partial<NFTState>) => void
    onMenuChange: (value: string) => void
    inputAmount: number
    setInputAmount: (value: number) => void
  }
  
  export const SliderWithInputBox = React.memo(({ max, inputBoxWidth = "38%", QAState, setQAState, onMenuChange, inputAmount, setInputAmount, bridgeCardToggle = false }: SliderWithInputProps) => {
            const onSliderChange = (value: number) => {      
        if (inputAmount != value) setInputAmount(value)

          if (bridgeCardToggle) {
            if (num(value).isGreaterThan(max)) setQAState({ selectedAsset: { ...QAState?.selectedAsset, amount: max, sliderValue: max }})
            else setQAState({ selectedAsset: { ...QAState?.selectedAsset, amount: value, sliderValue: value }})
          }
      }
  
      const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const newAmount = e.target.value
        if (num(newAmount).isGreaterThan(max)) setInputAmount(max)
          else setInputAmount(parseInt(e.target.value))
  
        setTimeout(() => {
          if (num(newAmount).isGreaterThan(max)) setQAState({ selectedAsset: { ...QAState?.selectedAsset, amount: max, sliderValue: max }})
            else setQAState({ selectedAsset: { ...QAState?.selectedAsset, amount: (parseInt(e.target.value)), sliderValue: (parseInt(e.target.value)) }})
        }, delayTime);  
      }
  
      useEffect(() => {
        //If the selected asset has a different slider value than the inputAmount, set the inputAmount to the slider value
        if (QAState?.selectedAsset?.sliderValue != inputAmount) {
          setInputAmount(QAState?.selectedAsset?.sliderValue??0)
        }
      }, [QAState?.selectedAsset?.sliderValue])
      
  
  
      return (
      <Stack py="5" w="full" gap="3" mb={"0"} pb={"0"} >     
        <Text fontSize="14px" fontWeight="700">
          Choose Asset
        </Text> 
        <Divider mx="0" mt="0" mb="5"/>
        <HStack justifyContent="space-between">
          <AssetsWithBalanceMenu 
            value={QAState?.selectedAsset} 
            onChange={onMenuChange}
            assets={QAState?.assets}
          />
          <Input 
            width={inputBoxWidth} 
            textAlign={"center"} 
            placeholder="0" 
            type="number" 
            value={inputAmount} 
            onChange={handleInputChange}
          />
        </HStack>
        <NFTAssetSlider key={QAState?.selectedAsset?.base} asset={QAState?.selectedAsset} label={QAState?.selectedAsset?.symbol} onChangeExt={onSliderChange} />  
    </Stack>)
  })