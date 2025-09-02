// --- Layout & color ---
const margin = { top: 130, right: 30, bottom: 50, left: 140 }; // extra top room for rotated labels

// Red (0) → Green (1)
const colorScale = d3.scaleLinear()
  .domain([0, 1])
  .range(["red", "green"])
  .interpolate(d3.interpolateHcl);

function computeCellSize(cols) {
  const container = document.getElementById("heatmap");
  const available = (container?.clientWidth || window.innerWidth) - margin.left - margin.right;
  return Math.max(28, Math.min(64, Math.floor(available / Math.max(1, cols))));
}

function truncateLabel(str, maxChars) {
  return (str.length > maxChars) ? (str.slice(0, Math.max(1, maxChars - 1)) + "…") : str;
}

// App state so we can update without rebuilding everything
const app = {
  initialized: false,
  men: [],
  women: [],
  cellSize: 45,
  svg: null,
  x: null,
  y: null,
  tooltip: null
};

function keyFn(d) {
  return `${d.woman}|${d.man}`; // stable key so cells update in place
}

function gridFrom(data) {
  const { men, women, probabilities } = data;
  return women.flatMap((w, i) => men.map((m, j) => ({
    woman: w,
    man: m,
    value: probabilities[i][j]
  })));
}

function initOnce(data) {
  app.men = data.men.slice();
  app.women = data.women.slice();
  app.cellSize = computeCellSize(app.men.length);

  const rotateX = app.cellSize < 46; // rotate only when tight
  const labelFont = Math.max(10, Math.round(app.cellSize * 0.26));

  const width = app.men.length * app.cellSize + margin.left + margin.right;
  const height = app.women.length * app.cellSize + margin.top + margin.bottom;

  // Root SVG
  app.svg = d3.select("#heatmap")
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("class", "heatmap");

  // Scales
  app.x = d3.scaleBand()
    .domain(app.men)
    .range([margin.left, margin.left + app.men.length * app.cellSize]);

  app.y = d3.scaleBand()
    .domain(app.women)
    .range([margin.top, margin.top + app.women.length * app.cellSize]);

  // Tooltip (single instance for the page)
  app.tooltip = d3.select("body").append("div")
    .attr("class", "tooltip")
    .style("opacity", 0);

  // X labels (men) – rotate when tight, otherwise stagger
  const xLabels = app.svg.append("g").attr("class", "xLabel")
    .selectAll("text")
    .data(app.men)
    .enter().append("text")
    .attr("x", d => app.x(d) + app.cellSize / 2)
    .attr("y", margin.top - 8)
    .attr("font-size", labelFont)
    .attr("class", "axis")
    .attr("text-anchor", rotateX ? "end" : "middle")
    .attr("dominant-baseline", "ideographic")
    .text(d => truncateLabel(d, Math.max(2, Math.floor(app.cellSize * 0.23))))
    .each(function (d) { d3.select(this).append("title").text(d); });

  if (rotateX) {
    xLabels.attr("transform", (d) =>
      `rotate(-40, ${app.x(d) + app.cellSize / 2}, ${margin.top - 8})`
    );
  } else {
    xLabels.attr("dy", (_, i) => (i % 2 ? -18 : -2));
  }

  // Y labels (women)
  app.svg.append("g").attr("class", "yLabel")
    .selectAll("text")
    .data(app.women)
    .enter().append("text")
    .attr("x", margin.left - 10)
    .attr("y", d => app.y(d) + app.cellSize / 2)
    .attr("text-anchor", "end")
    .attr("dominant-baseline", "middle")
    .attr("font-size", labelFont)
    .attr("class", "axis")
    .text(d => d);

  // Cells (enter once)
  app.svg.append("g").attr("class", "cells")
    .selectAll("rect.cell")
    .data(gridFrom(data), keyFn)
    .enter().append("rect")
    .attr("class", "cell")
    .attr("x", d => app.x(d.man))
    .attr("y", d => app.y(d.woman))
    .attr("width", app.cellSize)
    .attr("height", app.cellSize)
    .attr("fill", d => colorScale(d.value))
    .on("mouseover", function (event, d) {
      app.tooltip.transition().duration(150).style("opacity", 0.95);
      app.tooltip.html(`<strong>${d.woman}</strong> + <strong>${d.man}</strong><br/>${(d.value * 100).toFixed(1)}%`)
        .style("left", (event.pageX + 10) + "px")
        .style("top", (event.pageY - 20) + "px");
    })
    .on("mouseout", function () {
      app.tooltip.transition().duration(200).style("opacity", 0);
    });

  // Legend (draw once)
  const legendWidth = 250, legendHeight = 20;
  const legendSvg = d3.select("#legend").append("svg")
    .attr("width", legendWidth + 50)
    .attr("height", legendHeight + 50);

  const gradient = legendSvg.append("defs")
    .append("linearGradient")
    .attr("id", "legendGradient");

  gradient.append("stop").attr("offset", "0%").attr("stop-color", "red");
  gradient.append("stop").attr("offset", "100%").attr("stop-color", "green");

  legendSvg.append("rect")
    .attr("x", 20).attr("y", 10)
    .attr("width", legendWidth).attr("height", legendHeight)
    .style("fill", "url(#legendGradient)");

  legendSvg.append("text").attr("x", 20).attr("y", 45).text("0%");
  legendSvg.append("text").attr("x", 20 + legendWidth).attr("y", 45).attr("text-anchor", "end").text("100%");

  app.initialized = true;
}

