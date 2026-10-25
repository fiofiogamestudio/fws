import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanSpace, parseArguments, formatReport } from '../skills/fw-clear/scripts/scan-space.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../skills/fw-clear/scripts/scan-space.mjs', import.meta.url));

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-test-'));
  // parent is created by this test, never derived from user input.
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const realTemp = await fs.realpath(os.tmpdir());
    const relative = path.relative(realTemp, realParent);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(realParent.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(realParent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'project');
  await fs.mkdir(path.join(root, 'cache', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty'));
  await fs.writeFile(path.join(root, 'source.txt'), Buffer.alloc(7, 65));
  await fs.writeFile(path.join(root, 'cache', 'small.bin'), Buffer.alloc(3, 66));
  await fs.writeFile(path.join(root, 'cache', 'nested', 'big.bin'), Buffer.alloc(11, 67));
  const older = new Date('2020-01-02T03:04:05Z');
  const newer = new Date('2024-02-03T04:05:06Z');
  await fs.utimes(path.join(root, 'source.txt'), older, older);
  await fs.utimes(path.join(root, 'cache', 'small.bin'), newer, newer);
  await fs.utimes(path.join(root, 'cache', 'nested', 'big.bin'), newer, newer);
  return { parent, root };
}

test('full-tree totals, bounded file list, time range and directory depth are independent', async t => {
  const { root } = await fixture(t);
  const progress = [];
  const result = await scanSpace(root, { depth: 1, top: 2, onProgress: value => progress.push(value) });
  assert.equal(result.totals.logicalBytes, 21);
  assert.equal(result.totals.files, 3);
  assert.equal(result.totals.directories, 4);
  assert.equal(result.totals.earliestFileMtime, '2020-01-02T03:04:05.000Z');
  assert.equal(result.totals.latestFileMtime, '2024-02-03T04:05:06.000Z');
  assert.deepEqual(result.largestFiles.map(file => file.logicalBytes), [11, 7]);
  assert.deepEqual(result.directories.map(dir => dir.relativePath), ['.', 'cache', 'empty']);
  assert.equal(result.directories.find(dir => dir.relativePath === 'cache').logicalBytes, 14);
  assert.equal(result.errorCount, 0);
  assert.equal(result.consistentSnapshot, false);
  assert.ok(progress.length >= 2);
  assert.equal(progress.at(-1).final, true);
  assert.ok(progress.every(value => path.isAbsolute(value.currentPath) && !path.relative(root, value.currentPath).startsWith('..')));
  const shallow = await scanSpace(root, { depth: 0, top: 0 });
  assert.equal(shallow.totals.logicalBytes, 21);
  assert.equal(shallow.directories.length, 1);
  assert.equal(shallow.largestFiles.length, 0);
  const limited = await scanSpace(root, { dirs: 1 });
  assert.equal(limited.directories.length, 1);
  assert.equal(limited.directories[0].relativePath, '.');
  assert.equal(limited.directoryDetailCount, 4);
  assert.equal(limited.directoryDetailsOmitted, 3);
});

test('junction/symlink targets outside the project and cycles are skipped, linked roots are rejected', async t => {
  const { parent, root } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'only-source.bin'), Buffer.alloc(100));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(outside, path.join(root, 'linked-outside'), linkType);
  await fs.symlink(root, path.join(root, 'cycle'), linkType);
  const result = await scanSpace(root, { inventory: true });
  assert.equal(result.totals.logicalBytes, 21);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.totals.skippedCount, 2);
  assert.equal(result.totals.directSkippedCount, 2);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.unmeasured.logicalBytes, null);
  assert.equal(result.inventoryComplete, true);
  assert.equal(result.inventory.reduce((sum, row) => sum + row.directBytes, 0), 21);
  assert.ok(!result.inventory.some(row => /linked-outside|cycle/.test(row.relativePath)));
  assert.ok(result.skipped.every(entry => entry.reason === 'symbolic-link-or-junction'));
  await assert.rejects(scanSpace(path.join(root, 'linked-outside')), /non-redirected directory/);
  const before = await fs.readFile(path.join(outside, 'only-source.bin'));
  assert.equal(before.length, 100);
});

