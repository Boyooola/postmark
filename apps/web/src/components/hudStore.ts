import { create } from "zustand";
import type { HudState } from "@postmark/globe";

interface Store {
  hud: HudState | null;
  progress: { label: string; fraction: number };
  error: string | null;
  showHelp: boolean;
  setHud: (h: HudState) => void;
  setProgress: (label: string, fraction: number) => void;
  setError: (e: string | null) => void;
  toggleHelp: () => void;
}

/** The engine pushes HUD snapshots here ~10x a second; React only reads them. */
export const useHud = create<Store>((set) => ({
  hud: null,
  progress: { label: "Starting", fraction: 0 },
  error: null,
  showHelp: true,
  setHud: (hud) => set({ hud }),
  setProgress: (label, fraction) => set({ progress: { label, fraction } }),
  setError: (error) => set({ error }),
  toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),
}));
