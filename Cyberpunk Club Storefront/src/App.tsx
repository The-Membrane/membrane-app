import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Storefront } from './components/Storefront';
import { Lobby } from './components/Lobby';
import { About } from './components/About';
import { Levels } from './components/Levels';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Storefront />} />
        <Route path="/lobby" element={<Lobby />} />
        <Route path="/about" element={<About />} />
        <Route path="/levels" element={<Levels />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}