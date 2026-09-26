// The root redirect lives in middleware.ts so it executes at the edge without
// starting a server function. This static fallback should never render.
export default function Redirect() {
  return null
}
