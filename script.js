// --- Layout & color ---
const margin = { top: 130, right: 30, bottom: 50, left: 140 };
// Red (0) → Green (1)
const colorScale = d3
  .scaleLinear()
  .domain([0, 1])
  .range(["red", "green"])
  .interpolate(d3.interpolateHcl);

// Elements
const elHeatmap = document.getElementById("heatmap");
const elLegend = document.getElementById("legend");
const elWeekNav = document.getElementById("weekButtons");

const elCeremonyTitle = document.getElementById("ceremonyTitle");
const elCeremonyMeta = document.getElementById("ceremonyMeta");
const elCeremonyBody = document.querySelector("#ceremonyTable tbody");

// Create / get legend container just below meta
const elCeremonyLegend =
  document.getElementById("ceremonyLegend") ||
  (() => {
    const host = document.getElementById("ceremony");
    const meta = document.getElementById("ceremonyMeta");
    const div = document.createElement("div");
    div.id = "ceremonyLegend";
    div.className = "ceremony-legend";
    host.insertBefore(div, meta.nextSibling);
    return div;
  })();

// App state
const app = {
  initialized: false,
  men: [],
  women: [],
  cellSize: 45,
  svg: null,
  x: null,
  y: null,
  tooltip: null,
  maxWeek: 0,
  week: 0,
  lastOrientation: "men_by_women", // or "women_by_men"
  lastData: null
};

// ---------- utils ----------
const ceremonyCache = new Map(); // week -> normalized { pairs:[{man,woman}], meta:{} }

// Pair key helper (case-insensitive, trimmed)
function pairKey(man, woman) {
  return `${String(man).trim().toLowerCase()}||${String(woman).trim().toLowerCase()}`;
}

function normalizePairs(raw) {
  if (!raw) return [];

  // Case 1: Array of arrays: [["Man","Woman"], ...]
  if (Array.isArray(raw) && raw.length && Array.isArray(raw[0])) {
    return raw.map(([man, woman]) => ({ man: String(man), woman: String(woman) }));
  }

  // Case 2: Array of objects: [{man:"", woman:""}] (allow common key aliases)
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "object") {
    const manKeys = ["man", "male", "guy"];
    const womanKeys = ["woman", "female", "girl"];
    return raw
      .map((o) => {
        const man = manKeys.map((k) => o[k]).find((v) => v != null);
        const wom = womanKeys.map((k) => o[k]).find((v) => v != null);
        return man && wom ? { man: String(man), woman: String(wom) } : null;
      })
      .filter(Boolean);
  }

  // Case 3: Object map: { "Man": "Woman", ... }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([man, woman]) => ({ man: String(man), woman: String(woman) }));
  }

  return [];
}

function extractCeremonyFromWeeklyData(weeklyData) {
  if (!weeklyData || typeof weeklyData !== "object") return { pairs: [], meta: {} };
  const c = weeklyData.ceremony || {};
  const pairsRaw =
    c.pairs ??
    c.matches ??
    c.matchups ??
    weeklyData.matchups ??
    weeklyData.matches ??
    null;

  const pairs = normalizePairs(pairsRaw);
  const meta = {
    beams: c.beams ?? weeklyData.beams,
    blackout: c.blackout ?? weeklyData.blackout,
    week: weeklyData.week
  };
  return { pairs, meta };
}

