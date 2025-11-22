import React from "react"
import { CyberpunkHome } from './CyberpunkHome'

const Home = () => {
  return <CyberpunkHome />
};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Home;