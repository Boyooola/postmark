#!/usr/bin/env bash
# Downloads the raw, public-domain source data for the geo bake into ./raw
# (gitignored). Usage: bash tools/geo-pipeline/fetch_sources.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw && cd raw

# Global relief (land + ocean depth), ETOPO1 Ice Surface resampled to 10 arc-minutes.
[ -f ETOPO_10min_Ice.vtp ] || curl -fL -o ETOPO_10min_Ice.vtp \
  https://raw.githubusercontent.com/pyvista/vtk-data/master/Data/EarthModels/ETOPO_10min_Ice.vtp

# Natural Earth 1:10m vectors.
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_10m_land ne_10m_minor_islands ne_10m_lakes ne_10m_lakes_europe ne_10m_lakes_north_america \
         ne_10m_rivers_lake_centerlines ne_10m_glaciated_areas ne_10m_antarctic_ice_shelves_polys \
         ne_10m_urban_areas ne_10m_populated_places_simple ne_10m_geography_regions_polys; do
  [ -f "$f.geojson" ] || curl -fL -o "$f.geojson" "$NE/$f.geojson"
done

echo "Raw sources ready in $(pwd)"
echo "Optional: for sharper terrain, download an ETOPO 2022 GeoTIFF from NOAA and save it here as etopo2022_<res>.tif"
