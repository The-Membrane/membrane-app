import React from 'react';
import dynamic from 'next/dynamic';

// Client-only: the racing game touches window during render, which breaks prerender.
const QRacer = dynamic(() => import('@/components/Racing/QRacer'), { ssr: false });

const QRacingPage: React.FC = () => (
    <QRacer />
);

export default QRacingPage;
