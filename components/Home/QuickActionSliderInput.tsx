import { HStack, Input, Stack, Text} from "@chakra-ui/react"
import { QuickActionAssetWithSlider } from "./QuickActionAssetSlider"
import { ChangeEvent, useEffect } from "react"
import { num } from "@/helpers/num"
import { delayTime } from "@/config/defaults"
import { QuickActionState } from "./hooks/useQuickActionState"
import QASelect from "../QuickActionSelect"
import { AssetWithBalance } from "../Mint/hooks/useCombinBalance"
import { useUserPositions } from "@/hooks/useCDP"
import Divider from "../Divider"

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
    QAState: QuickActionState
    setQAState: (partialState: Partial<QuickActionState>) => void
    onMenuChange: (value: string) => void
    inputAmount: number
    setInputAmount: (value: number) => void
    bridgeCardToggle?: boolean
  }
  
  export const SliderWithInputBox = ({ max, inputBoxWidth = "38%", QAState, setQAState, onMenuChange, inputAmount, setInputAmount, bridgeCardToggle = false }: SliderWithInputProps) => {
      
      const { data: basketPositions } = useUserPositions()

      const onSliderChange = (value: number) => {      
        if (inputAmount != value) setInputAmount(value)
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
      <Stack py="5" w="full" gap="3" mb="8">     
        <Text fontSize="14px" fontWeight="700">
          {QAState.swapInsteadof || bridgeCardToggle ? "Choose Asset" : basketPositions ? "Add collateral to your existing vault (optional)" : "Choose Collateral"}
        </Text> 
        <Divider mx="0" mt="0" mb="5"/>
        {QAState?.selectedAsset != undefined ? <><HStack justifyContent="space-between">
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
        <QuickActionAssetWithSlider onChangeExt={onSliderChange} key={QAState?.selectedAsset?.base} asset={QAState?.selectedAsset} label={QAState?.selectedAsset?.symbol} />
        </> : null}
  
    </Stack>)
  }