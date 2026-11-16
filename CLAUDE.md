# Postmark: notes for Claude

- pnpm monorepo: `apps/web` (Next.js 16), `packages/game-core` (pure TS logic + vitest), `packages/globe` (three.js renderer), `tools/geo-pipeline` (Python bake).
- Read `docs/architecture.md` and `docs/geodata.md` before changing rendering, scale or data.
- Units: data, physics and HUD use real metres. Rendering multiplies elevations by `VERTICAL_EXAGGERATION` (game-core `constants.ts`). Never hard-code a scale elsewhere.
- Coordinates: +Y north, lon 0 on +Z, lon +90 on +X; equirectangular textures with v = 0 at the top, `flipY = false`.
- Never server-render the game; the engine must not drive React state per frame (HUD store is updated ~10 Hz).
- Baked files in `apps/web/public/geo/` are generated: change `tools/geo-pipeline/*` and re-run `pnpm geo:bake` instead of editing them.
- Before committing: `pnpm test`, `pnpm typecheck`, `pnpm build`. For visual changes, screenshot `/play` (see docs/architecture.md, Verification).
