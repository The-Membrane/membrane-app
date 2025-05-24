import useCloseAndEditBoostsTx from './hooks/useCloseAndEditBoostsTx';

const MarketActionEdit = ({ assetSymbol, position, marketAddress, collateralDenom, maxLTV, debt, collateral, price }: { assetSymbol: string, position: any, marketAddress: string, collateralDenom: string, maxLTV: number, debt: number, collateral: number, price: number }) => {
  // ...
  const { data: msgs = [] } = useCloseAndEditBoostsTx({
    marketContract: marketAddress,
    collateralDenom,
    managedActionState,
    run: true,
  });
  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['closeAndEditBoostsTx', marketAddress, collateralDenom, JSON.stringify(managedActionState)],
    enabled: !!msgs.length,
  });
  // ...
  return (
    // ...
    <ConfirmModal label="Confirm" action={action} isDisabled={false} />
    // ...
  );
}; 