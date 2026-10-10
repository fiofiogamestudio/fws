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
  const result = await scanSpace(root, { depth: 1, top: 2 });
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
  const result = await scanSpace(root);
  assert.equal(result.totals.logicalBytes, 21);
  assert.equal(result.skippedCount, 2);
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
  const result = await scanSpace(root, { io });
  assert.equal(result.totals.logicalBytes, 14);
  assert.equal(result.errorCount, 2);
  assert.deepEqual(new Set(result.errors.map(error => error.code)), new Set(['EACCES', 'ENOENT']));
  assert.match(formatReport(result), /Errors: 2/);
  assert.match(formatReport(result), /Logical bytes are not allocated/);
});

test('CLI emits parseable JSON and separate progress without modifying files or adding output artifacts', async t => {
  const { root } = await fixture(t);
  const source = path.join(root, 'source.txt');
  const before = { names: await fs.readdir(root), bytes: await fs.readFile(source), info: await fs.stat(source) };
  const { stdout, stderr } = await run(process.execPath, [script, '--root', root, '--depth', '0', '--top', '1', '--json', '--progress']);
  const report = JSON.parse(stdout);
  assert.equal(report.totals.logicalBytes, 21);
  assert.equal(report.largestFiles[0].logicalBytes, 11);
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
  for (const args of [[], ['--root'], ['--root', root, '--apply'], ['--root', root, '--depth', '1.5'], ['--root', root, '--root', root]]) assert.throws(() => parseArguments(args), /Usage/);
  assert.equal(parseArguments(['--help']).help, true);
});
