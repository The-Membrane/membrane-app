import React, { useMemo, useRef, useState } from 'react';
import { useRecentRacesForCar, useOwnedCars, useQRacing, useTopTimes } from '../../hooks/useQRacing';
import { JsonRaceResult, useTrackTrainingStats, useListTracks, useValidMazeId, useSecondsUntilOpen, useTopTimesWithSessions, useCarQTable } from '../../services/q-racing';
import useWallet from '../../hooks/useWallet';
import { useRouter } from 'next/router';
import useAppState from '@/persisted-state/useAppState';
import useRunRace from '@/components/Racing/hooks/useRunRace';
import useRacingState from './hooks/useRacingState';
import useRacingCampaign, { CampaignStepModal } from '@/persisted-state/useRacingCampaign';
import CampaignModal from '@/components/Racing/CampaignModal';
import DialogueBox from '@/components/Racing/DialogueBox';
import useCarSpriteImages from './hooks/useCarSpriteImages';
import useConfetti from './hooks/useConfetti';
import useTrackIq from './hooks/useTrackIq';
import useRaceAnimation from './hooks/useRaceAnimation';
import useRaceRouteQuery from './RaceRouteQuery';
import useRaceCampaignSync from './RaceCampaignSync';
import useRaceSelection from './RaceSelection';
import useRaceCanvasReset from './RaceCanvasReset';
import useRaceViewerActions from './RaceViewerActions';
import useRaceCampaignCompletion from './RaceCampaignCompletion';
import useRaceDerived from './RaceDerived';
import RaceHeader from './RaceHeader';
import RaceControlDropdowns from './RaceControlDropdowns';
import RaceRunControls from './RaceRunControls';
import RaceStatsPanel from './RaceStatsPanel';
import RacePlaybackControls from './RacePlaybackControls';
import RaceTileLegend from './RaceTileLegend';
import RaceCarRank from './RaceCarRank';
import RaceActionPad from './RaceActionPad';
import RaceCanvas from './RaceCanvas';
import RaceLeaderboard from './RaceLeaderboard';
import RaceConfettiOverlay from './RaceConfettiOverlay';

interface Props {
    trackId?: string;
}

