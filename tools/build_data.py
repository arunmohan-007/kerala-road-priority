"""Rebuild browser data from the three source datasets in the parent folder."""
import colorsys
import json
import math
import re
import warnings
from collections import defaultdict
from pathlib import Path
from statistics import fmean

import openpyxl
import shapefile
from shapely.geometry import LineString, MultiLineString

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent
ALIASES = {
    "trissurkuttipuramroad": "thrissurkuttipuramroad",
    "kayaamkulampathanapuramroad": "kayamkulampathanapuramroad",
    "alappuzhaarthungalroad": "alappuzhaarthungalchellanamroad",
    "ezhankulamenadiroad": "ezhamkulamenadiroad",
}


def key(name):
    normalized = re.sub(r"[^a-z0-9]", "", name.casefold())
    return ALIASES.get(normalized, normalized)


def sheet_rows(path, sheet):
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")
        book = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            return list(book[sheet].values)[1:]
        finally:
            book.close()


def parts(shape):
    stops = [*shape.parts, len(shape.points)]
    return [shape.points[a:b] for a, b in zip(stops, stops[1:]) if b - a >= 2]


def metres(a, b):
    lon, lat = (math.radians(y - x) for x, y in zip(a, b))
    h = math.sin(lat / 2)**2 + math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.sin(lon / 2)**2
    return 12_742_000 * math.asin(min(1, math.sqrt(h)))


def interpolate(line, fraction):
    edges = list(zip(line, line[1:]))
    lengths = [metres(a, b) for a, b in edges]
    target = fraction * sum(lengths)
    for (a, b), length in zip(edges, lengths):
        if length and target <= length:
            return [round(x + (y - x) * target / length, 6) for x, y in zip(a, b)]
        target -= length
    return list(line[-1])


def direction_votes(groups):
    votes = defaultdict(list)
    for group in groups.values():
        for earlier in group:
            for later in group:
                if earlier is later or earlier.record.ROADENDCH != later.record.ROADSTRTCH:
                    continue
                first = [earlier.shape.points[0], earlier.shape.points[-1]]
                second = [later.shape.points[0], later.shape.points[-1]]
                distance, i, j = min(
                    (metres(a, b), i, j) for i, a in enumerate(first) for j, b in enumerate(second)
                )
                if distance < 80:
                    votes[earlier.record.SEC_LABEL].append(i == 0)
                    votes[later.record.SEC_LABEL].append(j == 1)
    return votes


def lab(rgb):
    r, g, b = (c / 12.92 if c <= .04045 else ((c + .055) / 1.055)**2.4 for c in rgb)
    xyz = [(r*.4124 + g*.3576 + b*.1805)/.95047, r*.2126 + g*.7152 + b*.0722,
           (r*.0193 + g*.1192 + b*.9505)/1.08883]
    x, y, z = [v**(1/3) if v > .008856 else 7.787*v + 16/116 for v in xyz]
    return (116*y - 16, 500*(x-y), 200*(y-z))


def assign_colors(roads):
    candidates = {}
    for hue in range(0, 360, 7):
        for saturation in (.65, .9):
            for lightness in (.34, .48, .60):
                rgb = colorsys.hls_to_rgb(hue / 360, lightness, saturation)
                candidates["#" + "".join(f"{round(c*255):02x}" for c in rgb)] = lab(rgb)
    assigned = []
    for road in roads:
        lines = MultiLineString(road["geometry"]["coordinates"]).simplify(.00025)
        neighbors = sorted(
            ((lines.distance(shape), color) for shape, color in assigned),
            key=lambda pair: pair[0],
        )[:8]
        def contrast(color):
            return min((math.dist(candidates[color], other) * (1 + min(distance, .15)*12)
                        for distance, other in neighbors), default=0)
        color = max(candidates, key=contrast) if neighbors else "#233ad2"
        if color not in candidates:
            color = next(iter(candidates))
        road["properties"]["color"] = color
        assigned.append((lines, candidates.pop(color)))


def stats(values):
    return {"min": min(values), "max": max(values), "mean": round(fmean(values), 2)}



def combine_carriageways(stations):
    by_id = {station["id"]: station for station in stations}
    combined = []
    for station in stations:
        match = re.fullmatch(r"(.+\d)([AB])", station["id"])
        if not match or not all(match[1] + suffix in by_id for suffix in "AB"):
            combined.append(station)
            continue
        if match[2] == "B":
            continue
        a, b = (by_id[match[1] + suffix] for suffix in "AB")
        assert a["section"].endswith("A") and b["section"] == a["section"][:-1] + "B", match[1]
        assert a["days"] == b["days"] and a["chainage"] == b["chainage"], match[1]
        combined.append({
            **a,
            "id": match[1],
            "sourceIds": [a["id"], b["id"]],
            "section": [a["section"], b["section"]],
            "aadt": a["aadt"] + b["aadt"],
            "commercial": a["commercial"] + b["commercial"],
            "coordinate": [round((x + y) / 2, 6) for x, y in zip(a["coordinate"], b["coordinate"])],
        })
    assert len({station["id"] for station in combined}) == len(combined)
    return combined


