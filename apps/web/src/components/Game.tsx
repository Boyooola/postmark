"use client";

import { useEffect, useRef, useState } from "react";
import { Engine, type HudState } from "@postmark/globe";
import { formatLatLon } from "@postmark/game-core";
import { useHud } from "./hudStore";

declare global {
  interface Window {
    __postmark?: Engine;
  }
}

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export default function Game() {
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const { setHud, setProgress, setError, toggleHelp, toggleDebug, pushEvent } = useHud.getState();

  useEffect(() => {
    let e: Engine | null = null;
    let cancelled = false;
    Engine.create({
      container: host.current!,
      assetBase: "/geo",
      onProgress: setProgress,
      onHud: setHud,
      onEvent: pushEvent,
      onAction: (a) => {
        if (a === "help") toggleHelp();
        if (a === "debug") toggleDebug();
      },
    })
      .then((eng) => {
        if (cancelled) return eng.dispose();
        e = eng;
        window.__postmark = eng;
        setEngine(eng);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    // The controls hint fades away on its own.
    const hide = setTimeout(() => toggleHelp(false), 20000);
    return () => {
      cancelled = true;
      clearTimeout(hide);
      e?.dispose();
      delete window.__postmark;
    };
  }, [setHud, setProgress, setError, toggleHelp, toggleDebug, pushEvent]);

  return (
    <div className="game">
      <div ref={host} className="viewport" />
      <Loading />
      {engine && <Hud engine={engine} />}
    </div>
  );
}

function Loading() {
  const progress = useHud((s) => s.progress);
  const error = useHud((s) => s.error);
  if (progress.fraction >= 1 && !error) return null;
  return (
    <div className="loading">
      {error ? (
        <p className="error">Couldn&apos;t start: {error}</p>
      ) : (
        <>
          <p>{progress.label}…</p>
          <div className="bar">
            <div style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ HUD */

function Hud({ engine }: { engine: Engine }) {
  const hud = useHud((s) => s.hud);
  const showHelp = useHud((s) => s.showHelp);
  const showDebug = useHud((s) => s.showDebug);
  const toasts = useHud((s) => s.toasts);
  if (!hud) return null;
  return (
    <div className="hud">
      <Location name={hud.location} />
      {hud.target && <Waypoint target={hud.target} />}
      <BoostGauge hud={hud} />
      <Compass heading={hud.telemetry.headingDeg} />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <strong>{t.title}</strong>
            <span>{t.detail}</span>
          </div>
        ))}
      </div>
      {showHelp && <Help />}
      {showDebug && <Debug hud={hud} engine={engine} />}
    </div>
  );
}

/** Top centre: the country or sea under the plane. */
function Location({ name }: { name: string }) {
  return (
    <div className="location" style={{ opacity: name ? 1 : 0 }}>
      {name || "\u00a0"}
    </div>
  );
}

/** Bottom centre: an arrow lying "on the ground" that turns towards the delivery. */
function Waypoint({ target }: { target: NonNullable<HudState["target"]> }) {
  return (
    <div className="waypoint">
      <div className="waypoint-arrow" aria-hidden>
        <svg viewBox="0 0 100 100" style={{ transform: `rotateX(52deg) rotate(${target.relativeDeg}deg)` }}>
          <path d="M50 6 L80 46 L61 46 L61 92 L39 92 L39 46 L20 46 Z" />
        </svg>
      </div>
      <div className="waypoint-name">
        {target.city}, {target.country}
      </div>
      <div className="waypoint-dist">{nf.format(target.distanceKm)} km</div>
    </div>
  );
}

const ARC_START = -135;
const ARC_END = 135;
function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}

/** Bottom left: run timer, then a dial with the boost left (grey) and the speed (needle). */
function BoostGauge({ hud }: { hud: HudState }) {
  const t = hud.telemetry;
  const boostEnd = ARC_START + (ARC_END - ARC_START) * t.boostEnergy;
  const needle = ARC_START + (ARC_END - ARC_START) * Math.max(0, Math.min(1, t.speedFraction));
  const [nx, ny] = polar(60, 60, 40, needle);
  const mins = Math.floor(hud.elapsedS / 60);
  const secs = Math.floor(hud.elapsedS % 60);
  return (
    <div className="gauge">
      <div className="timer">
        {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
      </div>
      {hud.delivered > 0 && <div className="delivered">{hud.delivered} delivered</div>}
      <svg viewBox="0 0 120 120" className={t.boosting ? "boosting" : ""}>
        <circle cx="60" cy="60" r="56" className="dial-bg" />
        {t.boostEnergy > 0.005 && <path d={arc(60, 60, 50, ARC_START, Math.max(ARC_START + 0.5, boostEnd))} className="dial-boost" />}
        <circle cx="60" cy="60" r="34" className="dial-hub" />
        <text x="14" y="66" className="dial-label">Min</text>
        <text x="106" y="66" className="dial-label" textAnchor="end">Max</text>
        <text x="60" y="110" className="dial-label" textAnchor="middle">Boost</text>
        <line x1="60" y1="60" x2={nx} y2={ny} className="dial-needle" />
        <circle cx="60" cy="60" r="4" className="dial-pin" />
      </svg>
    </div>
  );
}

/** Bottom right: the plane stays put, the cardinal letters turn around it. */
function Compass({ heading }: { heading: number }) {
  const letters: [string, number][] = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  return (
    <div className="compass">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="56" className="dial-bg" />
        <g transform={`rotate(${-heading} 60 60)`}>
          {letters.map(([l, d]) => {
            const [x, y] = polar(60, 60, 44, d);
            return (
              <text key={l} x={x} y={y + 5} textAnchor="middle" className="compass-letter" transform={`rotate(${d} ${x} ${y})`}>
                {l}
              </text>
            );
          })}
        </g>
        <path
          className="compass-plane"
          d="M60 30 L63 46 L84 56 L84 61 L63 57 L62 74 L69 79 L69 82 L60 80 L51 82 L51 79 L58 74 L57 57 L36 61 L36 56 L57 46 Z"
        />
      </svg>
    </div>
  );
}

function Help() {
  return (
    <div className="help">
      <span><kbd>W</kbd><kbd>S</kbd> climb · dive</span>
      <span><kbd>A</kbd><kbd>D</kbd> turn</span>
      <span><kbd>Shift</kbd> boost</span>
      <span><kbd>Space</kbd> drop parcel</span>
      <span><kbd>H</kbd> hide</span>
    </div>
  );
}

/** Developer overlay (backtick): numbers, streaming state, teleport. */
function Debug({ hud, engine }: { hud: HudState; engine: Engine }) {
  const t = hud.telemetry;
  return (
    <section className="debug">
      <p className="row"><span>Position</span><b>{formatLatLon(t)}</b></p>
      <p className="row"><span>Altitude</span><b>{nf.format(t.altitudeM)} m</b></p>
      <p className="row"><span>Ground</span><b>{nf.format(t.groundM)} m</b></p>
      <p className="row"><span>Airspeed</span><b>{nf.format(t.airspeedKmh)} km/h</b></p>
      <p className="row"><span>Local time</span><b>{hud.localTime}{hud.timeScale !== 72 ? ` (×${Math.round((hud.timeScale / 72) * 100) / 100})` : ""}</b></p>
      <p className="row"><span>Render</span><b>{hud.fps} fps · {Math.round(hud.renderScale * 100)}% res · {hud.chunks} chunks</b></p>
      <p className="row"><span>Terrain</span><b>{hud.streaming ? "streaming…" : "ready"}</b></p>
      {hud.target && (
        <p className="row"><span>{hud.target.city}</span><b>{nf.format(hud.target.distanceKm)} km</b></p>
      )}
      <button
        type="button"
        onClick={(e) => {
          engine.teleportToTarget();
          e.currentTarget.blur();
        }}
      >
        Fly near the destination
      </button>
      <p className="hint">T / G: time of day faster / slower · R: restart here</p>
    </section>
  );
}
