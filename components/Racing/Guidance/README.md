# Racing App Guidance System

This guidance system provides a comprehensive onboarding experience for new users of the Racing app, including pre-mint guidance, interactive tutorials, and contextual tooltips.

## Components

### PreMintGuidance
- **Purpose**: Shows information about the Racing app before users mint their first car
- **Trigger**: Automatically shows for first-time users who haven't seen it
- **State**: Controlled by `hasSeenPreMintGuidance` in app state

### TutorialOverlay
- **Purpose**: Interactive click-through tutorial that appears after first car mint
- **Features**: 
  - Progress indicator (1/5, 2/5, etc.)
  - Forward/back navigation
  - Skip functionality
  - Positioned near components (left/right/top/bottom)
  - Backdrop overlay for focus

### TutorialButton
- **Purpose**: Button in footer to restart tutorial
- **Location**: Bottom right of page footer
- **Visibility**: Always visible after first car mint

### Tooltip
- **Purpose**: Contextual help for specific UI elements
- **Features**:
  - Standardized styling matching app aesthetic
  - Multiple positions (top/bottom/left/right)
  - Responsive design

## Hooks

### useTutorial
Manages tutorial state and provides actions:
```typescript
const {
  isTutorialOpen,
  currentStep,
  shouldShowPreMintGuidance,
  shouldShowTutorial,
  startTutorial,
  nextStep,
  previousStep,
  closeTutorial,
  skipTutorial,
  steps,
} = useTutorial(setTab) // Pass setTab function for automatic tab switching
```

### useTooltips
Manages tooltip visibility:
```typescript
const {
  tooltipStates,
  showTooltip,
  hideTooltip,
  hideAllTooltips,
} = useTooltips()
```

## State Management

The guidance system uses the existing `useAppState` hook with these new properties:
- `hasSeenPreMintGuidance`: Boolean
- `hasCompletedTutorial`: Boolean
- `tutorialStep`: Number
- `hasMintedFirstCar`: Boolean

## Customization

### Tab Switching
The tutorial system now supports automatic tab switching. Each step can specify a `targetTab` property:
- `'car'` - Switches to the Car tab
- `'race'` - Switches to the Race tab  
- `'create'` - Switches to the Create Track tab

When users navigate through the tutorial (Next/Previous), the app will automatically switch to the appropriate tab for each step.

### Adding Tutorial Steps
Modify the `defaultTutorialSteps` array in `useTutorial.ts`:

```typescript
export const defaultTutorialSteps: TutorialStep[] = [
  {
    id: 'new-step',
    title: 'New Step Title',
    content: 'Step content here...',
    position: 'right', // 'left' | 'right' | 'top' | 'bottom'
    targetTab: 'car', // 'car' | 'race' | 'create' - optional
  },
  // ... existing steps
]
```

### Adding Tooltips
1. Import the Tooltip component
2. Wrap your component with Tooltip
3. Use the useTooltips hook to manage visibility

```typescript
import { Tooltip, useTooltips } from '@/components/Racing/Guidance'

const MyComponent = () => {
  const { tooltipStates } = useTooltips()
  
  return (
    <Tooltip
      content="Your tooltip content here"
      isVisible={tooltipStates.myTooltip}
      position="top"
    >
      <YourComponent />
    </Tooltip>
  )
}
```

### Modifying Pre-mint Content
Edit the content in `PreMintGuidance.tsx` to match your specific app information.

## Integration

The guidance system is automatically integrated into the main `QRacer` component. It will:
1. Show pre-mint guidance for new users
2. Auto-start tutorial after first car mint
3. Provide tutorial button in footer
4. Track completion state

## Styling

All components follow the Racing app's cyberpunk aesthetic:
- Colors: `#00ffea` (cyan), `#0033ff` (blue), `#b8c1ff` (light blue)
- Font: "Press Start 2P" for headers, Inter for body text
- Borders: 2px solid with blue accent
- Background: Dark theme with gradients

