import { Button, HStack, Input, Stack } from "@chakra-ui/react"
import { QuickActionAssetWithSlider } from "./QuickActionAssetSlider"
import { ChangeEvent, useEffect } from "react"
import { num } from "@/helpers/num"
import { delayTime } from "@/config/defaults"
import { QuickActionState } from "./hooks/useQuickActionState"
import QASelect from "../QuickActionSelect"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import React from "react"
import { GrClose } from 'react-icons/gr'

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
    assets: AssetWithBalance[]
    QAState: QuickActionState
    setQAState: (partialState: Partial<QuickActionState>) => void
    onMenuChange: (value: string, index: number) => void
    inputAmounts: number[]
    setInputAmounts: (value: number[]) => void
    levAssetIndex: number
  }

  ////Remove menu options for assets that aren't the last 1
  
  export const SliderWithInputBox = React.memo(({ max, inputBoxWidth = "38%", assets, QAState, setQAState, onMenuChange, inputAmounts, setInputAmounts, levAssetIndex }: SliderWithInputProps) => {
      const onSliderChange = (value: number) => {      
        if (inputAmounts[levAssetIndex] != value) {
          inputAmounts[levAssetIndex] = value
          setInputAmounts(inputAmounts)
        }
      }
  
      const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const newAmount = e.target.value
        
        if (num(newAmount).isGreaterThan(max)) inputAmounts[levAssetIndex] = max
          else inputAmounts[levAssetIndex] = parseInt(e.target.value)
        setInputAmounts(inputAmounts)
  
        setTimeout(() => {
          if (!QAState?.levAssets) return
          if (num(newAmount).isGreaterThan(max)) QAState.levAssets[levAssetIndex].sliderValue = max
            else QAState.levAssets[levAssetIndex].sliderValue = parseInt(e.target.value)
          setQAState({levAssets: QAState.levAssets})
          
        }, delayTime);  
      }
  
      useEffect(() => {
        if (!QAState?.levAssets) return
        //If the selected asset has a different slider value than the inputAmount, set the inputAmount to the slider value
        if (QAState.levAssets[levAssetIndex].sliderValue != inputAmounts[levAssetIndex]) {
          inputAmounts[levAssetIndex] = QAState.levAssets[levAssetIndex].sliderValue??0
          setInputAmounts(inputAmounts)
        }
      }, [QAState?.levAssets?.[levAssetIndex].sliderValue])
      
  
      return (
      <Stack py="5" w="full" gap="3" mb={"0"} pb={"5"} >     
        {QAState?.levAssets?.[levAssetIndex] != undefined ? <><HStack justifyContent="space-between">
          <AssetsWithBalanceMenu 
            value={QAState?.levAssets[levAssetIndex]} 
            onChange={(value) => onMenuChange(value, levAssetIndex)}
            assets={assets}
          />          
          <Button variant="ghost" leftIcon={<GrClose />} onClick={()=>{}}/>
          <Input 
            width={inputBoxWidth} 
            textAlign={"center"} 
            placeholder="0" 
            type="number" 
            value={inputAmounts[levAssetIndex]} 
            onChange={handleInputChange}
          />
        </HStack>
        <QuickActionAssetWithSlider onChangeExt={onSliderChange} asset={QAState?.levAssets[levAssetIndex]} label={QAState?.levAssets?.[levAssetIndex].symbol} levAssetIndex={levAssetIndex} />        
        </> : null}  
      </Stack>
    )
  })