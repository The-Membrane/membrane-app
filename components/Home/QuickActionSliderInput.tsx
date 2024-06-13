import { HStack, Input, Stack } from "@chakra-ui/react"
import { QuickActionAssetWithSlider } from "./QuickActionAssetSlider"
import { ChangeEvent, useEffect } from "react"
import { num } from "@/helpers/num"
import { delayTime } from "@/config/defaults"
import { QuickActionState } from "./hooks/useQuickActionState"
import QASelect from "../QuickActionSelect"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import React from "react"

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
    onMenuChange: (value: string) => void
    inputAmount: number
    setInputAmount: (value: number) => void
    stable?: boolean
  }
  
  export const SliderWithInputBox = React.memo(({ max, inputBoxWidth = "38%", assets, QAState, setQAState, onMenuChange, inputAmount, setInputAmount, stable = false }: SliderWithInputProps) => {
      const onSliderChange = (value: number) => {      
        if (inputAmount != value) setInputAmount(value)
      }
  
      const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        e.preventDefault()
        const newAmount = e.target.value
        if (num(newAmount).isGreaterThan(max)) setInputAmount(max)
          else setInputAmount(parseInt(e.target.value))
  
        setTimeout(() => {
          if (stable){
            if (num(newAmount).isGreaterThan(max)) setQAState({ stableAsset: { ...QAState?.stableAsset, amount: max, sliderValue: max }})
              else setQAState({ stableAsset: { ...QAState?.stableAsset, amount: (parseInt(e.target.value)), sliderValue: (parseInt(e.target.value)) }})
          } else {
            if (num(newAmount).isGreaterThan(max)) setQAState({ levAsset: { ...QAState?.levAsset, amount: max, sliderValue: max }})
              else setQAState({ levAsset: { ...QAState?.levAsset, amount: (parseInt(e.target.value)), sliderValue: (parseInt(e.target.value)) }})
          }
        }, delayTime);  
      }
  
      useEffect(() => {
        //If the selected asset has a different slider value than the inputAmount, set the inputAmount to the slider value
        if (QAState?.stableAsset?.sliderValue != inputAmount) {
          setInputAmount(QAState?.stableAsset?.sliderValue??0)
        }
      }, [QAState?.stableAsset?.sliderValue])
      useEffect(() => {
        //If the selected asset has a different slider value than the inputAmount, set the inputAmount to the slider value
        if (QAState?.levAsset?.sliderValue != inputAmount) {
          setInputAmount(QAState?.levAsset?.sliderValue??0)
        }
      }, [QAState?.levAsset?.sliderValue])
      
  
  if (stable){
    return (
      <Stack py="5" w="full" gap="3" mb={"8"} pb={"5"} >     
        {QAState?.levAsset?.amount as number > 0 ? <><HStack justifyContent="space-between">
          <AssetsWithBalanceMenu 
            value={QAState?.stableAsset} 
            onChange={onMenuChange}
            assets={assets}
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
        <QuickActionAssetWithSlider onChangeExt={onSliderChange} asset={QAState?.stableAsset} label={QAState?.stableAsset?.symbol} />        
        </> : null}  
      </Stack>
    )
  }
      return (
      <Stack py="5" w="full" gap="3" mb={"8"} pb={"5"} >     
        {QAState?.levAsset != undefined ? <><HStack justifyContent="space-between">
          <AssetsWithBalanceMenu 
            value={QAState?.levAsset} 
            onChange={onMenuChange}
            assets={assets}
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
        <QuickActionAssetWithSlider onChangeExt={onSliderChange} asset={QAState?.levAsset} label={QAState?.levAsset?.symbol} />        
        </> : null}  
      </Stack>
    )
  })