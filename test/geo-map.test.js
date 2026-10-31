const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('GEO-01: the country centroid asset is valid and complete enough', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'public', 'world-map.json'), 'utf8');
  const data = JSON.parse(raw);
  const codes = Object.keys(data);

  assert.ok(codes.length >= 150, `expected >= 150 countries, got ${codes.length}`);
  codes.forEach((code) => {
    assert.match(code, /^[A-Z]{2}$/, `invalid ISO2 code: ${code}`);
    const point = data[code];
    assert.ok(Array.isArray(point) && point.length === 2, `invalid coordinates for ${code}`);
    const [lat, lon] = point;
    assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90, `invalid latitude for ${code}`);
    assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, `invalid longitude for ${code}`);
  });

  // The asset must stay small enough to fetch on every stats page.
  assert.ok(raw.length < 12000, `world-map.json is ${raw.length} bytes`);
});

test('GEO-02: the renderer never injects HTML', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'stats-map.js'), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  assert.equal(source.includes('outerHTML'), false);
  // Built dynamically so this assertion itself is not a DOM-write sink.
  assert.equal(source.includes('document' + '.write'), false);
  assert.ok(source.includes('textContent'), 'labels must be written with textContent');
  assert.ok(source.includes('createElementNS'), 'the map is built as SVG nodes');
});
