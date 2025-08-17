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
    const [tickDisplay, setTickDisplay] = useState(0);
    const [leaderDisplay, setLeaderDisplay] = useState<string>('');

    /** Draw the static maze */
    const drawMaze = (ctx: CanvasRenderingContext2D, t: Track, tilePx: number, timeMs: number) => {
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
                    const phase = Math.floor(timeMs / 300); // toggle ~3Hz
                    for (let cy = 0; cy < tilePx; cy += size) {
                        for (let cx = 0; cx < tilePx; cx += size) {
                            const idx = ((cx + cy) / size) | 0;
                            const flash = Math.sin(timeMs * 0.005 + idx) > 0;
                            ctx.fillStyle = flash ? FINISH : BG;
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
            // Determine leader for display
            let leaderId: string | null = null;
            let maxProg = -1;
            cars.forEach((c, id) => {
                const prog = c.x + c.y * cols;
                if (prog > maxProg) { maxProg = prog; leaderId = id; }
            });
            setLeaderDisplay(leaderId ?? '');
            setTickDisplay(tickRef.current);
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
            drawMaze(ctx, track, tilePx, now);
            drawCars();
            raf = requestAnimationFrame(renderFrame);
        };

        // initial draw
        updateCars();
        const startNow = performance.now();
        drawMaze(ctx, track, tilePx, startNow);
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
                    drawMaze(ctx, track, tilePx, performance.now());
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

    const scaledW = dims.rawW * dims.scale;
    const scaledH = dims.rawH * dims.scale;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'stretch', height: '100vh', background: 'linear-gradient(180deg, #05070f 0%, #0b0e17 100%)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '2px solid #0033ff', background: '#0a0f1e' }}>
                <div style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 16, color: '#00ffea', letterSpacing: 1 }}>RACE MODE</div>
                <div style={{ display: 'flex', gap: 16, fontFamily: '"Press Start 2P", monospace', fontSize: 12, color: '#b8c1ff' }}>
                    <span>Tick: <span style={{ color: '#fff' }}>{tickDisplay}</span></span>
                    <span>Leader: <span style={{ color: '#fff' }}>{leaderDisplay}</span></span>
                </div>
            </div>

            <div style={{ padding: 16, display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                <button
                    onClick={togglePlay}
                    style={{ padding: '10px 18px', background: playing ? '#ff2d2d' : '#274bff', color: '#fff', border: '2px solid #0033ff', cursor: 'pointer', boxShadow: '0 0 8px #0033ff', letterSpacing: 1 }}>
                    {playing ? 'PAUSE' : 'START'}
                </button>
                <button
                    onClick={restart}
                    style={{ padding: '10px 18px', background: '#274bff', color: '#fff', border: '2px solid #0033ff', cursor: 'pointer', boxShadow: '0 0 8px #0033ff', letterSpacing: 1 }}>
                    RESTART
                </button>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    Speed:
                    <select
                        value={speed}
                        onChange={e => setSpeed(parseFloat(e.target.value))}
                        style={{ background: '#0a0f1e', color: '#fff', border: '2px solid #0033ff', fontFamily: 'inherit', fontSize: 12, padding: '6px 8px', boxShadow: '0 0 8px #0033ff inset' }}>
                        {[0.25, 0.5, 1, 2, 4].map(s => (
                            <option key={s} value={s} style={{ background: '#0a0f1e', color: '#fff' }}>{s}x</option>
                        ))}
                    </select>
                </label>
                <div style={{ marginLeft: 24, display: 'flex', gap: 14, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>Legend:</span>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: WALL, display: 'inline-block', border: '1px solid #2a3550' }} /> Wall</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: START, display: 'inline-block', border: '1px solid #2a3550' }} /> Start</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: FINISH, display: 'inline-block', border: '1px solid #2a3550' }} /> Finish</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: STUCK, display: 'inline-block', border: '1px solid #2a3550' }} /> Sticky</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 12, background: BOOST, display: 'inline-block', border: '1px solid #2a3550' }} /> Boost</span>
                    </div>
                </div>
            </div>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 24 }}>
                <div style={{
                    position: 'relative',
                    width: scaledW,
                    height: scaledH,
                    // border: '3px solid #00ffea',
                    boxShadow: '0 0 18px #00ffea, inset 0 0 28px rgba(0, 255, 234, 0.15)',
                    background: 'radial-gradient(ellipse at center, rgba(0,20,40,0.6) 0%, rgba(0,0,0,0.9) 70%)',
                    overflow: 'hidden'
                }}>
                    <div style={{ position: 'absolute', inset: 0, backgroundSize: '12px 12px', backgroundImage: 'linear-gradient(rgba(0, 51, 255, 0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 51, 255, 0.07) 1px, transparent 1px)' }} />
                    <canvas ref={canvasRef} style={{ position: 'relative', border: '0', width: scaledW, height: scaledH }} />
                    <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 3px, transparent 4px)', pointerEvents: 'none' }} />
                </div>
            </div>
        </div>
    );
};

export default RaceViewer; 