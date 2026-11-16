import { Vector3 } from "three";
import { WORLD_RADIUS } from "@postmark/game-core";

/**
 * Atmosphere tuning, in world units (1 u = 6.371 km). The real atmosphere's
 * scale height is ~1.3 u; ours is much thicker (8.5 u) because the plane
 * cruises high and the sky should still look like a daytime sky up there.
 * The scattering coefficients are scaled down to keep roughly Earth's total
 * optical depth (and so the same blue).
 */
export function createAtmosphereUniforms(sunDir: Vector3) {
  return {
    uSunDir: { value: sunDir },
    uRadius: { value: WORLD_RADIUS },
    uAtmoRadius: { value: WORLD_RADIUS + 60 },
    uScaleHeight: { value: 8.5 },
    uBetaR: { value: new Vector3(0.0056, 0.013, 0.032) },
    uBetaM: { value: 0.0018 },
    uSunIntensity: { value: 24.0 },
  };
}
export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>;
