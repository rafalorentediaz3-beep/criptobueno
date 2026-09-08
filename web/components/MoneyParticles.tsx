"use client";

import { TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

interface Particle {
  id: number;
  left: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
  opacity: number;
}

const COUNT = 22;

/** Deterministic-per-mount pseudo-random particle layout, generated once on
 * the client after mount so server and first client render both paint an
 * empty container (no hydration mismatch from Math.random). */
function makeParticles(): Particle[] {
  return Array.from({ length: COUNT }, (_, id) => ({
    id,
    left: Math.random() * 100,
    size: 12 + Math.random() * 16,
    duration: 14 + Math.random() * 12,
    delay: Math.random() * -26,
    drift: (Math.random() - 0.5) * 60,
    opacity: 0.08 + Math.random() * 0.14,
  }));
}

/** Ambient background: faint green stock-uptrend arrows drifting up from the
 * bottom of the viewport, purely decorative. Fixed + behind all content,
 * ignores pointer events, and respects prefers-reduced-motion via CSS. */
export function MoneyParticles() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    setParticles(makeParticles());
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {particles.map((p) => (
        <TrendingUp
          key={p.id}
          className="money-particle"
          style={
            {
              "--money-left": `${p.left}%`,
              "--money-duration": `${p.duration}s`,
              "--money-delay": `${p.delay}s`,
              "--money-drift": `${p.drift}px`,
              "--money-opacity": p.opacity,
              width: p.size,
              height: p.size,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
