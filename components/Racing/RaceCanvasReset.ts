import React, { useEffect } from 'react';
import { JsonRaceResult } from '@/services/q-racing';

type CarState = {
    x: number;
    y: number;
    color: string;
    lastValidRenderX?: number;
    lastValidRenderY?: number;
    hit_wall?: boolean;
    path: Array<{ x: number, y: number }>;
    hasReachedFinish?: boolean;
};

interface UseRaceCanvasResetParams {
    playing: boolean;
    playingRef: React.MutableRefObject<boolean>;
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
    setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
    tickRef: React.MutableRefObject<number>;
    setTickDisplay: React.Dispatch<React.SetStateAction<number>>;
    carsRef: React.MutableRefObject<Map<string, CarState>>;
    setSelectedRace: React.Dispatch<React.SetStateAction<JsonRaceResult | null>>;
    selectedTrackId: string | undefined;
}

// Extracted verbatim from RaceViewer: mirrors `playing` into a ref for the
// animation loop, and resets canvas + race state whenever the track changes.
// Behaviour-identical relocation (effect order preserved).
export default function useRaceCanvasReset({
    playing,
    playingRef,
    canvasRef,
    setPlaying,
    tickRef,
    setTickDisplay,
    carsRef,
    setSelectedRace,
    selectedTrackId,
}: UseRaceCanvasResetParams) {
    // keep ref in sync with state so animation loop reads latest value
    useEffect(() => { playingRef.current = playing; }, [playing, playingRef]);

    // Reset canvas and race state when track changes
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Clear the canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Reset race state
        setPlaying(false);
        playingRef.current = false;
        tickRef.current = 0;
        setTickDisplay(0);

        // Clear car paths and reset car state
        carsRef.current.forEach((car) => {
            car.path = [];
            car.hasReachedFinish = false;
            car.lastValidRenderX = undefined;
            car.lastValidRenderY = undefined;
            car.hit_wall = false as any;
        });

        // Clear selected race when track changes
        setSelectedRace(null);
        // Only `selectedTrackId` drives this reset; every other dep is a stable ref/setter,
        // so listing them keeps exhaustive-deps happy without changing when the reset fires
        // (never resets canvas/game state mid-play on an unrelated re-render).
    }, [selectedTrackId, canvasRef, setPlaying, playingRef, tickRef, setTickDisplay, carsRef, setSelectedRace]);
}
