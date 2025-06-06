import React from 'react';
import { useRouter } from 'next/router';
import ManagedMarketPage from '@/components/ManagedMarkets/ManagedMarketPage';
import ManagePage from '@/components/ManagedMarkets/ManagePage';

const AddressActionPage = () => {
    const router = useRouter();
    const { action, marketAddress } = router.query;
    const actionArr = Array.isArray(action) ? action : action ? [action] : [];

    if (actionArr[0] === 'manage') {
        return <ManagePage marketAddress={marketAddress as string} />;
    }
    return <ManagedMarketPage />;
};

export default AddressActionPage; 

// import React from 'react';
// import { useRouter } from 'next/router';
// import ManagePage from '@/components/ManagedMarkets/ManagePage';

// const ManagedMarketRoute = () => {
//     const router = useRouter();
//     const { marketAddress } = router.query;
//     // You can pass marketAddress as a prop to ManagePage if needed
//     return <ManagePage marketAddress={marketAddress as string} />;
// };

// export default ManagedMarketRoute; 