//track id 3 is the Tiny Straight Track
const RaceViewer: React.FC<Props> = () => {
    const router = useRouter();
    const { racingState, setRacingState } = useRacingState();
    const { appState } = useAppState();
    const { address } = useWallet();
    const { data: ownedCars, isLoading: isLoadingCars, error: carsError } = useOwnedCars(address);
    const { config, progress, setConfig, startCampaign, endCampaign, nextTrack, incrementRaceCount, incrementRaceCountForTrack, setShowcaseMode, applyUnlocks, setAutoStartEnabled, markCampaignCompleted } = useRacingCampaign();

    // Load car sprite images
    const { carImgRefs, carImagesLoaded } = useCarSpriteImages();

    const updateRouteQuery = useRaceRouteQuery(router);

    const [selectedCarId, setSelectedCarId] = useState<string>('');
    const [selectedRace, setSelectedRace] = useState<JsonRaceResult | null>(null);
    ////REMOVE TRACK ID AND ONLY USE SELECTED ID
    const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>("3");
    const [showTraining, setShowTraining] = useState<boolean>(true);
    const [showPvp, setShowPvp] = useState<boolean>(false);
    const [showAdvancedParams, setShowAdvancedParams] = useState<boolean>(false);
    const [explorationRate, setExplorationRate] = useState<number>(0.1);
    const [enableDecay, setEnableDecay] = useState<boolean>(true);
    const [numberOfRaces, setNumberOfRaces] = useState<number>(1);
    const [maxRaceTicks, setMaxRaceTicks] = useState<number>(100); // 0 = unlimited
    const [maxRaceTicksInput, setMaxRaceTicksInput] = useState<string>('100');

    // Campaign modal state
    const [modalQueue, setModalQueue] = useState<CampaignStepModal[]>([]);
    const [activeModal, setActiveModal] = useState<CampaignStepModal | null>(null);

    // Showcase dialogue state
    const [showShowcaseDialogue, setShowShowcaseDialogue] = useState(false);

    // Track last processed race to prevent duplicate processing
    const lastProcessedRaceRef = useRef<string | null>(null);

    const isCampaign = !!progress.active;

    useRaceCampaignSync({
        config, setConfig, isCampaign, progress, selectedTrackId, setSelectedTrackId,
        updateRouteQuery, lastProcessedRaceRef, racingState, setRacingState,
        showTraining, setShowTraining, showPvp, setShowPvp,
    });

    // Get recent races for selected car
    const { data: carRecentRaces, isLoading: isLoadingCarRaces, error: carRacesError } = useRecentRacesForCar(selectedCarId);

    // Get race data using the selected race object
    const { track, log, isLoading } = useQRacing(selectedTrackId, selectedRace ?? undefined, appState.rpcUrl);

    // Get maze event data
    const { data: maze } = useSecondsUntilOpen('maze', appState.rpcUrl);
    const { data: validMazeId } = useValidMazeId(appState.rpcUrl);

    // Check if we're in maze mode: valid maze track selected AND in showcase mode
    const isMazeMode = !showTraining && selectedTrackId && validMazeId === selectedTrackId;

    // Fetch training stats for selected car + track
    const { data: trackTrainingStats, refetch: refetchTrainingStats } = useTrackTrainingStats(selectedCarId || undefined, selectedTrackId || undefined, appState.rpcUrl);
    // List available tracks
    const { data: availableTracks } = useListTracks(appState.rpcUrl);
    // Get top times for the selected track
    const { data: topTimes, refetch: refetchTopTimes } = useTopTimes(selectedTrackId || undefined, appState.rpcUrl);
    // Get top times with training session counts
    const { data: topTimesWithSessions, refetch: refetchTopTimesWithSessions } = useTopTimesWithSessions(selectedTrackId || undefined, appState.rpcUrl);

    // IQ tracking for mode switching
    const { data: qTableData } = useCarQTable(selectedCarId, appState.rpcUrl);
    const trackIqPercent = useTrackIq(track, qTableData);

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
    const lastRaceIdRef = useRef<string | undefined>(undefined);
    const carsRef = useRef<Map<string, { x: number; y: number; color: string; lastValidRenderX?: number; lastValidRenderY?: number; hit_wall?: boolean; path: Array<{ x: number, y: number }>; hasReachedFinish?: boolean; }>>(new Map());

    // Confetti state
    const { showConfetti, confettiCanvasRef, triggerConfetti } = useConfetti();

    const hasPreview = useMemo(() => {
        return Boolean(track);
    }, [track]);

    const hasRaceData = useMemo(() => {
        return Boolean(selectedRace && selectedRace.race_id !== 'sample' && track && log);
    }, [selectedRace, track, log]);

    const filteredTracks = useRaceSelection({
        router, carRecentRaces, setSelectedRace, setSelectedTrackId, availableTracks,
        ownedCars, selectedCarId, setSelectedCarId, updateRouteQuery, selectedTrackId, showPvp,
    });

    useRaceCanvasReset({
        playing, playingRef, canvasRef, setPlaying, tickRef, setTickDisplay,
        carsRef, setSelectedRace, selectedTrackId,
    });

    useRaceAnimation({
        track, log, speed, playing, canvasRef, tickRef, carsRef, lastRaceIdRef, playingRef,
        selectedRace, selectedCarId, carRecentRaces, carImgRefs, carImagesLoaded, lastActionDisplay,
        setDims, setPlaying, setTickDisplay, setLeaderDisplay, setLastActionDisplay, setSelectedRace,
    });

    const { handleExitCampaign, togglePlay, replay, scrollToLeaderboard, showLatestRace, handleRaceSuccess, advanceModal } = useRaceViewerActions({
        endCampaign, setShowTraining, setModalQueue, setActiveModal, progress,
        playing, log, tickRef, setPlaying, leaderboardRef,
        carRecentRaces, setSelectedRace, setSelectedTrackId, setTickDisplay, isMazeMode, triggerConfetti,
        refetchTrainingStats, refetchTopTimes, refetchTopTimesWithSessions,
        isCampaign, selectedTrackId, incrementRaceCountForTrack, config, applyUnlocks,
        showTraining, trackIqPercent, setShowcaseMode, setShowShowcaseDialogue,
        modalQueue, activeModal, nextTrack, updateRouteQuery,
    });

    // Handle campaign completion detection (when race is won in showcase mode)
    useRaceCampaignCompletion({
        isCampaign, selectedRace, selectedTrackId, showTraining, config, progress, selectedCarId,
        applyUnlocks, setModalQueue, setActiveModal, triggerConfetti, markCampaignCompleted,
    });

    const scaledW = dims.rawW * dims.scale;
    const scaledH = dims.rawH * dims.scale;

    // Derived label + total ticks (kept verbatim in a hook to keep the component lean)
    const { improvementLabel, sessions, totalTicks } = useRaceDerived({
        trackTrainingStats, showTraining, showPvp, selectedRace, selectedCarId, log,
    });

    const runRace = useRunRace({
        trackId: selectedTrackId,
        carIds: selectedCarId ? [selectedCarId] : [],
        train: showTraining,
        pvp: showPvp,
        onSuccess: handleRaceSuccess,
        // Advanced training parameters - only enabled when advanced section is expanded
        advanced: showAdvancedParams,
        explorationRate: showAdvancedParams ? explorationRate : 0.3,
        enableDecay: true,
        numberOfRaces: numberOfRaces,
        maxRaceTicks: showAdvancedParams && maxRaceTicks > 0 ? maxRaceTicks : undefined
    });

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'stretch', minHeight: '100vh', background: 'linear-gradient(180deg, #05070f 0%, #0b0e17 100%)' }}>

            {isLoading && (
                <div style={{ padding: '8px 18px', color: '#b8c1ff', fontFamily: '"Press Start 2P", monospace', fontSize: 12 }}>
                    Loading…
                </div>
            )}

            {/* Race Mode Header */}
            <RaceHeader
                isCampaign={isCampaign} isMazeMode={isMazeMode} handleExitCampaign={handleExitCampaign}
                startCampaign={startCampaign} triggerConfetti={triggerConfetti}
            />

            {/* Primary Controls - Responsive Layout */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e' }}>
                <div className="race-controls-container">
                    {/* Left: Car, Track, Mode dropdowns */}
                    <RaceControlDropdowns
                        selectedCarId={selectedCarId} setSelectedCarId={setSelectedCarId} isLoadingCars={isLoadingCars}
                        ownedCars={ownedCars} isCampaign={isCampaign} selectedTrackId={selectedTrackId}
                        setSelectedTrackId={setSelectedTrackId} filteredTracks={filteredTracks} showTraining={showTraining}
                        setShowTraining={setShowTraining} showPvp={showPvp} setShowPvp={setShowPvp}
                        availableTracks={availableTracks} updateRouteQuery={updateRouteQuery} address={address}
                        carsError={carsError}
                    />

                    {/* Right: Run Race Button with Race Count Controls */}
                    <RaceRunControls
                        showTraining={showTraining} racingState={racingState} isCampaign={isCampaign}
                        progress={progress} isMazeMode={isMazeMode} numberOfRaces={numberOfRaces}
                        setNumberOfRaces={setNumberOfRaces} runRace={runRace} selectedTrackId={selectedTrackId}
                        selectedCarId={selectedCarId} filteredTracks={filteredTracks}
                    />
                </div>
            </div>

            {/* Stats Panel - Compact, Always Visible */}
            <RaceStatsPanel
                trackTrainingStats={trackTrainingStats} track={track} selectedCarId={selectedCarId}
                tickDisplay={tickDisplay} log={log} availableTracks={availableTracks} selectedTrackId={selectedTrackId}
            />

            {/* Info Section - Collapsible, Starts Collapsed */}
            <div style={{ background: '#0a0f1e', borderBottom: '1px solid #2a3550' }}>
                <RacePlaybackControls
                    isCampaign={isCampaign} progress={progress} hasRaceData={hasRaceData} showControls={showControls}
                    setShowControls={setShowControls} togglePlay={togglePlay} playing={playing} replay={replay}
                    speed={speed} setSpeed={setSpeed}
                />
                <RaceTileLegend
                    isCampaign={isCampaign} progress={progress} hasPreview={hasPreview} showLegend={showLegend}
                    setShowLegend={setShowLegend} showTraining={showTraining} showAdvancedParams={showAdvancedParams}
                    setShowAdvancedParams={setShowAdvancedParams} explorationRate={explorationRate} setExplorationRate={setExplorationRate}
                    maxRaceTicksInput={maxRaceTicksInput} setMaxRaceTicksInput={setMaxRaceTicksInput} setMaxRaceTicks={setMaxRaceTicks}
                />
            </div>

            {/* Car Rank Display */}
            <RaceCarRank selectedCarId={selectedCarId} topTimes={topTimes} scrollToLeaderboard={scrollToLeaderboard} />

            {/* Game Boy Controller Icon */}
            {hasRaceData && (
                <RaceActionPad
                    tickDisplay={tickDisplay} log={log} availableTracks={availableTracks}
                    selectedTrackId={selectedTrackId} hasPreview={hasPreview} lastActionDisplay={lastActionDisplay}
                />
            )}

            {/* Keyboard Shortcuts Help */}
            <div style={{ padding: '8px 18px', borderBottom: '1px solid #2a3550', background: '#0a0f1e', opacity: 0.8 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontFamily: '"Press Start 2P", monospace', fontSize: 12, color: '#b8c1ff' }}>
                    <span>Keyboard: <span style={{ color: '#fff' }}>SPACE</span> Play/Pause | <span style={{ color: '#fff' }}>R</span> Reset | <span style={{ color: '#fff' }}>←→</span> Step </span>
                </div>
            </div>

            {/* Race Canvas */}
            <RaceCanvas
                hasPreview={hasPreview} scaledW={scaledW} scaledH={scaledH}
                canvasRef={canvasRef} selectedTrackId={selectedTrackId}
            />

            {/* Leaderboard */}
            {selectedTrackId && (
                <RaceLeaderboard
                    leaderboardRef={leaderboardRef} topTimesWithSessions={topTimesWithSessions}
                    ownedCars={ownedCars} rpcUrl={appState.rpcUrl}
                />
            )}

            {/* Confetti Canvas */}
            {showConfetti && (
                <RaceConfettiOverlay confettiCanvasRef={confettiCanvasRef} />
            )}

            {/* Campaign Modal */}
            {activeModal && (
                <CampaignModal
                    isOpen={!!activeModal} title={activeModal.title} body={activeModal.body}
                    onClose={() => setActiveModal(null)} onContinue={advanceModal} continueLabel="Continue"
                />
            )}

            {/* Showcase Dialogue */}
            <DialogueBox
                isVisible={showShowcaseDialogue} message="Complete the race on Showcase to move forward"
                position="top" offset={{ x: 0, y: -20 }} onClose={() => setShowShowcaseDialogue(false)}
                autoCloseDelay={5000}
            />
        </div>
    );
};

export default RaceViewer;
