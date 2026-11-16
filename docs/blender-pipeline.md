# Blender → game pipeline

Landmarks and aircraft are modelled in Blender and exported as glTF binary (`.glb`). Until a model exists,
the game draws a placeholder by landmark kind, so models can be added one at a time.

## Landmarks

**Where files go:** `apps/web/public/models/landmarks/<landmark-id>.glb`, where `<landmark-id>` is the `id`
in `tools/geo-pipeline/landmarks.source.json` (e.g. `eiffel-tower`).

**Hook it up:** add `"model": "/models/landmarks/eiffel-tower.glb"` to that landmark in
`landmarks.source.json`, then re-bake (`pnpm geo:bake`). If the file is missing or fails to load, the
placeholder stays and a warning is logged.

### Modelling rules

| Rule | Value | Why |
| --- | --- | --- |
| Units | **Metres**, real size (Eiffel Tower = 330 m tall) | the game applies its own scale (vertical exaggeration × landmark display scale) |
| Up axis | Blender +Z (exporter converts to glTF +Y) | the game stands the model on the local "up" of the globe |
| Origin | Centre of the base, at ground level | the origin is placed exactly on the terrain |
| Facing | Main façade towards Blender −Y | consistent orientation across landmarks |
| Detail | 2k–10k triangles; landmarks are seen from kilometres away | browser performance |
| Materials | Principled BSDF, base colour + roughness; no procedural nodes | only glTF-compatible features survive export |
| Textures | Optional, ≤ 1024 px, embedded in the .glb | keep each file under ~1 MB |
| Style | Clean, slightly simplified silhouettes, soft colours | matches the cozy art direction; silhouette matters more than detail |

### Export settings (File → Export → glTF 2.0)

- Format: **glTF Binary (.glb)**
- Include: Selected Objects, Apply Modifiers
- Transform: **+Y Up** (the default)
- Geometry: UVs, Normals; Compression off for now (we'll add Draco/meshopt in the performance pass)
- Animation: off unless the landmark moves (waterfall spray, windmill)

## Aircraft

Aircraft follow the same rules with these differences:

- Path: `apps/web/public/models/aircraft/<id>.glb`.
- **Units:** modelled in metres, but the game shows the plane at a fixed gameplay size (~0.3 world units long), so real proportions matter more than absolute size.
- **Facing:** nose towards Blender **+Y** (exports as glTF −Z, the game's forward). Wings along X.
- Name the propeller object `propeller` (spun by the game), and add empties named `wingtip_left` and `wingtip_right` for the vapour trails and navigation lights.
- Origin at the centre of mass.

The placeholder mail plane is built in code in `packages/globe/src/Plane.ts`. Replacing it with a glTF is
an M3 task.

## Using Blender with Claude

The Claude desktop app can drive Blender on your machine through its Blender connection. A good workflow:
ask Claude to block out a landmark with these rules, review it in Blender, then export with the settings
above.
