import React from 'react'
import { FlywheelDiagram } from '@/components/Flywheel'
import ChainLayout from '@/components/ChainLayout'

export default function FlywheelPage() {
    return (
        <ChainLayout>
            <FlywheelDiagram />
        </ChainLayout>
    )
}

