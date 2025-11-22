import { useNavigate } from 'react-router-dom';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { UserCircle, ArrowUp } from 'lucide-react';

export function Lobby() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen bg-[#0A0A0A] overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <ImageWithFallback
          src="https://images.unsplash.com/photo-1698614083129-15e976a503fe?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxuZW9uJTIwY2x1YiUyMGludGVyaW9yJTIwcHVycGxlfGVufDF8fHx8MTc2Mjg5NjYwNHww&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral"
          alt="Neon lobby"
          className="w-full h-full object-cover opacity-30"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-[#0A0A0A]/60 to-transparent" />
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center px-4">
        {/* Header */}
        <div className="text-center mb-16">
          <h1 
            className="text-4xl md:text-6xl tracking-wider mb-2"
            style={{
              fontFamily: 'monospace',
              color: '#A692FF',
              textShadow: '0 0 20px #6943FF, 0 0 30px #6943FF'
            }}
          >
            WELCOME TO THE LOBBY
          </h1>
          <p className="text-[#8A8A8A] tracking-widest text-sm">CHOOSE YOUR DESTINATION</p>
        </div>

        {/* Main Choices */}
        <div className="grid md:grid-cols-2 gap-12 max-w-4xl w-full">
          {/* Receptionist - About */}
          <button
            onClick={() => navigate('/about')}
            className="group relative h-80 bg-gradient-to-br from-[#6943FF]/20 to-[#0A0A0A] border-2 border-[#6943FF] rounded-lg overflow-hidden transition-all duration-300 hover:border-[#A692FF] hover:shadow-[0_0_40px_#6943FF] hover:scale-105"
          >
            {/* Receptionist Icon */}
            <div className="absolute top-8 left-1/2 -translate-x-1/2">
              <div className="relative">
                <UserCircle 
                  size={80} 
                  className="text-[#6943FF] group-hover:text-[#A692FF] transition-colors"
                  style={{
                    filter: 'drop-shadow(0 0 10px #6943FF)'
                  }}
                />
                <div className="absolute -inset-4 border-2 border-[#3BE5E5]/30 rounded-full animate-ping" />
              </div>
            </div>

            {/* Text */}
            <div className="absolute bottom-12 left-0 right-0 text-center px-6">
              <h3 className="text-[#F5F5F5] text-2xl mb-2 tracking-wider">RECEPTIONIST</h3>
              <p className="text-[#8A8A8A] text-sm">Learn about The Membrane</p>
              <div className="mt-4 h-1 w-24 mx-auto bg-gradient-to-r from-transparent via-[#3BE5E5] to-transparent" />
            </div>

            {/* Corner Accent */}
            <div className="absolute top-0 right-0 w-16 h-16 border-t-4 border-r-4 border-[#3BE5E5]/50" />
            <div className="absolute bottom-0 left-0 w-16 h-16 border-b-4 border-l-4 border-[#3BE5E5]/50" />
          </button>

          {/* Elevator - Levels */}
          <button
            onClick={() => navigate('/levels')}
            className="group relative h-80 bg-gradient-to-br from-[#3BE5E5]/20 to-[#0A0A0A] border-2 border-[#3BE5E5] rounded-lg overflow-hidden transition-all duration-300 hover:border-[#A692FF] hover:shadow-[0_0_40px_#3BE5E5] hover:scale-105"
          >
            {/* Elevator Icon */}
            <div className="absolute top-8 left-1/2 -translate-x-1/2">
              <div className="relative w-24 h-32 border-4 border-[#3BE5E5] rounded-lg bg-[#0A0A0A]/80 flex items-center justify-center">
                <ArrowUp 
                  size={48} 
                  className="text-[#3BE5E5] group-hover:text-[#A692FF] transition-all group-hover:animate-bounce"
                  style={{
                    filter: 'drop-shadow(0 0 10px #3BE5E5)'
                  }}
                />
              </div>
            </div>

            {/* Text */}
            <div className="absolute bottom-12 left-0 right-0 text-center px-6">
              <h3 className="text-[#F5F5F5] text-2xl mb-2 tracking-wider">ELEVATOR</h3>
              <p className="text-[#8A8A8A] text-sm">Explore the levels</p>
              <div className="mt-4 h-1 w-24 mx-auto bg-gradient-to-r from-transparent via-[#6943FF] to-transparent" />
            </div>

            {/* Corner Accent */}
            <div className="absolute top-0 right-0 w-16 h-16 border-t-4 border-r-4 border-[#6943FF]/50" />
            <div className="absolute bottom-0 left-0 w-16 h-16 border-b-4 border-l-4 border-[#6943FF]/50" />
          </button>
        </div>

        {/* Back Button */}
        <button
          onClick={() => navigate('/')}
          className="mt-16 px-8 py-3 border border-[#8A8A8A] text-[#8A8A8A] hover:border-[#F5F5F5] hover:text-[#F5F5F5] transition-colors tracking-wider text-sm"
        >
          EXIT
        </button>

        {/* Ambient Grid */}
        <div className="absolute inset-0 pointer-events-none opacity-10">
          <div className="w-full h-full" style={{
            backgroundImage: `
              linear-gradient(#6943FF 1px, transparent 1px),
              linear-gradient(90deg, #6943FF 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px'
          }} />
        </div>
      </div>
    </div>
  );
}
