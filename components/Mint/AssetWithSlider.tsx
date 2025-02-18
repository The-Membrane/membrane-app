import { HStack, useDisclosure, Text, Stack, Button, ModalOverlay, Modal, ModalContent, ModalFooter, ModalHeader, ModalCloseButton, ModalBody, Input } from "@chakra-ui/react";
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

    // <Stack gap="0">
    //   <HStack justifyContent="space-between">
    //     <HStack>
    //       <Text >${(asset?.sliderValue ?? 0).toFixed(2)}</Text>
    //       <Text >{label}</Text>
    //       <Text paddingLeft="5%" color={num(changeValue).isGreaterThan(0) ? "green.200" : "red.200"}>{changeValue != 0 ? changeValue > 0 ? `+$${changeValue.toFixed(2)}` : `-$${Math.abs(changeValue).toFixed(2)}` : ""}</Text>
    //     </HStack>
    //     <HStack width={"66%"}>
    //       <Input
    //         type="number"
    //         placeholder="Enter amount"
    //         min={0}
    //         step="0.01"
    //         value={transactionValue}
    //         onChange={(e) => { e.preventDefault(); setTransactionValue(e.target.value) }}
    //       />
    //       <HStack width={"33%"}>
    //         <Stack gap="0">
    //           <Button isDisabled={isAdditionDisabled} alignSelf={"center"} variant={"ghost"} width={"50%"} size="md" onClick={() => { handleTransaction('deposit'); }}>
    //             +
    //           </Button>
    //           <Text alignSelf="center" fontSize="8px" cursor="pointer" onClick={() => setTransactionValue(asset.walletsdValue.toString())}>max</Text>
    //         </Stack>
    //         <Stack gap="0">
    //           <Button isDisabled={isSubtractionDisabled} alignSelf={"center"} variant={"ghost"} width={"50%"} size="md" onClick={() => { handleTransaction('withdraw'); }}>
    //             -
    //           </Button>
    //           <Text alignSelf="center" fontSize="8px" height="1.5vh">{ }</Text>
    //         </Stack>
    //       </HStack>
    //     </HStack>

    //   </HStack>
    // </Stack>
  );
};
