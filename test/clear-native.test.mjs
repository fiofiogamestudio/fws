import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanSpace } from '../skills/fw-clear/scripts/scan-space.mjs';
import { reviewSpace } from '../skills/fw-clear/scripts/review-space.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../skills/fw-clear/scripts/scan-space-native.ps1', import.meta.url));
const windows = process.platform === 'win32';
const argumentsFor = root => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root];
const native = async (root, progress = false, fileDetails = false) => {
  const result = await run('powershell.exe', [...argumentsFor(root), ...(progress ? ['-Progress'] : []), ...(fileDetails ? ['-FileDetails'] : [])], { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 });
  return { ...result, report: JSON.parse(result.stdout.replace(/^\uFEFF/, '')) };
};

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-native-'));
  t.after(async () => {
    const real = await fs.realpath(parent);
    const temporary = await fs.realpath(os.tmpdir());
    const relative = path.relative(temporary, real);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(real.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(real, { recursive: true, force: true });
  });
  const root = path.join(parent, "project 中文 & a'b");
  await fs.mkdir(path.join(root, 'cache', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty'));
  await fs.writeFile(path.join(root, "源 & source's.txt"), Buffer.alloc(7, 65));
  await fs.writeFile(path.join(root, 'cache', 'small.bin'), Buffer.alloc(3, 66));
  await fs.writeFile(path.join(root, 'cache', 'nested', 'big.bin'), Buffer.alloc(11, 67));
  // NTFS exposes finer timestamps than JavaScript Date. Use exact seconds when
  // comparing two runtimes' millisecond formatting instead of their rounding.
  for (const name of ["源 & source's.txt", 'cache/small.bin', 'cache/nested/big.bin']) {
    const timestamp = new Date('2024-02-03T04:05:06Z');
    await fs.utimes(path.join(root, name), timestamp, timestamp);
  }
  return { parent, root };
}

test('native cached metadata agrees with portable scan and reconciles every directory', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  const actual = (await native(root)).report;
  const portable = await scanSpace(root, { inventory: true });
  const counters = ['logicalBytes', 'directBytes', 'files', 'directFiles', 'directories', 'childDirectories', 'errorCount', 'directErrorCount', 'skippedCount', 'directSkippedCount'];
  assert.equal(actual.totals.logicalBytes, 21);
  assert.equal(actual.totals.files, 3);
  assert.equal(actual.totals.directories, 4);
  assert.equal(actual.inventory.length, portable.inventory.length);
  for (const row of actual.inventory) {
    const expected = portable.inventory.find(other => other.relativePath.replaceAll('\\', '/') === row.relativePath);
    assert.ok(expected, row.relativePath);
    for (const key of counters) assert.equal(row[key], expected[key], `${row.relativePath}.${key}`);
    assert.deepEqual(row.directGitMarkers, expected.directGitMarkers);
    assert.equal(row.earliestFileMtime, expected.earliestFileMtime);
    assert.equal(row.latestFileMtime, expected.latestFileMtime);
  }
  const review = reviewSpace(actual, { chunkMiB: 0.000001 });
  assert.equal(review.partitionCoveragePercent, 100);
  assert.equal(review.logicalBytes, 21);
  assert.equal(actual.measurementComplete, true);
  assert.equal(actual.consistentSnapshot, false);
  assert.equal(actual.unmeasured.logicalBytes, 0);
});

test('native stdout is JSON, progress is separate, and scanning creates or changes no project files', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  const snapshot = async () => {
    const names = await fs.readdir(root, { recursive: true });
    const result = [];
    for (const name of names.sort()) {
      const filename = path.join(root, name);
      const info = await fs.stat(filename);
      result.push({ name, mtime: info.mtimeMs, size: info.size, directory: info.isDirectory(),
        hash: info.isFile() ? crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex') : null });
    }
    return result;
  };
  const before = await snapshot();
  const result = await native(root, true);
  const progress = result.stderr.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(progress.length >= 2);
  assert.equal(progress[0].final, false);
  assert.equal(progress.at(-1).final, true);
  assert.equal(progress.at(-1).logicalBytes, 21);
  assert.ok(progress.every(row => path.isAbsolute(row.currentPath)));
  assert.equal((await native(root)).stderr, '');
  assert.deepEqual(await snapshot(), before);
});

test('native observes Git file, bare-storage and worktree-admin markers with original case', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, '.GIT'), 'gitdir: ../private');
  await fs.mkdir(path.join(root, 'bare', 'OBJECTS'), { recursive: true });
  await fs.mkdir(path.join(root, 'bare', 'Refs'));
  await fs.writeFile(path.join(root, 'bare', 'head'), 'ref: refs/heads/main');
  await fs.mkdir(path.join(root, 'admin'));
  for (const name of ['HEAD', 'commondir', 'gitdir']) await fs.writeFile(path.join(root, 'admin', name), 'x');
  const result = (await native(root)).report;
  assert.deepEqual(result.inventory.find(row => row.relativePath === '.').directGitMarkers, ['.GIT']);
  assert.deepEqual(result.inventory.find(row => row.relativePath === 'bare').directGitMarkers, ['head', 'OBJECTS', 'Refs']);
  assert.deepEqual(result.inventory.find(row => row.relativePath === 'admin').directGitMarkers, ['HEAD', 'commondir', 'gitdir']);
  assert.deepEqual(result.inventory.find(row => row.relativePath === 'empty').directGitMarkers, []);
  assert.equal(reviewSpace(result).partitionCoveragePercent, 100);
});

