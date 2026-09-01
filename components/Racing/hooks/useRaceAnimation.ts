import { useEffect } from 'react';
import { Track, JsonRaceResult } from '@/services/q-racing';
import { BG, WALL, FINISH, START, STUCK, BOOST, PALETTE } from '../raceConstants';

type CarState = {
    x: number;
    y: number;
    color: string;
    lastValidRenderX?: number;
    lastValidRenderY?: number;
    hit_wall?: boolean;
    path: Array<{ x: number, y: number }>; // Track the car's path
    hasReachedFinish?: boolean; // Track if car has reached finish line
};

interface UseRaceAnimationParams {
    track: any;
    log: any;
    speed: number;
    playing: boolean;
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
    tickRef: React.MutableRefObject<number>;
    carsRef: React.MutableRefObject<Map<string, CarState>>;
    lastRaceIdRef: React.MutableRefObject<string | undefined>;
    playingRef: React.MutableRefObject<boolean>;
    selectedRace: JsonRaceResult | null;
    selectedCarId: string;
    carRecentRaces: JsonRaceResult[] | undefined;
    carImgRefs: React.MutableRefObject<Map<string, HTMLImageElement>>;
    carImagesLoaded: Set<string>;
    lastActionDisplay: string;
    setDims: React.Dispatch<React.SetStateAction<{ scale: number; rawW: number; rawH: number }>>;
    setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
    setTickDisplay: React.Dispatch<React.SetStateAction<number>>;
    setLeaderDisplay: React.Dispatch<React.SetStateAction<string>>;
    setLastActionDisplay: React.Dispatch<React.SetStateAction<string>>;
    setSelectedRace: React.Dispatch<React.SetStateAction<JsonRaceResult | null>>;
}

/** Draw the static maze */
const drawMaze = (ctx: CanvasRenderingContext2D, t: Track, tilePx: number, timeMs: number, isPlaying: boolean = true) => {
    if (!t) return;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (let y = 0; y < t.length; y++) {
        for (let x = 0; x < t[y].length; x++) {
            const cell = t[y][x];
            const px = x * tilePx;
            const py = y * tilePx;
            if (cell === 'W') {
                ctx.fillStyle = WALL;
                ctx.fillRect(px, py, tilePx, tilePx);
            } else if (cell === 'F') {
                const size = Math.max(2, Math.floor(tilePx / 4));
                // Only animate the finishing tile if the simulation is playing
                if (isPlaying) {
                    const phase = Math.floor(timeMs / 300); // toggle ~3Hz
                    for (let cy = 0; cy < tilePx; cy += size) {
                        for (let cx = 0; cx < tilePx; cx += size) {
                            const idx = ((cx + cy) / size) | 0;
                            const flash = Math.sin(timeMs * 0.005 + idx) > 0;
                            ctx.fillStyle = flash ? FINISH : BG;
                            ctx.fillRect(px + cx, py + cy, size, size);
                        }
                    }
                } else {
                    // Static finishing tile when paused
                    ctx.fillStyle = FINISH;
                    ctx.fillRect(px, py, tilePx, tilePx);
                }
            } else if (cell === 'S') {
                ctx.fillStyle = START;
                ctx.fillRect(px, py, tilePx, tilePx);
            } else if (cell === 'K') {
                ctx.fillStyle = STUCK;
                ctx.fillRect(px, py, tilePx, tilePx);
            } else if (cell === 'B') {
                ctx.fillStyle = BOOST;
                ctx.fillRect(px, py, tilePx, tilePx);
            }
        }
    }
};

