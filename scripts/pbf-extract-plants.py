#!/usr/bin/env python3
"""Extract power=plant features from an .osm.pbf into Overpass-shaped JSON.

Memory-lean three-pass design (no area assembler, so it copes with
country-sized files like France/Germany in a few hundred MB of RAM):

  pass 1: power=plant relations → member way ids
  pass 2: power=plant ways + relation-member ways → node refs
  pass 3: node locations for exactly those refs

Centroids are the mean of the geometry's node locations — plenty for a
point-on-map. Output matches Overpass `out tags center`, so
scripts/build-data.mjs consumes it unchanged.

  python3 scripts/pbf-extract-plants.py country.osm.pbf out.json
"""
import json
import sys

import osmium


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pbf_path, out_path = sys.argv[1:3]

    # ---- pass 1: plant relations and their member ways
    relations = []  # {id, tags, member_way_ids}
    rel_member_ways: set[int] = set()
    for obj in osmium.FileProcessor(pbf_path, osmium.osm.RELATION).with_filter(
        osmium.filter.KeyFilter("power")
    ):
        if obj.tags.get("power") != "plant":
            continue
        ways = [m.ref for m in obj.members if m.type == "w"]
        if not ways:
            continue
        relations.append({"id": obj.id, "tags": dict(obj.tags), "ways": ways})
        rel_member_ways.update(ways)

    # ---- pass 2: plant ways + relation-member ways → node refs
    plant_ways = []  # {id, tags, refs}
    way_refs: dict[int, list[int]] = {}
    needed_nodes: set[int] = set()
    for obj in osmium.FileProcessor(pbf_path, osmium.osm.WAY).with_filter(
        osmium.filter.KeyFilter("power")
    ):
        if obj.tags.get("power") != "plant":
            continue
        refs = [n.ref for n in obj.nodes]
        needed_nodes.update(refs)
        plant_ways.append({"id": obj.id, "tags": dict(obj.tags), "refs": refs})
    if rel_member_ways:
        for obj in osmium.FileProcessor(pbf_path, osmium.osm.WAY).with_filter(
            osmium.filter.IdFilter(rel_member_ways)
        ):
            refs = [n.ref for n in obj.nodes]
            needed_nodes.update(refs)
            way_refs[obj.id] = refs

    # ---- pass 3: node plants + locations for needed refs
    node_plants = []
    locations: dict[int, tuple[float, float]] = {}
    if needed_nodes:
        for obj in osmium.FileProcessor(pbf_path, osmium.osm.NODE).with_filter(
            osmium.filter.IdFilter(needed_nodes)
        ):
            locations[obj.id] = (obj.location.lon, obj.location.lat)
    for obj in osmium.FileProcessor(pbf_path, osmium.osm.NODE).with_filter(
        osmium.filter.KeyFilter("power")
    ):
        if obj.tags.get("power") != "plant":
            continue
        node_plants.append(
            {
                "type": "node",
                "id": obj.id,
                "tags": dict(obj.tags),
                "lat": round(obj.location.lat, 7),
                "lon": round(obj.location.lon, 7),
            }
        )

    def centroid(refs) -> dict | None:
        lons, lats, n = 0.0, 0.0, 0
        for r in refs:
            loc = locations.get(r)
            if loc:
                lons += loc[0]
                lats += loc[1]
                n += 1
        if not n:
            return None
        return {"lon": round(lons / n, 7), "lat": round(lats / n, 7)}

    elements = list(node_plants)
    for way in plant_ways:
        c = centroid(way["refs"])
        if c:
            elements.append({"type": "way", "id": way["id"], "tags": way["tags"], "center": c})
    for rel in relations:
        all_refs = [r for wid in rel["ways"] for r in way_refs.get(wid, [])]
        c = centroid(all_refs)
        if c:
            elements.append({"type": "relation", "id": rel["id"], "tags": rel["tags"], "center": c})

    with open(out_path, "w") as fh:
        json.dump({"generator": f"pbf-extract-plants ({pbf_path})", "elements": elements}, fh)
    print(f"{out_path}: {len(elements)} plants ({len(node_plants)} nodes, {len(plant_ways)} ways, {len(relations)} relations)")


if __name__ == "__main__":
    main()
