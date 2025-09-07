(() => {
  'use strict';

  // ====== DOM ======
  const elHeatmap = document.getElementById('heatmap');
  const elLegend = document.getElementById('legend');
  const elWeekNav = document.getElementById('weekButtons');
  const elCeremonyTitle = document.getElementById('ceremonyTitle');
  const elCeremonyResult = document.getElementById('ceremonyResult');
  const elCeremonyMeta = document.getElementById('ceremonyMeta');
  const elCeremonyBody = document.querySelector('#ceremonyTable tbody');

  // Create / ensure ceremony legend container
  const elCeremonyLegend = document.getElementById('ceremonyLegend') || (() => {
    const host = document.getElementById('ceremony');
    const meta = document.getElementById('ceremonyMeta');
    const div = document.createElement('div');
    div.id = 'ceremonyLegend';
    div.className = 'ceremony-legend';
    host.insertBefore(div, meta.nextSibling);
    return div;
  })();

  // Add CSS for perfect match highlighting
  if (!document.getElementById('perfectMatchStyles')) {
    const style = document.createElement('style');
    style.id = 'perfectMatchStyles';
    style.textContent = `
      .pair-new {
        background-color: #e6e6fa;
        color: #4b0082;
      }
      .pair-certain {
        background-color: #31ce01ff !important;
        color: #19ba0aff !important;
      }
      .pair-certain:hover {
        background-color: #ffeeba !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ====== Config & helpers ======
  const margin = { top: 130, right: 30, bottom: 50, left: 140 };
  const colorScale = d3
    .scaleLinear()
    .domain([0, 1])
    .range(['red', 'green'])
    .interpolate(d3.interpolateHcl);

  const keyPair = (man, woman) => `${String(man).trim().toLowerCase()}||${String(woman).trim().toLowerCase()}`;
  const keyCell = (d) => `${d.man}|${d.woman}`;

  const computeCellSize = (cols) => {
    const available = (elHeatmap?.clientWidth || window.innerWidth) - margin.left - margin.right;
    return Math.max(28, Math.min(64, Math.floor(available / Math.max(1, cols))));
  };
  const truncate = (str, max) => (str.length > max ? str.slice(0, Math.max(1, max - 1)) + '…' : str);

  const orientationOf = ({ men, women, probabilities, matrix_orientation }) => {
    if (matrix_orientation) return matrix_orientation;
    if (Array.isArray(probabilities) && probabilities.length) {
      if (probabilities.length === men.length && probabilities[0]?.length === women.length) return 'men_by_women';
      if (probabilities.length === women.length && probabilities[0]?.length === men.length) return 'women_by_men';
    }
    return 'men_by_women';
  };

  const toGrid = (data, orient) => {
    const { men, women, probabilities } = data;
    return men.flatMap((m, i) =>
      women.map((w, j) => ({
        man: m,
        woman: w,
        value: orient === 'women_by_men' ? (probabilities[j]?.[i] ?? 0) : (probabilities[i]?.[j] ?? 0)
      }))
    );
  };

  // ====== Data layer (prefetch once) ======
  const Cache = new Map(); // keys: data:w, ceremony:w

  async function fetchJSON(url) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  function normalizePairs(raw) {
    if (!raw) return [];
    if (Array.isArray(raw) && raw.length && Array.isArray(raw[0]))
      return raw.map(([man, woman]) => ({ man: String(man), woman: String(woman) }));
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
      const manKeys = ['man', 'male', 'guy'];
      const womanKeys = ['woman', 'female', 'girl'];
      return raw
        .map((o) => {
          const man = manKeys.map((k) => o[k]).find((v) => v != null);
          const wom = womanKeys.map((k) => o[k]).find((v) => v != null);
          return man && wom ? { man: String(man), woman: String(wom) } : null;
        })
        .filter(Boolean);
    }
    if (raw && typeof raw === 'object')
      return Object.entries(raw).map(([man, woman]) => ({ man: String(man), woman: String(woman) }));
    return [];
  }

  function extractCeremonyFromWeeklyData(weeklyData) {
    if (!weeklyData || typeof weeklyData !== 'object') return { pairs: [], meta: {} };
    const c = weeklyData.ceremony || {};
    const pairsRaw = c.pairs ?? c.matches ?? c.matchups ?? weeklyData.matchups ?? weeklyData.matches ?? null;
    const pairs = normalizePairs(pairsRaw);
    const meta = { beams: c.beams ?? weeklyData.beams, blackout: c.blackout ?? weeklyData.blackout, result: c.result ?? weeklyData.result, week: weeklyData.week };
    return { pairs, meta };
  }

  async function loadCeremonyForWeek(week, weeklyData) {
    if (Cache.has(`ceremony:${week}`)) return Cache.get(`ceremony:${week}`);

    // Prefer embedded in weekly data
    const embedded = extractCeremonyFromWeeklyData(weeklyData);
    if (embedded.pairs.length) {
      Cache.set(`ceremony:${week}`, embedded);
      return embedded;
    }

    // Try separate files
    const extra = await fetchJSON(`ceremony_data/week_${week}.json`);
    if (extra) {
      const c = extra.ceremony || extra;
      const pairs = normalizePairs(c.pairs ?? c.matches ?? c.matchups ?? c.couples ?? null);
      const meta = { beams: c.beams, blackout: c.blackout, result: c.result, week: c.week ?? week };
      const out = { pairs, meta };
      Cache.set(`ceremony:${week}`, out);
      return out;
    }

    const root = await fetchJSON(`week_${week}.json`);
    if (root) {
      const c2 = root.ceremony || root;
      const pairs2 = normalizePairs(c2.pairs ?? c2.matches ?? c2.matchups ?? c2.couples ?? null);
      const meta2 = { beams: c2.beams ?? c2.result, blackout: c2.blackout, result: c2.result, week: c2.week ?? week };
      const out2 = { pairs: pairs2, meta: meta2 };
      Cache.set(`ceremony:${week}`, out2);
      return out2;
    }

    const empty = { pairs: [], meta: {} };
    Cache.set(`ceremony:${week}`, empty);
    return empty;
  }

  async function discoverAndPrefetch(maxProbe = 60) {
    const weeks = [];
    for (let w = 0; w <= maxProbe; w++) {
      const data = await fetchJSON(`data_week_${w}.json`);
      if (!data) break;
      Cache.set(`data:${w}`, data);
      weeks.push(w);
      // Opportunistically cache ceremony too
      // (doesn't block boot; if missing, load lazily on render)
      loadCeremonyForWeek(w, data).catch(() => {});
    }
    return weeks; // [0..max]
  }

  function precomputePriorPairs(weeks) {
    const priorPairsByWeek = new Map();
    const seen = new Set();
    for (const w of weeks) {
      const weekly = Cache.get(`data:${w}`);
      const { pairs } = extractCeremonyFromWeeklyData(weekly);
      // include pairs from embedded ceremony if present; if not, use cached ceremony when loaded
      const embedded = (pairs && pairs.length) ? pairs : (Cache.get(`ceremony:${w}`)?.pairs || []);
      priorPairsByWeek.set(w, new Set(seen));
      for (const p of embedded) seen.add(keyPair(p.man, p.woman));
    }
    return priorPairsByWeek;
  }

  // ====== App state ======
  const app = {
    booted: false,
    men: [],
    women: [],
    weekList: [],
    week: 0,
    lastOrientation: 'men_by_women',
    cellSize: 45,
    svg: null,
    x: null,
    y: null,
    tooltip: null,
    priorPairsByWeek: new Map(),
  };

  // ====== UI: one-time scene build ======
  function buildSceneFor(data) {
    app.men = data.men.slice();
    app.women = data.women.slice();
    app.cellSize = computeCellSize(app.men.length);

    const rotateX = app.cellSize < 46;
    const labelFont = Math.max(10, Math.round(app.cellSize * 0.26));

    const width = app.men.length * app.cellSize + margin.left + margin.right;
    const height = app.women.length * app.cellSize + margin.top + margin.bottom;

    app.svg = d3
      .select('#heatmap')
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('class', 'heatmap');

    app.x = d3.scaleBand().domain(app.men).range([margin.left, margin.left + app.men.length * app.cellSize]);
    app.y = d3.scaleBand().domain(app.women).range([margin.top, margin.top + app.women.length * app.cellSize]);

    app.tooltip = d3.select('body').append('div').attr('class', 'tooltip').style('opacity', 0);

    // X labels (men)
    const xLabels = app.svg
      .append('g').attr('class', 'xLabel')
      .selectAll('text').data(app.men).enter().append('text')
      .attr('x', (d) => app.x(d) + app.cellSize / 2)
      .attr('y', margin.top - 8)
      .attr('font-size', labelFont)
      .attr('class', 'axis')
      .attr('text-anchor', rotateX ? 'end' : 'middle')
      .attr('dominant-baseline', 'ideographic')
      .text((d) => truncate(d, Math.max(2, Math.floor(app.cellSize * 0.23))))
      .each(function (d) { d3.select(this).append('title').text(d); });
    if (rotateX) xLabels.attr('transform', (d) => `rotate(-40, ${app.x(d) + app.cellSize / 2}, ${margin.top - 8})`);
    else xLabels.attr('dy', (_, i) => (i % 2 ? -18 : -2));

    // Y labels (women)
    app.svg
      .append('g').attr('class', 'yLabel')
      .selectAll('text').data(app.women).enter().append('text')
      .attr('x', margin.left - 10)
      .attr('y', (d) => app.y(d) + app.cellSize / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', labelFont)
      .attr('class', 'axis')
      .text((d) => d);

    // Cells
    app.svg
      .append('g').attr('class', 'cells')
      .selectAll('rect.cell')
      .data(toGrid(data, orientationOf(data)), keyCell)
      .enter()
      .append('rect')
      .attr('class', 'cell')
      .attr('x', (d) => app.x(d.man))
      .attr('y', (d) => app.y(d.woman))
      .attr('width', app.cellSize)
      .attr('height', app.cellSize)
      .attr('fill', (d) => colorScale(d.value))
      .on('mouseover', function (event, d) {
        app.tooltip.transition().duration(150).style('opacity', 0.95);
        app.tooltip
          .html(`<strong>${d.man}</strong> + <strong>${d.woman}</strong><br/>${(d.value * 100).toFixed(1)}%`)
          .style('left', event.pageX + 10 + 'px')
          .style('top', event.pageY - 20 + 'px');
      })
      .on('mouseout', function () { app.tooltip.transition().duration(200).style('opacity', 0); });

    // Legend gradient
    const legendWidth = 260, legendHeight = 35;
    const legendSvg = d3.select('#legend')
      .append('svg')
      .attr('width', legendWidth + 60)
      .attr('height', legendHeight + 72)
      .attr('class', 'legend');

    const gradient = legendSvg.append('defs')
      .append('linearGradient')
      .attr('id', 'legendGradient');

    gradient.append('stop').attr('offset', '0%').attr('stop-color', 'red');
    gradient.append('stop').attr('offset', '100%').attr('stop-color', 'green');

    const barX = 20, barY = 16;
    legendSvg.append('rect')
      .attr('x', barX)
      .attr('y', barY)
      .attr('width', legendWidth)
      .attr('height', legendHeight)
      .style('fill', 'url(#legendGradient)');

    // Use currentColor so text adapts to light/dark; avoid dominant-baseline (Safari quirks)
    const labelY = barY + legendHeight + 24;
    legendSvg.append('text')
      .attr('x', barX)
      .attr('y', labelY)
      .attr('fill', 'currentColor')
      .text('0%');

    legendSvg.append('text')
      .attr('x', barX + legendWidth)
      .attr('y', labelY)
      .attr('text-anchor', 'end')
      .attr('fill', 'currentColor')
      .text('100%');

    renderCeremonyLegendOnce();
  }

  function renderCeremonyLegendOnce() {
    elCeremonyLegend.innerHTML = `
      <div class="legend-item">
        <span class="legend-dot legend-new"></span>
        <span>Never sat together before</span>
      </div>
      <div class="legend-item">
        <span class="legend-dot" style="background-color: #28a745; border: 1px solid #28a745;"></span>
        <span>Perfect match (100% probability)</span>
      </div>
    `;
  }

  function updateCells(data) {
    const orient = orientationOf(data);
    const sel = app.svg.select('g.cells').selectAll('rect.cell').data(toGrid(data, orient), keyCell);
    sel.transition().duration(200).attr('fill', (d) => colorScale(d.value));
    sel.enter()
      .append('rect')
      .attr('class', 'cell')
      .attr('x', (d) => app.x(d.man))
      .attr('y', (d) => app.y(d.woman))
      .attr('width', app.cellSize)
      .attr('height', app.cellSize)
      .attr('fill', (d) => colorScale(d.value));
    sel.exit().remove();
  }

  function renderCeremonyTable(week, pairs, meta, priorPairSet = new Set(), certainSet = new Set()) {
    elCeremonyTitle.textContent = `Week ${week} — Matchups`;
    const notes = [];
    if (typeof meta.beams === 'number') notes.push(`Beams: ${meta.beams}`);
    if (typeof meta.blackout === 'boolean') notes.push(meta.blackout ? 'Blackout' : 'Not a blackout');

    // Top result block
    if (typeof meta.result === 'number') {
      elCeremonyResult.textContent = `Correct matches: ${meta.result}`;
      elCeremonyResult.style.display = '';
    } else {
      elCeremonyResult.textContent = '';
      elCeremonyResult.style.display = 'none';
    }

    elCeremonyMeta.textContent = notes.join(' • ');

    elCeremonyBody.innerHTML = '';
    if (!pairs.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2;
      td.textContent = 'No ceremony data for this week.';
      tr.appendChild(td);
      elCeremonyBody.appendChild(tr);
      return;
    }

    for (const { man, woman } of pairs) {
      const tr = document.createElement('tr');
      const tdM = document.createElement('td');
      const tdW = document.createElement('td');
      tdM.textContent = man;
      tdW.textContent = woman;
      if (!priorPairSet.has(keyPair(man, woman))) tr.classList.add('pair-new');
      if (certainSet.has(keyPair(man, woman))) tr.classList.add('pair-certain');
      tr.appendChild(tdM);
      tr.appendChild(tdW);
      elCeremonyBody.appendChild(tr);
    }
  }

  function buildWeekButtons(weeks) {
    elWeekNav.innerHTML = '';
    for (const w of weeks) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = `Week ${w}`;
      btn.dataset.week = String(w);
      btn.addEventListener('click', () => selectWeek(w), { passive: true });
      elWeekNav.appendChild(btn);
    }
  }

  async function selectWeek(w) {
    app.week = w;
    for (const b of elWeekNav.querySelectorAll('.btn')) b.classList.toggle('active', Number(b.dataset.week) === w);

    const data = Cache.get(`data:${w}`);
    if (!data) return; // should not happen after prefetch

    // Rebuild scene if names changed shape across weeks
    const sameShape = JSON.stringify(data.men) === JSON.stringify(app.men) && JSON.stringify(data.women) === JSON.stringify(app.women);
    if (!app.svg) buildSceneFor(data);
    else if (!sameShape) {
      d3.select('#heatmap').select('svg').remove();
      d3.select('#legend').select('svg').remove();
      d3.selectAll('.tooltip').remove();
      buildSceneFor(data);
    }

    // Ceremony
    const { pairs, meta } = Cache.get(`ceremony:${w}`) || await loadCeremonyForWeek(w, data);
    const priorSet = app.priorPairsByWeek.get(w) || new Set();

    // Build set of certain (100%) pairs for this week
    const orientFor100 = orientationOf(data);
    const certainSet = new Set(
      toGrid(data, orientFor100)
        .filter((d) => d.value >= 0.9999)
        .map((d) => keyPair(d.man, d.woman))
    );

    renderCeremonyTable(w, pairs, meta, priorSet, certainSet);

    // Heatmap values
    updateCells(data);
  }

  // Resize: recalc layout without reloading data
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!app.svg) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const data = Cache.get(`data:${app.week}`);
      if (!data) return;
      d3.select('#heatmap').select('svg').remove();
      d3.select('#legend').select('svg').remove();
      d3.selectAll('.tooltip').remove();
      buildSceneFor(data);
      updateCells(data);
    }, 150);
  }, { passive: true });

  // ====== Boot (guarded) ======
  async function boot() {
    if (app.booted) return; // guard
    app.booted = true;

    const weeks = await discoverAndPrefetch(60); // prefetch once
    if (!weeks.length) return;
    app.weekList = weeks;

    // Precompute prior-pair sets once (no future re-fetch)
    app.priorPairsByWeek = precomputePriorPairs(weeks);

    buildWeekButtons(weeks);
    await selectWeek(weeks[weeks.length - 1]); // default to latest
  }

  // Ensure run-once even if script is included twice accidentally
  if (!window.__HEATMAP_APP_BOOTED__) {
    window.__HEATMAP_APP_BOOTED__ = true;
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
