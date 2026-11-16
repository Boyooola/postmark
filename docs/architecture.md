# Architecture

```
apps/web               Next.js 16 site: landing, /play (client-only canvas + React HUD)
packages/game-core     Pure TypeScript game logic: scale, geo math, height sampling, flight, landmarks (unit-tested)
packages/globe         three.js renderer: terrain LOD, atmosphere, plane, landmarks, camera, input
tools/geo-pipeline     Python bake: raw public-domain data -> apps/web/public/geo/*
docs/                  geodata, blender pipeline, milestones
```

## Principles

- **Next.js is the website around the game, not the game.** `/play` loads the engine with `dynamic(..., { ssr: false })`. The frame loop never touches React state; the engine pushes a HUD snapshot to a Zustand store about 10 times a second.
- **Game logic doesn't depend on rendering.** `game-core` has no DOM or WebGL code and runs in Node for tests. It uses three.js only for vector maths.
- **Real metres everywhere** except the final vertical exaggeration at render time (see geodata.md).
- **Data is baked, not computed at runtime.** Anything that can be precomputed (masks, lake levels, peak heights, city elevations) is done in the pipeline.

## Rendering (packages/globe)

| Piece | File | Notes |
| --- | --- | --- |
| Engine | `Engine.ts` | Owns renderer, scene, loop, sun, cameras, HUD ticks; `debugView()` helps with screenshots and tests |
| Assets | `assets.ts` | Loads `/geo/*`; decodes Terrarium to a `HeightField` (CPU) and a float texture (GPU); downsizes masks to the GPU's max texture size |
| Terrain | `terrain/TerrainLOD.ts`, `terrainShader.ts` | Six cube faces, quadtree split by distance, one instanced 33×33 grid with skirts; displacement and shading in GLSL |
| Atmosphere | `shaders/chunks.ts`, `Sky.ts`, `atmosphereParams.ts` | Rayleigh + Mie single scattering, 8 view samples, 4 sun samples; shared by sky and terrain (aerial perspective) |
| Plane | `Plane.ts` | Placeholder model and ribbon trails |
| Landmarks | `Landmarks.ts` | Placeholders by kind, optional glTF, beams, CSS2D labels near the camera |
| Input | `Input.ts` | Keyboard and gamepad, eased |

Renderer choice: WebGL 2 + GLSL for the prototype, with a logarithmic depth buffer (near 0.004, far 20,000
units). The WebGPU/TSL port is planned for the M3 performance pass.

## Coordinate conventions

- World: planet centre at the origin, **+Y = north pole**, lat 0 / lon 0 on **+Z**, lon +90° on **+X**.
- Textures: `u = (lon + 180) / 360`, `v = (90 − lat) / 180` (v = 0 at the top), `flipY = false`.
- Plane model space: forward −Z, up +Y, right +X.

## Verification

- `pnpm test` runs the game-core unit tests.
- `pnpm typecheck` and `pnpm build`.
- Visual checks: render `/play` in headless Chrome (SwiftShader) and call `window.__postmark.debugView(lat, lon, aglM, headingDeg, utcHours)` to frame a location and time of day.
