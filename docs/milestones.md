# Milestones

Delivery plan for the prototype phase. Each milestone ends in something playable from a link.
The full game plan (eras, company, endgame, monetization) lives in the design document.

| Milestone | Goal | Status |
| --- | --- | --- |
| **M0 Foundation** | Monorepo, Next.js shell, client-only game canvas, data pipeline | Done |
| **M1 Flight on a real Earth** | Real elevation, coastlines, lakes, rivers; atmosphere; day/night; flyable plane; landmarks | Done (first pass) |
| **M1.5 Sharper Earth** | High-resolution terrain near the plane, clouds | Done |
| **M2 First delivery** | Letters, balloon marker, parachute drop, stamp, home airfield | Next |
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

## M1.5: what shipped

- Elevation source upgraded to **ETOPO 2022, 60 arc-second** (~1.9 km): 10× sharper than M1.
- Bake works on a 16384 × 8192 grid and writes 1,195 lossless-WebP detail tiles (land and coasts only, 49 MB) plus the global base map.
- **Terrain streaming**: a 45° × 45° detail window (2048² samples) follows the plane, assembled from cached tiles, blended into the base map in both the shaders and the CPU (`TerrainHeights`), so collision, HUD and rendering agree. A HUD note shows while a window loads.
- Real summits restored with a gentler, non-overshooting blend (all eight within 2 m of their real heights).
- Vertical exaggeration lowered from ×12 to ×8 now that slopes are resolved.
- **Clouds**: procedural drifting layer at 3,200 m with climate-like latitude bands, sun-lit with self-shadowing, cloud shadows on the ground, dimming city lights; grazing views fade to avoid an edge-on white band.

## Known issues to pick up

- Restored summits are smooth cones; regions like the Himalaya would benefit from ETOPO 2022 15″ tiles.
- Clouds are a flat layer (no volume when flying through); the volumetric version comes with weather in a later milestone.
- Arid plateaus (e.g. Colorado Plateau) read too pale; land colours need a red-rock or arid palette.
- WebGL 2 / GLSL for now; the WebGPU/TSL port is planned for the M3 performance pass.
- Not yet tested on mobile; the detail window uses ~16 MB of GPU memory as float32 (half-float on devices without float filtering).
- Detail tiles are in git (49 MB); they move to object storage before launch.

## M2: First delivery

1. Letter data model (from, to, clue tier, reward) and a start screen to choose a home city.
2. Delivery target: a balloon over the city, a parachute drop when flying low, a stamp in the Atlas.
3. Home airfield, a simple economy (coins) and a delivery log.
4. The first ten letters, written for the starting region.
