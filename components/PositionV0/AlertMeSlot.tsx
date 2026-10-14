// THE SLOT for the "Alert me at …" row. A parallel PR builds that control; until it lands
// this renders nothing. It receives the selected position's view so the control can read
// the line price and distance without another prop path through the page.

import type React from 'react'

import type { PositionView } from './viewModel'

export interface AlertMeSlotProps {
  view: PositionView
}

export const AlertMeSlot: React.FC<AlertMeSlotProps> = () => null