def main():
    features = list(shapefile.Reader(str(next(SOURCE.glob("*/*.shp")))).iterShapeRecords())
    roads_by_name = defaultdict(list)
    by_section = defaultdict(list)
    for feature in features:
        roads_by_name[key(feature.record.ROAD_NAME)].append(feature)
        by_section[feature.record.SEC_LABEL].append(feature)
    votes = direction_votes(roads_by_name)
    traffic = sheet_rows(SOURCE / "traffic adata new.xlsx", "traffic adata new")
    surveys = {row[0]: row for row in traffic}
    assert len(surveys) == len(traffic)
    priorities = sheet_rows(SOURCE / "Prioritised_Road_List_Lanes_Combined.xlsx", "Road Priority")
    roads = []
    used_stations = set()
    for rank, name, section_ids, station_count, mean_adt, mean_commercial, *_, station_ids in priorities:
        if not isinstance(rank, int):
            continue
        related = roads_by_name[key(name)]
        sections = {f.record.SEC_LABEL for f in related}
        stations = []
        for station_id in station_ids.split("; "):
            assert station_id not in used_stations, station_id
            used_stations.add(station_id)
            _, road_name, section, chainage, _, days, _, adt, commercial, *_ = surveys[station_id]
            assert key(road_name) == key(name) and section in sections, station_id
            matches = by_section[section]
            assert len(matches) == 1, section
            feature = matches[0]
            lines = parts(feature.shape)
            assert len(lines) == 1, section
            length = feature.record.MEASD_LEN
            assert 0 <= chainage <= length and length > 0, station_id
            evidence = votes[section]
            fraction = chainage / length
            if evidence and all(evidence):
                fraction = 1 - fraction
            stations.append(dict(id=station_id, section=section, chainage=chainage, days=days,
                                 aadt=adt, commercial=commercial, coordinate=interpolate(lines[0], fraction)))
        survey_locations = combine_carriageways(stations)
        surveyed_sections = {
            location["section"][0][:-1] if location.get("sourceIds") else location["section"]
            for location in survey_locations
        }
        assert set(section_ids.split("; ")) == surveyed_sections, name
        adt = stats([s["aadt"] for s in survey_locations])
        commercial = stats([s["commercial"] for s in survey_locations])
        assert len(survey_locations) == station_count
        assert abs(adt["mean"] - mean_adt) <= .00501 and abs(commercial["mean"] - mean_commercial) <= .00501, name
        roads.append({
            "type": "Feature",
            "properties": dict(rank=rank, name=name, segments=len(related), stations=stations, aadt=adt,
                               commercial=commercial, km=round(sum(f.record.DIGITSDLEN for f in related)/1000, 1)),
            "geometry": {"type": "MultiLineString", "coordinates": [line for f in related for line in parts(f.shape)]},
        })
    assert used_stations == surveys.keys()
    unique = {}
    for feature in roads:
        current = feature["properties"]
        normalized = key(current["name"])
        if normalized not in unique:
            current["sourceRanks"] = [current["rank"]]
            unique[normalized] = feature
            continue
        combined = unique[normalized]["properties"]
        combined["sourceRanks"].append(current["rank"])
        combined["stations"].extend(current["stations"])
    roads = list(unique.values())
    for feature in roads:
        road = feature["properties"]
        road["stations"] = combine_carriageways(road["stations"])
        for metric in ("aadt", "commercial"):
            road[metric] = stats([station[metric] for station in road["stations"]])
    assign_colors(roads)
    network = ROOT / "data" / "network"
    network.mkdir(exist_ok=True)
    for road in roads:
        rank = road["properties"]["rank"]
        geometry = road["geometry"]
        (network / f"{rank}.json").write_text(json.dumps(geometry, separators=(",", ":")), encoding="utf-8")
        road["geometry"] = {
            "type": geometry["type"],
            "coordinates": [[[round(x, 6), round(y, 6)] for x, y in line.coords]
                            for line in (LineString(points).simplify(.000055) for points in geometry["coordinates"])],
        }
    current_files = {f"{road['properties']['rank']}.json" for road in roads}
    for old in network.glob("*.json"):
        if old.stem.isdecimal() and old.name not in current_files:
            old.unlink()
    output = ROOT / "data" / "roads.json"
    output.write_text(json.dumps({"type": "FeatureCollection", "features": roads}, separators=(",", ":")), encoding="utf-8")
    locations = sum(len(r["properties"]["stations"]) for r in roads)
    print(f"{locations} station locations from {len(used_stations)} survey records")
    print(f"{len(roads)} roads, {sum(r['properties']['segments'] for r in roads)} sections")


if __name__ == "__main__":
    main()
