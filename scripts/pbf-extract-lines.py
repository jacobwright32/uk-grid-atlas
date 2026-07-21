#!/usr/bin/env python3
"""Extract transmission lines from an .osm.pbf into Overpass-shaped JSON.

Two-pass, memory-safe: pass 1 finds power=line ways whose voltage matches,
pass 2 resolves their node locations. Output matches the Overpass
`out tags geom` element shape, so scripts/build-data.mjs consumes it as-is.

  python3 scripts/pbf-extract-lines.py scotland.osm.pbf out.json "400000|275000|132000"

Requires:  pip install osmium
"""
import json
import re
import sys

import osmium


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    pbf_path, out_path, volt_pattern = sys.argv[1:4]
    volt_re = re.compile(volt_pattern)

    # ---- pass 1: matching ways + their node refs
    ways = []
    needed_nodes: set[int] = set()
    for obj in osmium.FileProcessor(pbf_path, osmium.osm.WAY).with_filter(
        osmium.filter.KeyFilter("power")
    ):
        if obj.tags.get("power") != "line":
            continue
        voltage = obj.tags.get("voltage")
        if not voltage or not volt_re.search(voltage):
            continue
        refs = [n.ref for n in obj.nodes]
        ways.append(
            {
                "type": "way",
                "id": obj.id,
                "tags": dict(obj.tags),
                "_refs": refs,
            }
        )
        needed_nodes.update(refs)

    # ---- pass 2: locations for just those nodes (C-side id filter)
    locations: dict[int, tuple[float, float]] = {}
    if needed_nodes:
        for obj in osmium.FileProcessor(pbf_path, osmium.osm.NODE).with_filter(
            osmium.filter.IdFilter(needed_nodes)
        ):
            locations[obj.id] = (obj.location.lon, obj.location.lat)

    # ---- assemble Overpass-shaped output
    elements = []
    dropped = 0
    for way in ways:
        geom = []
        for ref in way.pop("_refs"):
            loc = locations.get(ref)
            if loc:
                geom.append({"lon": round(loc[0], 7), "lat": round(loc[1], 7)})
        if len(geom) < 2:
            dropped += 1
            continue
        way["geometry"] = geom
        elements.append(way)

    with open(out_path, "w") as fh:
        json.dump({"generator": f"pbf-extract-lines ({pbf_path})", "elements": elements}, fh)
    print(f"{out_path}: {len(elements)} ways ({dropped} dropped, {len(needed_nodes)} nodes)")


if __name__ == "__main__":
    main()
