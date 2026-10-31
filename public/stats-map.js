/*
 * Country dot map for the statistics page.
 *
 * Coordinates are ISO 3166-1 alpha-2 centroids (see /world-map.json, ~190
 * entries, ~5 KB). The renderer draws one circle per country sized by
 * sqrt(clicks) on an equirectangular projection - it is intentionally a
 * "where is the traffic" map, not a land-border map, so there is no large
 * vector asset to vendor or license.
 *
 * All labels are written with textContent; nothing here uses innerHTML.
 */
(function () {
  'use strict';

  var MAP_URL = '/world-map.json';
  var MAX_DOTS = 60;
  var centroids = null;
  var loading = null;

  function load() {
    if (centroids) return Promise.resolve(centroids);
    if (loading) return loading;
    loading = fetch(MAP_URL, { credentials: 'omit' })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (data) {
        centroids = data && typeof data === 'object' ? data : {};
        return centroids;
      })
      .catch(function () {
        centroids = {};
        return centroids;
      });
    return loading;
  }

  function project(lat, lon) {
    var x = ((Number(lon) + 180) / 360) * 1000;
    var y = ((90 - Number(lat)) / 180) * 500;
    return [
      Math.max(0, Math.min(1000, x)),
      Math.max(0, Math.min(500, y)),
    ];
  }

  function pickEntries(counts) {
    return Object.keys(counts || {})
      .filter(function (code) { return /^[A-Z]{2}$/.test(code); })
      .map(function (code) { return [code, Number(counts[code]) || 0]; })
      .filter(function (entry) { return entry[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, MAX_DOTS);
  }

  function draw(container, entries, map, emptyLabel) {
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 500');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Country distribution');
    svg.setAttribute('width', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';
    svg.style.borderRadius = '12px';
    svg.style.background = 'rgba(127,127,127,0.06)';

    var max = entries[0][1];
    var drawn = 0;

    entries.forEach(function (entry) {
      var point = map[entry[0]];
      if (!point || point.length < 2) return;

      var coords = project(point[0], point[1]);
      var circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', coords[0].toFixed(1));
      circle.setAttribute('cy', coords[1].toFixed(1));
      circle.setAttribute('r', (4 + Math.sqrt(entry[1] / max) * 26).toFixed(1));
      circle.setAttribute('fill', 'rgba(255,255,255,0.62)');
      circle.setAttribute('stroke', 'rgba(0,0,0,0.28)');
      circle.setAttribute('stroke-width', '0.6');

      var title = document.createElementNS(svgNS, 'title');
      title.textContent = entry[0] + ': ' + entry[1].toLocaleString();
      circle.appendChild(title);
      svg.appendChild(circle);
      drawn += 1;
    });

    container.textContent = '';
    if (!drawn) {
      var empty = document.createElement('div');
      empty.className = 'm-list-empty';
      empty.textContent = emptyLabel || '—';
      container.appendChild(empty);
      return false;
    }
    container.appendChild(svg);
    return true;
  }

  /**
   * Renders the map into `container`. Returns true when there is something to
   * show (the caller uses it to reveal the panel). Coordinates load lazily on
   * the first call and are cached for the page lifetime.
   */
  function render(container, counts, options) {
    if (!container || !counts || typeof counts !== 'object') return false;
    var entries = pickEntries(counts);
    if (!entries.length) return false;

    var emptyLabel = options && options.emptyLabel;
    if (centroids) return draw(container, entries, centroids, emptyLabel);

    var placeholder = document.createElement('div');
    placeholder.className = 'm-list-empty';
    placeholder.textContent = '…';
    container.textContent = '';
    container.appendChild(placeholder);

    void load().then(function (map) {
      if (!container.isConnected) return;
      draw(container, entries, map, emptyLabel);
    });
    return true;
  }

  window.OvlinkWorldMap = { render: render, load: load };
})();
