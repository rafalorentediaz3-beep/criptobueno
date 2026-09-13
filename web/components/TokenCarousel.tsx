"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { type TokenRow } from "./TokenCard";
import { FeaturedTokenCard } from "./FeaturedTokenCard";
import styles from "./TokenCarousel.module.css";

export function TokenCarousel({ rows }: { rows: TokenRow[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const [position, setPosition] = useState(0);
  const previousPosition = useRef(0);
  const [visibleCount, setVisibleCount] = useState(5);
  const order = rows.map((row) => row.address).join(",");

  useEffect(() => {
    setPosition(0);
  }, [order]);

  useLayoutEffect(() => {
    previousPosition.current = position;
  }, [position]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setVisibleCount(Number(getComputedStyle(element).getPropertyValue("--visible")) || 5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function move(next: number) {
    if (rows.length < 2) return;
    setPosition((value) => value + next);
  }

  const count = Math.min(visibleCount, rows.length);
  const canLoop = rows.length > 1;
  // Keep a full offscreen buffer so looping never remounts a visible image.
  const total = canLoop ? Math.ceil((count + 6) / rows.length) * rows.length : rows.length;
  const buffer = Math.floor((total - count) / 2);
  const slotAt = (index: number, selected: number) =>
    ((index - selected + buffer) % total + total) % total - buffer;
  return (
    <section className={styles.carousel} aria-label="Hot coins" aria-roledescription="carousel">
      {canLoop && (
        <button type="button" className={`${styles.arrow} ${styles.previous}`} aria-label="Previous coins" title="Previous coins" onClick={() => move(-1)}><ArrowLeft size={20} /></button>
      )}
      <div ref={viewport} className={styles.viewport} tabIndex={0} aria-label="Coins" onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }} onPointerDown={(event) => {
        if (event.button === 0) gesture.current = { x: event.clientX, y: event.clientY };
      }} onPointerCancel={() => { gesture.current = null; }} onPointerUp={(event) => {
        const origin = gesture.current;
        if (!origin) return;
        const dx = event.clientX - origin.x;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(event.clientY - origin.y)) move(dx < 0 ? 1 : -1);
      }} onClickCapture={(event) => {
        if (gesture.current && Math.abs(event.clientX - gesture.current.x) > 40) {
          event.preventDefault();
          event.stopPropagation();
        }
        gesture.current = null;
      }} onDragStart={(event) => event.preventDefault()}>
        <div className={styles.track}>
          {Array.from({ length: total }, (_, index) => {
            const slot = slotAt(index, position);
            const previousSlot = slotAt(index, previousPosition.current);
            const wrapped = Math.abs(slot - previousSlot) > total / 2;
            const rowIndex = index % rows.length;
            const row = rows[rowIndex];
            if (!row) return null;
            const distance = slot - (count - 1) / 2;
            const offscreen = slot < 0 || slot >= count;
            return (
              <div key={`${index}:${row.address}`} className={styles.slide} style={{ "--slot": slot, "--duration": wrapped ? "0ms" : "700ms", "--angle": `${Math.max(-2, Math.min(2, distance)) * -14}deg`, "--scale": 1, "--edge": `${Math.max(-1, Math.min(1, distance)) * 4}px`, "--content-opacity": 1 - Math.min(Math.abs(distance), 1) * .6 } as CSSProperties} data-center={Math.abs(distance) < .5} role="group" aria-roledescription="slide" aria-label={`${rowIndex + 1} of ${rows.length}`} aria-hidden={offscreen || undefined} inert={offscreen}>
                <FeaturedTokenCard row={row} />
              </div>
            );
          })}
        </div>
      </div>
      {canLoop && (
        <button type="button" className={`${styles.arrow} ${styles.next}`} aria-label="Next coins" title="Next coins" onClick={() => move(1)}><ArrowRight size={20} /></button>
      )}
      <span className="sr-only" aria-live="polite">{rows.length ? `Coin ${((Math.round(position) % rows.length) + rows.length) % rows.length + 1} of ${rows.length}` : "No coins"}</span>
    </section>
  );
}
