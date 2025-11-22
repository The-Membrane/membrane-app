import { useNavigate } from 'react-router-dom';

export function Storefront() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen bg-[#0A0A0A] overflow-hidden">
      {/* Content */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-screen px-4">
        {/* Neon Sign */}
        <div className="mb-12 text-center">
          <h1 
            className="text-6xl md:text-8xl tracking-wider mb-4"
            style={{
              fontFamily: 'monospace',
              fontWeight: '300',
              color: '#3BE5E5',
              textShadow: `
                0 0 3px #3BE5E5,
                0 0 6px #3BE5E5,
                0 0 9px #3BE5E5
              `
            }}
          >
            THE MEMBRANE
          </h1>
          <div className="h-1 w-full bg-gradient-to-r from-transparent via-[#3BE5E5] to-transparent opacity-60" />
        </div>

        {/* Club Entrance Container */}
        <div className="relative group">
          {/* Hexagonal Door */}
          <button
            onClick={() => navigate('/lobby')}
            className="relative w-80 h-96 bg-[#0A0A0A] border-2 border-[#6943FF] rounded-lg overflow-hidden transition-all duration-500 group-hover:border-[#3BE5E5] group-hover:shadow-[0_0_40px_#3BE5E5]"
          >
            {/* Hexagon Pattern */}
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 320 384">
              <defs>
                <pattern id="hexPattern" x="0" y="0" width="60" height="52" patternUnits="userSpaceOnUse">
                  <polygon
                    points="30,1 52,14 52,38 30,51 8,38 8,14"
                    fill="none"
                    stroke="#6943FF"
                    strokeWidth="1"
                    className="group-hover:stroke-[#3BE5E5] transition-all duration-500"
                  />
                </pattern>
                <linearGradient id="hexGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#6943FF" stopOpacity="0.3" />
                  <stop offset="50%" stopColor="#A692FF" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#3BE5E5" stopOpacity="0.1" />
                </linearGradient>
              </defs>
              
              {/* Background hexagon pattern */}
              <rect width="100%" height="100%" fill="url(#hexPattern)" />
              
              {/* Central artistic hexagons */}
              <g className="transition-all duration-500 group-hover:opacity-80">
                {/* Large center hexagon */}
                <polygon
                  points="160,100 210,130 210,190 160,220 110,190 110,130"
                  fill="url(#hexGradient)"
                  stroke="#A692FF"
                  strokeWidth="2"
                  className="group-hover:stroke-[#3BE5E5] transition-all duration-500"
                  style={{ filter: 'drop-shadow(0 0 10px #6943FF)' }}
                />
                
                {/* Surrounding hexagons */}
                <polygon
                  points="160,40 190,58 190,94 160,112 130,94 130,58"
                  fill="none"
                  stroke="#6943FF"
                  strokeWidth="1.5"
                  className="group-hover:stroke-[#A692FF] transition-all duration-500"
                  opacity="0.8"
                />
                
                <polygon
                  points="220,130 250,148 250,184 220,202 190,184 190,148"
                  fill="none"
                  stroke="#6943FF"
                  strokeWidth="1.5"
                  className="group-hover:stroke-[#A692FF] transition-all duration-500"
                  opacity="0.8"
                />
                
                <polygon
                  points="100,130 130,148 130,184 100,202 70,184 70,148"
                  fill="none"
                  stroke="#6943FF"
                  strokeWidth="1.5"
                  className="group-hover:stroke-[#A692FF] transition-all duration-500"
                  opacity="0.8"
                />
                
                <polygon
                  points="160,240 190,258 190,294 160,312 130,294 130,258"
                  fill="none"
                  stroke="#6943FF"
                  strokeWidth="1.5"
                  className="group-hover:stroke-[#A692FF] transition-all duration-500"
                  opacity="0.8"
                />
                
                {/* Small accent hexagons */}
                <polygon
                  points="220,70 235,80 235,100 220,110 205,100 205,80"
                  fill="#3BE5E5"
                  fillOpacity="0.3"
                  stroke="#3BE5E5"
                  strokeWidth="1"
                  className="animate-pulse"
                />
                
                <polygon
                  points="100,70 115,80 115,100 100,110 85,100 85,80"
                  fill="#3BE5E5"
                  fillOpacity="0.3"
                  stroke="#3BE5E5"
                  strokeWidth="1"
                  className="animate-pulse"
                  style={{ animationDelay: '1s' }}
                />
                
                <polygon
                  points="160,280 175,290 175,310 160,320 145,310 145,290"
                  fill="#3BE5E5"
                  fillOpacity="0.3"
                  stroke="#3BE5E5"
                  strokeWidth="1"
                  className="animate-pulse"
                  style={{ animationDelay: '0.5s' }}
                />
              </g>
            </svg>

            {/* Door Handle */}
            <div className="absolute right-8 top-1/2 -translate-y-1/2 w-4 h-16 bg-[#3BE5E5] rounded-full shadow-[0_0_15px_#3BE5E5] z-10" />
          </button>

          {/* Enter Text - Below Door */}
          <div className="text-center mt-6 text-[#F5F5F5] opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <p className="text-sm tracking-wider">ENTER</p>
            <div className="h-0.5 w-16 mx-auto bg-[#3BE5E5] mt-1" />
          </div>
        </div>

        {/* Ambient Info */}
        <div className="absolute bottom-8 right-8 text-right">
          <p className="text-[#8A8A8A] text-xs tracking-widest">OPEN 24/7</p>
          <p className="text-[#3BE5E5] text-xs tracking-widest">NEURAL_DISTRICT_07</p>
        </div>
      </div>
    </div>
  );
}