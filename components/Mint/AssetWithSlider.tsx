import { HStack, useDisclosure, Text, Stack, Button, ModalOverlay, Modal, ModalContent, ModalFooter, ModalHeader, ModalCloseButton, ModalBody, Input, Flex } from "@chakra-ui/react";
import { AssetWithBalance } from "./hooks/useCombinBalance";
import useMintState from "./hooks/useMintState";
import { useEffect, useState } from "react";
import { num } from "@/helpers/num";
import { getSummary } from "@/helpers/mint";
import { colors } from "@/config/defaults";


export type AssetWithInputProps = {
  label: string;
  asset: AssetWithBalance;
};

export const AssetWithInput = ({ asset, label }: AssetWithInputProps) => {
  const { mintState, setMintState } = useMintState();
  // const { isOpen: isDepositOpen, onOpen: onDepositOpen, onClose: onDepositClose } = useDisclosure();
  // const { isOpen: isWithdrawOpen, onOpen: onWithdrawOpen, onClose: onWithdrawClose } = useDisclosure();
  const [transactionValue, setTransactionValue] = useState('');
  // const [transactionType, setTransactionType] = useState<string | null>(null);

  const [changeValue, setChangeValue] = useState(0);

  const handleTransaction = (transactionType: string) => {
    if (!transactionType || parseFloat(transactionValue) <= 0) return;

    let updatedAssets = mintState.assets.map((a) => {
      if (a.symbol !== label) return a;

      const sliderValue = transactionType === "deposit" ? Number(transactionValue) : -Number(transactionValue);

      const diffInUsd = num(asset.depositUsdValue).minus(sliderValue).toNumber()
      const newDeposit = num(asset.depositUsdValue).minus(diffInUsd).toNumber()
      const amountValue = num(diffInUsd).isGreaterThan(asset.depositUsdValue)
        ? newDeposit
        : -diffInUsd
      const amount = num(amountValue).dividedBy(asset.price).dp(asset.decimal ?? 6).toNumber()
      //
      setChangeValue(amountValue);
      //
      return {
        ...asset,
        amount,
        amountValue,
        sliderValue,
      }
    });

    const { summary, totalUsdValue } = getSummary(updatedAssets);
    setMintState({ assets: updatedAssets, summary, totalUsdValue });

    setTransactionValue('');
  };

  const isAdditionDisabled = asset.walletsdValue === 0 || transactionValue === '';
  const isSubtractionDisabled = asset.depositUsdValue === 0 || transactionValue === '';
  // console.log("asset", asset);

  return (
    <Stack gap="0">
      <Flex justifyContent="space-between" alignItems="center">
        <HStack>
          <Text>${(asset?.sliderValue ?? 0).toFixed(2)}</Text>
          <Text>{label}</Text>
          <Text paddingLeft="5%" color={num(changeValue).isGreaterThan(0) ? "green.200" : "red.200"}>
            {changeValue !== 0 ? (changeValue > 0 ? `+$${changeValue.toFixed(2)}` : `-$${Math.abs(changeValue).toFixed(2)}`) : ""}
          </Text>
        </HStack>

        {/* This ensures perfect alignment */}
        <Flex width="66%" alignItems="center" gap="8px">
          <Input
            type="number"
            placeholder="Enter amount"
            min={0}
            step="0.01"
            value={transactionValue}
            onChange={(e) => { e.preventDefault(); setTransactionValue(e.target.value); }}
            height="40px"
            borderRadius="8px"
            textAlign="center"
          />

          {/* Wraps + button & "max" text in a strict height container */}
          <Flex flexDirection="column" alignItems="center" justifyContent="center" height="40px">
            <Button
              isDisabled={isAdditionDisabled}
              variant={isAdditionDisabled ? "ghost" : "solid"}
              width="40px"
              height="40px"
              borderRadius="8px"
              onClick={() => { handleTransaction('deposit'); }}
            >
              +
            </Button>
            <Text
              fontSize="10px"
              cursor="pointer"
              mt="2px"
              lineHeight="1"
              onClick={() => setTransactionValue(asset.walletsdValue.toString())}
            >
              max
            </Text>
          </Flex>

          <Button
            isDisabled={isSubtractionDisabled}
            variant={isSubtractionDisabled ? "ghost" : "solid"}
            width="40px"
            height="40px"
            borderRadius="8px"
            onClick={() => { handleTransaction('withdraw'); }}
          >
            -
          </Button>
        </Flex>
      </Flex>


    </Stack>
  );
};
