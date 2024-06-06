import { Card, HStack, Stack, Text, Checkbox, CheckboxGroup } from '@chakra-ui/react'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance, { useBalanceByAsset } from '@/hooks/useBalance'
import useQuickActionState from './hooks/useQuickActionState'
import { use, useEffect, useMemo, useState } from 'react'
import { isGreaterThanZero, num, shiftDigits } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'
import { calcSliderValue } from '../Mint/TakeAction'
import { useOraclePrice } from '@/hooks/useOracle'
import { QuickActionLTVWithSlider } from './QuickActionLTVWithSlider'
import useQuickActionVaultSummary from './hooks/useQuickActionVaultSummary'
import useQuickAction from './hooks/useQuickAction'
import { QASummary } from './QASummary'
import useWallet from '@/hooks/useWallet'
import { ConnectButton } from '../WallectConnect'
import { SliderWithInputBox } from './QuickActionSliderInput'
import Divider from '../Divider'
import QASelect from '../QuickActionSelect'
import { SWAP_SLIPPAGE } from '@/config/defaults'
import useNFTState from '../NFT/hooks/useNFTState'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { SliderWithState } from '../Mint/SliderWithState'
import useIBC from '../NFT/hooks/useIBC'
import { TxButton } from '../TxButton'

type QuickActionWidgetProps = {
  actionMenuOptions: any[]
  bridgeCardToggle: boolean
  action?: any
}

