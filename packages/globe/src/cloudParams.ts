import { WORLD_RADIUS, elevationToUnits } from "@postmark/game-core";

/** Real-world altitude of the cloud layer (metres above sea level). */
export const CLOUD_ALTITUDE_M = 3200;

export function createCloudUniforms() {
  return {
    uCloudTime: { value: 0 },
    // Off by default to match the clear Geographical Adventures look; weather can turn it up.
    uCloudCover: { value: 0 },
  };
}
export type CloudUniforms = ReturnType<typeof createCloudUniforms>;

export const cloudRadius = () => WORLD_RADIUS + elevationToUnits(CLOUD_ALTITUDE_M);