test('unreadable or disappearing paths are counted and retained while other files still contribute', async t => {
  const { root } = await fixture(t);
  const io = Object.create(fs);
  io.lstat = async filename => {
    if (filename === path.join(root, 'source.txt')) throw Object.assign(new Error('simulated inaccessible file'), { code: 'EACCES' });
    return fs.lstat(filename);
  };
  io.readdir = async (filename, options) => {
    if (filename === path.join(root, 'empty')) throw Object.assign(new Error('simulated disappearing directory'), { code: 'ENOENT' });
    return fs.readdir(filename, options);
  };
  const result = await scanSpace(root, { io, inventory: true });
  assert.equal(result.totals.logicalBytes, 14);
  assert.equal(result.errorCount, 2);
  assert.equal(result.totals.errorCount, 2);
  assert.equal(result.totals.directErrorCount, 1);
  assert.equal(result.inventory.find(row => row.relativePath === 'empty').directErrorCount, 1);
  assert.equal(result.inventory.reduce((sum, row) => sum + row.directErrorCount, 0), result.errorCount);
  assert.equal(result.inventory.reduce((sum, row) => sum + row.directBytes, 0), 14);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.unmeasured.logicalBytes, null);
  assert.deepEqual(new Set(result.errors.map(error => error.code)), new Set(['EACCES', 'ENOENT']));
  assert.match(formatReport(result), /Errors: 2/);
  assert.match(formatReport(result), /Logical bytes are not allocated/);
  assert.match(formatReport(result), /Unmeasured bytes: unknown/);
});

test('complete inventory exposes deep small-file hotspots and all siblings despite bounded presentation', async t => {
  const { root } = await fixture(t);
  const deep = path.join(root, 'Library', 'ToolProject', '.godot', 'imported', 'worker', 'objects');
  await fs.mkdir(deep, { recursive: true });
  await Promise.all(Array.from({ length: 128 }, (_, index) => fs.writeFile(path.join(deep, `small-${String(index).padStart(3, '0')}.bin`), Buffer.alloc(13))));
  for (let index = 0; index < 64; index++) {
    const sibling = path.join(root, `artifact-${String(index).padStart(3, '0')}`);
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'result.bin'), Buffer.alloc(index + 1));
  }
  // Names/locations never confer delete permission: keep nested repository,
  // manual source and cache together in the measured inventory.
  const nested = path.join(root, 'Library', 'ToolProject');
  await fs.mkdir(path.join(nested, '.git'));
  await fs.writeFile(path.join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const source = path.join(nested, 'manual-source.gd');
  await fs.writeFile(source, 'extends Node\n');
  const gitBytes = Buffer.byteLength('ref: refs/heads/main\n');
  const sourceBytes = Buffer.byteLength('extends Node\n');
  const expectedBytes = 21 + 128 * 13 + 64 * 65 / 2 + gitBytes + sourceBytes;
  const result = await scanSpace(root, { depth: 1, dirs: 2, top: 1, hotspots: 2, inventory: true });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.totals.logicalBytes, expectedBytes);
  assert.equal(result.directories.length, 2);
  assert.ok(result.directoryDetailsOmitted > 50);
  assert.ok(result.directoryDepthOmitted >= 6);
  assert.equal(result.inventory.length, result.totals.directories);
  assert.equal(new Set(result.inventory.map(row => row.relativePath)).size, result.inventory.length);
  assert.equal(result.inventory.reduce((sum, row) => sum + row.directBytes, 0), expectedBytes);
  assert.equal(result.inventory.reduce((sum, row) => sum + row.directFiles, 0), result.totals.files);
  assert.equal(result.inventory.filter(row => row.relativePath.startsWith('artifact-')).length, 64);
  assert.equal(result.deepHotspots[0].relativePath, path.relative(root, deep));
  assert.equal(result.deepHotspots[0].directBytes, 128 * 13);
  assert.equal(result.deepHotspots[0].directFiles, 128);
  assert.equal(result.deepHotspots[0].logicalBytes, 128 * 13);
  assert.ok(result.deepHotspotsOmitted > 50);
  assert.equal(result.largestFilesOmitted, result.totals.files - 1);
  assert.equal(result.measurementComplete, true);
  assert.equal(result.unmeasured.logicalBytes, 0);
  const rows = new Map(result.inventory.map(row => [row.relativePath, row]));
  assert.equal(rows.get('.').parentRelativePath, null);
  assert.equal(rows.get(path.relative(root, nested)).directBytes, sourceBytes);
  assert.equal(rows.get(path.relative(root, path.join(nested, '.git'))).directBytes, gitBytes);
  for (const row of result.inventory) {
    const children = result.inventory.filter(child => child.parentRelativePath === row.relativePath);
    assert.equal(row.childDirectories, children.length, row.relativePath);
    assert.equal(row.logicalBytes, row.directBytes + children.reduce((sum, child) => sum + child.logicalBytes, 0), row.relativePath);
    assert.equal(row.files, row.directFiles + children.reduce((sum, child) => sum + child.files, 0), row.relativePath);
  }
  assert.equal(await fs.readFile(source, 'utf8'), 'extends Node\n');
  assert.match(formatReport(result), /Deep direct-file hotspots \(all depths/);
  assert.match(formatReport(result), /Full directory inventory:/);
});

