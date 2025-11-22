import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Zap, Shield, Brain } from 'lucide-react';

export function About() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen bg-[#0A0A0A] overflow-hidden">
      {/* Animated Background Grid */}
      <div className="absolute inset-0 opacity-10">
        <div className="w-full h-full" style={{
          backgroundImage: `
            linear-gradient(#6943FF 1px, transparent 1px),
            linear-gradient(90deg, #6943FF 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
          animation: 'gridScroll 20s linear infinite'
        }} />
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-screen flex flex-col px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-block p-6 border-2 border-[#6943FF] rounded-full mb-6"
            style={{
              boxShadow: '0 0 30px #6943FF'
            }}
          >
            <div className="w-24 h-24 bg-gradient-to-br from-[#6943FF] to-[#A692FF] rounded-full flex items-center justify-center">
              <div className="text-[#F5F5F5] text-4xl">R</div>
            </div>
          </div>
          <h1 
            className="text-4xl md:text-6xl tracking-wider mb-4"
            style={{
              fontFamily: 'monospace',
              color: '#A692FF',
              textShadow: '0 0 20px #6943FF'
            }}
          >
            RECEPTIONIST
          </h1>
          <p className="text-[#8A8A8A] tracking-widest">NEURAL INTERFACE ACTIVE</p>
        </div>

        {/* Dialogue Box */}
        <div className="max-w-3xl mx-auto w-full flex-grow">
          <div className="bg-gradient-to-br from-[#6943FF]/10 to-[#0A0A0A] border-2 border-[#6943FF] rounded-lg p-8 mb-8"
            style={{
              boxShadow: '0 0 20px #6943FF/20'
            }}
          >
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="w-2 h-2 bg-[#3BE5E5] rounded-full mt-2 animate-pulse" />
                <p className="text-[#F5F5F5] flex-1">
                  Welcome to <span className="text-[#A692FF]">The Membrane</span>, where the boundaries between reality and the digital realm blur into something extraordinary.
                </p>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-2 h-2 bg-[#3BE5E5] rounded-full mt-2 animate-pulse" style={{ animationDelay: '0.5s' }} />
                <p className="text-[#F5F5F5] flex-1">
                  We are more than just a club. We are a neural nexus, a convergence point for digital consciousness and human experience.
                </p>
              </div>
            </div>
          </div>

          {/* Features Grid */}
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <div className="border border-[#6943FF]/50 rounded-lg p-6 bg-[#0A0A0A]/80 hover:border-[#3BE5E5] transition-colors">
              <Zap className="text-[#3BE5E5] mb-4" size={32} style={{ filter: 'drop-shadow(0 0 10px #3BE5E5)' }} />
              <h3 className="text-[#F5F5F5] mb-2">IMMERSIVE EXPERIENCE</h3>
              <p className="text-[#8A8A8A] text-sm">Cutting-edge neural technology creates unparalleled sensory journeys</p>
            </div>

            <div className="border border-[#6943FF]/50 rounded-lg p-6 bg-[#0A0A0A]/80 hover:border-[#3BE5E5] transition-colors">
              <Shield className="text-[#A692FF] mb-4" size={32} style={{ filter: 'drop-shadow(0 0 10px #A692FF)' }} />
              <h3 className="text-[#F5F5F5] mb-2">SECURE PROTOCOL</h3>
              <p className="text-[#8A8A8A] text-sm">Military-grade encryption protects your neural signature</p>
            </div>

            <div className="border border-[#6943FF]/50 rounded-lg p-6 bg-[#0A0A0A]/80 hover:border-[#3BE5E5] transition-colors">
              <Brain className="text-[#6943FF] mb-4" size={32} style={{ filter: 'drop-shadow(0 0 10px #6943FF)' }} />
              <h3 className="text-[#F5F5F5] mb-2">MULTI-LEVEL ACCESS</h3>
              <p className="text-[#8A8A8A] text-sm">Explore different dimensions of consciousness across our levels</p>
            </div>
          </div>

          {/* Info Box */}
          <div className="border-l-4 border-[#3BE5E5] bg-[#3BE5E5]/5 rounded p-6 mb-8">
            <p className="text-[#F5F5F5] mb-2">
              <span className="text-[#3BE5E5]">STATUS:</span> Currently operating at 99.7% neural sync capacity
            </p>
            <p className="text-[#F5F5F5]">
              <span className="text-[#3BE5E5]">LOCATION:</span> Neural District 07, Sector Grid 42-A
            </p>
          </div>

          {/* Navigation Buttons */}
          <div className="flex gap-4 justify-center">
            <button
              onClick={() => navigate('/lobby')}
              className="px-8 py-3 border-2 border-[#6943FF] text-[#F5F5F5] hover:bg-[#6943FF]/20 hover:shadow-[0_0_20px_#6943FF] transition-all tracking-wider flex items-center gap-2"
            >
              <ArrowLeft size={20} />
              BACK TO LOBBY
            </button>
            <button
              onClick={() => navigate('/levels')}
              className="px-8 py-3 bg-gradient-to-r from-[#6943FF] to-[#A692FF] text-[#F5F5F5] hover:shadow-[0_0_30px_#6943FF] transition-all tracking-wider"
            >
              EXPLORE LEVELS
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes gridScroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(40px); }
        }
      `}</style>
    </div>
  );
}
