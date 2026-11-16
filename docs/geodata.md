# Geographic data and elevation

Everything the player sees on the globe comes from real, public-domain data, baked by
`tools/geo-pipeline/bake.py`. This page records what we use, how heights are stored, and what is real
versus stylized.

## Sources

| Layer | Source | Resolution | Licence |
| --- | --- | --- | --- |
| Elevation + ocean depth | **ETOPO 2022 Ice Surface, 60 arc-second** (NOAA NCEI), `ETOPO_2022_v1_60s_N90W180_surface.tif` | 21600 × 10800, ~1.9 km at the equator | Public domain (US Government) |
| Fine elevation (selected regions) | **GEBCO_2026 Grid, ice surface, 15 arc-second** (8 GeoTIFF tiles of 90° × 90°) | 86400 × 43200, ~450 m | Free to use with acknowledgement (GEBCO terms of use) |
| Sharp elevation (high mountains) | **Copernicus DEM GLO-90** (1° × 1° tiles, 3 arc-seconds), fetched with `tools/geo-pipeline/fetch_copdem90.ps1` | ~90 m, baked to ~153 m (level 10) | Free with attribution (Copernicus DEM licence) |
| Elevation fallback | ETOPO1 Ice Surface, 10 arc-minute resample (`pyvista/vtk-data`) | ~18.5 km | Public domain |
| Coastlines / land | Natural Earth 1:10m `land` + `minor_islands` | vector | Public domain |
| Lakes | Natural Earth 1:10m `lakes`, `lakes_europe`, `lakes_north_america` | vector | Public domain |
| Rivers | Natural Earth 1:10m `rivers_lake_centerlines` | vector | Public domain |
| Ice | Natural Earth 1:10m `glaciated_areas`, `antarctic_ice_shelves_polys` | vector | Public domain |
| Deserts | Natural Earth 1:10m `geography_regions_polys` (Desert, Erg) | vector | Public domain |
| City lights | Natural Earth 1:10m `urban_areas` + `populated_places_simple` | vector + points | Public domain |
| Cities | Natural Earth 1:10m `populated_places_simple` (top 2,000) | points | Public domain |
| Land colour | **NASA Blue Marble: Next Generation**, base map without topography shading, one month (June preferred), 8 tiles `world.YYYYMM.3x21600x21600.{A-D}{1,2}.jpg` | 86400 × 43200, 500 m (baked to 8192 × 4096) | Public domain; credit NASA Earth Observatory |
| Night lights | **NASA Black Marble 2016**, grayscale, 13500 × 6750 (3 km) | baked to 8192 × 4096 | Public domain |
| Moon | **NASA SVS CGI Moon Kit**, `lroc_color_2k.jpg` | 1024 × 512 | Public domain |
| Stars, Milky Way | **NASA SVS Deep Star Maps 2020**, `starmap_2020_8k.exr` (celestial coordinates) | 8192 × 4096 | Public domain |
| Landmarks | Curated by hand: `tools/geo-pipeline/landmarks.source.json` | points | Ours |

The ETOPO 2022 GeoTIFF (466 MB, SHA-256 `9d27d4b8…a7fd08e`) and the GEBCO_2026 grid (4.2 GB zip, from
gebco.net, "ice surface elevation", Data GeoTiff) can't be fetched by the build machine, so they are
downloaded manually. Without ETOPO 2022 the bake falls back to the 10′ grid; without GEBCO there are simply
no fine tiles.

Credit: *GEBCO Compilation Group (2026) GEBCO 2026 Grid.* · *Blue Marble: Next Generation, NASA Earth Observatory (Reto Stöckli).*

The Blue Marble tiles also have to be downloaded by hand: the "Base Map" page of NASA Earth Observatory's
Blue Marble Next Generation collection, one month, the eight full-resolution tiles.

## Baked outputs (`apps/web/public/geo/`)

All rasters are **equirectangular**: x = longitude −180° → +180°, y = latitude +90° → −90°, sampled at pixel centres.