test('all disabled presentation lists still retain complete accounting and deterministic tie order', async t => {
  const { root } = await fixture(t);
  for (let index = 15; index >= 0; index--) await fs.writeFile(path.join(root, `tie-${String(index).padStart(2, '0')}.bin`), Buffer.alloc(17));
  const result = await scanSpace(root, { depth: 0, dirs: 0, top: 3, hotspots: 0, inventory: true });
  assert.deepEqual(result.largestFiles.map(row => row.relativePath), ['tie-00.bin', 'tie-01.bin', 'tie-02.bin']);
  assert.deepEqual(result.directories, []);
  assert.deepEqual(result.deepHotspots, []);
  assert.equal(result.directoryDetailsOmitted, 1);
  assert.equal(result.directoryDepthOmitted, 3);
  assert.equal(result.deepHotspotCount, 3);
  assert.equal(result.deepHotspotsOmitted, 3);
  assert.equal(result.inventory.length, 4);
  assert.equal(result.inventory.reduce((sum, row) => sum + row.directBytes, 0), 21 + 16 * 17);
  const lean = await scanSpace(root, { top: 0, dirs: 0, hotspots: 0 });
  assert.equal(lean.inventoryEnabled, false);
  assert.equal(lean.inventory, null);
  assert.equal(lean.inventoryComplete, null);
  assert.equal(lean.totals.logicalBytes, result.totals.logicalBytes);
});

test('diagnostic counters propagate independently of the capped path samples', async t => {
  const { root } = await fixture(t);
  const troubled = path.join(root, 'cache', 'nested');
  const io = Object.create(fs);
  io.readdir = async (filename, options) => filename === troubled
    ? Array.from({ length: 105 }, (_, index) => ({ name: `inaccessible-${index}` }))
    : fs.readdir(filename, options);
  io.lstat = async filename => filename.startsWith(path.join(troubled, 'inaccessible-'))
    ? Promise.reject(Object.assign(new Error('simulated denied metadata'), { code: 'EACCES' }))
    : fs.lstat(filename);
  const result = await scanSpace(root, { inventory: true, io });
  assert.equal(result.errorCount, 105);
  assert.equal(result.errors.length, 100);
  assert.equal(result.unmeasured.errorsOmitted, 5);
  assert.equal(result.totals.errorCount, 105);
  assert.equal(result.totals.directErrorCount, 0);
  const cache = result.inventory.find(row => row.relativePath === 'cache');
  const nested = result.inventory.find(row => row.relativePath === path.join('cache', 'nested'));
  assert.equal(cache.errorCount, 105);
  assert.equal(cache.directErrorCount, 0);
  assert.equal(nested.errorCount, 105);
  assert.equal(nested.directErrorCount, 105);
  assert.equal(result.totals.logicalBytes, 10);
});

