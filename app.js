"use strict";

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const format = (value) => number.format(value);
const colors = ["#daf3c4", "#a5d989", "#63bc62", "#28944b", "#096536"];
const thresholds = [1000, 2500, 5000, 7500];
const heat = (value) => colors[thresholds.filter((limit) => value >= limit).length];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const normalized = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const leaf = window.L;
const map = leaf.map("map", { scrollWheelZoom: false, maxZoom: 19 }).setView([10.54, 76.28], 7);
leaf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
leaf.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
for (const [name, zIndex] of [["network", 410], ["selection", 420], ["stations", 430]]) {
  map.createPane(name).style.zIndex = zIndex;
}
const layerGroups = {
  network: leaf.featureGroup().addTo(map),
  stations: leaf.layerGroup().addTo(map),
  selection: leaf.layerGroup().addTo(map),
};
const state = { roads: [], selection: null, sort: "rank", order: 1, matches: [] };
const roadLayers = new Map();
const markerLayers = new Map();
const geometryCache = new Map();
const columns = ["commercial.max", "commercial.min", "commercial.mean", "aadt.max", "aadt.min", "aadt.mean"];
const valueAt = (road, field) => field.split(".").reduce((value, part) => value[part], road);
const roadColor = (road) => $("map-mode").value === "commercial" ? heat(road.commercial.max) : road.color;
const roadSwatch = (road) => '<span class="swatch" style="background:' + roadColor(road) + '"></span>';
const stationLabel = (count) => count + (count === 1 ? " station" : " stations");

function popup(station, road) {
  return '<div class="popup"><strong>' + escapeHTML(station.id) + '</strong><p>' + escapeHTML(road.name) +
    '</p><dl><dt>AADT*</dt><dd>' + format(station.aadt) + '</dd><dt>Commercial count</dt><dd>' +
    format(station.commercial) + '</dd></dl><small>Vehicles per day · ' + station.days +
    ' survey days<br>* Survey-period ADT<br>Estimated location at section chainage ' + format(station.chainage) + ' m</small></div>';
}

function drawRoad(feature) {
  const road = feature.properties;
  const coordinates = feature.geometry.coordinates.map((line) => line.map(([lon, lat]) => [lat, lon]));
  const line = leaf.polyline(coordinates, { pane: "network", weight: 4, color: roadColor(road), opacity: .9 });
  line.bindTooltip(escapeHTML(road.name), { sticky: true });
  line.on("click", () => selectRoad(road));
  line.addTo(layerGroups.network);
  roadLayers.set(road.rank, line);
  for (const station of road.stations) {
    const [lon, lat] = station.coordinate;
    const marker = leaf.circleMarker([lat, lon], {
      pane: "stations", radius: station.commercial === road.commercial.max ? 6 : 4,
      weight: 1.5, color: "#183d32", fillColor: heat(station.commercial), fillOpacity: 1,
    });
    marker.bindTooltip(escapeHTML(station.id)).bindPopup(popup(station, road));
    marker.addTo(layerGroups.stations);
    markerLayers.set(station.id, marker);
  }
}

function renderLegend() {
  const commercial = $("map-mode").value === "commercial";
  const showStations = $("show-stations").checked;
  const title = commercial ? "Peak commercial count by road" : showStations ? "Station commercial count" : "Colours identify individual roads";
  $("legend").innerHTML = "<strong>" + title + "</strong>" +
    (commercial || showStations ?
      '<div class="legend-scale">' + colors.map((color) => '<i style="background:' + color + '"></i>').join("") +
      '</div><div class="scale-labels"><span>&lt;1k</span><span>1–&lt;2.5k</span><span>2.5–&lt;5k</span><span>5–&lt;7.5k</span><span>7.5k+</span></div><div>Vehicles / day</div>' : "");
}

function refreshLayers() {
  for (const road of state.roads) {
    roadLayers.get(road.rank).setStyle({
      color: roadColor(road), weight: $("map-mode").value === "commercial" ? 5 : 4,
      opacity: !state.selection || state.selection === road ? .92 : .23,
    });
    for (const station of road.stations) {
      const focused = !state.selection || state.selection === road;
      markerLayers.get(station.id).setStyle({ opacity: focused ? 1 : .3, fillOpacity: focused ? 1 : .24 });
    }
  }
  if (state.selection) {
    layerGroups.selection.eachLayer((line) => {
      if (line.options.roadStroke) line.setStyle({ color: roadColor(state.selection) });
    });
  }
  renderLegend();
}

