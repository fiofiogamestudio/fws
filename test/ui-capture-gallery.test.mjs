import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { buildGallery, validateManifest } from '../skills/fw-ui-capture/scripts/build-gallery.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function png(width = 3, height = 2) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const start = row * (width * 4 + 1) + 1 + column * 4;
    pixels.set([240, 170, 70, 255], start);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-ui-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'), manifestPath = path.join(input, 'capture.json'), outDirectory = path.join(root, 'gallery');
  await fs.mkdir(path.join(input, 'captures'), { recursive: true });
  const bytes = png(); await fs.writeFile(path.join(input, 'captures', 'cover.png'), bytes);
  const manifest = {
    schemaVersion: 1, title: '跨游戏 UI 截图', project: 'example-game',
    run: { id: 'capture-20261007', capturedAt: '2026-10-07T01:30:00+08:00', sourceRevision: 'local-dirty', evidence: 'Native GPU capture; runner report.json. This test uses synthetic PNG fixtures.' },
    screenshots: [{ id: 'cover', number: 7, title: '主菜单', category: '入口', path: 'captures/cover.png', width: 3, height: 2, viewport: { width: 3, height: 2, dpr: 1 }, state: { screen: 'cover', save: false }, notes: '默认状态' }],
    coverage: [{ id: 'menu', title: '主菜单', status: 'captured', screenshotIds: ['cover'] }],
  };
  const save = () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await save();
  return { root, input, bytes, manifest, manifestPath, outDirectory, save };
}

