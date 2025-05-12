import { useRouter } from 'next/router';
import ManagedMarketAction from '@/components/ManagedMarkets/ManagedMarketAction';

const AddressActionPage = () => {
    const router = useRouter();
    const { address, action } = router.query;
    const actionType = Array.isArray(action) && action.length > 0 ? action[0] : 'multiply';

    // Placeholder asset, manager, and market
    const asset = { symbol: 'OSMO', base: 'uosmo', logo: '/osmo-logo.png' };
    const manager = 'osmo1manageraddress';
    const market = { params: { collateral_params: { max_borrow_LTV: '0.67' } } };

    return (
        <ManagedMarketAction
            action={actionType.charAt(0).toUpperCase() + actionType.slice(1)}
            asset={asset}
            manager={manager}
            market={market}
        />
    );
};

export default AddressActionPage; 