test('metadata inventory exposes Git files directories bare repositories and worktree admin markers', async t => {
  const { root } = await fixture(t);
  const gitFile = path.join(root, 'cache', 'worktree');
  await fs.mkdir(gitFile);
  await fs.writeFile(path.join(gitFile, '.git'), 'gitdir: /other/repository/.git/worktrees/test\n');
  const gitDirectory = path.join(root, 'cache', 'repository');
  await fs.mkdir(path.join(gitDirectory, '.git'), { recursive: true });
  const bare = path.join(root, 'cache', 'bare-repository');
  await fs.mkdir(path.join(bare, 'objects'), { recursive: true });
  await fs.mkdir(path.join(bare, 'refs'));
  await fs.writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  const admin = path.join(root, 'cache', 'worktree-admin');
  await fs.mkdir(admin);
  for (const name of ['HEAD', 'commondir', 'gitdir']) await fs.writeFile(path.join(admin, name), 'marker\n');
  const ordinary = path.join(root, 'cache', 'ordinary');
  await fs.mkdir(ordinary);
  await fs.writeFile(path.join(ordinary, 'HEAD'), 'not enough to identify Git\n');
  const result = await scanSpace(root, { inventory: true });
  const rows = new Map(result.inventory.map(row => [row.relativePath, row]));
  assert.deepEqual(rows.get(path.relative(root, gitFile)).directGitMarkers, ['.git']);
  assert.deepEqual(rows.get(path.relative(root, gitDirectory)).directGitMarkers, ['.git']);
  assert.deepEqual(rows.get(path.relative(root, bare)).directGitMarkers, ['HEAD', 'objects', 'refs']);
  assert.deepEqual(rows.get(path.relative(root, admin)).directGitMarkers, ['HEAD', 'commondir', 'gitdir']);
  assert.deepEqual(rows.get(path.relative(root, ordinary)).directGitMarkers, []);
  assert.ok(result.inventory.every(row => Array.isArray(row.directGitMarkers)));
  assert.equal(await fs.readFile(path.join(gitFile, '.git'), 'utf8'), 'gitdir: /other/repository/.git/worktrees/test\n');
});

test('optional per-file metadata exactly reconciles mixed direct buckets without reading file contents', async t => {
  const { root } = await fixture(t);
  const files = new Map([['duplicate player.dll', 31], ['必要源文件.txt', 17], ['.git', 13], ['empty file.bin', 0]]);
  for (const [name, bytes] of files) await fs.writeFile(path.join(root, 'cache', name), Buffer.alloc(bytes));
  const io = Object.create(fs);
  io.readFile = async () => { throw new Error('The scanner must not read file contents.'); };
  const result = await scanSpace(root, { inventory: false, fileDetails: true, top: 0, dirs: 0, hotspots: 0, io });
  assert.equal(result.inventoryEnabled, true);
  assert.equal(result.fileDetailsEnabled, true);
  for (const row of result.inventory) {
    assert.ok(Array.isArray(row.directFileEntries));
    assert.equal(row.directFileEntries.length, row.directFiles, row.relativePath);
    assert.equal(row.directFileEntries.reduce((sum, file) => sum + file.logicalBytes, 0), row.directBytes, row.relativePath);
    assert.ok(row.directFileEntries.every(file => Object.keys(file).sort().join(',') === 'logicalBytes,modifiedAt,name'));
    assert.ok(row.directFileEntries.every(file => Number.isFinite(Date.parse(file.modifiedAt))));
  }
  const cache = result.inventory.find(row => row.relativePath === 'cache');
  const entries = new Map(cache.directFileEntries.map(file => [file.name, file]));
  for (const [name, bytes] of files) assert.equal(entries.get(name).logicalBytes, bytes);
  assert.ok(!entries.has('nested'));
  assert.deepEqual(cache.directGitMarkers, ['.git']);
  assert.deepEqual(result.inventory.find(row => row.relativePath === 'empty').directFileEntries, []);
  const lean = await scanSpace(root, { inventory: true });
  assert.equal(lean.fileDetailsEnabled, false);
  assert.ok(lean.inventory.every(row => row.directFileEntries === null));
  assert.equal(lean.totals.logicalBytes, result.totals.logicalBytes);
  assert.match(formatReport(result), /Per-file metadata enabled/);
});

