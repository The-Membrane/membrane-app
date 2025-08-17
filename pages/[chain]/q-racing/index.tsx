import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import QRacer from '@/components/Racing/QRacer';

const queryClient = new QueryClient();

const QRacingPage: React.FC = () => (
    <QueryClientProvider client={queryClient}>
        <QRacer />
    </QueryClientProvider>
);

export default QRacingPage; 