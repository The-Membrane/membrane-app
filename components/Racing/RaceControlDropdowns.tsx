import React from 'react';
import { TYPOGRAPHY } from '@/helpers/typography';

// no-many-boolean-props FP: isLoadingCars (async loading), isCampaign (route context),
// showTraining (mode select) and showPvp (currently inert/disabled) are independent, unrelated
// flags, not mutually-exclusive variants — see RaceViewer.tsx where each feeds separate,
// unrelated computations. Forcing a single enum would hurt clarity, not help it.
interface RaceControlDropdownsProps {
    selectedCarId: string;
    setSelectedCarId: React.Dispatch<React.SetStateAction<string>>;
    isLoadingCars: boolean;
    ownedCars: any[] | undefined;
    isCampaign: boolean;
    selectedTrackId: string | undefined;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string | undefined>>;
    filteredTracks: any[];
    showTraining: boolean;
    setShowTraining: React.Dispatch<React.SetStateAction<boolean>>;
    showPvp: boolean;
    setShowPvp: React.Dispatch<React.SetStateAction<boolean>>;
    availableTracks: any[] | undefined;
    updateRouteQuery: (updates: { carId?: string; trackId?: string }) => void;
    address: string | undefined;
    carsError: any;
}

const SELECT_BASE_STYLE: React.CSSProperties = {
    background: '#0a0f1e',
    color: '#fff',
    border: '2px solid #0033ff',
    fontFamily: '"Press Start 2P", monospace',
    fontSize: 10,
    padding: '6px 8px',
    boxShadow: '0 0 8px #0033ff inset',
    minHeight: '44px',
};

const RaceControlDropdowns: React.FC<RaceControlDropdownsProps> = ({
    selectedCarId,
    setSelectedCarId,
    isLoadingCars,
    ownedCars,
    isCampaign,
    selectedTrackId,
    setSelectedTrackId,
    filteredTracks,
    showTraining,
    setShowTraining,
    showPvp,
    setShowPvp,
    availableTracks,
    updateRouteQuery,
    address,
    carsError,
}) => {
    return (
        <div className="race-controls-dropdowns">
            {/* Car Selection */}
            <div className="race-control-item">
                <label htmlFor="race-car-select" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 12, color: '#b8c1ff' }}>CAR:</label>
                <select
                    id="race-car-select"
                    value={selectedCarId}
                    onChange={(e) => setSelectedCarId(e.target.value)}
                    disabled={isLoadingCars}
                    className="race-control-select"
                    style={{ ...SELECT_BASE_STYLE, minWidth: '120px', opacity: isLoadingCars ? 0.6 : 1 }}>
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
            {!isCampaign && (
                <div className="race-control-item">
                    <label htmlFor="race-track-select" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: TYPOGRAPHY.xs, color: '#b8c1ff' }}>TRACK:</label>
                    <select
                        id="race-track-select"
                        value={selectedTrackId || ''}
                        onChange={(e) => setSelectedTrackId(e.target.value || undefined)}
                        className="race-control-select"
                        style={{ ...SELECT_BASE_STYLE, minWidth: '150px' }}>
                        <option value="">Select Track</option>
                        {filteredTracks?.map((t: any) => (
                            <option key={t.id} value={t.id} style={{ background: '#0a0f1e', color: '#fff' }}>
                                {t.name || `Track ${t.id}`}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {/* Mode Dropdown - Training or Showcase */}
            {!isCampaign && (
                <div className="race-control-item">
                    <label htmlFor="race-mode-select" style={{ fontFamily: '"Press Start 2P", monospace', fontSize: 10, color: '#b8c1ff' }}>MODE:</label>
                    <select
                        id="race-mode-select"
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
                        style={{ ...SELECT_BASE_STYLE, minWidth: '120px' }}>
                        <option value="training">Training</option>
                        <option value="showcase">Showcase</option>
                    </select>
                </div>
            )}

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
    );
};

export default RaceControlDropdowns;
