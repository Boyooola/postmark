# geo-pipeline

Bakes real, public-domain geographic data into the textures and JSON in `apps/web/public/geo/`.
Details on sources, encodings and limits: [docs/geodata.md](../../docs/geodata.md).

```bash
pip install -r requirements.txt   # needs tifffile + imagecodecs for the GeoTIFF
bash fetch_sources.sh              # raw data -> ./raw (gitignored)
python3 bake.py                    # or: python3 bake.py --raw /path/to/raw
```

- Edit `landmarks.source.json` to add landmarks. Mountains with `summitM` get their real summit height restored in the heightmap.
- Put `ETOPO_2022_v1_60s_N90W180_surface.tif` (466 MB, from NOAA) in `raw/` for the sharp terrain; without it the bake falls back to the 10′ ETOPO1 grid. The bake takes about 2 minutes and needs ~3 GB of RAM.
