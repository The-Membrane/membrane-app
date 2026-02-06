import React from 'react'
import ChainLayout from '@/components/ChainLayout'
import { TransmuterLockdropVisualizer } from '@/components/trans-lockdrop/TransmuterLockdropVisualizer'

export default function TransmutationPage() {
    return (
        <ChainLayout>
            <TransmuterLockdropVisualizer />
        </ChainLayout>
    )
}

