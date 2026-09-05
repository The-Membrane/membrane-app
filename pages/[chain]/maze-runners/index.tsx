import React from 'react';
import dynamic from 'next/dynamic';
import PageSeo from '@/components/PageSeo';

// Client-only: the racing game touches window during render, which breaks prerender.
const QRacer = dynamic(() => import('@/components/Racing/QRacer'), { ssr: false });

const QRacingPage: React.FC = () => (
    <>
        {/* Rule 0 (docs/SEO_RULESET.md): internal — Q-Racing game sim page */}
        <PageSeo
            seoClass="internal"
            title="Membrane — Maze Runners"
            description="Client-only Q-Racing game page: mint and manage racing pets, create tracks, run onchain and offchain races, and view the tournament bracket and leaderboard."
        />
        <QRacer />
    </>
);

export default QRacingPage;
