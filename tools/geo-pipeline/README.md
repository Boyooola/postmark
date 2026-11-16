# geo-pipeline

Bakes real, public-domain geographic data into the textures and JSON in `apps/web/public/geo/`.
Details on sources, encodings and limits: [docs/geodata.md](../../docs/geodata.md).

```bash
pip install -r requirements.txt
bash fetch_sources.sh              # raw data -> ./raw (gitignored)
python3 bake.py                    # or: python3 bake.py --raw /path/to/raw
```

- Edit `landmarks.source.json` to add landmarks. Mountains with `summitM` get their real summit height restored in the heightmap.
- To use a sharper DEM, put an ETOPO 2022 GeoTIFF in `raw/` named `etopo2022_<res>.tif`; `bake.py` picks it up automatically. This path hasn't been exercised yet, so check the output previews when you first use it.
