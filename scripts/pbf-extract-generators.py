#!/usr/bin/env python3
"""Extract wind power=generator features from an .osm.pbf.

Some mapping communities (Finland, Austria, Estonia…) tag individual wind
turbines as power=generator and never draw a power=plant around the farm —
so whole GW-scale fleets are invisible to the plants pipeline. This pulls
every wind generator with its capacity so scripts/cluster-wind.mjs can
aggregate them into synthetic farm stations.

  python3 scripts/pbf-extract-generators.py country.osm.pbf out.json

Output: Overpass-shaped {elements: [{type, id, tags, center|lat/lon}]}.
"""
import json
import sys

import osmium


def is_wind(tags) -> bool:
    if tags.get("power") != "generator":
        return False
    src = (tags.get("generator:source") or tags.get("generator:method") or "").lower()
    return "wind" in src


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pbf_path, out_path = sys.argv[1:3]

    elements = []
    way_refs: dict[int, tuple[dict, list[int]]] = {}
    needed: set[int] = set()

    # pass 1: nodes are self-locating; ways need their first node resolved
    for obj in osmium.FileProcessor(pbf_path, osmium.osm.NODE | osmium.osm.WAY).with_filter(
        osmium.filter.KeyFilter("power")
    ):
        tags = dict(obj.tags)
        if not is_wind(tags):
            continue
        if obj.is_node():
            elements.append(
                {
                    "type": "node",
                    "id": obj.id,
                    "lat": obj.location.lat,
                    "lon": obj.location.lon,
                    "tags": tags,
                }
            )
        else:
            refs = [n.ref for n in obj.nodes]
            if refs:
                way_refs[obj.id] = (tags, refs)
                needed.update(refs[:1])  # first node is enough for a turbine

    # pass 2: locations for the way anchors
    locations: dict[int, tuple[float, float]] = {}
    if needed:
        for obj in osmium.FileProcessor(pbf_path, osmium.osm.NODE).with_filter(
            osmium.filter.IdFilter(needed)
        ):
            locations[obj.id] = (obj.location.lon, obj.location.lat)

    for way_id, (tags, refs) in way_refs.items():
        loc = locations.get(refs[0])
        if not loc:
            continue
        elements.append(
            {
                "type": "way",
                "id": way_id,
                "center": {"lon": loc[0], "lat": loc[1]},
                "tags": tags,
            }
        )

    with open(out_path, "w") as f:
        json.dump({"elements": elements}, f)
    print(f"{out_path}: {len(elements)} wind generators")


if __name__ == "__main__":
    main()
