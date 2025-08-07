import React, { useEffect, useRef, useState } from 'react';
import { useQRacing } from '../../hooks/useQRacing';
import { Track, PlayByPlayEntry } from '../../services/q-racing';

const BASE_TILE = 24;
const WALL = '#0033ff';
const BG = '#000';

const FINISH = '#00ff00';
const PALETTE = ['#ffff00', '#ff0000', '#00ffff', '#ff00ff', '#ff8000', '#00ff00', '#8000ff', '#ffffff'];
// tile colours
const START = '#00aa00';
const STUCK = '#555555';
const BOOST = '#ffdd00';

interface Props {
    trackId?: string;
    raceId?: string;
}

const RaceViewer: React.FC<Props> = ({ trackId = 'sample', raceId = 'sample' }) => {
    const { track, log, isLoading } = useQRacing(trackId, raceId);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [playing, setPlaying] = useState(true);
    const playingRef = useRef(true);
    const [dims, setDims] = useState({ scale: 1, rawW: 0, rawH: 0 });
    const [speed, setSpeed] = useState(1); // 1 tick per second baseline

    /** Draw the static maze */
    const drawMaze = (ctx: CanvasRenderingContext2D, t: Track, tilePx: number) => {
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
                    for (let cy = 0; cy < tilePx; cy += size) {
                        for (let cx = 0; cx < tilePx; cx += size) {
                            const idx = ((cx + cy) / size) | 0;
                            ctx.fillStyle = idx % 2 ? FINISH : BG;
                            ctx.fillRect(px + cx, py + cy, size, size);
                        }
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
        if (!track || !log) return;
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
        const cars = new Map<string, { x: number; y: number; color: string; flash: number }>();
        Object.keys(log[0].positions).forEach((id, i) => {
            cars.set(id, { x: 0, y: 0, color: PALETTE[i % PALETTE.length], flash: 0 });
        });
        const tickRef = { current: 0 } as { current: number };
        let raf = 0;

        const updateCars = () => {
            const entry = log[tickRef.current];
            if (!entry) return;
            Object.entries(entry.positions).forEach(([id, [x, y]]) => {
                const car = cars.get(id);
                if (car) {
                    car.x = x;
                    car.y = y;
                    if (track[y] && track[y][x] === 'F' && car.flash === 0) car.flash = 18;
                }
            });
        };

        const drawCars = () => {
            cars.forEach((c, id) => {
                const px = c.x * tilePx + tilePx / 2;
                const py = c.y * tilePx + tilePx / 2;
                ctx.beginPath();
                ctx.arc(px, py, tilePx / 3, 0, Math.PI * 2);
                ctx.fillStyle = c.flash-- > 0 ? '#ffff00' : c.color;
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = '8px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(id, px, py + 2);
            });
        };

        const tickInterval = 1000 / speed;
        let last = performance.now();

        const renderFrame = (now: number) => {
            if (playingRef.current && now - last >= tickInterval) {
                if (tickRef.current < log.length - 1) {
                    tickRef.current += 1;
                    updateCars();
                }
                last = now;
            }
            drawMaze(ctx, track, tilePx);
            drawCars();
            raf = requestAnimationFrame(renderFrame);
        };

        // initial draw
        updateCars();
        drawMaze(ctx, track, tilePx);
        drawCars();
        raf = requestAnimationFrame(renderFrame);

        // controls
        const handler = (e: KeyboardEvent) => {
            switch (e.code) {
                case 'Space':
                    setPlaying(p => !p);
                    break;
                case 'ArrowRight':
                    if (!playingRef.current && tickRef.current < log.length - 1) { tickRef.current++; updateCars(); }
                    break;
                case 'ArrowLeft':
                    if (!playingRef.current && tickRef.current > 0) { tickRef.current--; updateCars(); }
                    break;
                case 'KeyR':
                    tickRef.current = 0;
                    updateCars();
                    drawMaze(ctx, track, tilePx);
                    drawCars();
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
    }, [track, log, speed]); // playing removed to avoid reset

    if (isLoading) return <p>Loading…</p>;
    if (!track || !log) return <p>Error loading race data.</p>;

    const togglePlay = () => setPlaying(p => !p);
    const restart = () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
            <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
                <button onClick={togglePlay} style={{ marginRight: 8 }}>{playing ? 'Pause' : 'Start'}</button>
                <button onClick={restart}>Restart</button>
                <label style={{ color: '#fff' }}>
                    Speed:&nbsp;
                    <select value={speed} onChange={e => setSpeed(parseFloat(e.target.value))}>
                        {[0.25, 0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}x</option>)}
                    </select>
                </label>
            </div>
            <canvas ref={canvasRef} style={{ border: '2px solid #0033ff', width: dims.rawW * dims.scale, height: dims.rawH * dims.scale }} />
        </div>
    );
};

export default RaceViewer; 