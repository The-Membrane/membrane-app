import { Card, HStack, Stack, Text, Checkbox, CheckboxGroup } from '@chakra-ui/react'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance, { useBalanceByAsset } from '@/hooks/useBalance'
import { useEffect, useMemo, useState } from 'react'
import { isGreaterThanZero, num, shiftDigits } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'
import { useOraclePrice } from '@/hooks/useOracle'
import useWallet from '@/hooks/useWallet'
import Divider from '../Divider'
import QASelect from '../QuickActionSelect'
import { SWAP_SLIPPAGE } from '@/config/defaults'
import useNFTState from '../NFT/hooks/useNFTState'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { SliderWithState } from '../Mint/SliderWithState'
import useIBC from '../NFT/hooks/useIBC'
import { TxButton } from '../TxButton'
import { SliderWithInputBox } from '../Home/QuickActionSliderInput'

const BridgeTo = () => {
    const { NFTState, setNFTState } = useNFTState()
    const ibc = useIBC()
    const [swapAmount, setswapAmount] = useState(0)
    useMemo(() => {
      if (ibc.swapMinAmount && ibc.swapMinAmount != swapAmount && NFTState.swapInsteadof) setswapAmount(ibc.swapMinAmount)
        else if (!NFTState.swapInsteadof) setswapAmount(0)
    }, [ibc.swapMinAmount, NFTState.swapInsteadof])
  
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
    
    
    const [chainName, setChainName] = useState("osmosis")
    useEffect(() => {
      if (NFTState.action.value === "Bridge to Osmosis") setChainName("stargaze")
      if (NFTState.action.value === "Bridge to Stargaze") setChainName("osmosis")
    }, [NFTState.action.value])
    const { address } = useWallet(chainName)
  
    const { data: walletBalances } = useBalance(chainName)
    const assets = useCollateralAssets()
    const { data: prices } = useOraclePrice()
    
    const [ inputAmount, setInputAmount ] = useState(0);
    
    ////Get all assets that have a wallet balance///////
    //List of all denoms in the wallet
    const walletDenoms = (walletBalances??[]).map((coin: Coin) => {
      if (num(coin.amount).isGreaterThan(0)) return coin.denom
      else return ""
    }).filter((asset: string) => asset != "");
  
    //Create an object of assets that only holds assets that have a walletBalance
    useMemo(() => {    
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
  
  
          setNFTState({
            assets: (assetsWithBalance??[])
          })
        }
    }, [assets, walletBalances, prices, address])
  
    useEffect(() => {
      if (!NFTState?.selectedAsset && (NFTState?.assets??[]).length > 0) {
        setNFTState({
          selectedAsset:  NFTState?.assets[0], 
        })
      }
    }, [NFTState?.assets, walletBalances])
    //
    
    const onAssetMenuChange = (value: string) => {
      setNFTState({
        selectedAsset: value
      })
    }
  
    const onActionMenuChange = (value: string) => {
        setNFTState({
            action: value,
            swapInsteadof: false,
            cdtBridgeAmount: 0, mbrnBridgeAmount: 0
        })
    }
  
  
    useEffect(() => {
  
      if (NFTState?.assets && NFTState?.selectedAsset?.symbol != undefined) {
        setNFTState({
          selectedAsset: NFTState?.assets.find((asset) => asset.symbol === NFTState?.selectedAsset?.symbol),
        })
      }
      
    }, [NFTState?.assets, NFTState?.selectedAsset?.symbol])
  
    return (
        <Stack w="full" gap="5">
            <Text variant="title">Bridge</Text>
            
            <HStack justifyContent="center">
            <Card w="384px" alignItems="center" justifyContent="space-between" p="8" gap="0">
                {NFTState.assets.length === 0 && NFTState.action.value === "Bridge to Stargaze" ? 
                <Text variant="body" fontSize="16px" marginTop={4} mb={4}>
                    Loading options to swap...
                </Text> 
                :
                NFTState.action.value === "Bridge to Stargaze" ? <>
                    <HStack justifyContent="space-between">
                    <Text variant="title" fontSize="16px">
                        {NFTState.swapInsteadof ? "Swap &" : null}
                    </Text>        
                    <QASelect 
                        options={[{ value: "Bridge to Stargaze", label: "Bridge to Stargaze" }, { value: "Bridge to Osmosis", label: "Bridge to Osmosis"}]}
                        onChange={onActionMenuChange}
                        value={NFTState?.action} 
                    />
                    </HStack>

                    {/* //Action */}
                    {/* Asset Menu + Input Box/Slider*/}        
                    <Stack py="5" w="full" gap="2">  
                    <HStack justifyContent="space-between">
                        <Checkbox isChecked={NFTState.swapInsteadof} paddingBottom={"4%"} borderColor={"#00A3F9"} onChange={() => {setNFTState({swapInsteadof: !NFTState.swapInsteadof}); setNFTState({ cdtBridgeAmount: 0 });}}> 
                            Swap & Bridge
                        </Checkbox >
                    </HStack>
                    {NFTState.swapInsteadof ? <SliderWithInputBox
                        max={NFTState?.selectedAsset?.combinUsdValue??0}
                        inputBoxWidth='42%'
                        QAState={NFTState}
                        setQAState={setNFTState}
                        onMenuChange={onAssetMenuChange}
                        inputAmount={inputAmount}
                        setInputAmount={setInputAmount}
                        bridgeCardToggle={true}
                    /> : null}
                
                    {NFTState.swapInsteadof ?
                    <><Text fontSize="sm" color="white" mb="2" minH="21px">
                        max slippage: {SWAP_SLIPPAGE}%
                    </Text></> : null }
                    </Stack>
                    </>
                : null}

                {NFTState.action.value === "Bridge to Osmosis" ?  
                    <QASelect 
                        mb="2%"
                        options={[{ value: "Bridge to Stargaze", label: "Bridge to Stargaze" }, { value: "Bridge to Osmosis", label: "Bridge to Osmosis"}]}
                        onChange={onActionMenuChange}
                        value={NFTState?.action} 
                    />: null}

                {/* Bridge Sliders */}
                <Stack width={"100%"}>
                    <Text fontSize="14px" fontWeight="700">
                    {NFTState.action.value}
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
                        max={NFTState.action.value === "Bridge to Stargaze" ? Number(osmosisCDTBalance) + swapAmount : Number(stargazeCDTBalance)}
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
                        max={NFTState.action.value === "Bridge to Stargaze" ? Number(osmosisMBRNBalance) : Number(stargazeMBRNBalance)}
                    />
                </Stack>
        
                {/* Action Button */}
                <TxButton
                    marginTop={"3%"}
                    w="100%"
                    px="10"
                    isDisabled={(!isGreaterThanZero(NFTState.cdtBridgeAmount) && !isGreaterThanZero(NFTState.mbrnBridgeAmount)) || ibc.action?.simulate.isError || !ibc.action?.simulate.data}
                    isLoading={ibc.action.simulate.isPending && !ibc.action.simulate.isError && ibc.action.simulate.data}
                    onClick={() => ibc.action.tx.mutate()}
                    chain_name={chainName}
                    >
                    {NFTState.action.value}
                </TxButton>
            </Card>
            </HStack>
        </Stack>
    )
}

export default BridgeTo