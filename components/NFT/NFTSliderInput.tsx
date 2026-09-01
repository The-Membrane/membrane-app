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
  
  export const AssetsWithBalanceMenu = ({ value, onChange, assets }: Props) => {
      return <QASelect options={assets as any} onChange={onChange} value={value} />
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
  
  export const SliderWithInputBox = React.memo(function SliderWithInputBox({ max, inputBoxWidth = "38%", NFTState, setNFTState, onMenuChange, inputAmount, setInputAmount}: SliderWithInputProps) {
        const onSliderChange = (value: number) => {      
        if (inputAmount != value) setInputAmount(value)

        if (num(value).isGreaterThan(max)) setNFTState({ selectedAsset: { ...NFTState?.selectedAsset, sliderValue: max } as any })
        else setNFTState({ selectedAsset: { ...NFTState?.selectedAsset, sliderValue: value } as any })
          
      }
  
      const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const newAmount = e.target.value
        if (num(newAmount).isGreaterThan(max)) setInputAmount(max)
          else setInputAmount(parseInt(e.target.value))
  
        setTimeout(() => {
          if (num(newAmount).isGreaterThan(max)) setNFTState({ selectedAsset: { ...NFTState?.selectedAsset, sliderValue: max } as any })
            else setNFTState({ selectedAsset: { ...NFTState?.selectedAsset, sliderValue: (parseInt(e.target.value)) } as any })
        }, delayTime);  
      }
  
      // Intentionally keyed only on sliderValue: this is a one-way sync (slider -> input).
      // `inputAmount` is read only to diff against; adding it as a dep would fire this on
      // every keystroke and revert the user's typed value before the debounced slider
      // update lands, so it is deliberately excluded (behavior-preserving).
      useEffect(() => {
        //If the selected asset has a different slider value than the inputAmount, set the inputAmount to the slider value
        if (NFTState?.selectedAsset?.sliderValue != inputAmount) {
          setInputAmount(NFTState?.selectedAsset?.sliderValue??0)
        }
      }, [NFTState?.selectedAsset?.sliderValue])
      
  
  
      return (
      <Stack py="5" w="full" gap="3" mb={"0"} pb={"0"} >     
        {NFTState?.selectedAsset ? <><Text fontSize="14px" fontWeight="700">
          Choose Asset
        </Text> 
        <Divider mx="0" mt="0" mb="5"/>
        <HStack justifyContent="space-between">
          <AssetsWithBalanceMenu 
            value={NFTState?.selectedAsset as any}
            onChange={onMenuChange}
            assets={NFTState?.assets}
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
        <NFTAssetSlider key={NFTState?.selectedAsset?.base} asset={NFTState?.selectedAsset} label={NFTState?.selectedAsset?.symbol} onChangeExt={onSliderChange} />  
        </>
      : null}
    </Stack>)
  })