test('per-file metadata lists only measured regular files while unreadable files and links remain unknown', async t => {
  const { root } = await fixture(t);
  const link = path.join(root, 'linked-cache');
  await fs.symlink(path.join(root, 'cache'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const io = Object.create(fs);
  io.lstat = async filename => {
    if (filename === path.join(root, 'source.txt')) throw Object.assign(new Error('simulated denied metadata'), { code: 'EACCES' });
    return fs.lstat(filename);
  };
  const result = await scanSpace(root, { fileDetails: true, io });
  const all = result.inventory.flatMap(row => row.directFileEntries);
  assert.equal(all.length, 2);
  assert.equal(all.reduce((sum, file) => sum + file.logicalBytes, 0), 14);
  assert.ok(!all.some(file => file.name === 'source.txt' || file.name === 'linked-cache'));
  assert.equal(result.unmeasured.logicalBytes, null);
  assert.equal(result.errorCount, 1);
  assert.equal(result.skippedCount, 1);
});

test('CLI emits parseable JSON and separate progress without modifying files or adding output artifacts', async t => {
  const { root } = await fixture(t);
  const source = path.join(root, 'source.txt');
  const before = { names: await fs.readdir(root), bytes: await fs.readFile(source), info: await fs.stat(source) };
  const { stdout, stderr } = await run(process.execPath, [script, '--root', root, '--depth', '0', '--top', '1', '--hotspots', '2', '--file-details', '--json', '--progress']);
  const report = JSON.parse(stdout);
  assert.equal(report.totals.logicalBytes, 21);
  assert.equal(report.largestFiles[0].logicalBytes, 11);
  assert.equal(report.inventory.length, 4);
  assert.equal(report.deepHotspots.length, 2);
  assert.equal(report.fileDetailsEnabled, true);
  assert.equal(report.inventory.flatMap(row => row.directFileEntries).length, 3);
  assert.match(stderr, /Scan progress: 3 files, 4 directories, 21 logical bytes, 0 errors, 0 skipped .* finished/);
  assert.deepEqual(await fs.readdir(root), before.names);
  assert.deepEqual(await fs.readFile(source), before.bytes);
  assert.equal((await fs.stat(source)).mtimeMs, before.info.mtimeMs);
});

test('invalid roots and options fail instead of guessing a workspace or accepting mutation flags', async t => {
  const { root } = await fixture(t);
  await assert.rejects(scanSpace('.'), /absolute/);
  await assert.rejects(scanSpace(path.join(root, 'source.txt')), /real, non-redirected directory/);
  await assert.rejects(scanSpace(root, { depth: -1 }), /depth/);
  await assert.rejects(scanSpace(root, { top: 1001 }), /top/);
  await assert.rejects(scanSpace(root, { dirs: -1 }), /dirs/);
  await assert.rejects(scanSpace(root, { hotspots: 1001 }), /hotspots/);
  await assert.rejects(scanSpace(root, { inventory: 'true' }), /inventory/);
  await assert.rejects(scanSpace(root, { fileDetails: 'true' }), /fileDetails/);
  assert.equal(parseArguments(['--root', root, '--file-details']).inventory, true);
  for (const args of [[], ['--root'], ['--root', root, '--apply'], ['--root', root, '--depth', '1.5'], ['--root', root, '--root', root]]) assert.throws(() => parseArguments(args), /Usage/);
  assert.equal(parseArguments(['--help']).help, true);
});
