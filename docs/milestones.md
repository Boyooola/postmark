# Milestones

Delivery plan for the prototype phase. Each milestone ends in something playable from a link.
The full game plan (eras, company, endgame, monetization) lives in the design document.

| Milestone | Goal | Status |
| --- | --- | --- |
| **M0 Foundation** | Monorepo, Next.js shell, client-only game canvas, data pipeline | Done |
| **M1 Flight on a real Earth** | Real elevation, coastlines, lakes, rivers; atmosphere; day/night; flyable plane; landmarks | Done (first pass) |
| **M1.5 Sharper Earth** | High-resolution terrain near the plane, clouds | Done |
| **M1.6 Flight UI** | Geographical Adventures-style HUD and camera; first delivery loop | Done |
| **M1.7 Look pass** | Geographical Adventures colours, rugged relief, ocean waves and surf, Blender plane | Done |
| **M1.8 Fine terrain + Blender assets** | GEBCO ~610 m terrain for 10 regions, second streaming window, Blender parcel/balloon/landmarks | Done |
| **M2 First delivery** | Letters, stamps, home airfield, Atlas (the drop loop already exists) | Next |
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

## M1.6: Flight UI (Geographical Adventures style)

- Globe view removed; one high chase camera that shows the curve of the Earth, wider field of view when boosting.
- Plane cruises at 9,000 m and faster (cruise 5 u/s, boost 12 u/s); boost runs on an energy bar that drains and refills.
- HUD rebuilt with no panels: three destinations across the top (country, city, direction arrow), a boost/speed dial with the run timer (bottom left), and a compass dial with turning N/E/S/W letters (bottom right). Delivery messages appear briefly; a controls hint fades out by itself.
- Everything else (altitude, coordinates, fps, streaming, "Fly to" landmark menu) moved to a developer overlay on the backtick key.
- Delivery loop: game-core `Deliveries` picks three well-separated destinations (capitals and cities over 1 million), a striped hot-air balloon floats over each, and **Space** drops a parcel that keeps some of the plane's speed, opens a parachute and drifts down. Landing within 80 km of a destination delivers it and opens a new one. Covered by unit tests and an in-browser check.
- Atmosphere retuned (thicker, same overall optical depth) so the sky stays blue at cruising altitude.

## M1.7: Look pass

- Terrain palette reworked to muted natural tones: dark forest and green lowlands, steppe and sand in dry belts, red rock on arid highlands, grey-brown rock with lighter crests, snow above a latitude-dependent snowline.
- Rugged relief: domain-warped ridged multifractal detail on mountains (normals only), with ambient occlusion in gullies and stronger, lower-ambient sunlight.
- Ocean: colour by real depth, five travelling wave trains plus ripples, sun glitter, darker sky reflection, and white surf bands rolling in along every coast from a baked coastline distance field (`coast.png`). Thin beaches on low coasts.
- Less haze at cruising altitude; clouds off by default.
- The player's plane is now a Blender model (`tools/blender/mailplane.blend` to `mailplane.glb`), with a code placeholder as fallback.

## M1.8: Fine terrain and Blender assets

- GEBCO_2026 15″ grid baked into 994 level-8 tiles (~610 m, 46 MB) for the Himalaya & Karakoram, Alps, Rockies/Grand Canyon/Sierra, central Andes, Norway, Japan, New Zealand, Philippines, Kilimanjaro and Iceland (`bake_detail.py`, memory-mapped, ~1.5 min).
- A second streaming window (11.25°) layers the fine data over the level-6 window; off automatically outside those regions. CPU and GPU blend base → detail → fine identically (tested).
- Vertical exaggeration ×8 → ×4 now that slopes are real; cruising altitude raised to 16,000 m to keep the view; synthetic relief reduced where fine data exists; rivers re-baked thinner.
- Blender: parachute parcel, hot-air balloon (gores recoloured per country) and five landmarks (Eiffel Tower, Great Pyramid, Big Ben, Burj Khalifa, CN Tower), all in `tools/blender/postmark-assets.blend`; the plane re-exported with merged meshes.

## Known issues to pick up

- Outside the 10 fine regions terrain is ~2.4 km; Denali, Table Mountain and the Caucasus are not covered yet.
- Mountain detail between 610 m and the screen is procedural, not real erosion; real high-resolution normal maps (ETOPO 15″ / Copernicus) would be the next step for exact ridgelines.
- Balloons use colour stripes; flags (as in Geographical Adventures) need flag art.
- No sounds yet for drops and deliveries.
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