| File | Size | Contents |
| --- | --- | --- |
| `height.png` | 4096 × 2048 RGB, 10.8 MB | Global base elevation (~9.8 km/px), Terrarium-encoded. Always loaded. |
| `tiles/6/X_Y.webp` | 1,195 tiles of 256 × 256, 49 MB total | Detail elevation (~2.4 km/px), Terrarium, lossless WebP. Only tiles touching land; open ocean uses the base. |
| `tiles.json` | | Tile manifest: level, size, grid, list of tiles present |
| `tiles/8/X_Y.webp` | 994 tiles of 256 × 256, 46 MB total | Fine elevation (~610 m/px) from GEBCO for 10 regions: Himalaya & Karakoram, Alps, Rockies/Grand Canyon/Sierra, central Andes, Norway, Japan, New Zealand, Philippines, Kilimanjaro, Iceland |
| `tiles-8.json` | | Fine tile manifest, incl. the region list |
| `surface.png` | 8192 × 4096 RGBA | Anti-aliased masks: R land, G lake, B river, A ice |
| `coast.png` | 8192 × 4096 RGB | Signed distances, `km = (v − 128) × 0.5` (±64 km): R to the sea coast (positive at sea), G to a lake shore (positive on the lake). Draws smooth coastlines and drives surf lines, shallows and beaches. |
| `color.webp` | 8192 × 4096 sRGB | Satellite true colour (Blue Marble), graded in the terrain shader (`uSatGrade`: brightness, saturation, contrast) |
| `places.png` + `places.json` | 4096 × 2048 RGB | Country and sea IDs for "where am I" (`bake_places.py`, from Natural Earth admin-0 countries and marine areas) |
| `lights.webp`, `moon.jpg`, `stars.webp` | see `bake_sky.py` | Night lights, moon albedo, star field (u = 0.5 − RA/360°, v = 0.5 − Dec/180°) |
| `extras.png` | 4096 × 2048 RGB | R city lights, G desert, B reserved (named "extras", not "aux": `aux` is a reserved file name on Windows) |
| `cities.json` | 2,000 entries | name, country, lat/lon, population, capital flag, elevation |
| `landmarks.json` | 43 entries | landmark data plus ground elevation sampled from the DEM |
| `meta.json` | | sizes, encodings, sources, bake statistics |

Tile `X_Y` covers longitude `−180 + X·5.625°` eastwards and latitude `90 − Y·5.625°` southwards (64 × 32
tiles cover the globe; together they form a 16384 × 8192 grid).

### Height encoding

All height rasters use the **Terrarium** encoding, also used by public elevation tile services:

```
elevation_m = R * 256 + G + B / 256 - 32768
```

- Vertical datum: mean sea level. Positive = land elevation, negative = ocean depth.
- Stored in whole metres (B = 0). ETOPO 2022's measured global accuracy is about 7 m RMSE, so finer steps would only make files bigger.
- Ranges in the current bake: detail grid −10,676 m to +8,909 m; base map −10,338 m to +7,298 m (averaging lowers the peaks; up close the detail grid takes over).
- Tiles are lossless WebP (about 30% smaller than PNG and bit-identical once decoded).

### Consistency rules applied at bake time (on the 16384 × 8192 working grid)

1. **Coastlines win.** Where Natural Earth says land, elevation is raised to at least +1 m; where it says sea, lowered to at most −2 m.
2. **Lakes are flat.** Each lake (3,791 of them) gets one water level: the median elevation of its shoreline. The Caspian Sea sits below sea level.
3. **Real summits are restored.** Averaging still trims peaks, so each mountain in the landmark list is blended towards its real summit with a Gaussian weight (σ = 6 km at level 6, 2 km in the fine tiles). The blend never overshoots far from the peak, and a small correction loop makes the sampled summit match. The fine GEBCO data needs much less help (Everest 8,341 m before, Aconcagua 6,571 m, Fuji 3,543 m). Level-6 numbers:

| Peak | ETOPO 2022 grid | After | Real |
| --- | --- | --- | --- |
| Everest | 7,228 m | 8,847 m | 8,849 m |
| Aconcagua | 5,594 m | 6,959 m | 6,961 m |
| Denali | 5,289 m | 6,190 m | 6,190 m |
| Kilimanjaro | 5,163 m | 5,894 m | 5,895 m |
| Matterhorn | 3,081 m | 4,478 m | 4,478 m |
| Mount Fuji | 2,815 m | 3,775 m | 3,776 m |
| Mayon | 1,188 m | 2,461 m | 2,463 m |
| Table Mountain | 510 m | 1,084 m | 1,085 m |

Add a mountain to `landmarks.source.json` with `summitM` and re-bake to restore it too.

## How the game uses it

