"use client";

import { useEffect, useRef, useState } from "react";
import { Engine } from "@postmark/globe";
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
  const { setHud, setProgress, setError, toggleHelp } = useHud.getState();

  useEffect(() => {
    let e: Engine | null = null;
    let cancelled = false;
    Engine.create({
      container: host.current!,
      assetBase: "/geo",
      onProgress: setProgress,
      onHud: setHud,
      onAction: (a) => a === "help" && toggleHelp(),
    })
      .then((eng) => {
        if (cancelled) return eng.dispose();
        e = eng;
        window.__postmark = eng;
        setEngine(eng);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      e?.dispose();
      delete window.__postmark;
    };
  }, [setHud, setProgress, setError, toggleHelp]);

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

function Arrow({ deg }: { deg: number }) {
  return (
    <span className="arrow" style={{ transform: `rotate(${deg}deg)` }} aria-hidden>
      ▲
    </span>
  );
}

function Compass({ heading }: { heading: number }) {
  const marks = [];
  for (let d = -90; d <= 90; d += 15) {
    const h = (Math.round(heading / 15) * 15 + d + 360) % 360;
    const offset = ((h - heading + 540) % 360) - 180;
    const names: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    marks.push(
      <span key={d} className={names[h] ? "major" : ""} style={{ left: `calc(50% + ${offset * 2.4}px)` }}>
        {names[h] ?? "·"}
      </span>,
    );
  }
  return (
    <div className="compass">
      <div className="tape">{marks}</div>
      <div className="needle" />
      <div className="value">{String(Math.round(heading) % 360).padStart(3, "0")}°</div>
    </div>
  );
}

function Hud({ engine }: { engine: Engine }) {
  const hud = useHud((s) => s.hud);
  const showHelp = useHud((s) => s.showHelp);
  if (!hud) return null;
  const t = hud.telemetry;
  return (
    <div className="hud">
      <Compass heading={t.headingDeg} />

      <section className="panel left">
        <Row k="Altitude" v={`${nf.format(t.altitudeM)} m`} />
        <Row k="Ground" v={`${nf.format(t.groundM)} m`} />
        <Row k="Above ground" v={`${nf.format(t.aglM)} m`} />
        <Row k="Airspeed" v={`${nf.format(t.airspeedKmh)} km/h`} />
        <Row k="Climb" v={`${t.climbDeg.toFixed(0)}°`} />
        {t.scraping && <p className="warn">Terrain! Pull up</p>}
      </section>

      <section className="panel right">
        {hud.landmark && (
          <div className="target">
            <p className="label">Nearest landmark</p>
            <p className="name">
              <Arrow deg={hud.landmark.relativeDeg} /> {hud.landmark.name}
            </p>
            <p className="sub">
              {hud.landmark.detail} · {nf.format(hud.landmark.distanceKm)} km
            </p>
          </div>
        )}
        {hud.city && (
          <div className="target">
            <p className="label">Nearest city</p>
            <p className="name">
              <Arrow deg={hud.city.relativeDeg} /> {hud.city.name}
            </p>
            <p className="sub">
              {hud.city.detail} · {nf.format(hud.city.distanceKm)} km
            </p>
          </div>
        )}
      </section>

      <section className="panel bottom-left">
        <Row k="Position" v={formatLatLon(t)} />
        <Row k="Local time" v={`${hud.localTime}${hud.timeScale === 0 ? " (paused)" : hud.timeScale !== 60 ? ` (×${hud.timeScale / 60})` : ""}`} />
        <Row k="Render" v={`${hud.fps} fps · ${hud.chunks} chunks`} />
      </section>

      <section className="panel bottom-right">
        <label>
          Fly to
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) engine.teleportToLandmark(e.target.value);
              e.target.blur();
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              a landmark…
            </option>
            {[...engine.landmarkList]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.country})
                </option>
              ))}
          </select>
        </label>
        <button onClick={() => engine.setCameraMode(hud.cameraMode === "chase" ? "orbit" : "chase")}>
          {hud.cameraMode === "chase" ? "Globe view" : "Back to plane"}
        </button>
      </section>

      {showHelp && (
        <section className="help">
          <h2>Controls</h2>
          <ul>
            <li><kbd>W</kbd>/<kbd>S</kbd> or <kbd>↑</kbd>/<kbd>↓</kbd> climb / descend</li>
            <li><kbd>A</kbd>/<kbd>D</kbd> or <kbd>←</kbd>/<kbd>→</kbd> turn</li>
            <li><kbd>Shift</kbd> or <kbd>Space</kbd> boost · <kbd>Q</kbd> slow</li>
            <li><kbd>C</kbd> globe view · <kbd>R</kbd> restart here</li>
            <li><kbd>T</kbd>/<kbd>G</kbd> time faster / slower</li>
            <li><kbd>H</kbd> hide this</li>
          </ul>
          <p>Gamepad: left stick to fly, right trigger to boost.</p>
        </section>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <p className="row">
      <span>{k}</span>
      <b>{v}</b>
    </p>
  );
}
