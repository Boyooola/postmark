# Architecture

```
apps/web               Next.js 16 site: landing, /play (client-only canvas + React HUD)
packages/game-core     Pure TypeScript game logic: scale, geo math, height sampling, flight, deliveries, places (unit-tested)
packages/globe         three.js renderer: terrain LOD, atmosphere, plane, balloons, parcels, curved horizon, camera, input
tools/geo-pipeline     Python bake: raw public-domain data -> apps/web/public/geo/*
docs/                  geodata, blender pipeline, milestones
```

## Principles

- **Next.js is the website around the game, not the game.** `/play` loads the engine with `dynamic(..., { ssr: false })`. The frame loop never touches React state; the engine pushes a HUD snapshot to a Zustand store about 10 times a second, and one-off game events (delivered, missed) through `onEvent`.
- **UI follows Geographical Adventures:** no panels or cards in flight, just text with a soft shadow. Where you are (country or sea) at the top; one arrow at the bottom pointing to the open delivery, with its name and distance; boost dial and timer bottom left; compass bottom right. Developer readouts live behind the backtick key.
- **Game logic doesn't depend on rendering.** `game-core` has no DOM or WebGL code and runs in Node for tests. It uses three.js only for vector maths.
- **Real metres everywhere** except the final vertical exaggeration at render time (see geodata.md).
- **Data is baked, not computed at runtime.** Anything that can be precomputed (masks, lake levels, peak heights, city elevations) is done in the pipeline.

## Rendering (packages/globe)

| Piece | File | Notes |
| --- | --- | --- |
| Engine | `Engine.ts` | Owns renderer, scene, loop, sun, cameras, HUD ticks; `debugView()` helps with screenshots and tests |
| Assets | `assets.ts` | Loads `/geo/*` (incl. the tile manifest); decodes Terrarium to a `HeightField` (CPU) and a float texture (GPU); downsizes masks to the GPU's max texture size |
| Terrain | `terrain/TerrainLOD.ts`, `terrainShader.ts` | Six cube faces, quadtree split by distance, one instanced 33×33 grid with skirts; displacement in GLSL; shading = palette, procedural relief detail, ocean waves/glitter/surf from the coast distance field |
| Terrain streaming | `terrain/DetailTerrain.ts` + game-core `terrainHeights.ts` | Three windows around the plane: level 6 (45°, ~2.4 km) everywhere, level 8 (11.25°, ~610 m) in fine regions and level 10 (2.8°, ~153 m, Copernicus) over high mountains; `heightAt()` in GLSL and `TerrainHeights.sample()` on the CPU blend base → detail → fine → sharp identically |
| Models | `models.ts` | Shared glTF template cache, cloning with per-instance materials (balloon colours) |
| Clouds | `Clouds.ts`, `cloudParams.ts`, `cloudChunk` | Procedural layer at 3,200 m; the same density function shades clouds and casts shadows on terrain |
| Curved horizon | `bend.ts` (`WorldBend` + `bendChunk`) | Render-only: the world is drawn on a sphere of radius R / curvature (default 5) touching the real one under the camera; ground distance and height are kept, so nearby terrain is unchanged. Terrain bends in its vertex shader, props are bent just before drawing and restored after, and the sky occludes against the drawn sphere (`uPlanetC`, `uPlanetR`). Physics, collisions and the HUD never see bent positions |
| Shadows | `terrainShadow()` in `terrainShader.ts` | Per-pixel march towards the sun through `heightAt()` (24 geometric steps), soft penumbra; long evening shadows of real ranges |
| Sky, day and night | `Sky.ts`, game-core `astro.ts` | A game clock on today's real date runs 72× (one day = 20 min); sun and moon positions come from low-precision ephemerides (seasons, moon phases), the star map turns with sidereal time. Moon lit by the sun (phase), soft halo; night lights from Black Marble; auroras ray-marched in a 100–300 km shell around the geomagnetic poles, on the night side |
| Atmosphere | `shaders/chunks.ts`, `Sky.ts`, `atmosphereParams.ts` | Rayleigh + Mie single scattering, 8 view samples, 4 sun samples; shared by sky and terrain (aerial perspective) |
| Plane | `Plane.ts` | Loads the Blender glTF (`/models/aircraft/mailplane.glb`), placeholder fallback, ribbon trails |
| Where am I | game-core `places.ts`, `places.png` | Country or sea under the plane, for the top of the HUD |
| Input | `Input.ts` | Keyboard and gamepad, eased; Space/A drops a parcel |
| Deliveries | game-core `deliveries.ts`, globe `Balloons.ts`, `Parcels.ts` | Destinations, balloons over them, parachute parcels; landing point decides the delivery |

Renderer choice: WebGL 2 + GLSL for the prototype, with a normal depth buffer (near 0.25, far 20,000 units).
A logarithmic depth buffer would write depth per fragment and disable the GPU's early depth test, so terrain
hidden behind mountains would still run the full terrain shader.

Performance budget: atmosphere (sunlight, in-scatter, transmittance) is computed per vertex; the fragment
shader does 5 height taps, a 16-step shadow march, and relief noise only where it is visible. Render
resolution adapts to the frame rate (50–150% of CSS pixels, `adaptResolution()` in `Engine.ts`; the
backtick overlay shows fps and the current scale). Fine-terrain gaps are filled from a coarse grid and
spread over frames so streaming doesn't stall the main thread. The WebGPU/TSL port is planned for the M3 performance pass.

## Coordinate conventions

- World: planet centre at the origin, **+Y = north pole**, lat 0 / lon 0 on **+Z**, lon +90° on **+X**.
- Textures: `u = (lon + 180) / 360`, `v = (90 − lat) / 180` (v = 0 at the top), `flipY = false`.
- Plane model space: forward −Z, up +Y, right +X.
- Everything in world space is the real sphere. Only drawing goes through the curved-horizon bend (`bend.ts`); never feed bent positions back into game logic.

## Verification

- `pnpm test` runs the game-core unit tests.
- `pnpm typecheck` and `pnpm build`.
- Visual checks: render `/play` in headless Chrome (SwiftShader) and call `window.__postmark.debugView(lat, lon, altitudeM, headingDeg, utcHours)` to frame a location and time of day.