const QuickActionWidget = ({ actionMenuOptions, bridgeCardToggle, action }: QuickActionWidgetProps) => {

  const { NFTState, setNFTState } = useNFTState()
  const ibc = useIBC()

  const mbrn = useAssetBySymbol('MBRN')
  const osmosisMBRNBalance = useBalanceByAsset(mbrn)
  const cdt = useAssetBySymbol('CDT')
  const osmosisCDTBalance = useBalanceByAsset(cdt, 'osmosis')

  
  const mbrnSG = useAssetBySymbol('MBRN', 'stargaze')
  const stargazeMBRNBalance = useBalanceByAsset(mbrnSG, 'stargaze')
  const cdtSG = useAssetBySymbol('CDT', 'stargaze')
  const stargazeCDTBalance = useBalanceByAsset(cdtSG, 'stargaze')

  const onCDTChange = (value: number) => {
      setNFTState({ cdtBridgeAmount: value })
  }
  const onMBRNChange = (value: number) => {
      setNFTState({ mbrnBridgeAmount: value })
  }

  const { quickActionState, setQuickActionState } = useQuickActionState()
  if(quickActionState.action.value === "") setQuickActionState({action: actionMenuOptions[0]})
  
  const [chainName, setChainName] = useState("osmosis")
  useEffect(() => {
    if (quickActionState.action.value === "Bridge to Osmosis") setChainName("stargaze")
    if (quickActionState.action.value === "Bridge to Stargaze") setChainName("osmosis")
  }, [quickActionState.action.value])
  const { isWalletConnected, address } = useWallet(chainName)

  const { data: walletBalances } = useBalance(chainName)
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  const { action: quickAction, newPositionLTV, newPositionValue} = useQuickAction()
  const { debtAmount, maxMint } = useQuickActionVaultSummary()
  const sliderValue = calcSliderValue(debtAmount, quickActionState.mint, 0)
  
  const [ inputAmount, setInputAmount ] = useState(0);
  
  ////Get all assets that have a wallet balance///////
  //List of all denoms in the wallet
  const walletDenoms = (walletBalances??[]).map((coin: Coin) => {
    if (num(coin.amount).isGreaterThan(0)) return coin.denom
    else return ""
  }).filter((asset: string) => asset != "");

  //Create an object of assets that only holds assets that have a walletBalance
  useEffect(() => {    
    if (prices && walletBalances && assets){
        const assetsWithBalance = assets?.filter((asset) => {
          if (asset !== undefined) return walletDenoms.includes(asset.base)
          else return false
        }).map((asset) => {
          if (!asset) return
          
          return {
            ...asset,
            value: asset?.symbol,
            label: asset?.symbol,
            sliderValue: 0,
            balance: num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount??0), -(asset?.decimal??6))).toNumber(),
            price: Number(prices?.find((p: any) => p.denom === asset.base)?.price??"0"),
            combinUsdValue: num(num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount??0), -(asset?.decimal??6))).times(num(prices?.find((p: any) => p.denom === asset.base)?.price??"0"))).toNumber()
          }
        }).filter((asset) => {
          if (!asset) return false
           //This helps us decrease the menu size by removing dust
           //Technically we could do anything under $110 as that's the minimum but for new users that adds confusion
          if (asset.combinUsdValue < 5) return false
          else return true
        })

        //Sort assets by USD value
        assetsWithBalance.sort((a, b) => {
          if (a.combinUsdValue < b.combinUsdValue) return 1
          else return -1
        })

        // console.log(chainName, assetsWithBalance)

        setQuickActionState({
          assets: (assetsWithBalance??[])
        })
      }
  }, [assets, walletBalances, prices, address])

  useEffect(() => {
    if (!quickActionState?.selectedAsset && (quickActionState?.assets??[]).length > 0) {
      setQuickActionState({
        selectedAsset:  quickActionState?.assets[0], 
      })
    }
  }, [quickActionState?.assets, walletBalances])
  //
  
  const onAssetMenuChange = (value: string) => {
    setQuickActionState({
      selectedAsset: value
    })
  }

  const onActionMenuChange = (value: string) => {
    if (value.value === "Loop") {
      setQuickActionState({
        action: value,
        swapInsteadof: false,
      })
    } else {
      setQuickActionState({
        action: value,
      })
    }
    if (value.value === "Bridge to Stargaze" || value.value === "Bridge to Osmosis") {
      setQuickActionState({
        swapInsteadof: false,
        addMintSection: false,
      })
      setNFTState({ cdtBridgeAmount: 0, mbrnBridgeAmount: 0 })
    }
  }


  useEffect(() => {

    if (quickActionState?.assets && quickActionState?.selectedAsset?.symbol != undefined) {
      setQuickActionState({
        selectedAsset: quickActionState?.assets.find((asset) => asset.symbol === quickActionState?.selectedAsset?.symbol),
      })
    }
    
  }, [quickActionState?.assets, quickActionState?.selectedAsset?.symbol])

  
  useEffect(() => {
    if (!quickActionState?.swapInsteadof) {
      setQuickActionState({
        mint: 0,
      })
    }
    
  }, [quickActionState?.swapInsteadof])

  ///////////Bridge to Stargaze Card////////
  ////The action for this card will be in useIBC.ts
  if (bridgeCardToggle) {
    console.log((!isGreaterThanZero(NFTState.cdtBridgeAmount) && !isGreaterThanZero(NFTState.mbrnBridgeAmount)), action?.simulate.isError, !action?.simulate.data)
    return (
      <HStack justifyContent="center">
      <Card w="384px" alignItems="center" justifyContent="space-between" p="8" gap="0">
          {quickActionState.assets.length === 0 && quickActionState.action.value === "Bridge to Stargaze" ? 
          <Text variant="body" fontSize="16px" marginTop={6} mb="2%">
              Loading swap or mint options...
          </Text> 
          :
          quickActionState.action.value === "Bridge to Stargaze" ? <>
            <HStack justifyContent="space-between">
              <Text variant="title" fontSize="16px">
                  {quickActionState.swapInsteadof ? "Swap &" : quickActionState.addMintSection ? "Mint &" : null}
              </Text>        
              <QASelect 
                  options={actionMenuOptions}
                  onChange={onActionMenuChange}
                  value={quickActionState?.action} 
              />
            </HStack>

            {/* //Action */}
            {/* Asset Menu + Input Box/Slider*/}        
            <Stack py="5" w="full" gap="2">  
              <HStack justifyContent="space-between">
                <CheckboxGroup>
                  <Checkbox paddingBottom={"4%"} borderColor={"#00A3F9"} onChange={() => setQuickActionState({swapInsteadof: true, addMintSection: false})}> 
                    Swap & Bridge
                  </Checkbox >
                  <Checkbox paddingBottom={"4%"} borderColor={"#00A3F9"} onChange={() => setQuickActionState({addMintSection: true, swapInsteadof: false})}> 
                    Mint & Bridge
                  </Checkbox >
                </CheckboxGroup>
              </HStack>
            {(quickActionState.addMintSection || quickActionState.swapInsteadof) ? <SliderWithInputBox
                max={quickActionState?.selectedAsset?.combinUsdValue??0}
                inputBoxWidth='42%'
                QAState={quickActionState}
                setQAState={setQuickActionState}
                onMenuChange={onAssetMenuChange}
                inputAmount={inputAmount}
                setInputAmount={setInputAmount}
                bridgeCardToggle={bridgeCardToggle}
            /> : null}
    
            {/* Mint Section */}
            {quickActionState.addMintSection ? <><Stack w="full">
                <Text fontSize="14px" fontWeight="700" marginBottom={"1%"}>
                Mint CDT to { quickActionState.action.value }
                </Text> 
                <Divider mx="0" mt="0" mb="4%"/>
                <QuickActionLTVWithSlider label="Your Debt" value={sliderValue}/>
                { maxMint < 100 ? <Text fontSize="sm" color="red.500" mt="2" minH="21px">
                Minimum debt is 100, deposit more to increase your available mint amount: ${(maxMint??0).toFixed(2)}
                </Text>
                : null }
                
            </Stack></> : null}
    
    
            {quickActionState.swapInsteadof ?
            <><Text fontSize="sm" color="white" mb="2" minH="21px">
                max slippage: {SWAP_SLIPPAGE}%
            </Text></> : null }
            </Stack>
            </>
          : null}

          {quickActionState.action.value === "Bridge to Osmosis" ?  
              <QASelect 
                  mb="2%"
                  options={actionMenuOptions}
                  onChange={onActionMenuChange}
                  value={quickActionState?.action} 
              />: null}

          {/* Bridge Sliders */}
          <Stack width={"100%"}>
            <Text fontSize="14px" fontWeight="700">
              {quickActionState.action.value}
            </Text> 
            <Divider mx="0" mt="0" mb="5"/>
            <HStack justifyContent="space-between">
                <Text fontSize="16px" fontWeight="700">
                CDT
                </Text>
                <Text fontSize="16px" fontWeight="700">
                {NFTState.cdtBridgeAmount}
                </Text>
            </HStack>
            <SliderWithState
                value={NFTState.cdtBridgeAmount}
                onChange={onCDTChange}
                min={0}
                max={quickActionState.action.value === "Bridge to Stargaze" ? Number(osmosisCDTBalance) : Number(stargazeCDTBalance)}
            />
            <HStack justifyContent="space-between">
                <Text fontSize="16px" fontWeight="700">
                MBRN
                </Text>
                <Text fontSize="16px" fontWeight="700">
                {NFTState.mbrnBridgeAmount}
                </Text>
            </HStack>
            <SliderWithState
                value={NFTState.mbrnBridgeAmount}
                onChange={onMBRNChange}
                min={0}
                max={quickActionState.action.value === "Bridge to Stargaze" ? Number(osmosisMBRNBalance) : Number(stargazeMBRNBalance)}
            />
          </Stack>
  
          {/* Action Button */}
          <TxButton
              marginTop={"3%"}
              w="100%"
              px="10"
              isDisabled={(!isGreaterThanZero(NFTState.cdtBridgeAmount) && !isGreaterThanZero(NFTState.mbrnBridgeAmount)) || action?.simulate.isError || !action?.simulate.data}
              isLoading={action.simulate.isPending && !action.simulate.isError && action.simulate.data}
              onClick={() => action.tx.mutate()}
              chain_name={chainName}
              >
              {quickActionState.action.value}
          </TxButton>
      </Card>
      </HStack>
    )
  }

  ///////Basic Onboarding Card///////
  return (
    <HStack justifyContent="center">
    <Card w="384px" alignItems="center" justifyContent="space-between" p="8" gap="0">
        <HStack justifyContent="space-between">
        <Text variant="title" fontSize="16px">
            {quickActionState.swapInsteadof ? "Swap" : "Mint"} & 
        </Text>        
        <QASelect 
            options={actionMenuOptions}
            onChange={onActionMenuChange}
            value={quickActionState?.action} 
        />
        </HStack>
        {!isWalletConnected ? 
        <ConnectButton chain_name={chainName} marginTop={6}/>
        : quickActionState.assets.length === 0 ? 
        <Text variant="body" fontSize="16px" marginTop={6}>
            Loading your available collateral assets...
        </Text>
        : 
        <>
        {/* //Action */}
        {/* Asset Menu + Input Box/Slider*/}        
        <Stack py="5" w="full" gap="2">            
        {quickActionState.action.value !== "Loop" ? <Checkbox paddingBottom={"4%"} borderColor={"#00A3F9"} onChange={() => setQuickActionState({swapInsteadof: !quickActionState.swapInsteadof})}> 
            Swap Instead of Mint
        </Checkbox > : null}
        <SliderWithInputBox
            max={quickActionState?.selectedAsset?.combinUsdValue??0}
            inputBoxWidth='42%'
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onAssetMenuChange}
            inputAmount={inputAmount}
            setInputAmount={setInputAmount}
        />                   


        {!quickActionState.swapInsteadof ? <><Stack w="full">
            <Text fontSize="14px" fontWeight="700" marginBottom={"1%"}>
            Mint CDT to  {quickActionState.action.value === "LP" ? <a style={{textDecoration: "underline"}} href="https://app.osmosis.zone/pool/1268">LP</a> : quickActionState.action.value === "Loop" ? "Loop" : "Bid"}
            </Text> 
            <Divider mx="0" mt="0" mb="4%"/>
            <QuickActionLTVWithSlider label="Your Debt" value={sliderValue}/>
            { maxMint < 100 && !quickActionState.swapInsteadof ? <Text fontSize="sm" color="red.500" mt="2" minH="21px">
            Minimum debt is 100, deposit more to increase your available mint amount: ${(maxMint??0).toFixed(2)}
            </Text>
            : null }
            
        </Stack></> : null}


        {quickActionState.action.value === "LP" || quickActionState.action.value === "Loop" ?
        <><Text fontSize="sm" color="white" mt="2" minH="21px">
            max slippage: {SWAP_SLIPPAGE}%
        </Text></> : null }
        </Stack>

        {/* Deposit-Mint-LP Button */}
        <ConfirmModal 
        action={quickAction}
        label={quickActionState.action.value}
        isDisabled={quickAction?.simulate.isError || !quickAction?.simulate.data || !quickActionState?.mint}>
          <QASummary newPositionValue={newPositionValue} newLTV={newPositionLTV}/>
        </ConfirmModal></>}
    </Card>
    </HStack>
  )
}

export default QuickActionWidget