test('build creates an offline gallery with explicit numbering, true dimensions, hashes and unchanged input bytes', async t => {
  const f = await fixture(t), before = await fs.readFile(f.manifestPath);
  const result = await buildGallery(f);
  assert.equal(result.summary.percentCaptured, 100);
  const capture = JSON.parse(await fs.readFile(path.join(f.outDirectory, 'capture.json'), 'utf8'));
  assert.equal(capture.screenshots[0].path, 'images/007-cover.png');
  assert.deepEqual(capture.screenshots[0].state, { screen: 'cover', save: false });
  assert.equal(capture.screenshots[0].sha256, createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(capture.generated.sourceManifestSha256, createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(await fs.readFile(path.join(f.outDirectory, 'images/007-cover.png')), f.bytes);
  assert.deepEqual(await fs.readFile(path.join(f.input, 'captures/cover.png')), f.bytes);
  assert.deepEqual(await fs.readFile(f.manifestPath), before);
  const html = await fs.readFile(path.join(f.outDirectory, 'index.html'), 'utf8');
  assert.ok(html.includes('object-fit:contain'));
  assert.ok(!/<(?:script|link)\b[^>]*(?:src|href)=["']https?:/i.test(html));
  assert.ok(!html.includes('__CAPTURE_DATA_JSON__'));
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('counts coverage items rather than PNGs and excludes historical pictures from completed-state evidence', async t => {
  const f = await fixture(t);
  f.manifest.screenshots.push({ ...f.manifest.screenshots[0], id: 'cover-old', number: 2, historical: true });
  f.manifest.coverage.push({ id: 'paused', title: '暂停', status: 'blocked', screenshotIds: [], reason: 'Test fixture has no runtime.' });
  f.manifest.coverage.push({ id: 'store', title: '平台支付', status: 'excluded', screenshotIds: [], reason: 'Outside requested scope.' });
  await f.save(); await buildGallery(f);
  const coverage = JSON.parse(await fs.readFile(path.join(f.outDirectory, 'coverage.json'), 'utf8'));
  assert.deepEqual(coverage.summary, { total: 3, captured: 1, blocked: 1, excluded: 1, percentCaptured: 33.3, screenshots: 2, currentScreenshots: 1, historicalScreenshots: 1 });
});

test('zero screenshots with blocked/excluded coverage builds an honest empty gallery', async t => {
  const f = await fixture(t); f.manifest.screenshots = [];
  f.manifest.coverage = [{ id: 'menu', title: '主菜单', status: 'blocked', screenshotIds: [], reason: 'Runtime unavailable.' }];
  await f.save(); const result = await buildGallery(f);
  assert.equal(result.summary.percentCaptured, 0); assert.equal(result.summary.currentScreenshots, 0);
  assert.deepEqual(await fs.readdir(path.join(f.outDirectory, 'images')), []);
});

test('partial blocked coverage can retain evidence without claiming completion', async t => {
  const f = await fixture(t); f.manifest.coverage[0].status = 'blocked'; f.manifest.coverage[0].reason = 'Only the initial frame was reached.';
  await f.save(); assert.equal((await validateManifest(f.manifestPath)).coverage.summary.percentCaptured, 0);
});

test('optional empty notes are accepted', async t => {
  const f = await fixture(t); f.manifest.screenshots[0].notes = ''; await f.save();
  assert.equal((await validateManifest(f.manifestPath)).capture.screenshots[0].notes, '');
});

test('JSON embedded in HTML cannot terminate scripts or inject markup', async t => {
  const f = await fixture(t), hostile = '</script><img src=x onerror="globalThis.pwned=true"><script>&\u2028\u2029';
  f.manifest.title = hostile; f.manifest.screenshots[0].notes = hostile; f.manifest.screenshots[0].state = { value: hostile };
  await f.save(); await buildGallery(f);
  const html = await fs.readFile(path.join(f.outDirectory, 'index.html'), 'utf8');
  assert.ok(!html.includes(hostile)); assert.ok(!html.includes('<img src=x')); assert.ok(html.includes('\\u003c/script\\u003e'));
  const embedded = JSON.parse(/<script id="capture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(embedded.title, hostile); assert.equal(embedded.screenshots[0].state.value, hostile);
  assert.ok(!/\.innerHTML\s*=/.test(html));
});

test('literal template tokens in user metadata are preserved without replacing inserted JSON', async t => {
  const f = await fixture(t), tokens = '__COVERAGE_DATA_JSON__ __CAPTURE_DATA_JSON__';
  f.manifest.title = tokens;
  f.manifest.screenshots[0].notes = tokens;
  await f.save(); await buildGallery(f);
  const html = await fs.readFile(path.join(f.outDirectory, 'index.html'), 'utf8');
  const capture = JSON.parse(/<script id="capture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const coverage = JSON.parse(/<script id="coverage-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(capture.title, tokens);
  assert.equal(capture.screenshots[0].notes, tokens);
  assert.equal(coverage.summary.captured, 1);
  assert.deepEqual(coverage.items, f.manifest.coverage);
});

test('an existing output is never overwritten', async t => {
  const f = await fixture(t); await fs.mkdir(f.outDirectory); await fs.writeFile(path.join(f.outDirectory, 'keep.txt'), 'keep');
  await assert.rejects(buildGallery(f), /already exists/);
  assert.deepEqual(await fs.readdir(f.outDirectory), ['keep.txt']);
  assert.equal(await fs.readFile(path.join(f.outDirectory, 'keep.txt'), 'utf8'), 'keep');
});

const invalidCases = [
  ['schema version', m => { m.schemaVersion = 2; }, /schemaVersion/],
  ['empty project', m => { m.project = ''; }, /project/],
  ['run ID traversal', m => { m.run.id = '../run'; }, /run.id/],
  ['timestamp without zone', m => { m.run.capturedAt = '2026-10-07T01:30:00'; }, /timestamp/],
  ['missing evidence', m => { delete m.run.evidence; }, /evidence/],
  ['empty coverage', m => { m.coverage = []; }, /coverage/],
  ['invalid ID', m => { m.screenshots[0].id = '../escape'; }, /id/],
  ['zero number', m => { m.screenshots[0].number = 0; }, /number/],
  ['fractional number', m => { m.screenshots[0].number = 1.5; }, /number/],
  ['duplicate ID', m => { m.screenshots.push({ ...m.screenshots[0], number: 8 }); }, /Duplicate screenshot id/],
  ['duplicate number', m => { m.screenshots.push({ ...m.screenshots[0], id: 'other' }); }, /Duplicate screenshot number/],
  ['zero PNG metadata dimension', m => { m.screenshots[0].width = 0; }, /width/],
  ['PNG mismatch', m => { m.screenshots[0].width = 999; }, /dimensions do not match/],
  ['viewport invalid', m => { m.screenshots[0].viewport.height = 0; }, /viewport.height/],
  ['state wrong type', m => { m.screenshots[0].state = 'menu'; }, /state/],
  ['history wrong type', m => { m.screenshots[0].historical = 'yes'; }, /historical/],
  ['unknown coverage status', m => { m.coverage[0].status = 'done'; }, /status/],
  ['duplicate coverage ID', m => { m.coverage.push({ ...m.coverage[0] }); }, /Duplicate coverage id/],
  ['empty captured evidence', m => { m.coverage[0].screenshotIds = []; }, /current screenshot/],
  ['unknown captured ID', m => { m.coverage[0].screenshotIds = ['missing']; }, /unknown screenshot/],
  ['duplicate captured ID', m => { m.coverage[0].screenshotIds.push('cover'); }, /repeats screenshot/],
  ['historical-only completion', m => { m.screenshots[0].historical = true; }, /current screenshot/],
  ['unreferenced current screenshot', m => { m.screenshots.push({ ...m.screenshots[0], id: 'orphan', number: 8 }); }, /not referenced/],
  ['blocked without reason', m => { m.coverage[0].status = 'blocked'; }, /reason/],
  ['excluded without reason', m => { m.coverage[0].status = 'excluded'; }, /reason/],
  ['absolute POSIX path', m => { m.screenshots[0].path = '/tmp/cover.png'; }, /relative path/],
  ['absolute Windows path', m => { m.screenshots[0].path = 'C:\\captures\\cover.png'; }, /relative path/],
  ['Windows drive relative path', m => { m.screenshots[0].path = 'C:cover.png'; }, /relative path/],
  ['UNC path', m => { m.screenshots[0].path = '\\\\server\\share\\cover.png'; }, /relative path/],
  ['parent traversal', m => { m.screenshots[0].path = '../cover.png'; }, /relative path/],
  ['embedded traversal', m => { m.screenshots[0].path = 'captures/../captures/cover.png'; }, /relative path/],
  ['backslash traversal', m => { m.screenshots[0].path = '..\\cover.png'; }, /relative path/],
  ['null byte path', m => { m.screenshots[0].path = 'captures/\0cover.png'; }, /relative path/],
];
for (const [name, mutate, expected] of invalidCases) test(`rejects ${name} before creating output`, async t => {
  const f = await fixture(t); mutate(f.manifest); await f.save();
  await assert.rejects(buildGallery(f), expected);
  await assert.rejects(fs.lstat(f.outDirectory), { code: 'ENOENT' });
});

test('rejects invalid PNG signature, malformed IHDR and zero actual dimensions', async t => {
  const f = await fixture(t), file = path.join(f.input, 'captures/cover.png');
  for (const bytes of [Buffer.from('not PNG'), Buffer.from(f.bytes), png(0, 2)]) {
    if (bytes.length === f.bytes.length) bytes.writeUInt32BE(12, 8);
    await fs.writeFile(file, bytes);
    await assert.rejects(buildGallery(f), /PNG|IHDR/);
    await assert.rejects(fs.lstat(f.outDirectory), { code: 'ENOENT' });
  }
});

test('realpath rejects a directory symlink/junction escaping the manifest root', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'cover.png'), f.bytes);
  await fs.symlink(outside, path.join(f.input, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.manifest.screenshots[0].path = 'linked/cover.png'; await f.save();
  await assert.rejects(buildGallery(f), /symlink escapes/);
  await assert.rejects(fs.lstat(f.outDirectory), { code: 'ENOENT' });
});

test('CLI handles paths containing spaces and rejects duplicate options', async t => {
  const f = await fixture(t), script = fileURLToPath(new URL('../skills/fw-ui-capture/scripts/build-gallery.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--manifest', f.manifestPath, '--out', path.join(f.root, 'gallery with spaces')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).summary.captured, 1);
  const invalid = spawnSync(process.execPath, [script, '--manifest', f.manifestPath, '--manifest', f.manifestPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Usage/);
});