async function fetchCeremonyForWeek(week, weeklyData) {
  // 1) Try embedded in weekly data
  const embedded = extractCeremonyFromWeeklyData(weeklyData);
  if (embedded.pairs.length) return embedded;

  // 2) Cache
  if (ceremonyCache.has(week)) return ceremonyCache.get(week);

  // 3) Try separate file: ceremony_data/week_<w>.json
  const extra = await fetchJSON(`ceremony_data/week_${week}.json`);
  if (extra) {
    const c = extra.ceremony || extra; // allow nested or top-level
    const pairsRaw = c.pairs ?? c.matches ?? c.matchups ?? c.couples ?? null;
    const pairs = normalizePairs(pairsRaw);
    const meta = {
      beams: c.beams,
      blackout: c.blackout,
      week: c.week ?? week
    };
    const out = { pairs, meta };
    ceremonyCache.set(week, out);
    return out;
  }

  // 4) Fallback: root-level week_<w>.json
  const root = await fetchJSON(`week_${week}.json`);
  if (root) {
    const c2 = root.ceremony || root;
    const pairsRaw2 = c2.pairs ?? c2.matches ?? c2.matchups ?? c2.couples ?? null;
    const pairs2 = normalizePairs(pairsRaw2);
    const meta2 = { beams: c2.beams ?? c2.result, blackout: c2.blackout, week: c2.week ?? week };
    const out2 = { pairs: pairs2, meta: meta2 };
    ceremonyCache.set(week, out2);
    return out2;
  }

  // 5) Nothing found
  const out = { pairs: [], meta: {} };
  ceremonyCache.set(week, out);
  return out;
}

function renderLegend() {
  elCeremonyLegend.innerHTML = `
    <div class="legend-item">
      <span class="legend-dot legend-new"></span>
      <span>Never sat together before</span>
    </div>
  `;
}

function renderCeremonyTable(week, pairs, meta, priorPairSet = new Set()) {
  // Title (safe em-dash)
  elCeremonyTitle.textContent = `Week ${week} \u2014 Matchups`;

  // Meta line (optional info)
  const notes = [];
  if (typeof meta.beams === "number") notes.push(`Beams: ${meta.beams}`);
  if (typeof meta.blackout === "boolean")
    notes.push(meta.blackout ? "Blackout" : "Not a blackout");
  elCeremonyMeta.textContent = notes.join(" • ");

  // Table body
  elCeremonyBody.innerHTML = "";
  if (!pairs.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2;
    td.textContent = "No ceremony data for this week.";
    tr.appendChild(td);
    elCeremonyBody.appendChild(tr);
    return;
  }

  for (const { man, woman } of pairs) {
    const tr = document.createElement("tr");
    const tdM = document.createElement("td");
    const tdW = document.createElement("td");
    tdM.textContent = man;
    tdW.textContent = woman;

    const isNew = !priorPairSet.has(pairKey(man, woman));
    if (isNew) tr.classList.add("pair-new"); // purple row

    tr.appendChild(tdM);
    tr.appendChild(tdW);
    elCeremonyBody.appendChild(tr);
  }
}

function computeCellSize(cols) {
  const available =
    (elHeatmap?.clientWidth || window.innerWidth) - margin.left - margin.right;
  return Math.max(28, Math.min(64, Math.floor(available / Math.max(1, cols))));
}

function truncateLabel(str, maxChars) {
  return str.length > maxChars
    ? str.slice(0, Math.max(1, maxChars - 1)) + "…"
    : str;
}

function keyFn(d) {
  return `${d.man}|${d.woman}`;
}

function orientationOf({ men, women, probabilities, matrix_orientation }) {
  if (matrix_orientation) return matrix_orientation; // "men_by_women" | "women_by_men"
  if (Array.isArray(probabilities) && probabilities.length) {
    if (
      probabilities.length === men.length &&
      probabilities[0]?.length === women.length
    )
      return "men_by_women";
    if (
      probabilities.length === women.length &&
      probabilities[0]?.length === men.length
    )
      return "women_by_men";
  }
  return "men_by_women"; // default
}

function toGrid(data) {
  const { men, women, probabilities } = data;
  const orient = orientationOf(data);
  app.lastOrientation = orient;
  return men.flatMap((m, i) =>
    women.map((w, j) => ({
      man: m,
      woman: w,
      value:
        orient === "women_by_men"
          ? probabilities[j]?.[i] ?? 0
          : probabilities[i]?.[j] ?? 0
    }))
  );
}