// Drives the race replay: sizes the canvas to the track, initializes cars from
// the log, and runs the requestAnimationFrame loop plus keyboard controls.
// Behaviour-identical relocation of the original RaceViewer animation effect.
export default function useRaceAnimation({
    track,
    log,
    speed,
    playing,
    canvasRef,
    tickRef,
    carsRef,
    lastRaceIdRef,
    playingRef,
    selectedRace,
    selectedCarId,
    carRecentRaces,
    carImgRefs,
    carImagesLoaded,
    lastActionDisplay,
    setDims,
    setPlaying,
    setTickDisplay,
    setLeaderDisplay,
    setLastActionDisplay,
    setSelectedRace,
}: UseRaceAnimationParams) {
    useEffect(() => {
        if (!track) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        // decide tile size to fit viewport
        const cols = track[0].length;
        const rows = track.length;
        const maxWpx = window.innerWidth * 0.9;
        const maxHpx = window.innerHeight * 0.8; // leave room for buttons
        const idealTile = Math.floor(Math.min(maxWpx / cols, maxHpx / rows));
        const tilePx = Math.max(4, idealTile); // minimum 4px

        const rawW = cols * tilePx;
        const rawH = rows * tilePx;
        canvas.width = rawW;
        canvas.height = rawH;
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        if (!ctx) return;

        // compute scale so canvas fits within 90vw x 90vh
        const updateScale = () => {
            const maxW = window.innerWidth * 0.9;
            const maxH = window.innerHeight * 0.8;
            const newScale = Math.min(1, Math.min(maxW / rawW, maxH / rawH)); // never upscale via CSS, only downscale
            setDims({ scale: newScale, rawW, rawH });
        };
        // no-pass-live-state-to-parent FP: setDims mirrors window-measured canvas dims from a resize subscription (addEventListener below) the caller cannot own — the rule's documented external-subscription FP.
        updateScale();
        window.addEventListener('resize', updateScale);

        // --- animation state --------------------------------------------------
        const cars = carsRef.current;

        // Validate log data before initializing cars
        if (log && log.length > 0 && log[0].positions) {
            // Only clear and reinitialize cars if we don't have any cars yet
            // or if this is a completely new race (different race ID)
            const hasExistingCars = cars.size > 0;
            const currentRaceId = selectedRace?.race_id;

            if (!hasExistingCars || (currentRaceId && currentRaceId !== lastRaceIdRef.current)) {
                cars.clear();
                lastRaceIdRef.current = currentRaceId;

                Object.keys(log[0].positions).forEach((id, i) => {
                    const initialPos = log[0].positions[id];
                    if (Array.isArray(initialPos) && initialPos.length === 2 &&
                        typeof initialPos[0] === 'number' && typeof initialPos[1] === 'number') {
                        cars.set(id, {
                            x: initialPos[0],
                            y: initialPos[1],
                            color: PALETTE[i % PALETTE.length],
                            lastValidRenderX: undefined,
                            lastValidRenderY: undefined,
                            path: [{ x: initialPos[0], y: initialPos[1] }], // Initialize with starting position
                            hasReachedFinish: false
                        });
                    } else {
                        console.error(`Invalid initial position for car ${id}:`, initialPos);
                    }
                });
            }
        }

        let raf = 0;

        const updateCars = () => {
            // If no log data, don't update cars
            if (!log) return;

            const entry = log[tickRef.current];
            if (!entry || !entry.positions) {
                console.warn(`Invalid log entry at tick ${tickRef.current}:`, entry);
                return;
            }


            // Update car positions directly from the race log
            Object.entries(entry.positions).forEach(([id, position]) => {
                if (!Array.isArray(position) || position.length !== 2) {
                    console.warn(`Invalid position data for car ${id} at tick ${tickRef.current}:`, position);
                    return;
                }

                const [x, y] = position;
                if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) {
                    console.warn(`Invalid coordinates for car ${id} at tick ${tickRef.current}: x=${x}, y=${y}`);
                    return;
                }


                const car = cars.get(id);
                if (car) {
                    // Store the raw log position
                    car.x = x;
                    car.y = y;

                    // Add current position to path if it's different from the last position
                    // and if the car hasn't already reached the finish line
                    const lastPathPoint = car.path[car.path.length - 1];
                    const isAtFinish = track[y] && track[y][x] === 'F';

                    if (!lastPathPoint || lastPathPoint.x !== x || lastPathPoint.y !== y) {
                        // Only add to path if we haven't reached the finish line yet
                        if (!isAtFinish && !car.hasReachedFinish) {
                            car.path.push({ x, y });
                        } else if (isAtFinish && !car.hasReachedFinish) {
                            // Add the finish line position and mark as reached
                            car.path.push({ x, y });
                            car.hasReachedFinish = true;
                        }
                        // Don't add any more points after reaching the finish line
                    }



                } else {
                    console.warn(`Car ${id} not found in cars map at tick ${tickRef.current}. Available cars:`, Array.from(cars.keys()));
                }
            });


            // Determine leader for display
            let leaderId: string | null = null;
            let maxProg = -1;
            cars.forEach((c, id) => {
                const prog = c.x + c.y * cols;
                if (prog > maxProg) { maxProg = prog; leaderId = id; }
            });
            setLeaderDisplay(leaderId ?? '');
            setTickDisplay(tickRef.current);

            // Get the actual action from the JsonAction objects in play_by_play
            // PRIORITY: Show user's car actions if available, otherwise fall back to leader car
            let targetCarId = null;
            let targetPlayByPlay = null;

            // First, try to get the user's car actions
            if (selectedCarId && selectedRace?.play_by_play && selectedRace.play_by_play[selectedCarId]) {
                targetCarId = selectedCarId;
                targetPlayByPlay = selectedRace.play_by_play[selectedCarId];
            }
            // Fall back to leader car if user's car not available
            else if (leaderId && selectedRace?.play_by_play && selectedRace.play_by_play[leaderId]) {
                targetCarId = leaderId;
                targetPlayByPlay = selectedRace.play_by_play[leaderId];
            }

            if (targetCarId && targetPlayByPlay && targetPlayByPlay.actions) {
                // Log the available actions for debugging - disabled to prevent spam
                // if (targetCarId === leaderDisplay) {
                //     console.log(`Available actions for ${targetCarId}:`, targetPlayByPlay.actions.map(a => ({ action_value: a.action_value, pos: a.resulting_position })));
                // }

                // The tick index corresponds to the action index (tick 0 = starting position, tick 1 = first action, etc.)
                const actionIndex = tickRef.current - 1; // -1 because tick 0 is starting position

                if (actionIndex >= 0 && actionIndex < targetPlayByPlay.actions.length) {
                    const action = targetPlayByPlay.actions[actionIndex];
                    if (action && (action as any).action_value !== undefined) {
                        // Map the action_value (i8) to our display format
                        let displayAction = 'Idle';
                        switch ((action as any).action_value) {
                            case 0:
                                displayAction = 'Up';
                                break;
                            case 1:
                                displayAction = 'Down';
                                break;
                            case 2:
                                displayAction = 'Left';
                                break;
                            case 3:
                                displayAction = 'Right';
                                break;
                            default:
                                // If action_value is not recognized, default to Idle
                                displayAction = 'Idle';
                        }
                        setLastActionDisplay(displayAction);
                    }
                } else if (tickRef.current === 0) {
                    // At tick 0, we're at the starting position, no action yet
                    if (lastActionDisplay !== 'Idle') {
                        // console.log(`At starting position, setting action to Idle`); // Disabled to prevent spam
                        setLastActionDisplay('Idle');
                    }
                } else {
                    // Beyond the last action, keep the last known action
                    const lastAction = targetPlayByPlay.actions[targetPlayByPlay.actions.length - 1];
                    if (lastAction && (lastAction as any).action_value !== undefined) {
                        let displayAction = 'Idle';
                        switch ((lastAction as any).action_value) {
                            case 0:
                                displayAction = 'Up';
                                break;
                            case 1:
                                displayAction = 'Down';
                                break;
                            case 2:
                                displayAction = 'Left';
                                break;
                            case 3:
                                displayAction = 'Right';
                                break;
                            default:
                                displayAction = 'Idle';
                        }
                        if (displayAction !== lastActionDisplay) {
                            setLastActionDisplay(displayAction);
                        }
                    }
                }
            }
        };

        const drawCarPaths = () => {
            // Validate canvas context
            if (!ctx || !ctx.canvas) {
                console.error('Invalid canvas context in drawCarPaths');
                return;
            }

            cars.forEach((c, id) => {
                // Draw the car's path as a red line following track tiles
                if (c.path && c.path.length > 1) {

                    ctx.beginPath();
                    ctx.strokeStyle = '#ff0000';
                    ctx.lineWidth = 2;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';

                    // Start at the first position
                    const firstPoint = c.path[0];

                    // Validate first point coordinates
                    if (typeof firstPoint.x !== 'number' || typeof firstPoint.y !== 'number' ||
                        isNaN(firstPoint.x) || isNaN(firstPoint.y)) {
                        console.warn(`Invalid first path point for car ${id}:`, firstPoint);
                        return;
                    }

                    const startX = firstPoint.x * tilePx + tilePx / 2;
                    const startY = firstPoint.y * tilePx + tilePx / 2;
                    ctx.moveTo(startX, startY);

                    // Draw path following track tiles (horizontal/vertical lines only)
                    for (let i = 1; i < c.path.length; i++) {
                        const prevPoint = c.path[i - 1];
                        const currentPoint = c.path[i];

                        // Validate coordinates before drawing
                        if (typeof prevPoint.x !== 'number' || typeof prevPoint.y !== 'number' ||
                            typeof currentPoint.x !== 'number' || typeof currentPoint.y !== 'number' ||
                            isNaN(prevPoint.x) || isNaN(prevPoint.y) ||
                            isNaN(currentPoint.x) || isNaN(currentPoint.y)) {
                            console.warn(`Invalid path coordinates for car ${id} at index ${i}:`, { prevPoint, currentPoint });
                            continue; // Skip this segment but continue with the rest
                        }

                        // Additional validation: check if coordinates are within reasonable bounds
                        const maxX = track[0] ? track[0].length : 0;
                        const maxY = track.length;

                        if (prevPoint.x < 0 || prevPoint.x >= maxX || prevPoint.y < 0 || prevPoint.y >= maxY ||
                            currentPoint.x < 0 || currentPoint.x >= maxX || currentPoint.y < 0 || currentPoint.y >= maxY) {
                            console.warn(`Path coordinates out of bounds for car ${id} at index ${i}:`, {
                                prevPoint,
                                currentPoint,
                                bounds: { maxX, maxY }
                            });
                            continue; // Skip this segment
                        }

                        // Calculate center positions
                        const prevX = prevPoint.x * tilePx + tilePx / 2;
                        const prevY = prevPoint.y * tilePx + tilePx / 2;
                        const currentX = currentPoint.x * tilePx + tilePx / 2;
                        const currentY = currentPoint.y * tilePx + tilePx / 2;

                        // Draw direct line from previous point to current point
                        ctx.lineTo(currentX, currentY);
                    }

                    ctx.stroke();
                }
            });
        };

        const drawCars = () => {
            // Validate canvas context
            if (!ctx || !ctx.canvas) {
                console.error('Invalid canvas context in drawCars');
                return;
            }

            cars.forEach((c, id) => {
                // Validate car position
                if (c.x === undefined || c.y === undefined || isNaN(c.x) || isNaN(c.y)) {
                    console.warn(`Invalid car position for ${id}: x=${c.x}, y=${c.y}`);
                    return;
                }

                // Calculate pixel position from actual car coordinates
                const actualPx = c.x * tilePx + tilePx / 2;
                const actualPy = c.y * tilePx + tilePx / 2;

                // Check if current position is within canvas bounds
                const isWithinBounds = actualPx >= 0 && actualPy >= 0 &&
                    actualPx <= ctx.canvas.width && actualPy <= ctx.canvas.height;

                // Determine rendering position
                let renderPx: number;
                let renderPy: number;
                let isUsingFallback = false;

                if (isWithinBounds) {
                    // Position is valid, use it and save it as last valid
                    renderPx = actualPx;
                    renderPy = actualPy;
                    c.lastValidRenderX = actualPx;
                    c.lastValidRenderY = actualPy;
                } else {
                    // Position is outside bounds, try to use last valid position
                    if (c.lastValidRenderX !== undefined && c.lastValidRenderY !== undefined) {
                        renderPx = c.lastValidRenderX;
                        renderPy = c.lastValidRenderY;
                        isUsingFallback = true;
                        // console.log(`Car ${id} using fallback position - logging disabled to prevent spam`);
                    } else {
                        // No fallback available, clamp to edge as last resort
                        renderPx = Math.max(tilePx / 2, Math.min(actualPx, ctx.canvas.width - tilePx / 2));
                        renderPy = Math.max(tilePx / 2, Math.min(actualPy, ctx.canvas.height - tilePx / 2));
                        // console.log(`Car ${id} no fallback available, clamped to edge - logging disabled to prevent spam`);
                    }
                }

                // Get the appropriate car image based on car ID
                const carImageId = id === '0' ? '0' : 'default'
                const img = carImgRefs.current.get(carImageId)
                const isImageLoaded = carImagesLoaded.has(carImageId)

                if (img && isImageLoaded) {
                    const size = Math.floor(tilePx * 0.9);
                    const drawX = renderPx - size / 2;
                    const drawY = renderPy - size / 2;


                    try {
                        // Check if car should be flipped based on current action
                        // Get the current action for this specific car
                        let currentAction = 'Idle';
                        if (selectedRace?.play_by_play && selectedRace.play_by_play[id]) {
                            const playByPlay = selectedRace.play_by_play[id];
                            if (playByPlay.actions) {
                                const actionIndex = tickRef.current - 1; // -1 because tick 0 is starting position
                                if (actionIndex >= 0 && actionIndex < playByPlay.actions.length) {
                                    const action = playByPlay.actions[actionIndex];
                                    if (action && (action as any).action_value !== undefined) {
                                        switch ((action as any).action_value) {
                                            case 0: currentAction = 'Up'; break;
                                            case 1: currentAction = 'Down'; break;
                                            case 2: currentAction = 'Left'; break;
                                            case 3: currentAction = 'Right'; break;
                                            default: currentAction = 'Idle';
                                        }
                                    }
                                }
                            }
                        }

                        const shouldFlip = currentAction === 'Left';
                        if (shouldFlip) {
                            // Save the current canvas state
                            ctx.save();

                            // Move to the center of the car image
                            ctx.translate(renderPx, renderPy);

                            // Flip horizontally by scaling x by -1
                            ctx.scale(-1, 1);

                            // Draw the image at the flipped position
                            ctx.drawImage(img, -size / 2, -size / 2, size, size);

                            // Restore the canvas state
                            ctx.restore();
                        } else {
                            // Draw normally without flipping
                            ctx.drawImage(img, drawX, drawY, size, size);
                        }

                        // Add red border if car is using fallback position
                        if (isUsingFallback) {
                            ctx.strokeStyle = '#ff0000';
                            ctx.lineWidth = 2;
                            ctx.strokeRect(drawX - 1, drawY - 1, size + 2, size + 2);
                        }

                        // Add red border if car hit a wall (collision)
                        if (c.hit_wall) {
                            ctx.strokeStyle = '#ff0000';
                            ctx.lineWidth = 3;
                            ctx.strokeRect(drawX - 2, drawY - 2, size + 4, size + 4);
                        }

                        // Debug logging removed to prevent console spam
                    } catch (error) {
                        console.error(`Error drawing car image for ${id}:`, error);
                        // Fallback to circle if image drawing fails
                        ctx.beginPath();
                        ctx.arc(renderPx, renderPy, tilePx / 3, 0, Math.PI * 2);
                        ctx.fillStyle = c.color;
                        ctx.fill();

                        // Add red border if car is using fallback position (for fallback rendering too)
                        if (isUsingFallback) {
                            ctx.strokeStyle = '#ff0000';
                            ctx.lineWidth = 2;
                            ctx.strokeRect(renderPx - tilePx / 3 - 1, renderPy - tilePx / 3 - 1, (tilePx / 3) * 2 + 2, (tilePx / 3) * 2 + 2);
                        }

                        // Add red border if car hit a wall (collision) - for fallback rendering too
                        if (c.hit_wall) {
                            ctx.strokeStyle = '#ff0000';
                            ctx.lineWidth = 3;
                            ctx.strokeRect(renderPx - tilePx / 3 - 2, renderPy - tilePx / 3 - 2, (tilePx / 3) * 2 + 4, (tilePx / 3) * 2 + 4);
                        }
                    }
                } else {
                    // fallback to simple circle until image loads
                    ctx.beginPath();
                    ctx.arc(renderPx, renderPy, tilePx / 3, 0, Math.PI * 2);
                    ctx.fillStyle = c.color;
                    ctx.fill();

                    // Add red border if car hit a wall (collision) - for main circle rendering
                    if (c.hit_wall) {
                        ctx.strokeStyle = '#ff0000';
                        ctx.lineWidth = 3;
                        ctx.strokeRect(renderPx - tilePx / 3 - 2, renderPy - tilePx / 3 - 2, (tilePx / 3) * 2 + 4, (tilePx / 3) * 2 + 4);
                    }

                    // Debug logging removed to prevent console spam
                }

                // draw car id on top
                ctx.fillStyle = '#000';
                ctx.font = '8px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(id, renderPx, renderPy + 2);
            });
        };

        let last = performance.now();

        const renderFrame = (now: number) => {
            // Get current speed value for this frame
            const currentSpeed = speed;
            const tickInterval = 1000 / currentSpeed;

            if (playingRef.current && log && now - last >= tickInterval) {
                if (tickRef.current < log.length - 1) {
                    tickRef.current += 1;
                    updateCars();
                } else if (tickRef.current >= log.length - 1) {
                    // Race is finished, stop playing
                    setPlaying(false);
                    playingRef.current = false;
                }
                last = now;
            }
            // Check if race is completed (at the last tick)
            const isRaceCompleted = log && tickRef.current >= log.length - 1;
            drawMaze(ctx, track, tilePx, now, playing && !isRaceCompleted);
            drawCarPaths(); // Draw the car paths before drawing the cars
            drawCars();

            // Continue animation if we have track data
            if (track) {
                raf = requestAnimationFrame(renderFrame);
            }
        };

        // initial draw
        // no-pass-live-state-to-parent FP: updateCars pushes requestAnimationFrame-driven tick/leader display into the caller's setters — an animation-loop (external system) sync, not upward mirroring.
        if (log && log.length > 0) {
            updateCars();
            const startNow = performance.now();
            // Check if race is completed initially
            const isRaceCompleted = tickRef.current >= log.length - 1;
            drawMaze(ctx, track, tilePx, startNow, playing && !isRaceCompleted);
            drawCarPaths(); // Draw the car paths before drawing the cars
            drawCars();
            raf = requestAnimationFrame(renderFrame);
        } else {
            // Draw track without race data
            const startNow = performance.now();
            drawMaze(ctx, track, tilePx, startNow, false); // No animation when no race data
            drawCarPaths(); // Draw the car paths before drawing the cars
            drawCars(); // This will draw empty cars map
            raf = requestAnimationFrame(renderFrame);
        }

        // controls
        const handler = (e: KeyboardEvent) => {
            switch (e.code) {
                case 'Space':
                    setPlaying(p => !p);
                    break;
                case 'ArrowRight':
                    if (!playingRef.current && log && tickRef.current < log.length - 1) { tickRef.current++; updateCars(); }
                    break;
                case 'ArrowLeft':
                    if (!playingRef.current && tickRef.current > 0) { tickRef.current--; updateCars(); }
                    break;
                case 'KeyR':
                    // Replay the race from the beginning
                    tickRef.current = 0;
                    setTickDisplay(0);
                    // Clear drawn paths and reset finish flags before replay
                    carsRef.current.forEach((car) => {
                        car.path = [];
                        car.hasReachedFinish = false;
                        car.lastValidRenderX = undefined;
                        car.lastValidRenderY = undefined;
                        car.hit_wall = false as any;
                    });
                    setPlaying(true);
                    updateCars();
                    // Reset to beginning, so race is not completed
                    drawMaze(ctx, track, tilePx, performance.now(), true);
                    drawCarPaths(); // Draw the car paths before drawing the cars
                    drawCars();
                    break;
                case 'KeyN':
                    // Navigate to next race if available
                    if (carRecentRaces && carRecentRaces.length > 0) {
                        if (selectedRace) {
                            const currentIndex = carRecentRaces.findIndex(r => r.race_id === selectedRace.race_id);
                            if (currentIndex >= 0 && currentIndex < carRecentRaces.length - 1) {
                                setSelectedRace(carRecentRaces[currentIndex + 1]);
                            }
                        } else {
                            // If no race selected, select the first one
                            setSelectedRace(carRecentRaces[0]);
                        }
                    }
                    break;
                case 'KeyP':
                    // Navigate to previous race if available
                    if (carRecentRaces && carRecentRaces.length > 0) {
                        if (selectedRace) {
                            const currentIndex = carRecentRaces.findIndex(r => r.race_id === selectedRace.race_id);
                            if (currentIndex > 0) {
                                setSelectedRace(carRecentRaces[currentIndex - 1]);
                            }
                        } else {
                            // If no race selected, select the last one
                            setSelectedRace(carRecentRaces[carRecentRaces.length - 1]);
                        }
                    }
                    break;
            }
        };
        window.addEventListener('keydown', handler);

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('keydown', handler);
            window.removeEventListener('resize', updateScale);
        };
        // exhaustive-deps: deps deliberately limited to [track, log, speed, playing]. This effect
        // sets up the requestAnimationFrame loop plus keydown/resize listeners; adding the flagged
        // deps (selectedRace, carRecentRaces, refs, setters, etc.) would tear down and restart the
        // animation loop mid-play. The omitted values are read via refs / stable setters at call
        // time, so they stay current without being reactive.
    }, [track, log, speed, playing]);
}
