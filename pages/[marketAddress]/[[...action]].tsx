import { useRouter } from 'next/router';
import ManagedMarketAction from '@/components/ManagedMarkets/ManagedMarketAction';

const AddressActionPage = () => {
    const router = useRouter();
    const { marketAddress, action } = router.query;
    const collateralSymbol = Array.isArray(action) && action.length > 0 ? action[0] : 'multiply';
    const actionType = Array.isArray(action) && action.length > 1 ? action[1] : 'multiply';

    // Placeholder asset, manager, and market
    const manager = 'osmo1manageraddress';

    return (
        <ManagedMarketAction
            action={actionType.charAt(0).toUpperCase() + actionType.slice(1)}
            marketAddress={marketAddress as string}
            collateralSymbol={collateralSymbol}
        />
    );
};

export default AddressActionPage; 