test('native skips outside links and cycles and rejects linked roots, linked ancestors and nonabsolute roots', { skip: !windows }, async t => {
  const { parent, root } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'protected.txt'), Buffer.alloc(100));
  await fs.symlink(outside, path.join(root, 'outside-link'), 'junction');
  await fs.symlink(root, path.join(root, 'cycle'), 'junction');
  const result = (await native(root)).report;
  assert.equal(result.totals.logicalBytes, 21);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.totals.directSkippedCount, 2);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.unmeasured.logicalBytes, null);
  assert.equal(reviewSpace(result).unmeasured.skippedCount, 2);
  for (const invalid of [path.join(root, 'cycle'), path.join(root, 'cycle', 'cache'), '.', 'C:relative', path.join(root, 'missing'), path.join(root, "源 & source's.txt")]) {
    await assert.rejects(native(invalid), invalid);
  }
  assert.equal((await fs.readFile(path.join(outside, 'protected.txt'))).length, 100);
});

test('native bounds skipped-entry samples while retaining exact diagnostic totals and unknown bytes', { skip: !windows }, async t => {
  const { parent, root } = await fixture(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  for (let i = 0; i < 103; i++) await fs.symlink(outside, path.join(root, `link-${i}`), 'junction');
  const result = (await native(root)).report;
  assert.equal(result.skippedCount, 103);
  assert.equal(result.skipped.length, 100);
  assert.equal(result.unmeasured.skippedOmitted, 3);
  assert.equal(result.totals.skippedCount, 103);
  assert.equal(result.totals.logicalBytes, 21);
  assert.equal(result.unmeasured.logicalBytes, null);
  assert.equal(reviewSpace(result).logicalBytes, 21);
});

test('optional native file details enumerate exact direct files without duplicating recursive buckets', { skip: !windows }, async t => {
  const { root } = await fixture(t);
  const light = (await native(root)).report;
  assert.equal(light.fileDetailsEnabled, false);
  assert.ok(light.inventory.every(row => row.directFileEntries === null));
  const detailed = (await native(root, false, true)).report;
  assert.equal(detailed.fileDetailsEnabled, true);
  for (const row of detailed.inventory) {
    assert.equal(row.directFileEntries.length, row.directFiles);
    assert.equal(row.directFileEntries.reduce((sum, file) => sum + file.logicalBytes, 0), row.directBytes);
    for (const file of row.directFileEntries) {
      assert.ok(!file.name.includes('/') && !file.name.includes('\\'));
      assert.equal(file.modifiedAt, '2024-02-03T04:05:06.000Z');
      assert.equal((await fs.stat(path.join(root, row.relativePath, file.name))).size, file.logicalBytes);
    }
  }
  assert.deepEqual(detailed.inventory.find(row => row.relativePath === '.').directFileEntries.map(file => file.name), ["源 & source's.txt"]);
  assert.equal(reviewSpace(detailed).logicalBytes, 21);
});