- **Base map:** decoded once into a `Float32Array` (`HeightField`) and a float texture.
- **Detail window (level 6):** `DetailTerrain` assembles 8 × 8 tiles (45° × 45°, 2048 × 2048 samples) around the plane into one float texture. It re-centres when the plane is 1.75 tiles from the centre; the old window stays live while the new one loads, and decoded tiles are cached (192 tiles).
- **Fine window (level 8):** a second `DetailTerrain` does the same with level-8 tiles (8 × 8 tiles = 11.25°). Where no fine tile exists it fills from the level-6 data, and it switches itself off entirely when no fine tiles are near the plane.
- **Sharp window (level 10):** a third `DetailTerrain` (8 × 8 tiles = 2.8°, ~153 m) over 13 mountain regions, only for tiles with ≥ 500 m of relief; gaps are filled from level 8/6. While it is active the terrain mesh refines two levels deeper near the camera.
- **Blending:** `TerrainHeights` (game-core, CPU) and `heightAt()` (GLSL) both return base → detail → fine → sharp, each fading in over the outer 6% of its window. Collision, landmark placement and rendering always agree.

## World scale (game-core `constants.ts`)

| Quantity | Value | Why |
| --- | --- | --- |
| Planet radius | 1000 world units = 6,371 km | true proportions; 1 unit = 6.371 km |
| Vertical exaggeration | **×4** (×12 with the 18 km data, ×8 with 1.9 km) | at ~610 m the real slopes are steep enough; more turns ranges into needles |
| Landmark display scale | ×6 on top of the exaggeration | a 330 m tower must be readable from cruising altitude |
| Cloud layer | 3,200 m | procedural, see below |
| Cruising altitude | 16,000 m, band 11,000–20,000 m (and ≥ 2,500 m above the ground) | keeps the high, curved-horizon view; the plane levels out softly near either limit |
| Cruise speed | 5 units/s (boost 12) | time is compressed so continents take minutes |

All data, physics and HUD numbers stay in **real metres**. Only rendering and the collision surface (so it
matches what you see) use the exaggerated heights.

## What is real and what is stylized

| Real data | Stylized |
| --- | --- |
| Continents, coastlines, islands, lakes, rivers, ice | Colour grading of the satellite image (darker, muted); bare rock on steep faces |
| Land colour from satellite imagery (~4.9 km) | |
| Terrain at ~2.4 km near the plane, ~9.8 km elsewhere | Relief detail below ~2 km: domain-warped ridged noise ("erosion"), shading only, strongest on mountains, faded per octave so it never shimmers |
| Ocean depth and colour by depth; coast and lake-shore distance | Waves, sun glitter and surf lines on coasts and lakes (animated, procedural) |
| Terrain shadows (ray-marched through the real heights) | Curved horizon: drawn as a planet 1/5 of Earth's radius (render only) |
| | Night-light points when flying low |
| Summit heights of listed peaks | Snowline (latitude-based curve) |
| Positions of cities and landmarks | Clouds (procedural, off by default) |

## Known limits and next steps

- **More fine regions:** add a box to `REGIONS` in `bake_detail.py`. Covering all land at level 8 would be roughly 600–800 MB.
- **Hosting:** ~500 MB of tiles live in git for now (levels 6, 8 and 10). Before launch, move `tiles/` to object storage plus a CDN and keep only the bake in the repo.
- Restored summits are smooth cones; the real ridgelines need finer data.
- The night-light texture is a proxy, not satellite night imagery. Clouds are a single procedural layer, not real weather.
- Country borders are deliberately not drawn (see the design plan's risk table).

## Re-baking

```bash
pip install -r tools/geo-pipeline/requirements.txt
pnpm geo:fetch    # Natural Earth + fallback DEM into tools/geo-pipeline/raw (gitignored)
# put ETOPO_2022_v1_60s_N90W180_surface.tif in tools/geo-pipeline/raw/ as well
pnpm geo:bake     # writes apps/web/public/geo/* (about 2.5 minutes, ~3 GB RAM)
# satellite colour: put the 8 Blue Marble tiles in a folder, then
python3 tools/geo-pipeline/bake_color.py --bmng <that folder>     # ~1 minute; also refreshes coast.png
# (pnpm geo:bake also runs bake_places.py: country and sea lookup for the HUD)
# sky: python3 tools/geo-pipeline/bake_sky.py --lights BlackMarble_2016_3km_gray.jpg --moon lroc_color_2k.jpg --stars starmap_2020_8k.exr
# fine tiles: unzip the GEBCO_2026 GeoTIFFs into a folder, then
python3 tools/geo-pipeline/bake_detail.py --gebco <that folder>   # ~1.5 minutes, reads with memory maps
# sharp mountains: run tools/geo-pipeline/fetch_copdem90.ps1 (Windows) for the Copernicus tiles, then
python3 tools/geo-pipeline/bake_detail10.py --copdem <copdem90 folder> --gebco <gebco folder>
```
