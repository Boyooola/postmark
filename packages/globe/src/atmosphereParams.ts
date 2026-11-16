import { Vector3 } from "three";
import { WORLD_RADIUS } from "@postmark/game-core";

/**
 * Atmosphere tuning, in world units (1 u = 6.371 km). The real atmosphere's
 * scale height is ~1.3 u; ours is thicker so the limb glow reads from orbit,
 * and the scattering coefficients are scaled down to keep the same optical
 * depth (and the same blue) as Earth's.
 */
export function createAtmosphereUniforms(sunDir: Vector3) {
  return {
    uSunDir: { value: sunDir },
    uRadius: { value: WORLD_RADIUS },
    uAtmoRadius: { value: WORLD_RADIUS + 28 },
    uScaleHeight: { value: 3.6 },
    uBetaR: { value: new Vector3(0.0128, 0.0298, 0.073) },
    uBetaM: { value: 0.004 },
    uSunIntensity: { value: 24.0 },
  };
}
export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>;
