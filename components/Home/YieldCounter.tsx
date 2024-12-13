import { useState, useEffect, useRef } from 'react';

const IncreasingCounter = ({ 
  incrementPerSecond = 1,
  precision = 2           // Number of decimal places to show
}: {incrementPerSecond?: number, precision?: number}) => {
  const [displayValue, setDisplayValue] = useState(0);
  const actualValueRef = useRef(0);
  const lastUpdateRef = useRef(Date.now());

  useEffect(() => {
    // Update the actual value continuously
    const interval = setInterval(() => {
      const now = Date.now();
      const deltaTime = (now - lastUpdateRef.current) / 1000;
      actualValueRef.current += deltaTime * incrementPerSecond;
      lastUpdateRef.current = now;
      
      // Only update display value if it would show a different number
      const roundedValue = Number(actualValueRef.current);
      if (roundedValue !== displayValue) {
        setDisplayValue(roundedValue);
      }
    }, 50); // Update frequently for smooth counting

    return () => clearInterval(interval);
  }, [incrementPerSecond, precision, displayValue]);

  return (
      <div >
        <div className="text-6xl font-bold tabular-nums">
          {displayValue}
        </div>
        <div className="text-gray-600 mt-2">
          Increasing by {incrementPerSecond} per second
        </div>
      </div>
  );
};

export default IncreasingCounter;