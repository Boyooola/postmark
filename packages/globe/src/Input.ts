import type { FlightInput } from "@postmark/game-core";

export type ActionKey = "drop" | "timeFaster" | "timeSlower" | "respawn" | "help" | "debug";

/** Keyboard + gamepad. WASD/arrows steer (W climbs), Shift boosts, Q slows down, Space drops a parcel. */
export class Input {
  private keys = new Set<string>();
  private listeners: ((a: ActionKey) => void)[] = [];
  private smooth: FlightInput = { pitch: 0, turn: 0, boost: false, slow: false };
  private padDrop = false;

  constructor(private target: Window = window) {
    target.addEventListener("keydown", this.onDown);
    target.addEventListener("keyup", this.onUp);
    target.addEventListener("blur", this.onBlur);
  }

  onAction(fn: (a: ActionKey) => void) {
    this.listeners.push(fn);
  }

  private onDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "SELECT" || (e.target as HTMLElement)?.tagName === "INPUT") return;
    this.keys.add(e.code);
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    if (e.repeat) return;
    const map: Record<string, ActionKey> = {
      Space: "drop",
      Enter: "drop",
      KeyT: "timeFaster",
      KeyG: "timeSlower",
      KeyR: "respawn",
      KeyH: "help",
      Backquote: "debug",
    };
    const a = map[e.code];
    if (a) this.listeners.forEach((l) => l(a));
  };
  private onUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.keys.clear();

  read(dt: number): FlightInput {
    const k = this.keys;
    // Non-inverted by default: W / Up climbs. (An "invert" option comes with settings.)
    let pitch = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    let turn = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    let boost = k.has("ShiftLeft") || k.has("ShiftRight");
    let slow = k.has("KeyQ") || k.has("ControlLeft");

    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      turn += dz(p.axes[0] ?? 0);
      pitch -= dz(p.axes[1] ?? 0); // stick up = climb
      boost ||= (p.buttons[7]?.value ?? 0) > 0.3;
      const a = !!p.buttons[0]?.pressed;
      if (a && !this.padDrop) this.listeners.forEach((l) => l("drop"));
      this.padDrop = a;
      slow ||= (p.buttons[6]?.value ?? 0) > 0.3;
    }

    // Keyboard input is digital; ease it so the plane feels smooth.
    const ease = Math.min(1, dt * 6);
    this.smooth.pitch += (Math.max(-1, Math.min(1, pitch)) - this.smooth.pitch) * ease;
    this.smooth.turn += (Math.max(-1, Math.min(1, turn)) - this.smooth.turn) * ease;
    this.smooth.boost = boost;
    this.smooth.slow = slow;
    return this.smooth;
  }

  dispose() {
    this.target.removeEventListener("keydown", this.onDown);
    this.target.removeEventListener("keyup", this.onUp);
    this.target.removeEventListener("blur", this.onBlur);
  }
}
