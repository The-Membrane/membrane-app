import { useRouter } from 'next/router';
import ManagePage from '@/components/ManagedMarkets/ManagePage';

export default function SymbolManagePage() {
  const router = useRouter();
  const { marketAddress } = router.query;

  if (!router.isReady || !marketAddress) return null;

  return <ManagePage marketAddress={marketAddress as string} />;
} 