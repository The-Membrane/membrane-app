import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRecentRacesForCar, useOwnedCars, useQRacing, useTopTimes, useByteMinterConfig } from '../../hooks/useQRacing';
import { Track, PlayByPlayEntry, JsonRaceResult, useTrackTrainingStats, useListTracks, useCarName, useValidMazeId, useSecondsUntilOpen } from '../../services/q-racing';
import useWallet from '../../hooks/useWallet';
import { useRouter } from 'next/router';
import useAppState from '@/persisted-state/useAppState';
import useRunRace from '@/components/Racing/hooks/useRunRace';
import ConfirmModal from '@/components/ConfirmModal';
import { Text } from '@chakra-ui/react';
import useRacingState from './hooks/useRacingState';

// Testing toggle - set to true to force maze mode
const FORCE_MAZE_MODE = false;
// Testing toggle - set to true to test confetti
const TEST_CONFETTI = false;

const BASE_TILE = 24;
const WALL = '#0033ff';
const BG = '#000';

const FINISH = '#00ff00';
const PALETTE = ['#ffff00', '#ff0000', '#00ffff', '#ff00ff', '#ff8000', '#00ff00', '#8000ff', '#ffffff'];
// tile colours
const START = 'red';
const STUCK = '#555555';
const BOOST = '#ffdd00';

interface Props {
    trackId?: string;
}

