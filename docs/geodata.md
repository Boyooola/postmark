# Geographic data and elevation

Everything the player sees on the globe comes from real, public-domain data, baked into a few files by
`tools/geo-pipeline/bake.py`. This page records what we use, how heights are stored, and what is real
versus stylized.

## Sources

| Layer | Source | Resolution | Licence |
| --- | --- | --- | --- |
| Elevation + ocean depth | ETOPO1 Ice Surface (NOAA NCEI), 10 arc-minute resample from `pyvista/vtk-data` | 2160 × 1081 grid, ~18.5 km at the equator | Public domain (US Government) |
| Coastlines / land | Natural Earth 1:10m `land` + `minor_islands` | vector, ~1 km detail | Public domain |
| Lakes | Natural Earth 1:10m `lakes`, `lakes_europe`, `lakes_north_america` | vector | Public domain |
| Rivers | Natural Earth 1:10m `rivers_lake_centerlines` | vector | Public domain |
| Ice | Natural Earth 1:10m `glaciated_areas`, `antarctic_ice_shelves_polys` | vector | Public domain |
| Deserts | Natural Earth 1:10m `geography_regions_polys` (Desert, Erg) | vector | Public domain |
| City lights | Natural Earth 1:10m `urban_areas` + `populated_places_simple` | vector + points | Public domain |
| Cities | Natural Earth 1:10m `populated_places_simple` (top 2,000) | points | Public domain |
| Landmarks | Curated by hand: `tools/geo-pipeline/landmarks.source.json` | points | Ours |

Attribution is not required for either source, but we credit NOAA and Natural Earth in the game's credits anyway.

## Baked outputs (`apps/web/public/geo/`)

All rasters are **equirectangular**: x = longitude −180° → +180°, y = latitude +90° → −90°, sampled at pixel centres.

| File | Size | Contents |
| --- | --- | --- |
| `height.png` | 4096 × 2048 RGB | Elevation in metres, Terrarium-encoded (below) |
| `surface.png` | 8192 × 4096 RGBA | Anti-aliased masks: R land, G lake, B river, A ice |
| `aux.png` | 4096 × 2048 RGB | R city lights, G desert, B reserved |
| `cities.json` | 2,000 entries | name, country, lat/lon, population, capital flag, elevation |
| `landmarks.json` | 43 entries | landmark data plus ground elevation sampled from the DEM |
| `meta.json` | | sizes, encodings, sources, bake statistics |

### Height encoding

`height.png` uses the **Terrarium** encoding (the same one used by public elevation tile services, so the
runtime decoder will also work for streamed tiles later):

```
elevation_m = R * 256 + G + B / 256 - 32768
```

- Vertical datum: mean sea level. Positive = land elevation, negative = ocean depth.
- Stored in whole metres (B = 0). The source is accurate to about ±10 m, so sub-metre precision would only make the file bigger.
- Range in the current bake: −10,334 m (Mariana Trench area, smoothed) to +8,892 m (Everest after peak restoration).
- The game decodes it once on load into a `Float32Array` (CPU: collision, HUD) and a single-channel float texture (GPU: displacement, slope shading).

### Consistency rules applied at bake time

1. **Coastlines win.** Where Natural Earth says land, the elevation is raised to at least +1 m; where it says sea, it is lowered to at most −2 m. This keeps the crisp vector coastline and the coarse DEM in agreement.
2. **Lakes are flat.** Each lake (3,743 of them) is set to one water level: the median elevation of its shoreline. The Caspian Sea, for example, sits below sea level.
3. **Real summits are restored.** Averaging into 18 km cells flattens peaks (Everest drops to 5,537 m), so for every mountain in the landmark list the bake adds a narrow Gaussian bump (σ ≈ 13 km) until the sampled summit matches the real height:

| Peak | DEM before | After | Real |
| --- | --- | --- | --- |
| Everest | 5,537 m | 8,847 m | 8,849 m |
| Aconcagua | 4,887 m | 6,960 m | 6,961 m |
| Denali | 2,576 m | 6,188 m | 6,190 m |
| Kilimanjaro | 3,445 m | 5,894 m | 5,895 m |
| Matterhorn | 2,467 m | 4,474 m | 4,478 m |
| Mount Fuji | 1,198 m | 3,775 m | 3,776 m |
| Mayon | 174 m | 2,460 m | 2,463 m |
| Table Mountain | 6 m | 1,084 m | 1,085 m |

Add a mountain to `landmarks.source.json` with `summitM` and re-bake to restore it too.

## World scale (game-core `constants.ts`)

| Quantity | Value | Why |
| --- | --- | --- |
| Planet radius | 1000 world units = 6,371 km | true proportions; 1 unit = 6.371 km |
| Vertical exaggeration | ×12 | without it Everest is a 1.4-unit bump on a 1000-unit sphere |
| Landmark display scale | ×4 on top of the exaggeration | a 330 m tower must be readable from a few km up |
| Cruise speed | 2 units/s; HUD shows 360 km/h | time is compressed so flights take minutes, not hours |
| Minimum clearance | 0.15 units (~80 m real) | |
| Ceiling | 15,000 m | |

All data, physics and HUD numbers stay in **real metres**. Only rendering and the collision surface (so it
matches what you see) use the exaggerated heights. The HUD's altitude is real-world-equivalent: flying
just over Everest's summit reads about 8,900 m.

## What is real and what is stylized

| Real data | Stylized |
| --- | --- |
| Continents, coastlines, islands, lakes, rivers, ice | Land colours (generated from latitude, elevation, slope, deserts) |
| Mountain ranges and valleys at ~18 km detail | Fine surface detail below ~18 km: procedural shading only, geometry is untouched |
| Ocean depth and colour by depth | Night-light points when flying low (the light map is ~10 km per pixel) |
| Summit heights of listed peaks | Snowline (latitude-based curve) |
| Positions of cities and landmarks | Landmark placeholder models |

## Known limits and the upgrade path

- **Terrain resolution is the main gap.** 10 arc-minutes is fine from orbit and at cruise altitude, but valleys like Yosemite or the Grand Canyon aren't resolved. The plan, as its own milestone:
  1. Drop-in: `bake.py` already accepts an ETOPO 2022 GeoTIFF (`raw/etopo2022*.tif`, 60″ or 30″) for a 10–20× sharper global base. It has to be downloaded from NOAA manually, because the build machine can't reach NOAA.
  2. Streaming: high-resolution tiles near the plane (Copernicus GLO-90 or Terrarium tiles hosted on our own CDN), decoded with the same Terrarium code, feeding the quadtree's deeper levels.
- The peak bumps are Gaussian, so restored summits look like cones, not real ridgelines. Streaming terrain fixes this.
- The night-light texture is a proxy (urban areas and city points), not real satellite night imagery.
- Disputed borders: we don't draw country borders at all right now (see the design plan's risk table).

## Re-baking

```bash
pip install -r tools/geo-pipeline/requirements.txt
pnpm geo:fetch    # downloads raw sources into tools/geo-pipeline/raw (gitignored)
pnpm geo:bake     # writes apps/web/public/geo/*
```

The bake takes about 20 seconds and is deterministic.
