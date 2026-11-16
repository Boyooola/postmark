# Milestones

Delivery plan for the prototype phase. Each milestone ends in something playable from a link.
The full game plan (eras, company, endgame, monetization) lives in the design document.

| Milestone | Goal | Status |
| --- | --- | --- |
| **M0 Foundation** | Monorepo, Next.js shell, client-only game canvas, data pipeline | Done |
| **M1 Flight on a real Earth** | Real elevation, coastlines, lakes, rivers; atmosphere; day/night; flyable plane; landmarks | Done (first pass) |
| **M1.5 Sharper Earth** | High-resolution terrain near the plane, clouds | Next |
| **M2 First delivery** | Letters, balloon marker, parachute drop, stamp, home airfield | Planned |
| **M3 Feel polish** | Sound, wind, Blender aircraft + first landmark models, settings, perf pass | Planned |
| Gate | "Flying feels great": testers keep flying 5+ minutes unprompted | |

## M0 + M1: what shipped

- `tools/geo-pipeline`: reproducible bake of real elevation, ocean depth, coastlines, 3,743 flattened lakes, rivers, ice, deserts, city lights, 2,000 cities and 43 landmarks. See [geodata.md](geodata.md).
- `packages/game-core`: world scale, geo math, height sampling, arcade flight on a sphere, nearest-landmark search, with unit tests.
- `packages/globe`: three.js renderer.
  - Cube-sphere quadtree terrain, instanced, ~200 chunks per frame, with horizon and frustum culling.
  - Real displacement with water shading by depth, sun glint, snowline, slope rock.
  - Single-scattering atmosphere (sky, limb glow, aerial perspective) and a moving sun with soft terminator.
  - City lights on the night side, stars, eye adaptation.
  - Placeholder mail plane with vapour trails; chase and globe cameras; landmark markers, beams and labels.
- `apps/web`: landing page, `/play` with HUD (altitude, ground elevation, airspeed, compass, nearest landmark and city with direction arrows, local time), a "Fly to landmark" menu, and controls help.

## Known issues to pick up

- Terrain detail is ~18 km per sample (see geodata.md). Fixed by M1.5.
- WebGL 2 with GLSL shaders for now. The WebGPU/TSL port is scheduled for the M3 performance pass (decided for speed of iteration and widest compatibility).
- Night lights are a proxy, not satellite imagery.
- No clouds, weather or wind yet.
- Not yet tested on mobile or touch.

## M1.5: Sharper Earth (next)

1. Swap the global base to ETOPO 2022 at 60″ (about 10× sharper), or 30″ if the download size is acceptable.
2. Add terrain streaming: Terrarium tiles at zoom 8–11 around the plane, from our own bucket, feeding quadtree depths 6–9.
3. A cloud layer: a global cloud-cover texture plus a raymarched or billboard layer at cruise altitude.
4. A per-biome detail texture to replace the procedural noise.

## M2: First delivery

1. Letter data model (from, to, clue tier, reward) and a start screen to choose a home city.
2. Delivery target: a balloon over the city, a parachute drop when flying low, a stamp in the Atlas.
3. Home airfield, a simple economy (coins) and a delivery log.
4. The first ten letters, written for the starting region.
