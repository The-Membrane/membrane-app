import { useState } from 'react'

export function useTemporaryDisable(durationMs: number = 3000) {
  const [isDisabled, setIsDisabled] = useState(false);

  const triggerDisable = () => {
    setIsDisabled(true);
    setTimeout(() => setIsDisabled(false), durationMs);
  };

  return { isDisabled, triggerDisable };
}
