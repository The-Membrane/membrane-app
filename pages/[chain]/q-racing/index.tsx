import React from 'react';
import RaceViewer from '../../../components/Racing/RaceViewer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

const QRacingPage: React.FC = () => (
    <QueryClientProvider client={queryClient}>
        <RaceViewer />
    </QueryClientProvider>
);

export default QRacingPage; 