"use client";

import dynamic from "next/dynamic";

// The game is a client-only canvas: never server-render it.
const Game = dynamic(() => import("./Game"), {
  ssr: false,
  loading: () => <div className="loading">Warming up the engine…</div>,
});

export default function GameLoader() {
  return <Game />;
}
