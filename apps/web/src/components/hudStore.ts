import { create } from "zustand";
import type { GameEvent, HudState } from "@postmark/globe";

export interface Toast {
  id: number;
  kind: "good" | "bad";
  title: string;
  detail: string;
}

interface Store {
  hud: HudState | null;
  progress: { label: string; fraction: number };
  error: string | null;
  showHelp: boolean;
  showDebug: boolean;
  toasts: Toast[];
  setHud: (h: HudState) => void;
  setProgress: (label: string, fraction: number) => void;
  setError: (e: string | null) => void;
  toggleHelp: (on?: boolean) => void;
  toggleDebug: () => void;
  pushEvent: (e: GameEvent) => void;
}

let nextToast = 1;
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** The engine pushes HUD snapshots here ~10x a second; React only reads them. */
export const useHud = create<Store>((set, get) => ({
  hud: null,
  progress: { label: "Starting", fraction: 0 },
  error: null,
  showHelp: true,
  showDebug: false,
  toasts: [],
  setHud: (hud) => set({ hud }),
  setProgress: (label, fraction) => set({ progress: { label, fraction } }),
  setError: (error) => set({ error }),
  toggleHelp: (on) => set((s) => ({ showHelp: on ?? !s.showHelp })),
  toggleDebug: () => set((s) => ({ showDebug: !s.showDebug })),
  pushEvent: (e) => {
    const toast: Toast =
      e.type === "delivered"
        ? { id: nextToast++, kind: "good", title: `Delivered to ${e.city}`, detail: `${e.country} · ${nf.format(e.distanceKm)} km from the city` }
        : { id: nextToast++, kind: "bad", title: `Missed ${e.city}`, detail: `Landed ${nf.format(e.distanceKm)} km away` };
    set({ toasts: [...get().toasts, toast].slice(-3) });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== toast.id) }), 3200);
  },
}));
