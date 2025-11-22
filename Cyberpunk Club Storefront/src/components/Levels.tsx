import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { ArrowLeft, Lock, Unlock, Wifi } from 'lucide-react';

interface Level {
  id: number;
  name: string;
  description: string;
  status: 'unlocked' | 'locked';
  color: string;
}

const levels: Level[] = [
  {
    id: 1,
    name: 'GROUND FLOOR',
    description: 'Main dance floor with holographic DJs',
    status: 'unlocked',
    color: '#3BE5E5'
  },
  {
    id: 2,
    name: 'LEVEL AZURE',
    description: 'Ambient lounge with neural relaxation pods',
    status: 'unlocked',
    color: '#6943FF'
  },
  {
    id: 3,
    name: 'LEVEL VIOLET',
    description: 'VIP section with exclusive experiences',
    status: 'unlocked',
    color: '#A692FF'
  },
  {
    id: 4,
    name: 'THE NEXUS',
    description: 'Direct neural interface experimental zone',
    status: 'locked',
    color: '#8A8A8A'
  },
  {
    id: 5,
    name: 'LEVEL OMEGA',
    description: 'Top secret - Requires special clearance',
    status: 'locked',
    color: '#8A8A8A'
  }
];

export function Levels() {
  const navigate = useNavigate();
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);
  const [currentFloor, setCurrentFloor] = useState(0);

  const handleLevelClick = (level: Level) => {
    if (level.status === 'unlocked') {
      setSelectedLevel(level.id);
      setCurrentFloor(level.id);
    }
  };

  return (
    <div className="relative min-h-screen bg-[#0A0A0A] overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <ImageWithFallback
          src="https://images.unsplash.com/photo-1694951558444-03b27ca33665?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxmdXR1cmlzdGljJTIwZWxldmF0b3J8ZW58MXx8fHwxNzYyODk2NjA1fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral"
          alt="Elevator"
          className="w-full h-full object-cover opacity-20"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A]/80 via-transparent to-[#0A0A0A]" />
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-screen flex flex-col px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 
            className="text-4xl md:text-6xl tracking-wider mb-4"
            style={{
              fontFamily: 'monospace',
              color: '#3BE5E5',
              textShadow: '0 0 20px #3BE5E5, 0 0 40px #3BE5E5'
            }}
          >
            ELEVATOR ACCESS
          </h1>
          <div className="flex items-center justify-center gap-2 text-[#8A8A8A]">
            <Wifi size={16} className="animate-pulse" />
            <p className="tracking-widest text-sm">NEURAL LINK STABLE</p>
          </div>
        </div>

        <div className="flex-grow max-w-6xl mx-auto w-full grid md:grid-cols-2 gap-8">
          {/* Elevator Control Panel */}
          <div>
            <div className="bg-gradient-to-br from-[#6943FF]/10 to-[#0A0A0A] border-2 border-[#6943FF] rounded-lg p-6"
              style={{ boxShadow: '0 0 30px #6943FF/30' }}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-[#F5F5F5] text-xl tracking-wider">CONTROL PANEL</h2>
                <div className="text-[#3BE5E5] text-2xl font-mono">
                  {currentFloor}
                </div>
              </div>

              {/* Level Buttons */}
              <div className="space-y-3">
                {levels.map((level) => (
                  <button
                    key={level.id}
                    onClick={() => handleLevelClick(level)}
                    disabled={level.status === 'locked'}
                    className={`w-full p-4 border-2 rounded-lg transition-all duration-300 ${
                      selectedLevel === level.id
                        ? 'bg-gradient-to-r from-[#6943FF]/30 to-[#A692FF]/30 border-[#3BE5E5]'
                        : level.status === 'locked'
                        ? 'border-[#8A8A8A]/30 opacity-50 cursor-not-allowed'
                        : 'border-[#6943FF]/50 hover:border-[#A692FF] hover:bg-[#6943FF]/10'
                    }`}
                    style={
                      selectedLevel === level.id && level.status === 'unlocked'
                        ? { boxShadow: `0 0 20px ${level.color}` }
                        : {}
                    }
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-left">
                        <div className="flex items-center gap-2 mb-1">
                          {level.status === 'unlocked' ? (
                            <Unlock size={16} style={{ color: level.color }} />
                          ) : (
                            <Lock size={16} className="text-[#8A8A8A]" />
                          )}
                          <h3 
                            className="tracking-wider"
                            style={{ color: level.status === 'unlocked' ? level.color : '#8A8A8A' }}
                          >
                            {level.name}
                          </h3>
                        </div>
                        <p className="text-[#8A8A8A] text-sm">{level.description}</p>
                      </div>
                      <div 
                        className="text-3xl font-mono"
                        style={{ color: level.status === 'unlocked' ? level.color : '#8A8A8A' }}
                      >
                        {level.id}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Level Display */}
          <div>
            {selectedLevel ? (
              <div className="bg-gradient-to-br from-[#3BE5E5]/10 to-[#0A0A0A] border-2 border-[#3BE5E5] rounded-lg p-8 h-full"
                style={{ boxShadow: '0 0 30px #3BE5E5/30' }}
              >
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div 
                    className="text-8xl font-mono mb-6"
                    style={{ 
                      color: levels[selectedLevel - 1].color,
                      textShadow: `0 0 30px ${levels[selectedLevel - 1].color}`
                    }}
                  >
                    {selectedLevel}
                  </div>
                  <h2 
                    className="text-3xl tracking-wider mb-4"
                    style={{ color: levels[selectedLevel - 1].color }}
                  >
                    {levels[selectedLevel - 1].name}
                  </h2>
                  <p className="text-[#F5F5F5] mb-8 max-w-md">
                    {levels[selectedLevel - 1].description}
                  </p>

                  {/* Level Visualization */}
                  <div className="w-full max-w-xs">
                    {[...Array(5)].reverse().map((_, i) => (
                      <div
                        key={i}
                        className={`h-12 mb-2 border-2 rounded transition-all duration-300 ${
                          5 - i === selectedLevel
                            ? 'bg-gradient-to-r from-[#6943FF] to-[#A692FF] border-[#3BE5E5]'
                            : 'bg-[#0A0A0A] border-[#6943FF]/30'
                        }`}
                        style={
                          5 - i === selectedLevel
                            ? { boxShadow: '0 0 20px #6943FF' }
                            : {}
                        }
                      >
                        <div className="flex items-center justify-between h-full px-4">
                          <span className="text-[#8A8A8A] text-sm">
                            {levels[4 - i].name}
                          </span>
                          {5 - i === selectedLevel && (
                            <div className="w-2 h-2 bg-[#3BE5E5] rounded-full animate-pulse" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="border-2 border-[#6943FF]/30 border-dashed rounded-lg p-8 h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="text-6xl mb-4 opacity-20">⟐</div>
                  <p className="text-[#8A8A8A]">Select a level to begin</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <div className="flex gap-4 justify-center mt-8">
          <button
            onClick={() => navigate('/lobby')}
            className="px-8 py-3 border-2 border-[#8A8A8A] text-[#8A8A8A] hover:border-[#F5F5F5] hover:text-[#F5F5F5] transition-all tracking-wider flex items-center gap-2"
          >
            <ArrowLeft size={20} />
            LOBBY
          </button>
          <button
            onClick={() => navigate('/about')}
            className="px-8 py-3 border-2 border-[#6943FF] text-[#F5F5F5] hover:bg-[#6943FF]/20 hover:shadow-[0_0_20px_#6943FF] transition-all tracking-wider"
          >
            ABOUT
          </button>
        </div>
      </div>
    </div>
  );
}
