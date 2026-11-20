const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { APP_ROOT, resolvePaths, migrateLegacyData } = require('../src/paths');

test('development paths stay inside the checkout', () => {
  const paths = resolvePaths({});
  assert.equal(paths.packaged, false);
  assert.equal(paths.appRoot, APP_ROOT);
  assert.equal(paths.publicDir, path.join(APP_ROOT, 'public'));
  assert.equal(paths.dataDir, path.join(APP_ROOT, 'data'));
  assert.equal(paths.logsDir, path.join(APP_ROOT, 'data', 'logs'));
  assert.equal(paths.whisperHome, path.join(APP_ROOT, 'vendor', 'whisper'));
});

test('packaged paths resolve against the resources directory', () => {
  const paths = resolvePaths({ BRO_PACKAGED: '1', BRO_RESOURCES_PATH: path.join('C:', 'res') });
  assert.equal(paths.packaged, true);
  assert.equal(paths.resourcesDir, path.join('C:', 'res'));
  assert.equal(paths.scriptsDir, path.join('C:', 'res', 'scripts'));
  assert.equal(paths.whisperHome, path.join('C:', 'res', 'whisper'));
});

test('explicit environment overrides win', () => {
  const paths = resolvePaths({
    BRO_PACKAGED: '1',
    BRO_DATA_DIR: path.join('D:', 'custom-data'),
    BRO_LOGS_DIR: path.join('D:', 'custom-logs'),
    BRO_PUBLIC_DIR: path.join('D:', 'custom-public'),
  });
  assert.equal(paths.dataDir, path.join('D:', 'custom-data'));
  assert.equal(paths.logsDir, path.join('D:', 'custom-logs'));
  assert.equal(paths.publicDir, path.join('D:', 'custom-public'));
});

test('legacy migration copies missing files and never overwrites or deletes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-paths-'));
  const legacy = path.join(root, 'legacy');
  const target = path.join(root, 'target');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'state.json'), '{"projects":["old"]}');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"apiKey":"legacy"}');
  fs.writeFileSync(path.join(legacy, 'notes.txt'), 'not migrated');

  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'settings.json'), '{"apiKey":"current"}');

  const copied = migrateLegacyData(legacy, target);
  assert.deepEqual(copied.sort(), ['state.json']);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"apiKey":"current"}');
  assert.equal(fs.existsSync(path.join(target, 'notes.txt')), false);
  assert.equal(fs.existsSync(path.join(legacy, 'state.json')), true, 'legacy files are left in place');
  assert.deepEqual(migrateLegacyData(legacy, target), [], 'a second run copies nothing');
  assert.deepEqual(migrateLegacyData(path.join(root, 'missing'), target), []);
  assert.deepEqual(migrateLegacyData(legacy, legacy), []);
});