// ---------- heatmap ----------
function initOnce(data) {
  app.men = data.men.slice();
  app.women = data.women.slice();
  app.cellSize = computeCellSize(app.men.length);

  const rotateX = app.cellSize < 46;
  const labelFont = Math.max(10, Math.round(app.cellSize * 0.26));

  const width = app.men.length * app.cellSize + margin.left + margin.right;
  const height = app.women.length * app.cellSize + margin.top + margin.bottom;

  app.svg = d3
    .select("#heatmap")
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("class", "heatmap");

  app.x = d3
    .scaleBand()
    .domain(app.men)
    .range([margin.left, margin.left + app.men.length * app.cellSize]);
  app.y = d3
    .scaleBand()
    .domain(app.women)
    .range([margin.top, margin.top + app.women.length * app.cellSize]);

  app.tooltip = d3
    .select("body")
    .append("div")
    .attr("class", "tooltip")
    .style("opacity", 0);

  // X labels (men)
  const xLabels = app.svg
    .append("g")
    .attr("class", "xLabel")
    .selectAll("text")
    .data(app.men)
    .enter()
    .append("text")
    .attr("x", (d) => app.x(d) + app.cellSize / 2)
    .attr("y", margin.top - 8)
    .attr("font-size", labelFont)
    .attr("class", "axis")
    .attr("text-anchor", rotateX ? "end" : "middle")
    .attr("dominant-baseline", "ideographic")
    .text((d) => truncateLabel(d, Math.max(2, Math.floor(app.cellSize * 0.23))))
    .each(function (d) {
      d3.select(this).append("title").text(d);
    });
  if (rotateX)
    xLabels.attr(
      "transform",
      (d) =>
        `rotate(-40, ${app.x(d) + app.cellSize / 2}, ${margin.top - 8})`
    );
  else xLabels.attr("dy", (_, i) => (i % 2 ? -18 : -2));

  // Y labels (women)
  app.svg
    .append("g")
    .attr("class", "yLabel")
    .selectAll("text")
    .data(app.women)
    .enter()
    .append("text")
    .attr("x", margin.left - 10)
    .attr("y", (d) => app.y(d) + app.cellSize / 2)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "middle")
    .attr("font-size", labelFont)
    .attr("class", "axis")
    .text((d) => d);

  // Cells
  app.svg
    .append("g")
    .attr("class", "cells")
    .selectAll("rect.cell")
    .data(toGrid(data), keyFn)
    .enter()
    .append("rect")
    .attr("class", "cell")
    .attr("x", (d) => app.x(d.man))
    .attr("y", (d) => app.y(d.woman))
    .attr("width", app.cellSize)
    .attr("height", app.cellSize)
    .attr("fill", (d) => colorScale(d.value))
    .on("mouseover", function (event, d) {
      app.tooltip.transition().duration(150).style("opacity", 0.95);
      app.tooltip
        .html(
          `<strong>${d.man}</strong> + <strong>${d.woman}</strong><br/>${(
            d.value * 100
          ).toFixed(1)}%`
        )
        .style("left", event.pageX + 10 + "px")
        .style("top", event.pageY - 20 + "px");
    })
    .on("mouseout", function () {
      app.tooltip.transition().duration(200).style("opacity", 0);
    });

  // Legend
  const legendWidth = 250,
    legendHeight = 20;
  const legendSvg = d3
    .select("#legend")
    .append("svg")
    .attr("width", legendWidth + 50)
    .attr("height", legendHeight + 50);
  const gradient = legendSvg
    .append("defs")
    .append("linearGradient")
    .attr("id", "legendGradient");
  gradient.append("stop").attr("offset", "0%").attr("stop-color", "red");
  gradient.append("stop").attr("offset", "100%").attr("stop-color", "green");
  legendSvg
    .append("rect")
    .attr("x", 20)
    .attr("y", 10)
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .style("fill", "url(#legendGradient)");
  legendSvg.append("text").attr("x", 20).attr("y", 45).text("0%");
  legendSvg
    .append("text")
    .attr("x", 20 + legendWidth)
    .attr("y", 45)
    .attr("text-anchor", "end")
    .text("100%");

  app.initialized = true;
}

