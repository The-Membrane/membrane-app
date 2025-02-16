import { HStack, useDisclosure, Text, Stack, Button, ModalOverlay, Modal, ModalContent, ModalFooter, ModalHeader, ModalCloseButton, ModalBody, Input } from "@chakra-ui/react";
import { AssetWithBalance } from "./hooks/useCombinBalance";
import useMintState from "./hooks/useMintState";
import { useState } from "react";
import { num } from "@/helpers/num";


export type AssetWithInputProps = {
  label: string;
  asset: AssetWithBalance;
};

export const AssetWithInput = ({ asset, label }: AssetWithInputProps) => {
  const { mintState, setMintState } = useMintState();
  const { isOpen: isDepositOpen, onOpen: onDepositOpen, onClose: onDepositClose } = useDisclosure();
  const { isOpen: isWithdrawOpen, onOpen: onWithdrawOpen, onClose: onWithdrawClose } = useDisclosure();
  const [transactionValue, setTransactionValue] = useState('');
  const [transactionType, setTransactionType] = useState<string | null>(null);

  const handleTransaction = () => {
    if (!transactionType || parseFloat(transactionValue) <= 0) return;

    let updatedAssets = mintState.assets.map((a) => {
      if (a.symbol !== label) return a;

      const amountValue = transactionType === 'deposit' ? parseFloat(transactionValue) : -parseFloat(transactionValue);
      const amount = num(amountValue).dividedBy(a.price).dp(a.decimal ?? 6).toNumber();
      const sliderValue = num(a.sliderValue || 0).plus(amountValue).toNumber();

      return {
        ...a,
        amount,
        amountValue,
        sliderValue,
      };
    });

    const { summary, totalUsdValue } = getSummary(updatedAssets);
    setMintState({ assets: updatedAssets, summary, totalUsdValue });

    setTransactionValue('');
    transactionType === 'deposit' ? onDepositClose() : onWithdrawClose();
  };

  return (
    <Stack gap="0">
      <HStack justifyContent="space-between">
        <Text >{label}</Text>
        <Text >${(asset?.sliderValue ?? 0).toFixed(2)}</Text>
        <Button size="sm" onClick={() => { setTransactionType('deposit'); onDepositOpen(); }}>
          Deposit
        </Button>
        <Button size="sm" onClick={() => { setTransactionType('withdraw'); onWithdrawOpen(); }}>
          Withdraw
        </Button>
      </HStack>

      {/* Modal */}
      <Modal isOpen={isDepositOpen || isWithdrawOpen} onClose={transactionType === 'deposit' ? onDepositClose : onWithdrawClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{transactionType === 'deposit' ? 'Deposit' : 'Withdraw'} {label}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Input
              type="number"
              placeholder="Enter amount"
              min={0}
              step="0.01"
              value={transactionValue}
              onChange={(e) => { e.preventDefault(); setTransactionValue(e.target.value) }}
            />
          </ModalBody>
          <ModalFooter>
            <Button colorScheme="blue" mr={3} onClick={handleTransaction}>Confirm</Button>
            <Button variant="ghost" onClick={transactionType === 'deposit' ? onDepositClose : onWithdrawClose}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Stack>
  );
};