function filterRoads() {
  const query = $("search").value.trim();
  const search = normalized(query);
  state.matches = state.roads.filter((road) => !search ||
    normalized(road.name).includes(search) ||
    (search.includes("trissur") && normalized(road.name).includes(search.replace("trissur", "thrissur"))) ||
    road.sourceRanks.some((rank) => String(rank) === search) ||
    road.stations.some((station) => normalized(station.id).includes(search)));
  renderList();
  renderTable();
}

function renderList() {
  const query = normalized($("search").value);
  const count = state.matches.length;
  $("results").textContent = count + (count === 1 ? " road" : " roads") + (query ? " found" : " in the priority list");
  $("road-list").innerHTML = state.matches.map((road) => {
    const station = query ? road.stations.find((item) => normalized(item.id) === query) : null;
    return '<button class="road-item" data-rank="' + road.rank + '" data-station="' + (station?.id || "") +
      '" aria-pressed="' + (state.selection === road) + '"><span class="pill">' + road.rank +
      '</span><span><strong>' + escapeHTML(road.name) + '</strong><small>' +
      (station ? escapeHTML(station.id) : stationLabel(road.stations.length) + " · " + format(road.km) + " km") +
      '</small></span>' + roadSwatch(road) + '</button>';
  }).join("");
}

function renderTable() {
  const rows = sortedRoads();
  for (const header of document.querySelectorAll("th[data-key]")) {
    if (header.dataset.key === state.sort) header.setAttribute("aria-sort", state.order > 0 ? "ascending" : "descending");
    else header.removeAttribute("aria-sort");
  }
  $("ranking-body").innerHTML = rows.map((road) => '<tr class="' + (state.selection === road ? "selected" : "") +
    '"><td>' + road.rank + '</td><td><button class="table-road" data-rank="' + road.rank + '">' +
    roadSwatch(road) + escapeHTML(road.name) + '</button></td>' +
    columns.map((field) => "<td>" + format(valueAt(road, field)) + "</td>").join("") + "</tr>").join("") ||
    '<tr><td colspan="8">No matching roads.</td></tr>';
  $("download").disabled = !rows.length;
}

function sortedRoads() {
  return [...state.matches].sort((a, b) => {
    const first = valueAt(a, state.sort);
    const second = valueAt(b, state.sort);
    return state.order * (typeof first === "string" ? first.localeCompare(second) : first - second) || a.rank - b.rank;
  });
}

function renderDetail(road) {
  $("detail").hidden = !road;
  if (!road) return;
  $("detail").innerHTML = '<div class="detail-top"><div><h3>' + escapeHTML(road.name) +
    '</h3><p class="muted">Rank ' + road.rank + ' · ' + format(road.km) + ' km · ' + road.segments +
    ' mapped sections · ' + stationLabel(road.stations.length) + '</p></div><button type="button" data-close>Clear selection</button></div>' +
    '<div class="station-list">' + [...road.stations].sort((a,b) => b.commercial - a.commercial).map((station) =>
      '<button type="button" data-station="' + escapeHTML(station.id) + '">' + escapeHTML(station.id) +
      '<small>' + format(station.commercial) + ' commercial / day' +
      (station.commercial === road.commercial.max ? ' · Peak' : '') + '</small></button>').join("") + '</div>';
}