//track id 3 is the Tiny Straight Track
const RaceViewer: React.FC<Props> = ({ trackId = '3' }) => {
    console.log('RaceViewer', trackId);
    const router = useRouter();
    const { racingState, setRacingState } = useRacingState();
    const { appState } = useAppState();
    const { address } = useWallet();
    const { data: ownedCars, isLoading: isLoadingCars, error: carsError } = useOwnedCars(address);

    // Component to display car name with fallback to ID
    const CarNameDisplay: React.FC<{ carId: string; isOwned: boolean }> = ({ carId, isOwned }) => {
        const { data: carName } = useCarName(carId, appState.rpcUrl);

        return (
            <div style={{
                color: isOwned ? '#00ffea' : '#fff',
                fontWeight: isOwned ? 'bold' : 'normal',
                fontSize: 14
            }}>
                {carName || `Car ${carId}`}
            </div>
        );
    };

    const updateRouteQuery = (updates: { carId?: string; trackId?: string }) => {
        const nextQuery: Record<string, any> = { ...router.query };
        if (updates.carId !== undefined) {
            if (updates.carId) nextQuery.carId = updates.carId; else delete nextQuery.carId;
        }
        if (updates.trackId !== undefined) {
            if (updates.trackId) nextQuery.trackId = updates.trackId; else delete nextQuery.trackId;
        }
        router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true, scroll: false });
    };

    // Load car sprite images
    const carImgRefs = useRef<Map<string, HTMLImageElement>>(new Map())
    const [carImagesLoaded, setCarImagesLoaded] = useState<Set<string>>(new Set())

    useEffect(() => {
        // Load images for different car types
        const carImages = [
            { id: '0', src: '/images/evil-retro-car.png' }, // Car ID 0 gets evil car
            { id: 'default', src: '/images/pixel-retro-car.png' } // All other cars get default
        ]

        let loadedCount = 0
        const totalImages = carImages.length

        carImages.forEach(({ id, src }) => {
            const img = new Image()
            img.src = src
            img.onload = () => {
                carImgRefs.current.set(id, img)
                setCarImagesLoaded(prev => new Set([...prev, id]))
                loadedCount++
                if (loadedCount === totalImages) {
                    console.log('All car images loaded successfully')
                }
            }
            img.onerror = () => {
                console.error(`Failed to load car image for ${id}: ${src}`)
                // Try to load fallback image
                const fallbackImg = new Image()
                fallbackImg.src = '/images/pixel-retro-car.png'
                fallbackImg.onload = () => {
                    carImgRefs.current.set(id, fallbackImg)
                    setCarImagesLoaded(prev => new Set([...prev, id]))
                    loadedCount++
                    if (loadedCount === totalImages) {
                        console.log('All car images loaded successfully (with fallbacks)')
                    }
                }
            }
        })
    }, [])

    const [selectedCarId, setSelectedCarId] = useState<string>('');
    const [selectedRace, setSelectedRace] = useState<JsonRaceResult | null>(null);
    const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>(trackId);
    const [showTraining, setShowTraining] = useState<boolean>(true);
    const [showPvp, setShowPvp] = useState<boolean>(false);
    const [showAdvancedParams, setShowAdvancedParams] = useState<boolean>(false);
    const [explorationRate, setExplorationRate] = useState<number>(0.1);
    const [enableDecay, setEnableDecay] = useState<boolean>(true);

    // Sync racing state with local state
    useMemo(() => {
        if (racingState.selectedTrackId && racingState.selectedTrackId !== selectedTrackId) {
            setSelectedTrackId(racingState.selectedTrackId);
            updateRouteQuery({ trackId: racingState.selectedTrackId });
            setRacingState({ ...racingState, selectedTrackId: undefined });
        }
        if (racingState.showTraining !== undefined && racingState.showTraining !== showTraining) {
            setShowTraining(racingState.showTraining);
            setRacingState({ ...racingState, showTraining: undefined });
        }
        if (racingState.showPvp !== undefined && racingState.showPvp !== showPvp) {
            setShowPvp(racingState.showPvp);
            setRacingState({ ...racingState, showPvp: undefined });
        }

    }, [racingState.selectedTrackId, racingState.showTraining, racingState.showPvp, selectedTrackId, showTraining, showPvp]);

    // Get recent races for selected car
    const { data: carRecentRaces, isLoading: isLoadingCarRaces, error: carRacesError } = useRecentRacesForCar(selectedCarId);

    // Get race data using the selected race object
    const { track, log, isLoading } = useQRacing(selectedTrackId, selectedRace ?? undefined, appState.rpcUrl);

    // Get maze event data
    const { data: maze } = useSecondsUntilOpen('maze', appState.rpcUrl);
    const { data: validMazeId } = useValidMazeId(appState.rpcUrl);

    // Check if we're in maze mode: valid maze track selected AND in showcase mode
    const isMazeMode = !showTraining && selectedTrackId && validMazeId === selectedTrackId;

    console.log('RaceViewer: Maze mode check', {
        FORCE_MAZE_MODE,
        selectedTrackId,
        validMazeId,
        maze,
        isMazeMode
    });





    // Debug logging for race selection
    useEffect(() => {
        console.log('RaceViewer: selectedRace changed:', selectedRace?.race_id);
        console.log('RaceViewer: selectedTrackId changed:', selectedTrackId);
        console.log('RaceViewer: track loaded:', track ? `${track.length}x${track[0]?.length || 0} grid` : 'null');
        console.log('RaceViewer: log loaded:', log?.length, 'entries');
    }, [selectedRace, selectedTrackId, track, log]);

    // Fetch training stats for selected car + track
    const { data: trackTrainingStats, refetch: refetchTrainingStats } = useTrackTrainingStats(selectedCarId || undefined, selectedTrackId || undefined, appState.rpcUrl);
    // List available tracks
    const { data: availableTracks } = useListTracks(appState.rpcUrl);
    // Get top times for the selected track
    const { data: topTimes, refetch: refetchTopTimes } = useTopTimes(selectedTrackId || undefined, appState.rpcUrl);

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const leaderboardRef = useRef<HTMLDivElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const playingRef = useRef(false);
    const [dims, setDims] = useState({ scale: 1, rawW: 0, rawH: 0 });
    const [speed, setSpeed] = useState(1); // 1 tick per second baseline
    const [tickDisplay, setTickDisplay] = useState(0);
    const [leaderDisplay, setLeaderDisplay] = useState<string>('');
    const [lastActionDisplay, setLastActionDisplay] = useState<string>('');
    const tickRef = useRef(0); // Move tickRef to component level
    const [showSimPanel, setShowSimPanel] = useState(false);
    const [showControls, setShowControls] = useState(false);
    const [showLegend, setShowLegend] = useState(false);

    // Confetti state
    const [showConfetti, setShowConfetti] = useState(false);
    const confettiCanvasRef = useRef<HTMLCanvasElement>(null);

    // Confetti animation effect
    useEffect(() => {
        if (!showConfetti || !confettiCanvasRef.current) return;

        const canvas = confettiCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Confetti pieces
        const confetti: Array<{
            x: number;
            y: number;
            vx: number;
            vy: number;
            color: string;
            size: number;
        }> = [];

        // Generate confetti pieces
        for (let i = 0; i < 150; i++) {
            confetti.push({
                x: Math.random() * canvas.width,
                y: -10,
                vx: (Math.random() - 0.5) * 8,
                vy: Math.random() * 3 + 2,
                color: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8000', '#8000ff'][Math.floor(Math.random() * 8)],
                size: Math.random() * 3 + 2
            });
        }

        let animationId: number;
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            confetti.forEach((piece, index) => {
                piece.x += piece.vx;
                piece.y += piece.vy;
                piece.vy += 0.1; // gravity

                ctx.fillStyle = piece.color;
                ctx.fillRect(piece.x, piece.y, piece.size, piece.size);

                // Remove pieces that are off screen
                if (piece.y > canvas.height || piece.x < -10 || piece.x > canvas.width + 10) {
                    confetti.splice(index, 1);
                }
            });

            if (confetti.length > 0) {
                animationId = requestAnimationFrame(animate);
            }
        };

        animate();

        // Handle window resize
        const handleResize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        window.addEventListener('resize', handleResize);

        return () => {
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
            window.removeEventListener('resize', handleResize);
        };
    }, [showConfetti]);

    const hasPreview = useMemo(() => {
        return Boolean(track);
    }, [track]);

    const hasRaceData = useMemo(() => {
        return Boolean(selectedRace && selectedRace.race_id !== 'sample' && track && log);
    }, [selectedRace, track, log]);

    // Always select the most recent race (last in the list)
    useEffect(() => {
        if (carRecentRaces && carRecentRaces.length > 0) {
            console.log('RaceViewer: carRecentRaces length:', carRecentRaces.length);
            console.log('RaceViewer: All race IDs:', carRecentRaces.map(r => r.race_id));
            console.log('RaceViewer: All race track IDs:', carRecentRaces.map(r => r.track_id));
            console.log('RaceViewer: Race IDs as numbers:', carRecentRaces.map(r => ({ race_id: r.race_id, as_number: Number(r.race_id) })));

            // The contract stores races in insertion order (newest at the end)
            // So the last race in the array should be the most recent
            const mostRecentRace = carRecentRaces[carRecentRaces.length - 1];

            // Log the race IDs to verify ordering
            console.log('RaceViewer: Original array order (newest should be last):', carRecentRaces.map(r => r.race_id));
            console.log('RaceViewer: Last race in array (should be newest):', mostRecentRace.race_id);

            // Double-check: if race IDs are numeric, verify the last one has the highest ID
            if (carRecentRaces.length > 1) {
                const lastRaceId = Number(mostRecentRace.race_id);
                const secondLastRaceId = Number(carRecentRaces[carRecentRaces.length - 2].race_id);
                console.log('RaceViewer: Last race ID:', lastRaceId, 'Second last race ID:', secondLastRaceId);

                if (lastRaceId < secondLastRaceId) {
                    console.warn('RaceViewer: WARNING! Last race in array has lower ID than second last. Array order may be wrong.');
                }
            }

            console.log('RaceViewer: Selected most recent race:', mostRecentRace.race_id, 'with steps:', mostRecentRace.steps_taken, 'track:', mostRecentRace.track_id);

            // Always auto-select the latest race
            console.log('RaceViewer: Auto-selecting race:', mostRecentRace.race_id);
            setSelectedRace(mostRecentRace);
            setSelectedTrackId(mostRecentRace.track_id);
        } else {
            setSelectedRace(null);
        }
    }, [carRecentRaces]);

    // Remove navigation via route; always show latest race

    // Memoized filtered tracks: PvP filtering disabled (tabled until v2)
    const filteredTracks = useMemo(() => {
        if (!availableTracks) return [] as any[];
        // if (showPvp) {
        //     return availableTracks.filter((t: any) => (t?.starting_tiles?.length ?? 0) > 1);
        // }
        return availableTracks;
    }, [availableTracks]);

    // Always auto-select the latest race - no URL-based race selection
    // This prevents circular dependencies and ensures we always show the most recent race

    // Sync selected car from URL when present
    useEffect(() => {
        const qCar = (router.query?.carId as string) || '';
        if (qCar && qCar !== selectedCarId) {
            if (!ownedCars || ownedCars.some((c) => c.id === qCar)) {
                setSelectedCarId(qCar);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [router.query?.carId, ownedCars]);

    // Auto-select first car when ownedCars load
    useEffect(() => {
        if (ownedCars && ownedCars.length > 0) {
            if (!selectedCarId || !ownedCars.some((c) => c.id === selectedCarId)) {
                const first = ownedCars[0].id;
                setSelectedCarId(first);
                updateRouteQuery({ carId: first });
            }
        } else if (selectedCarId) {
            setSelectedCarId('');
            updateRouteQuery({ carId: undefined });
        }
    }, [ownedCars, selectedCarId]);

    // Auto-select first track from filtered list when none selected yet
    useEffect(() => {
        if (!selectedTrackId && filteredTracks && filteredTracks.length > 0) {
            const first = filteredTracks[0];
            if (first && first.id != null) {
                const tid = String(first.id);
                setSelectedTrackId(tid);
                updateRouteQuery({ trackId: tid });
            }
        }
    }, [filteredTracks, selectedTrackId]);

    // Auto-select first available track when PvP is toggled on
    useEffect(() => {
        // This logic has been moved to the toggle button click handler
    }, [showPvp, availableTracks, selectedTrackId]);



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

    // keep ref in sync with state so animation loop reads latest value
    useEffect(() => { playingRef.current = playing; }, [playing]);

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
        updateScale();
        window.addEventListener('resize', updateScale);

        // --- animation state --------------------------------------------------
        const cars = new Map<string, { x: number; y: number; color: string; flash: number; lastValidRenderX?: number; lastValidRenderY?: number; hit_wall?: boolean }>();

        // Validate log data before initializing cars
        if (log && log.length > 0 && log[0].positions) {
            Object.keys(log[0].positions).forEach((id, i) => {
                const initialPos = log[0].positions[id];
                if (Array.isArray(initialPos) && initialPos.length === 2 &&
                    typeof initialPos[0] === 'number' && typeof initialPos[1] === 'number') {
                    cars.set(id, {
                        x: initialPos[0],
                        y: initialPos[1],
                        color: PALETTE[i % PALETTE.length],
                        flash: 0,
                        lastValidRenderX: undefined,
                        lastValidRenderY: undefined
                    });
                    console.log(`Initialized car ${id} at position (${initialPos[0]}, ${initialPos[1]})`);
                } else {
                    console.error(`Invalid initial position for car ${id}:`, initialPos);
                }
            });
        } else if (!log) {
            console.log('No log data available - showing track without cars');
        } else {
            console.error('Invalid log data:', log);
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

            // Debug: Log the current tick and available positions
            console.log(`Tick ${tickRef.current}: Updating cars with positions:`, entry.positions);
            console.log(`Cars map before update:`, Array.from(cars.entries()));

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
                    console.log(`Updated car ${id} to position (${x}, ${y}) at tick ${tickRef.current}`);

                    // Check if car is at finish line for flash effect
                    if (track[y] && track[y][x] === 'F' && car.flash === 0) {
                        car.flash = 18;
                    }

                    // Log position updates for debugging - disabled to prevent spam
                    // if (id === leaderDisplay) {
                    //     console.log(`Updated car ${id} to position (${x}, ${y}) at tick ${tickRef.current}`);
                    // }
                } else {
                    console.warn(`Car ${id} not found in cars map at tick ${tickRef.current}. Available cars:`, Array.from(cars.keys()));
                }
            });

            // Debug: Log the cars map after update
            console.log(`Cars map after update:`, Array.from(cars.entries()));

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
                //     console.log(`Available actions for ${targetCarId}:`, targetPlayByPlay.actions.map(a => ({ action: a.action, pos: a.resulting_position })));
                // }

                // The tick index corresponds to the action index (tick 0 = starting position, tick 1 = first action, etc.)
                const actionIndex = tickRef.current - 1; // -1 because tick 0 is starting position

                if (actionIndex >= 0 && actionIndex < targetPlayByPlay.actions.length) {
                    const action = targetPlayByPlay.actions[actionIndex];
                    if (action && action.action) {
                        // Map the action string to our display format
                        let displayAction = 'Idle';
                        switch (action.action.toLowerCase()) {
                            case 'up':
                            case 'north':
                            case '0':
                                displayAction = 'Up';
                                break;
                            case 'down':
                            case 'south':
                            case '1':
                                displayAction = 'Down';
                                break;
                            case 'left':
                            case 'west':
                            case '2':
                                displayAction = 'Left';
                                break;
                            case 'right':
                            case 'east':
                            case '3':
                                displayAction = 'Right';
                                break;
                            default:
                                // If action is not a recognized word, default to Idle
                                displayAction = 'Idle';
                        }

                        // Debug logging for action changes - disabled to prevent spam
                        // if (displayAction !== lastActionDisplay) {
                        //     console.log(`Action changed from ${displayAction} to ${displayAction} at tick ${tickRef.current}, target car: ${targetCarId}, action: ${action.action}, pos: (${action.resulting_position.x}, ${action.resulting_position.y})`);
                        // }

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
                    if (lastAction && lastAction.action) {
                        let displayAction = 'Idle';
                        switch (lastAction.action.toLowerCase()) {
                            case 'up':
                            case 'north':
                            case '0':
                                displayAction = 'Up';
                                break;
                            case 'down':
                            case 'south':
                            case '1':
                                displayAction = 'Down';
                                break;
                            case 'left':
                            case 'west':
                            case '2':
                                displayAction = 'Left';
                                break;
                            case 'right':
                            case 'east':
                            case '3':
                                displayAction = 'Right';
                                break;
                            default:
                                // If action is not a recognized word, default to Idle
                                displayAction = 'Idle';
                        }

                        if (displayAction !== lastActionDisplay) {
                            // console.log(`Beyond last action, keeping: ${displayAction}`); // Disabled to prevent spam
                            setLastActionDisplay(displayAction);
                        }
                    }
                }
            }
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

                    // optional flash effect: brief yellow glow behind sprite
                    if (c.flash-- > 0) {
                        ctx.beginPath();
                        ctx.arc(renderPx, renderPy, size * 0.55, 0, Math.PI * 2);
                        ctx.fillStyle = '#ffff00';
                        ctx.fill();
                    }

                    try {
                        ctx.drawImage(img, drawX, drawY, size, size);

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
                        ctx.fillStyle = c.flash-- > 0 ? '#ffff00' : c.color;
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
                    ctx.fillStyle = c.flash-- > 0 ? '#ffff00' : c.color;
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
            drawCars();

            // Continue animation if we have track data
            if (track) {
                raf = requestAnimationFrame(renderFrame);
            }
        };

        // initial draw
        if (log && log.length > 0) {
            updateCars();
            const startNow = performance.now();
            // Check if race is completed initially
            const isRaceCompleted = tickRef.current >= log.length - 1;
            drawMaze(ctx, track, tilePx, startNow, playing && !isRaceCompleted);
            drawCars();
            raf = requestAnimationFrame(renderFrame);
        } else {
            // Draw track without race data
            const startNow = performance.now();
            drawMaze(ctx, track, tilePx, startNow, false); // No animation when no race data
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
                    setPlaying(true);
                    updateCars();
                    // Reset to beginning, so race is not completed
                    drawMaze(ctx, track, tilePx, performance.now(), true);
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
        // include dims setter dependency to silence lint (but function identity stable)
    }, [track, log, speed, playing]); // playing removed to avoid reset


    // Derive improvement label from training stats and toggles
    const { improvementLabel, sessions } = (() => {
        const stats = trackTrainingStats?.stats;
        const active = showTraining ? stats?.solo : showPvp ? stats?.pvp : undefined;
        if (!active) return { improvementLabel: '', sessions: 0 };
        const first = active.first_time;
        const fastest = active.fastest;
        if (!first || first === 0 || !fastest || fastest === 0 || fastest > first) return { improvementLabel: '', sessions: 0 };
        const improvement = Math.round(((first - fastest) / first) * 100);
        const sessions = active.tally;

        return {
            improvementLabel: `${improvement}% faster in ${sessions} training sessions`,
            sessions: sessions
        };
    })();

    // if (!track || !log) {
    //     return (
    //         <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'linear-gradient(180deg, #05070f 0%, #0b0e17 100%)', color: '#fff', fontFamily: '"Press Start 2P", monospace' }}>
    //             <div style={{ fontSize: 24, marginBottom: 20, color: '#00ffea' }}>RACE VIEWER</div>
    //             <div style={{ fontSize: 14, color: '#b8c1ff', textAlign: 'center', maxWidth: 400 }}>
    //                 Select a race from the dropdown above to view the race replay.<br />
    //                 Connect your wallet to see your cars and their recent races.
    //             </div>
    //         </div>
    //     );
    // }
    // return <p>Error loading race data.</p>;

    const togglePlay = () => {
        // If we're at the end of the race and clicking start, restart first
        if (!playing && log && tickRef.current >= log.length - 1) {
            // Replay the race first
            replay();
            // Then start playing
            setPlaying(true);
        } else {
            setPlaying(p => !p);
        }
    };

    const replay = () => {
        // Dispatch KeyR event to trigger the proper replay logic
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    };

    const scrollToLeaderboard = () => {
        if (leaderboardRef.current) {
            leaderboardRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    };

    // Function to trigger confetti
    const triggerConfetti = () => {
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 3000); // Hide after 3 seconds
    };

    // Function to show the latest race
    const showLatestRace = () => {
        // Add a small delay to ensure queries are refreshed
        setTimeout(() => {
            if (carRecentRaces && carRecentRaces.length > 0) {
                const latest = carRecentRaces[carRecentRaces.length - 1];
                setSelectedRace(latest);
                setSelectedTrackId(latest.track_id);
                // Reset race playback to beginning and start playing
                if (tickRef.current) {
                    tickRef.current = 0;
                    setTickDisplay(0);
                }
                // Start playing the new race after successful RunRace transaction
                setPlaying(true);

                // Trigger confetti if in maze mode
                if (isMazeMode) {
                    triggerConfetti();
                }

                // Manually refetch training stats and top times to ensure fresh data
                setTimeout(() => {
                    console.log("Manually refetching training stats and top times");
                    refetchTrainingStats();
                    refetchTopTimes();
                }, 1000); // Additional delay to ensure blockchain state is updated
            }
        }, 500); // 500ms delay to allow queries to refresh
    };

    const scaledW = dims.rawW * dims.scale;
    const scaledH = dims.rawH * dims.scale;

    const runRace = useRunRace({
        trackId: selectedTrackId,
        carIds: selectedCarId ? [selectedCarId] : [],
        train: showTraining,
        pvp: showPvp,
        onSuccess: showLatestRace,
        // Advanced training parameters - only enabled when advanced section is expanded
        advanced: showAdvancedParams,
        explorationRate: showAdvancedParams ? explorationRate : 0.3,
        enableDecay: true
    });

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'stretch', minHeight: '100vh', background: 'linear-gradient(180deg, #05070f 0%, #0b0e17 100%)' }}>

            {isLoading && (
                <div style={{ padding: '8px 18px', color: '#b8c1ff', fontFamily: '"Press Start 2P", monospace', fontSize: 10 }}>
                    Loading…
                </div>
            )}

            {/* Race Mode Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '2px solid #0033ff', background: '#0a0f1e' }}>
                <div style={{
                    fontFamily: '"Press Start 2P", monospace',
                    fontSize: 16,
                    color: isMazeMode ? '#8b5cf6' : '#00ffea',
                    letterSpacing: 1
                }}>
                    {isMazeMode ? 'MAZE MINT MODE' : 'RACE MODE'}
                </div>
                {/* Test confetti button */}
                {TEST_CONFETTI && (
                    <button
                        onClick={triggerConfetti}
                        style={{
                            padding: '8px 16px',
                            background: '#d946ef',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: '10px'
                        }}
                    >
                        Test Confetti
                    </button>
                )}
            </div>

            {/* Primary Controls - Responsive Layout */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e' }}>
                <div className="race-controls-container">
                    {/* Left: Car, Track, Mode dropdowns */}
                    <div className="race-controls-dropdowns">
                        {/* Car Selection */}
                        <div className="race-control-item">
                            <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff' }}>CAR:</label>
                            <select
                                value={selectedCarId}
                                onChange={(e) => setSelectedCarId(e.target.value)}
                                disabled={isLoadingCars}
                                className="race-control-select"
                                style={{
                                    background: '#0a0f1e',
                                    color: '#fff',
                                    border: '2px solid #0033ff',
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: 10,
                                    padding: '6px 8px',
                                    boxShadow: '0 0 8px #0033ff inset',
                                    minWidth: '120px',
                                    opacity: isLoadingCars ? 0.6 : 1,
                                    minHeight: '44px'
                                }}>
                                <option value="">
                                    {isLoadingCars ? 'Loading cars...' : 'Select Car'}
                                </option>
                                {ownedCars && ownedCars.length > 0 ? (
                                    ownedCars.map((car: { id: string; name?: string | null }) => (
                                        <option key={car.id} value={car.id} style={{ background: '#0a0f1e', color: '#fff' }}>
                                            {car.name ?? car.id}
                                        </option>
                                    ))
                                ) : (
                                    !isLoadingCars && (
                                        <option value="" disabled style={{ background: '#0a0f1e', color: '#666' }}>
                                            No cars found
                                        </option>
                                    )
                                )}
                            </select>
                        </div>

                        {/* Track Selector */}
                        <div className="race-control-item">
                            <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff' }}>TRACK:</label>
                            <select
                                value={selectedTrackId || ''}
                                onChange={(e) => setSelectedTrackId(e.target.value || undefined)}
                                className="race-control-select"
                                style={{
                                    background: '#0a0f1e',
                                    color: '#fff',
                                    border: '2px solid #0033ff',
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: 10,
                                    padding: '6px 8px',
                                    boxShadow: '0 0 8px #0033ff inset',
                                    minWidth: '150px',
                                    minHeight: '44px'
                                }}>
                                <option value="">Select Track</option>
                                {filteredTracks?.map((t: any) => (
                                    <option key={t.id} value={t.id} style={{ background: '#0a0f1e', color: '#fff' }}>
                                        {t.name || `Track ${t.id}`}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Mode Dropdown - Training or Showcase */}
                        <div className="race-control-item">
                            <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff' }}>MODE:</label>
                            <select
                                value={showTraining ? 'training' : 'showcase'}
                                onChange={(e) => {
                                    const mode = e.target.value;
                                    const newShowTraining = mode === 'training';

                                    console.log('RaceViewer: Mode dropdown onChange triggered', {
                                        mode,
                                        currentShowTraining: showTraining,
                                        willSetTo: newShowTraining
                                    });

                                    // Only update if the value is actually changing
                                    if (newShowTraining !== showTraining) {
                                        setShowTraining(newShowTraining);
                                    } else {
                                        console.log('RaceViewer: Mode dropdown onChange ignored - no change needed');
                                    }

                                    // Auto-select first available track when switching to showcase mode
                                    if (newShowTraining !== showTraining && mode === 'showcase' && availableTracks && availableTracks.length > 0) {
                                        const pvpTracks = availableTracks.filter((t: any) => (t?.starting_tiles?.length ?? 0) > 1);
                                        if (pvpTracks.length > 0) {
                                            const firstPvpTrack = pvpTracks[0];
                                            if (firstPvpTrack && firstPvpTrack.id != null) {
                                                const tid = String(firstPvpTrack.id);
                                                setSelectedTrackId(tid);
                                                updateRouteQuery({ trackId: tid });
                                            }
                                        }
                                    }
                                }}
                                className="race-control-select"
                                style={{
                                    background: '#0a0f1e',
                                    color: '#fff',
                                    border: '2px solid #0033ff',
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: 10,
                                    padding: '6px 8px',
                                    boxShadow: '0 0 8px #0033ff inset',
                                    minWidth: '120px',
                                    minHeight: '44px'
                                }}>
                                <option value="training">Training</option>
                                <option value="showcase">Showcase</option>
                            </select>
                        </div>

                        {/* PvP Toggle - Temporarily disabled for v1 (table PvP until v2) */}
                        {false && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '10px', color: '#b8c1ff' }}>
                                    <input
                                        type="checkbox"
                                        checked={showPvp}
                                        onChange={(e) => {
                                            const newPvpState = e.target.checked;
                                            setShowPvp(newPvpState);

                                            // Auto-select first PvP track when PvP is toggled on
                                            if (newPvpState && availableTracks && availableTracks.length > 0) {
                                                const pvpTracks = availableTracks.filter((t: any) => (t?.starting_tiles?.length ?? 0) > 1);
                                                if (pvpTracks.length > 0) {
                                                    // Check if current selection is already a PvP track
                                                    const currentTrackIsPvp = selectedTrackId && pvpTracks.some((t: any) => String(t.id) === selectedTrackId);

                                                    // Only auto-select if current selection is not a PvP track
                                                    if (!currentTrackIsPvp) {
                                                        const firstPvpTrack = pvpTracks[0];
                                                        if (firstPvpTrack && firstPvpTrack.id != null) {
                                                            const tid = String(firstPvpTrack.id);
                                                            setSelectedTrackId(tid);
                                                            updateRouteQuery({ trackId: tid });
                                                        }
                                                    }
                                                }
                                            }
                                        }}
                                    /> PvP
                                </label>
                            </div>
                        )}

                        {!address && (
                            <div style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#ff6b6b' }}>
                                Connect wallet to view your cars
                            </div>
                        )}
                        {carsError && (
                            <div style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#ff6b6b' }}>
                                Error loading cars: {carsError.message}
                            </div>
                        )}
                    </div>

                    {/* Right: Run Race Button */}
                    <div className="race-controls-button">
                        <ConfirmModal
                            executeDirectly={true}
                            label={isMazeMode ? "Traverse" : "Run Race"}
                            action={runRace.action}
                            isDisabled={!selectedTrackId || !selectedCarId || racingState.energy < 10 || filteredTracks.length === 0}
                            isLoading={runRace.action.simulate.isPending || runRace.action.tx.isPending}
                            buttonProps={{
                                colorScheme: 'blue',
                                bg: '#274bff',
                                _hover: { bg: '#1f3bd9' },
                                fontFamily: '"Press Start 2P", monospace',
                                fontSize: { base: '12px', md: '14px' },
                                padding: { base: '12px 16px', md: '12px 24px' },
                                fontWeight: 'bold',
                                boxShadow: '0 0 12px #0033ff',
                                minH: { base: '44px', md: 'auto' },
                                w: { base: '100%', md: 'auto' }
                            }}
                        />
                    </div>
                </div>
            </div>



            {/* Stats Panel - Compact, Always Visible */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: '"Press Start 2P", monospace', fontSize: 10 }}>
                    {/* Performance Stats - Always show track-specific improvement */}
                    <div style={{ color: '#b8c1ff' }}>
                        Performance: {(() => {
                            const stats = trackTrainingStats?.stats;
                            // Always show training stats for the selected car + track, regardless of mode
                            const trainingStats = stats?.solo;
                            if (!trainingStats) return 'N/A';
                            const first = trainingStats.first_time;
                            const fastest = trainingStats.fastest;
                            if (!first || first === 0 || !fastest || fastest === 0 || fastest > first) return 'N/A';
                            const improvement = Math.round(((first - fastest) / first) * 100);
                            return `+${improvement}% (${trainingStats.tally} sessions)`;
                        })()}
                    </div>

                    {/* Current Run Stats */}
                    <div style={{ color: '#b8c1ff' }}>
                        Current Run: {tickDisplay}/{Math.max(0, (log?.length ?? 0) - 1)} ticks | Fastest Possible: {(() => {
                            if (availableTracks && selectedTrackId) {
                                const selectedTrack = availableTracks.find((t: any) => t.id === selectedTrackId);
                                if (selectedTrack?.starting_tiles && selectedTrack.starting_tiles.length > 0) {
                                    return Math.min(...selectedTrack.starting_tiles.map((tile: any) => tile.progress_towards_finish));
                                }
                            }
                            return 'N/A';
                        })()}
                    </div>
                </div>
            </div>

            {/* Info Section - Collapsible, Starts Collapsed */}
            <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550' }}>
                {/* Race Controls Section */}
                <div style={{ opacity: hasRaceData ? 1 : 0.5 }}>
                    <div
                        onClick={() => setShowControls(!showControls)}
                        style={{
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            color: '#00ffea',
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: 12,
                            padding: '16px 16px 12px 16px',
                            userSelect: 'none',
                            transition: 'color 0.2s ease'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#00ffff'}
                        onMouseLeave={(e) => e.currentTarget.style.color = '#00ffea'}
                    >
                        <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: showControls ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                        <span>RACE CONTROLS</span>
                    </div>
                    {showControls && (
                        <div style={{ padding: '0 16px 16px 16px' }}>
                            <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                                <button
                                    onClick={togglePlay}
                                    style={{ padding: '10px 18px', background: playing ? '#ff2d2d' : '#274bff', color: '#fff', border: '2px solid #0033ff', cursor: 'pointer', boxShadow: '0 0 8px #0033ff', letterSpacing: 1 }}>
                                    {playing ? 'PAUSE' : 'START'}
                                </button>
                                <button
                                    onClick={replay}
                                    style={{ padding: '10px 18px', background: '#274bff', color: '#fff', border: '2px solid #0033ff', cursor: 'pointer', boxShadow: '0 0 8px #0033ff', letterSpacing: 1 }}>
                                    REPLAY
                                </button>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    Speed:
                                    <select
                                        value={speed}
                                        onChange={e => setSpeed(parseFloat(e.target.value))}
                                        style={{ background: '#0a0f1e', color: '#fff', border: '2px solid #0033ff', fontFamily: 'inherit', fontSize: 12, padding: '6px 8px', boxShadow: '0 0 8px #0033ff inset' }}>
                                        {[0.25, 0.5, 1, 2, 4].map((s: number) => (
                                            <option key={s} value={s} style={{ background: '#0a0f1e', color: '#fff' }}>{s}x</option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                        </div>
                    )}
                </div>

                {/* Tile Legend Section */}
                <div style={{ opacity: hasPreview ? 1 : 0.5 }}>
                    <div
                        onClick={() => setShowLegend(!showLegend)}
                        style={{
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            color: '#00ffea',
                            fontFamily: '"Press Start 2P", monospace',
                            fontSize: 12,
                            padding: '16px 16px 12px 16px',
                            userSelect: 'none',
                            transition: 'color 0.2s ease'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#00ffff'}
                        onMouseLeave={(e) => e.currentTarget.style.color = '#00ffea'}
                    >
                        <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: showLegend ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                        <span>TILE LEGEND</span>
                    </div>
                    {showLegend && (
                        <div style={{ padding: '0 16px 16px 16px' }}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: WALL, display: 'inline-block', border: '1px solid #2a3550' }} /> Wall</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: START, display: 'inline-block', border: '1px solid #2a3550' }} /> Start</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: FINISH, display: 'inline-block', border: '1px solid #2a3550' }} /> Finish</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: STUCK, display: 'inline-block', border: '1px solid #2a3550' }} /> Sticky</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: BOOST, display: 'inline-block', border: '1px solid #2a3550' }} /> Boost</span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: 'transparent', display: 'inline-block', border: '2px solid #ff0000' }} /> Collision</span>
                            </div>
                        </div>
                    )}
                    {/* Advanced Training Parameters - Collapsible, only visible when Training mode is selected */}
                    {showTraining && (
                        <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550' }}>
                            <div
                                onClick={() => setShowAdvancedParams(!showAdvancedParams)}
                                style={{
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    color: '#00ffea',
                                    fontFamily: '"Press Start 2P", monospace',
                                    fontSize: 12,
                                    padding: '16px 16px 12px 16px',
                                    userSelect: 'none',
                                    transition: 'color 0.2s ease'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.color = '#00ffff'}
                                onMouseLeave={(e) => e.currentTarget.style.color = '#00ffea'}
                            >
                                <span style={{ fontSize: 14, transition: 'transform 0.2s ease', transform: showAdvancedParams ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                                <span>ADVANCED TRAINING PARAMETERS</span>
                            </div>
                            {showAdvancedParams && (
                                <div style={{ padding: '0 16px 16px 16px' }}>
                                    <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
                                        {/* Exploration Rate Slider */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <label style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff', minWidth: '120px' }}>
                                                Exploration Rate: {Math.round(explorationRate * 100)}%
                                            </label>
                                            <input
                                                type="range"
                                                min="0"
                                                max="1"
                                                step="0.05"
                                                value={explorationRate}
                                                onChange={(e) => setExplorationRate(parseFloat(e.target.value))}
                                                style={{
                                                    width: '120px',
                                                    height: '6px',
                                                    background: '#0033ff',
                                                    outline: 'none',
                                                    borderRadius: '3px'
                                                }}
                                            />
                                        </div>

                                        {/* Decay Checkbox */}
                                        {/* <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '10px', color: '#b8c1ff' }}>
                                            <input
                                                type="checkbox"
                                                checked={enableDecay}
                                                onChange={(e) => setEnableDecay(e.target.checked)}
                                            /> Enable Exploration Decay
                                        </label> */}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>



            {/* Car Rank Display */}
            {(() => {
                if (selectedCarId && topTimes) {
                    const carRank = topTimes.findIndex(t => t.car_id === selectedCarId);
                    return (
                        <div style={{ background: '#0a0f1e', width: '100%', display: 'flex', justifyContent: 'center' }}>
                            <div style={{ padding: '12px 18px', background: '#0a0f1e' }}>
                                <div
                                    onClick={scrollToLeaderboard}
                                    style={{
                                        color: '#00ffea',
                                        fontSize: 16,
                                        fontWeight: 'bold',
                                        padding: '8px 12px',
                                        background: 'rgba(0, 255, 234, 0.1)',
                                        border: '1px solid #00ffea',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s ease',
                                        display: 'inline-block'
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = 'rgba(0, 255, 234, 0.2)';
                                        e.currentTarget.style.transform = 'scale(1.05)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = 'rgba(0, 255, 234, 0.1)';
                                        e.currentTarget.style.transform = 'scale(1)';
                                    }}
                                >
                                    Rank {carRank !== -1 ? carRank + 1 : "N/A"}
                                </div>
                            </div>
                        </div>
                    );
                }
                return null;
            })()}

            {/* Game Boy Controller Icon */}
            {hasRaceData && (
                <>
                    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, background: '#0a0f1e' }}>
                        <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff" pt="0.5%">
                            Action: {tickDisplay}/{Math.max(0, (log?.length ?? 0) - 1)} | Fastest Possible: {(() => {
                                if (availableTracks && selectedTrackId) {
                                    const selectedTrack = availableTracks.find((t: any) => t.id === selectedTrackId);
                                    if (selectedTrack?.starting_tiles && selectedTrack.starting_tiles.length > 0) {
                                        return Math.min(...selectedTrack.starting_tiles.map((tile: any) => tile.progress_towards_finish));
                                    }
                                }
                                return 'N/A';
                            })()}
                        </Text>
                    </div>
                    <div style={{ opacity: hasPreview ? 1 : 0.5, display: 'flex', justifyContent: 'center', padding: '16px 0', background: '#0a0f1e' }}>
                        <div className="gameboy-controller">
                            {/* D-pad */}
                            <div className="gameboy-dpad">
                                {/* Up button */}
                                <div style={{
                                    gridColumn: '2',
                                    gridRow: '1',
                                    width: '100%',
                                    height: '100%',
                                    background: lastActionDisplay === 'Up' ? '#00ff00' : '#666',
                                    borderRadius: '4px',
                                    border: '2px solid #333',
                                    boxShadow: lastActionDisplay === 'Up' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                                    transition: 'all 0.2s ease'
                                }} />

                                {/* Left button */}
                                <div style={{
                                    gridColumn: '1',
                                    gridRow: '2',
                                    width: '100%',
                                    height: '100%',
                                    background: lastActionDisplay === 'Left' ? '#00ff00' : '#666',
                                    borderRadius: '4px',
                                    border: '2px solid #333',
                                    boxShadow: lastActionDisplay === 'Left' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                                    transition: 'all 0.2s ease'
                                }} />

                                {/* Center (not a button) */}
                                <div style={{
                                    gridColumn: '2',
                                    gridRow: '2',
                                    width: '100%',
                                    height: '100%',
                                    background: '#444',
                                    borderRadius: '4px',
                                    border: '2px solid #333'
                                }} />

                                {/* Right button */}
                                <div style={{
                                    gridColumn: '3',
                                    gridRow: '2',
                                    width: '100%',
                                    height: '100%',
                                    background: lastActionDisplay === 'Right' ? '#00ff00' : '#666',
                                    borderRadius: '4px',
                                    border: '2px solid #333',
                                    boxShadow: lastActionDisplay === 'Right' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                                    transition: 'all 0.2s ease'
                                }} />

                                {/* Down button */}
                                <div style={{
                                    gridColumn: '2',
                                    gridRow: '3',
                                    width: '100%',
                                    height: '100%',
                                    background: lastActionDisplay === 'Down' ? '#00ff00' : '#666',
                                    borderRadius: '4px',
                                    border: '2px solid #333',
                                    boxShadow: lastActionDisplay === 'Down' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                                    transition: 'all 0.2s ease'
                                }} />
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* Keyboard Shortcuts Help */}
            <div style={{ padding: '8px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e', opacity: 0.8 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontFamily: '"Press Start 2P", monospace', fontSize: 8, color: '#b8c1ff' }}>
                    <span>Keyboard: <span style={{ color: '#fff' }}>SPACE</span> Play/Pause | <span style={{ color: '#fff' }}>R</span> Reset | <span style={{ color: '#fff' }}>←→</span> Step </span>
                </div>
            </div>

            {/* Race Canvas */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 24 }}>
                {hasPreview ? <div style={{
                    position: 'relative',
                    width: scaledW,
                    height: scaledH,
                    boxShadow: '0 0 18px #00ffea, inset 0 0 28px rgba(0, 255, 234, 0.15)',
                    background: 'radial-gradient(ellipse at center, rgba(0,20,40,0.6) 0%, rgba(0,0,0,0.9) 70%)',
                    overflow: 'hidden'
                }}>
                    <div style={{ position: 'absolute', inset: 0, backgroundSize: '12px 12px', backgroundImage: 'linear-gradient(rgba(0, 51, 255, 0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 51, 255, 0.07) 1px, transparent 1px)' }} />
                    <canvas ref={canvasRef} style={{ position: 'relative', border: '0', width: scaledW, height: scaledH }} />
                    <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 3px, transparent 4px)', pointerEvents: 'none' }} />
                </div> :
                    <Text opacity={0.5} color="white" fontFamily="Press Start 2P" fontSize="12px">
                        {selectedTrackId ? 'Select a car and run a race to see the playback' : 'Select a track to view'}
                    </Text>
                }
            </div>

            {/* Leaderboard */}
            {selectedTrackId && (
                <div ref={leaderboardRef} style={{ padding: '20px 24px', borderTop: '1px solid #2a3550', background: '#0a0f1e' }}>
                    <div style={{ fontFamily: '"Press Start 2P", monospace', fontSize: window.innerWidth < 768 ? 12 : 16, color: '#00ffea', marginBottom: 16 }}>
                        Leaderboard (Top Times)
                    </div>
                    <div className="leaderboard-container">
                        {/* Header */}
                        <div className="leaderboard-header">
                            <div className="leaderboard-header-rank">Rank</div>
                            <div className="leaderboard-header-name">Car Name</div>
                            <div className="leaderboard-header-time">Time (ticks)</div>
                        </div>
                        {/* Entries */}
                        {(topTimes ?? []).map((t, idx) => {
                            const isOwned = ownedCars?.some(car => car.id === t.car_id) || false;
                            return (
                                <div key={`${t.car_id}-${idx}`} className="leaderboard-entry">
                                    <div className="leaderboard-rank">{idx + 1}</div>
                                    <div className="leaderboard-name">
                                        <CarNameDisplay carId={t.car_id} isOwned={isOwned} />
                                    </div>
                                    <div className="leaderboard-time">{t.time}</div>
                                </div>
                            );
                        })}
                        {(!topTimes || topTimes.length === 0) && (
                            <div className="leaderboard-empty">No times yet.</div>
                        )}
                    </div>
                </div>
            )}

            {/* Confetti Canvas */}
            {showConfetti && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    width: '100vw',
                    height: '100vh',
                    pointerEvents: 'none',
                    zIndex: 9999
                }}>
                    <canvas
                        ref={confettiCanvasRef}
                        width={window.innerWidth}
                        height={window.innerHeight}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0
                        }}
                    />
                </div>
            )}
        </div>
    );
};

export default RaceViewer; 