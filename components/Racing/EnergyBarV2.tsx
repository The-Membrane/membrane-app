import React from 'react'
import useEnergyBarV2 from './hooks/useEnergyBarV2'
import EnergyBarDesktop from './EnergyBarDesktop'
import EnergyBarMobile from './EnergyBarMobile'

export type EnergyBarV2Props = {
    tokenId?: string
    inline?: boolean
}

const EnergyBarV2: React.FC<EnergyBarV2Props> = ({ tokenId, inline }) => {
    const view = useEnergyBarV2(tokenId)

    // Desktop single button with dropdown
    if (!view.isMobile) {
        return <EnergyBarDesktop {...view} inline={inline} />
    }

    // Mobile single button with long press
    return <EnergyBarMobile {...view} inline={inline} />
}

export default EnergyBarV2
