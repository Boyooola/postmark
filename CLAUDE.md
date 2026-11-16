# Postmark: notes for Claude

- pnpm monorepo: `apps/web` (Next.js 16), `packages/game-core` (pure TS logic + vitest), `packages/globe` (three.js renderer), `tools/geo-pipeline` (Python bake).
- Read `docs/architecture.md` and `docs/geodata.md` before changing rendering, scale or data.
- Units: data, physics and HUD use real metres. Rendering multiplies elevations by `VERTICAL_EXAGGERATION` (game-core `constants.ts`). Never hard-code a scale elsewhere.
- Coordinates: +Y north, lon 0 on +Z, lon +90 on +X; equirectangular textures with v = 0 at the top, `flipY = false`. The curved horizon (`packages/globe/src/bend.ts`) is render-only: game logic always uses real positions.
- Never server-render the game; the engine must not drive React state per frame (HUD store is updated ~10 Hz).
- Baked files in `apps/web/public/geo/` (incl. `tiles/`) are generated: change `tools/geo-pipeline/*` and re-run `pnpm geo:bake` instead of editing them. The ETOPO 2022 GeoTIFF must be placed in `tools/geo-pipeline/raw/` by hand, and fine tiles come from `bake_detail.py --gebco <dir>` (see docs/geodata.md).
- 3D assets come from `tools/blender/postmark-assets.blend` (one collection per asset); follow docs/blender-pipeline.md for node names and export settings.
- Terrain heights must stay identical on CPU and GPU: `TerrainHeights.sample()` (game-core) mirrors `heightAt()` (globe `shaders/chunks.ts`). Change both together.
- Before committing: `pnpm test`, `pnpm typecheck`, `pnpm build`. For visual changes, screenshot `/play` (see docs/architecture.md, Verification).
