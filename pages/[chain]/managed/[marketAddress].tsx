import React from 'react';
import { useRouter } from 'next/router';
import ManagePage from '@/components/ManagedMarkets/ManagePage';

const ManagedMarketRoute = () => {
    const router = useRouter();
    const { marketAddress } = router.query;
    // You can pass marketAddress as a prop to ManagePage if needed
    return <ManagePage marketAddress={marketAddress as string} />;
};

export default ManagedMarketRoute; 