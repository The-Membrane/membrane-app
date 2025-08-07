# Q-Racing Visualizer

A browser-only racing replay visualizer that draws Pac-Man-like mazes and animates car sprites through racing logs.

## Quick Start (60 seconds)

1. **Open the visualizer:**
   ```bash
   # Navigate to the q-racing folder
   cd q-racing
   
   # Open index.html in your browser
   open index.html
   # or double-click index.html
   ```

2. **Watch the demo:**
   - The sample race will start automatically
   - Three cars (yellow, red, cyan) race through the maze
   - Cars flash yellow when reaching the finish line

3. **Use controls:**
   - **Space** - Pause/Play
   - **← →** - Step one frame back/forward (when paused)
   - **R** - Restart current replay

4. **Load custom logs:**
   - Click "Choose File" to load a JSON replay log
   - Format: `[{ tick: 0, positions: { carId: [x,y], ... } }, ...]`

## File Structure

```
q-racing/
├── index.html          # Main HTML with canvas and controls
├── maze.js            # Static maze rendering (off-screen canvas)
├── replay.js          # Animation engine and car management
├── sample-track.js    # Example maze layout (W=wall, E=empty, F=finish)
├── sample-log.js      # Example racing replay data
└── README.md          # This file
```

## API Reference

### `startReplay({ ctx, track, playByPlay, palette, fps })`

Creates and starts a racing replay.

**Parameters:**
- `ctx` - Canvas 2D context
- `track` - 2D array: `W`=wall, `E`=empty, `F`=finish
- `playByPlay` - Array of `{ tick, positions: { carId: [x,y] } }`
- `palette` - Array of car colors (hex strings)
- `fps` - Target frames per second

**Returns:** Replay controller object with methods:
- `restart()` - Reset to beginning
- `stepForward()` - Advance one frame
- `stepBackward()` - Go back one frame
- `togglePlayPause()` - Play/pause
- `replaceTrack(track)` - Hot-swap track
- `replaceLog(playByPlay)` - Hot-swap replay data
- `stop()` - Stop animation

### `renderMaze(ctx, track)`

Renders static maze walls to off-screen canvas for efficient blitting.

## Track Format

```javascript
const track = [
  ['W', 'W', 'W', 'W'],  // W = wall
  ['W', 'E', 'E', 'W'],  // E = empty
  ['W', 'E', 'F', 'W'],  // F = finish line
  ['W', 'W', 'W', 'W']
];
```

## Log Format

```javascript
const playByPlay = [
  { tick: 0, positions: { '1': [1, 1], '2': [2, 1] } },
  { tick: 1, positions: { '1': [2, 1], '2': [3, 1] } },
  // ... more frames
];
```

## Visual Features

- **Grid:** 24px tiles, neon-blue walls (#0033ff)
- **Background:** Black (#000)
- **Cars:** Colored circles with ID labels
- **Finish:** Animated green checkerboard
- **HUD:** Current tick and leading car
- **Font:** Retro "Press Start 2P" pixel font

## Performance

- Static maze rendered once to off-screen canvas
- Efficient blitting for 60 FPS on 2015 hardware
- FPS throttling for smooth playback
- Vanilla ES modules, no frameworks

## Customization

**Add new tracks:**
```javascript
import { track } from './my-track.js';
replay.replaceTrack(track);
```

**Load custom logs:**
```javascript
const customLog = JSON.parse(logData);
replay.replaceLog(customLog);
```

**Change colors:**
```javascript
const customPalette = ['#ff0000', '#00ff00', '#0000ff'];
// Pass to startReplay({ ..., palette: customPalette })
```

## Browser Compatibility

- Modern browsers with ES6 modules support
- Canvas 2D API
- requestAnimationFrame
- File API (for JSON upload)

## Development

All files use:
- 2-space indentation
- Semicolons
- 'use strict'
- Concise functions (< 40 lines)
- ES6 modules 