function patchValues(data) {
  const sel = app.svg
    .select("g.cells")
    .selectAll("rect.cell")
    .data(toGrid(data), keyFn);
  sel.transition().duration(200).attr("fill", (d) => colorScale(d.value));
  sel
    .enter()
    .append("rect")
    .attr("class", "cell")
    .attr("x", (d) => app.x(d.man))
    .attr("y", (d) => app.y(d.woman))
    .attr("width", app.cellSize)
    .attr("height", app.cellSize)
    .attr("fill", (d) => colorScale(d.value));
  sel.exit().remove();
}

function rebuildForResize() {
  if (!app.initialized) return;
  const shapeOnly = {
    men: app.men,
    women: app.women,
    probabilities:
      app.lastOrientation === "women_by_men"
        ? app.women.map(() => app.men.map(() => 0))
        : app.men.map(() => app.women.map(() => 0))
  };
  d3.select("#heatmap").select("svg").remove();
  d3.select("#legend").select("svg").remove();
  d3.selectAll(".tooltip").remove();
  app.initialized = false;
  initOnce(shapeOnly);
  if (app.lastData) patchValues(app.lastData);
}

// ---------- data ----------
async function fetchJSON(url) {
  try {
    const r = await fetch(`${url}?nocache=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function discoverWeeks(limit = 40) {
  let w = 0;
  while (w <= limit) {
    const data = await fetchJSON(`data_week_${w}.json`);
    if (!data) break;
    w++;
  }
  return Math.max(0, w - 1);
}

// Build a set of prior pairs (before currentWeek)
async function computePriorPairs(currentWeek) {
  const seen = new Set();
  if (currentWeek <= 0) return seen;

  const weeks = Array.from({ length: currentWeek }, (_, i) => i);
  await Promise.all(
    weeks.map(async (w) => {
      const weeklyData = await fetchJSON(`data_week_${w}.json`);
      const { pairs } = await fetchCeremonyForWeek(w, weeklyData);
      for (const p of pairs) seen.add(pairKey(p.man, p.woman));
    })
  );
  return seen;
}

async function loadWeek(week) {
  const data = await fetchJSON(`data_week_${week}.json`);
  if (!data) return;

  if (!app.initialized) {
    initOnce(data);
  } else if (
    JSON.stringify(data.men) !== JSON.stringify(app.men) ||
    JSON.stringify(data.women) !== JSON.stringify(app.women)
  ) {
    d3.select("#heatmap").select("svg").remove();
    d3.select("#legend").select("svg").remove();
    d3.selectAll(".tooltip").remove();
    app.initialized = false;
    initOnce(data);
  }
  app.lastData = data;

  // Ceremony: fetch, build prior set, render legend + table
  const { pairs, meta } = await fetchCeremonyForWeek(week, data);
  const priorSet = await computePriorPairs(week);
  renderLegend();
  renderCeremonyTable(week, pairs, meta, priorSet);

  // Heatmap values
  patchValues(data);
}

// ---------- week buttons ----------
function buildWeekButtons(maxW) {
  elWeekNav.innerHTML = "";
  for (let w = 0; w <= maxW; w++) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = `Week ${w}`;
    btn.dataset.week = String(w);
    btn.addEventListener("click", () => setWeek(w));
    elWeekNav.appendChild(btn);
  }
}

function setWeek(w) {
  app.week = w;
  [...elWeekNav.querySelectorAll(".btn")].forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.week) === w);
  });
  loadWeek(w);
}

// ---------- boot ----------
(async function boot() {
  app.maxWeek = await discoverWeeks(40);
  buildWeekButtons(app.maxWeek);

  // default to the latest available week; change to 0 if you prefer Week 0
  setWeek(app.maxWeek);
})();

// Rebuild on resize
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rebuildForResize, 150);
});
