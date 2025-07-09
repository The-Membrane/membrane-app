import React, { useState, useMemo, useEffect } from 'react';
import { Box, Flex, Text, Image, Button, VStack, HStack, Input, Tooltip, Radio, RadioGroup } from '@chakra-ui/react';
import { InfoOutlineIcon } from '@chakra-ui/icons';

// @ts-ignore
import tinycolor from 'tinycolor2';
import { Formatter } from '@/helpers/formatter';
import ConfirmModal from '../ConfirmModal';
import useManagedAction from './hooks/useManagedMarketState';
import useTransformExposure from './hooks/useIncreasedExposureCard';
import { Asset } from '@/helpers/chain';
import TransformExposureSummary from './TransformExposureSummary';

interface AssetProps {
  logo: string;
  symbol: string;
  large?: boolean;
  glowColor?: string;
  balance?: string;
  price?: string;
  maxBorrowLTV?: number;
  maxLTV?: string;
  marketContract: string;
  asset: Asset;
}

const IncreaseExposureCards: React.FC<AssetProps> = ({ logo, symbol, large, glowColor, balance, price, maxBorrowLTV, maxLTV, marketContract, asset }) => {
  const [mode, setMode] = useState<'multiply' | 'de-risk'>('multiply');
  const [amount, setAmount] = useState('');
  const [selectedMultiplier, setSelectedMultiplier] = useState('conservative');
  
  const { managedActionState, setManagedActionState } = useManagedAction();
  console.log('maxBorrowLTV', maxBorrowLTV);
  const maxMultiplier = 1 / (1 - (Number(maxBorrowLTV) ?? 1));
  
  // Calculate conservative and moderate multipliers as percentages of max
  const conservativeMultiplier = 1 / (1 - ((Number(maxBorrowLTV) ?? 1) * 0.4));
  const moderateMultiplier = 1 / (1 - ((Number(maxBorrowLTV) ?? 1) * 0.7));
  
  // Update managed market state when amount or mode changes
  useEffect(() => {
    let multiplierValue;
    if (selectedMultiplier === 'max') {
      multiplierValue = maxMultiplier;
    } else if (selectedMultiplier === 'conservative') {
      multiplierValue = conservativeMultiplier;
    } else if (selectedMultiplier === 'moderate') {
      multiplierValue = moderateMultiplier;
    } else {
      multiplierValue = parseFloat(selectedMultiplier);
    }
    
    if (mode === 'multiply') {
      setManagedActionState({
        collateralAmount: amount,
        multiplier: multiplierValue,
      });
    } else {
      // For de-risk mode, no multiplier
      setManagedActionState({
        collateralAmount: amount,
        multiplier: undefined, // No multiplier for de-risk
      });
    }
  }, [amount, mode, selectedMultiplier, setManagedActionState, maxMultiplier, conservativeMultiplier, moderateMultiplier]);
  const liqPrice = useMemo(() => {
    if (!maxLTV || maxLTV === '—' || !price || price === '0') return '';
    
    // Calculate liquidation price with 10% LTV buffer
    const maxLTVNum = parseFloat(maxLTV);
    const currentPrice = parseFloat(price);

    var loopLTV = 1 - 1 / managedActionState.multiplier;
    if (maxBorrowLTV && loopLTV > maxBorrowLTV) {
      loopLTV = maxBorrowLTV;
    }
    console.log('loopLTV', loopLTV, maxBorrowLTV, managedActionState.multiplier);
    const bufferLTV = maxLTVNum / (mode === 'de-risk' ? 0.1 : loopLTV);
    
    // Liquidation price 
    const liquidationPrice = currentPrice / bufferLTV;
    
    return liquidationPrice.toFixed(4);
  }, [maxLTV, price, maxBorrowLTV, managedActionState.multiplier]);
  const buttonColor = glowColor ? tinycolor(glowColor).toHexString() : '#63b3ed';
  const displayBalance = balance !== undefined ? balance : '1000';
  const displayPrice = price !== undefined ? price : '0.00';
  const value = amount && price ? (parseFloat(amount) * parseFloat(displayPrice)).toFixed(2) : '0.00';
  const collateralValue = Number(value);
  const borrowAmount = (Number(value) / 10).toString();
  const { action: transformExposure } = useTransformExposure({
    marketContract: marketContract,
    asset: asset,
    managedActionState: managedActionState,
    maxBorrowLTV: maxBorrowLTV ?? 0,
    collateralValue: collateralValue,
    borrowAmount: borrowAmount,
    mode: mode,
    run: true,
  });


  return (
    <VStack align="center" spacing={large ? 10 : 6} w="100%">
      <VStack>
        <HStack align="center" spacing={large ? 5 : 3} mb={large ? 0 : 0} w="auto" minW="fit-content">
            {logo && <Image src={logo} alt={symbol} boxSize={large ? "48px" : "32px"} flexShrink={0} />}
            <Text fontWeight="bold" fontSize={large ? "4xl" : "2xl"} color="white" whiteSpace="nowrap">Transform Exposure to {symbol}</Text>
        </HStack>
        {/* Helper text under mode selection */}
        <Text color="whiteAlpha.700" fontSize="sm" mt={1} mb={-2}>
            Select whether to <b><i>multiply</i></b> your exposure or <b><i>de-risk</i></b> by taking capital out of {symbol}.
        </Text>
      </VStack>
      {/* Mode selection */}
      <RadioGroup value={mode} onChange={v => setMode(v as 'multiply' | 'de-risk')}>
        <HStack spacing={8} justify="start">
          <HStack>
            <Radio value="multiply" colorScheme="blue"><Text as="span" fontSize={large ? '2xl' : 'xl'} py={2}>Multiply</Text></Radio>
            <Tooltip label={`Multiply exposure to ${symbol} now at current market prices`} hasArrow>
              <span><InfoOutlineIcon color="whiteAlpha.600" boxSize={5} style={{ marginLeft: 8, cursor: 'pointer' }} /></span>
            </Tooltip>
          </HStack>
          <HStack>
            <Radio value="de-risk" colorScheme="blue"><Text as="span" fontSize={large ? '2xl' : 'xl'} py={2}>De-risk</Text></Radio>
            <Tooltip label={`Reduce exposure to ${symbol} by taking capital out`} hasArrow>
              <span><InfoOutlineIcon color="whiteAlpha.600" boxSize={5} style={{ marginLeft: 8, cursor: 'pointer' }} /></span>
            </Tooltip>
          </HStack>
        </HStack>
      </RadioGroup>
      {/* Amount input */}
      <Box w={large ? '420px' : '320px'}>
        <HStack justify="space-between" align="flex-start" w="100%">
          <VStack align="flex-start" spacing={1} flex={1}>
            <Input
              variant="unstyled"
              fontSize={large ? "3xl" : "2xl"}
              fontWeight="bold"
              color="white"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              type="number"
              min={0}
              placeholder="0"
              w="100%"
              _placeholder={{ color: 'whiteAlpha.400' }}
              paddingInlineEnd={"3"}
            />
            <Text color="whiteAlpha.600" fontSize="md">~ ${value}</Text>
          </VStack>
          <VStack align="flex-end" spacing={2}>
            <HStack bg="#1a2330" borderRadius="full" px={3} py={1} spacing={2}>
              {logo && <Image src={logo} alt={symbol} boxSize="24px" />}
              <Text color="white" fontWeight="bold">{symbol || 'SYM'}</Text>
            </HStack>
            <HStack 
              cursor="pointer"
              onClick={() => setAmount(displayBalance.toString())}
              sx={{
                '&:hover > .wallet-hover-text': {
                  textDecoration: 'underline',
                  color: 'blue.300',
                },
              }}
            >
              <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                Wallet
              </Text>
              <Text className="wallet-hover-text" color="whiteAlpha.700" fontSize="md">
                {Formatter.toNearestNonZero(displayBalance)}
              </Text>
            </HStack>
          </VStack>
        </HStack>
      </Box>
      {/* Multiplier selection */}
      <HStack
        gap={4}
        align="center"
        spacing={2}
        w={large ? '420px' : '320px'}
        borderRadius="md"
        
        cursor={mode === 'de-risk' ? 'not-allowed' : 'default'}
        transition="all 0.2s"
      >
        <Text opacity={mode === 'de-risk' ? 0.3 : 1} fontWeight="bold" fontSize={large ? "2xl" : "lg"} color="white" mb={1}>Multiplier:</Text>
        <HStack spacing={6} justify="center">
          <HStack as="label" spacing={2}>
            <input type="radio" checked={selectedMultiplier === 'conservative'} onChange={() => mode === 'multiply' && setSelectedMultiplier('conservative')} disabled={mode === 'de-risk'} style={{ cursor: mode === 'de-risk' ? 'not-allowed' : 'pointer', opacity: mode === 'de-risk' ? 0.3 : 1 }} />
            <Text opacity={mode === 'de-risk' ? 0.3 : 1} color="white" fontSize={large ? "lg" : "md"}>{conservativeMultiplier.toFixed(1)}x</Text>
          </HStack>
          {moderateMultiplier.toFixed(2) !== conservativeMultiplier.toFixed(2) && <HStack as="label" spacing={2}>
            <input type="radio" checked={selectedMultiplier === 'moderate'} onChange={() => mode === 'multiply' && setSelectedMultiplier('moderate')} disabled={mode === 'de-risk'} style={{ cursor: mode === 'de-risk' ? 'not-allowed' : 'pointer', opacity: mode === 'de-risk' ? 0.3 : 1 }} />
            <Text opacity={mode === 'de-risk' ? 0.3 : 1} color="white" fontSize={large ? "lg" : "md"}>{moderateMultiplier.toFixed(1) === conservativeMultiplier.toFixed(1) ? moderateMultiplier.toFixed(2) : moderateMultiplier.toFixed(1)}x</Text>
          </HStack>}
          <HStack as="label" spacing={2}>
            <input type="radio" checked={selectedMultiplier === 'max'} onChange={() => mode === 'multiply' && setSelectedMultiplier('max')} disabled={mode === 'de-risk'} style={{ cursor: mode === 'de-risk' ? 'not-allowed' : 'pointer', opacity: mode === 'de-risk' ? 0.3 : 1 }} />
            <Text opacity={mode === 'de-risk' ? 0.3 : 1} color="white" fontSize={large ? "lg" : "md"}>Max ({maxMultiplier.toFixed(1)}x)</Text>
          </HStack>
        </HStack>
      </HStack>
      {/* Exposure summary */}
      <Text color="white" fontSize={large ? "lg" : "md"} fontWeight="normal" w={large ? '420px' : '320px'} textAlign="center">
        {mode === 'multiply' ? (
          <>
            Using <b>{amount || '0'} {symbol}</b> to get <b>{amount && !isNaN(Number(amount)) ? (() => {
              let multiplierValue;
              if (selectedMultiplier === 'max') {
                multiplierValue = maxMultiplier;
              } else if (selectedMultiplier === 'conservative') {
                multiplierValue = conservativeMultiplier;
              } else if (selectedMultiplier === 'moderate') {
                multiplierValue = moderateMultiplier;
              } else {
                multiplierValue = parseFloat(selectedMultiplier);
              }
              return (parseFloat(amount) * multiplierValue).toFixed(2);
            })() : '0.00'} {symbol}</b> exposure
          </>
        ) : (
          <>
            Reducing exposure to <b>{amount || '0'} {symbol} by taking out ${Number(value) / 10} CDT </b>
          </>
        )}
      </Text>
      {/* Send It button */}
      <Box w={large ? '420px' : '320px'}>
        <ConfirmModal
          buttonProps={{ bg: buttonColor, _hover: { bg: glowColor }, w: '100%', textShadow: '0 0 20px rgba(0, 0, 0, 1)' }}
          label={mode === 'multiply' ? "Send It" : "Take Capital Out"}
          isDisabled={amount === '0' || Number(managedActionState.collateralAmount) <= 0 }
          action={transformExposure}
        >
             <TransformExposureSummary
                    mode={mode}
                    asset={asset}
                    collateralAmount={managedActionState.collateralAmount}
                    multiplier={managedActionState.multiplier}
                    borrowAmount={borrowAmount}
                    collateralValue={collateralValue}
                    maxBorrowLTV={maxBorrowLTV ?? 0}
                />
        </ConfirmModal>
        <Text color="gray.400" fontSize="xs" mt={2} alignSelf="flex-end">(liq price ${liqPrice})</Text>
      </Box>
    </VStack>
  );
};

export default IncreaseExposureCards; 