async function selectRoad(road, station) {
  state.selection = road;
  map.closePopup();
  layerGroups.selection.clearLayers();
  $("map-status").hidden = true;
  refreshLayers();
  renderList();
  renderTable();
  renderDetail(road);
  if (!road) {
    if (layerGroups.network.getBounds().isValid()) map.fitBounds(layerGroups.network.getBounds(), { padding: [28, 28] });
    return;
  }
  if (station) openStation(station);
  else map.fitBounds(roadLayers.get(road.rank).getBounds(), { padding: [34, 34], maxZoom: 15 });
  try {
    if (!geometryCache.has(road.rank)) {
      const request = fetch("./data/network/" + road.rank + ".json").then((result) => {
        if (!result.ok) throw new Error("Road geometry could not be loaded");
        return result.json();
      }).catch((error) => {
        geometryCache.delete(road.rank);
        throw error;
      });
      geometryCache.set(road.rank, request);
    }
    const geometry = await geometryCache.get(road.rank);
    if (state.selection !== road) return;
    layerGroups.selection.clearLayers();
    for (const stroke of [false, true]) {
      leaf.geoJSON(geometry, { pane: "selection", interactive: false, smoothFactor: 0, roadStroke: stroke,
        style: { color: stroke ? roadColor(road) : "#142c37", weight: stroke ? 6 : 9, opacity: 1 } })
        .eachLayer((layer) => {
          layer.options.roadStroke = stroke;
          layer.addTo(layerGroups.selection);
        });
    }
  } catch {
    if (state.selection === road) {
      $("map-status").textContent = "Full route unavailable. Showing the overview alignment.";
      $("map-status").hidden = false;
    }
  }
}

function openStation(id) {
  const marker = markerLayers.get(id);
  if (!marker) return;
  if (!$("show-stations").checked) {
    $("show-stations").checked = true;
    layerGroups.stations.addTo(map);
    renderLegend();
  }
  map.setView(marker.getLatLng(), Math.max(13, map.getZoom()), { animate: false });
  marker.openPopup();
}

$("search").addEventListener("input", filterRoads);
$("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("road-list").querySelector("button")?.click();
});
for (const id of ["road-list", "ranking-body"]) {
  $(id).addEventListener("click", (event) => {
    const button = event.target.closest("[data-rank]");
    if (!button) return;
    const road = state.roads.find((item) => item.rank === Number(button.dataset.rank));
    if (id === "ranking-body") $("explorer").scrollIntoView();
    selectRoad(road, button.dataset.station);
    if (id === "road-list") $("road-list").querySelector('[data-rank="' + road.rank + '"]')?.focus({ preventScroll: true });
  });
}
$("detail").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-close")) {
    selectRoad(null);
    $("search").focus({ preventScroll: true });
  } else {
    $("map").scrollIntoView({ block: "center" });
    openStation(button.dataset.station);
  }
});
$("reset").addEventListener("click", () => {
  $("search").value = "";
  filterRoads();
  selectRoad(null);
});
$("map-mode").addEventListener("change", () => { refreshLayers(); renderList(); renderTable(); });
$("show-stations").addEventListener("change", (event) => {
  if (event.target.checked) layerGroups.stations.addTo(map);
  else { map.closePopup(); layerGroups.stations.remove(); }
  renderLegend();
});
document.querySelector("thead").addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort]");
  if (!button) return;
  const key = button.dataset.sort;
  state.order = state.sort === key ? -state.order : columns.includes(key) ? -1 : 1;
  state.sort = key;
  renderTable();
});

$("download").addEventListener("click", () => {
  const header = ["Rank", "Road name", "Commercial max", "Commercial min", "Commercial mean", "AADT max", "AADT min", "AADT mean"];
  const rows = sortedRoads().map((road) => [road.rank, road.name, ...columns.map((field) => valueAt(road, field))]);
  const csv = [header, ...rows].map((row) => row.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "kerala-road-priority.csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function start() {
  renderLegend();
  try {
    const response = await fetch("./data/roads.json");
    if (!response.ok) throw new Error("Could not load the road dataset");
    const data = await response.json();
    state.roads = data.features.map((feature) => feature.properties);
    for (const feature of data.features) drawRoad(feature);
    $("road-count").textContent = format(state.roads.length);
    $("section-count").textContent = format(state.roads.reduce((sum, road) => sum + road.segments, 0));
    $("station-count").textContent = format(markerLayers.size);
    $("peak-count").textContent = format(Math.max(...state.roads.map((road) => road.commercial.max)));
    filterRoads();
    selectRoad(null);
  } catch (error) {
    $("results").textContent = "Road data could not be loaded. Reload to try again.";
    console.error(error);
  }
}
start();