// Update only the fills (and bound data), no DOM rebuild
function patchValues(data) {
  const sel = app.svg.select("g.cells")
    .selectAll("rect.cell")
    .data(gridFrom(data), keyFn);

  // Update existing cells’ fill with a light transition
  sel.transition().duration(250)
    .attr("fill", d => colorScale(d.value));

  // If new cells appear (structure changed), add them; if cells disappear, remove them
  sel.enter().append("rect")
    .attr("class", "cell")
    .attr("x", d => app.x(d.man))
    .attr("y", d => app.y(d.woman))
    .attr("width", app.cellSize)
    .attr("height", app.cellSize)
    .attr("fill", d => colorScale(d.value))
    .on("mouseover", function (event, d) {
      app.tooltip.transition().duration(150).style("opacity", 0.95);
      app.tooltip.html(`<strong>${d.woman}</strong> + <strong>${d.man}</strong><br/>${(d.value * 100).toFixed(1)}%`)
        .style("left", (event.pageX + 10) + "px")
        .style("top", (event.pageY - 20) + "px");
    })
    .on("mouseout", function () {
      app.tooltip.transition().duration(200).style("opacity", 0);
    });

  sel.exit().remove();
}

// If the roster shape changes (different men/women lists), rebuild once
function shapeChanged(next) {
  const sameMen = JSON.stringify(next.men) === JSON.stringify(app.men);
  const sameWomen = JSON.stringify(next.women) === JSON.stringify(app.women);
  return !(sameMen && sameWomen);
}

// // Polling every 5s — updates in place (no page reload)
// function fetchAndUpdate() {
//   fetch("data.json?nocache=" + Date.now())
//     .then(r => r.json())
//     .then(data => {
//       if (!app.initialized) {
//         initOnce(data);
//       } else if (shapeChanged(data)) {
//         // rare: structure changed → rebuild SVG once
//         d3.select("#heatmap").select("svg").remove();
//         d3.select("#legend").select("svg").remove();
//         d3.selectAll(".tooltip").remove();
//         app.initialized = false;
//         initOnce(data);
//       } else {
//         patchValues(data); // cheap in-place update
//       }
//     })
//     .catch(() => { /* ignore transient fetch errors */ });
// }

// fetchAndUpdate();
// setInterval(fetchAndUpdate, 500); // 5 seconds

// On resize, rebuild once to reflow labels & cell sizes (does NOT affect scroll)
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!app.initialized) return;
    // Rebuild using last known shape; values will be refreshed on next poll
    const shapeOnly = { men: app.men, women: app.women, probabilities: app.women.map(() => app.men.map(() => 0)) };
    d3.select("#heatmap").select("svg").remove();
    d3.select("#legend").select("svg").remove();
    d3.selectAll(".tooltip").remove();
    app.initialized = false;
    initOnce(shapeOnly);
  }, 150);
});
