import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmReplacement, exportMap, normalizeBaseMap, projectChanged, restoreWorld, worldPayload } from '../src/world.ts';

const geometry = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] };
const land = { type: 'Feature', properties: { name: 'Original' }, geometry };
const sea = { type: 'Feature', properties: { name: 'Sea', featureType: 'sea' }, geometry };
const base = { type: 'FeatureCollection', features: [land, sea] };
const initial = { edits: {}, base_map: base, background_image: null, background_bounds: null, allow_overlapping: false };
const roundTrip = value => JSON.parse(JSON.stringify(value));

test('saving appearance changes preserves the base geometry; deletion remains explicit', () => {
  const state = { ...initial, edits: { Original: { name: 'Renamed', color: '#123456' } } };
  const restored = restoreWorld(roundTrip(worldPayload('World', state)), base);
  assert.equal(Object.hasOwn(restored.edits.Original, 'geometry'), false);
  const exported = exportMap(restored.base_map, restored.edits);
  assert.deepEqual(exported.features[0].geometry, geometry);
  assert.equal(exported.features[0].properties.name, 'Renamed');
  assert.equal(exported.features[0].properties.customColor, '#123456');
  const deleted = roundTrip(worldPayload('World', { ...initial, edits: { Original: { name: 'Original', color: '#fff', geometry: null } } }));
  assert.equal(exportMap(base, deleted.edits).features.length, 1);
});

test('a custom map, sea, background and overlap setting survive a fresh reload', () => {
  const state = { ...initial, background_image: '/background.png', background_bounds: [[-1,1],[1,1],[1,-1],[-1,-1]], allow_overlapping: true };
  const restored = restoreWorld(roundTrip(worldPayload('Custom', state)), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(restored, state);
  assert.deepEqual(exportMap(restored.base_map, {}), {
    ...base, features: base.features.map(f => ({ ...f, properties: { ...f.properties, customColor: '#dcdcdc' } })),
  });
});

test('legacy worlds use the default map, not the map currently imported', () => {
  const restored = restoreWorld({ name: 'Legacy', edits: { Original: { name: 'Gone', color: '#fff', geometry: null } } }, base);
  assert.equal(restored.base_map, base);
  assert.equal(restored.edits.Original.geometry, null);
  assert.throws(() => restoreWorld({ schema_version: 2 }, base), /unsupported/);
  assert.throws(() => restoreWorld({ schema_version: 1, edits: {} }, base), /missing/);
});

test('failed or cancelled save blocks replacement; discard requires confirmation', async () => {
  for (const result of [false, true]) {
    assert.equal(await confirmReplacement(true, () => true, async () => result), result);
  }
  const answers = [false, false];
  assert.equal(await confirmReplacement(true, () => answers.shift(), () => assert.fail('Unexpected save')), false);
  const discard = [false, true];
  assert.equal(await confirmReplacement(true, () => discard.shift(), () => assert.fail('Unexpected save')), true);
  assert.equal(await confirmReplacement(false, () => assert.fail('Unexpected prompt'), () => assert.fail('Unexpected save')), true);
});

test('dirty tracking covers imports and options; a successful save only clears its snapshot', () => {
  assert.equal(projectChanged({ ...initial }, initial), false);
  assert.equal(projectChanged({ ...initial, base_map: { ...base } }, initial), true);
  assert.equal(projectChanged({ ...initial, allow_overlapping: true }, initial), true);
  const first = { ...initial, edits: { Original: { name: 'First', color: '#fff' } } };
  const newer = { ...first, edits: { Original: { name: 'Later', color: '#fff' } } };
  assert.equal(projectChanged(first, first), false);
  assert.equal(projectChanged(newer, first), true);
});

test('imports validate geometry and identity before replacing a world', () => {
  assert.deepEqual(normalizeBaseMap(base), base);
  for (const input of [null, {}, { ...base, features: [land, land] },
    { ...base, features: [{ ...land, geometry: null }] },
    { ...base, features: [{ ...land, geometry: { type: 'Point', coordinates: [0,0] } }] },
    { ...base, features: [{ ...land, geometry: { type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1]]] } }] },
  ]) assert.throws(() => normalizeBaseMap(input));
});
