import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { confirmReplacement, exportMap, normalizeBaseMap, normalizeLegacyMap, projectChanged, restoreWorld, worldPayload } from '../src/world.ts';

const geometry = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] };
const land = { type: 'Feature', id: 'Original', properties: { name: 'Original' }, geometry };
const sea = { type: 'Feature', id: 'sea-mask', properties: { name: 'Sea', featureType: 'sea' }, geometry };
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
  assert.deepEqual(restored.base_map, base);
  assert.equal(restored.edits.Original.geometry, null);
  assert.throws(() => restoreWorld({ schema_version: 3 }, base), /unsupported/);
  assert.throws(() => restoreWorld({ schema_version: 1, edits: {} }, base), /missing/);
});

test('renames and duplicate display names preserve independent IDs across save/export/import', () => {
  const imported = normalizeBaseMap({ ...base, features: [
    { ...land, id: 'country-a' }, { ...land, id: 'country-b' }, sea,
  ] });
  const state = { ...initial, base_map: imported, edits: {
    'country-a': { name: 'Shared', color: '#112233' },
    'country-b': { name: 'Shared', color: '#445566' },
    'new-country': { name: 'Shared', color: '#778899', geometry },
  } };
  const saved = roundTrip(worldPayload('Identity', state));
  assert.equal(saved.schema_version, 2);
  const restored = restoreWorld(saved, base);
  const exported = exportMap(restored.base_map, restored.edits);
  const reimported = normalizeBaseMap(roundTrip(exported));
  assert.deepEqual(reimported.features.map(f => f.id), ['country-a', 'country-b', 'sea-mask', 'new-country']);
  assert.equal(reimported.features[0].properties.customColor, '#112233');
  assert.equal(reimported.features[1].properties.customColor, '#445566');
  assert.equal(reimported.features[3].properties.customColor, '#778899');
  assert.equal(exportMap(imported, { ...restored.edits, 'country-a': { ...restored.edits['country-a'], geometry: null } }).features.length, 3);
});

test('missing IDs are assigned without colliding; numeric IDs survive as canonical strings', () => {
  const imported = normalizeBaseMap({ ...base, features: [
    { ...land, id: undefined }, { ...land, id: 'territory-1' }, { ...land, id: 0 },
  ] });
  assert.deepEqual(imported.features.map(f => f.id), ['territory-2', 'territory-1', '0']);
  assert.deepEqual(normalizeBaseMap(roundTrip(imported)), imported);
  for (const id of ['', '  ', null, {}, 'prototype', ...Object.getOwnPropertyNames(Object.prototype)]) {
    assert.throws(() => normalizeBaseMap({ ...base, features: [{ ...land, id }] }), /ID/);
  }
  assert.throws(() => normalizeBaseMap({ ...base, features: [{ ...land, id: 0 }, { ...land, id: '0' }] }), /ID/);
});

test('legacy migration maps old name keys, keeps new countries and deletions, and does not mutate input', () => {
  const oldBase = { ...base, features: [{ ...land, id: 'stable-land' }, sea] };
  const old = { schema_version: 1, name: 'Old', base_map: oldBase, edits: {
    Original: { name: 'Renamed', color: '#123456' },
    Custom: { name: 'Original', color: '#abcdef', geometry },
    Gone: { name: 'Gone', color: '#ffffff', geometry: null },
  } };
  const before = roundTrip(old);
  const migrated = restoreWorld(old, base);
  assert.deepEqual(old, before);
  assert.deepEqual(migrated.edits['stable-land'], old.edits.Original);
  assert.equal(Object.hasOwn(migrated.edits['stable-land'], 'geometry'), false);
  assert.equal(migrated.edits['legacy-1'].name, 'Original');
  assert.equal(migrated.edits['legacy-2'].geometry, null);
  assert.deepEqual(restoreWorld(roundTrip(worldPayload('Migrated', migrated)), base), migrated);
});

test('legacy duplicate removal retains distinct sea masks and copies sharing names', () => {
  const noId = { ...land, id: undefined };
  const otherGeometry = { type: 'Polygon', coordinates: [[[3,0],[4,0],[4,1],[3,0]]] };
  const legacyBase = { ...base, features: [noId, roundTrip(noId), { ...noId, geometry: otherGeometry },
    { ...sea, id: undefined }, { ...sea, id: undefined, geometry: otherGeometry },
  ] };
  const normalized = normalizeLegacyMap(legacyBase);
  assert.equal(normalized.features.length, 4);
  const migrated = restoreWorld({ name: 'Legacy', base_map: legacyBase, edits: { Original: { name: 'Changed', color: '#fff' } } }, base);
  assert.equal(Object.keys(migrated.edits).length, 2);
  assert.equal(exportMap(migrated.base_map, migrated.edits).features.filter(f => f.properties.name === 'Changed').length, 2);
});

test('version 2 rejects missing IDs and invalid edit records before replacing the current map', () => {
  const payload = worldPayload('World', initial);
  assert.throws(() => restoreWorld({ ...payload, base_map: { ...base, features: [{ ...land, id: undefined }] } }, base), /ID/);
  for (const edits of [null, [], { bad: null }, { bad: { name: 'New', color: '#fff' } },
    { Original: { name: '', color: '#fff' } },
    { Original: { name: 'Bad', color: '#fff', geometry: { type: 'Point', coordinates: [0,0] } } },
    JSON.parse('{"__proto__":{"name":"Bad","color":"#fff","geometry":null}}'),
  ]) assert.throws(() => restoreWorld({ ...payload, edits }, base));
});

test('blank country names cannot be saved and orphan legacy edits cannot silently lose geometry', () => {
  assert.throws(() => worldPayload('World', { ...initial, edits: { Original: { name: '  ', color: '#fff' } } }), /non-empty name/);
  assert.throws(() => restoreWorld({ name: 'Legacy', edits: { Unknown: { name: 'Lost', color: '#fff' } } }, base), /missing its geometry/);
});

test('the bundled map loads with one copy per country and both sea masks', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../src/data/countries_mid_res.geojson', import.meta.url), 'utf8'));
  const normalized = normalizeLegacyMap(raw);
  assert.equal(normalized.features.length, raw.features.length - 3);
  for (const name of ['Mexico', 'Canada', 'United States of America']) {
    assert.equal(normalized.features.filter(f => f.properties.name === name).length, 1);
  }
  assert.equal(normalized.features.filter(f => f.properties.featureType === 'sea').length, 2);
  assert.deepEqual(normalizeBaseMap(roundTrip(normalized)), normalized);
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
