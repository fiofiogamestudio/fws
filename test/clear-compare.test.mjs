import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compareTrees, parseArguments, formatReport } from '../skills/fw-clear/scripts/compare-trees.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../skills/fw-clear/scripts/compare-trees.mjs', import.meta.url));
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-compare-'));
  const candidate = path.join(parent, '旧 Assets & %');
  const retain = path.join(parent, '保留 Assets');
  await fs.mkdir(candidate);
  await fs.mkdir(retain);
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const realTemp = await fs.realpath(os.tmpdir());
    const relative = path.relative(realTemp, realParent);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.equal(realParent.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(realParent, { recursive: true, force: true });
  });
  const write = async (root, relative, data) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), data);
  };
  return { parent, candidate, retain, write };
}

test('every measured candidate byte is accounted and only equal-size matching paths are hashed', async t => {
  const f = await fixture(t);
  for (const [relative, left, right] of [['same.bin', 'ABC', 'ABC'], ['different.bin', 'ABC', 'DEF'], ['size.bin', 'AB', 'ABCD'], ['missing.bin', 'only', null]]) {
    await f.write(f.candidate, relative, left);
    if (right !== null) await f.write(f.retain, relative, right);
  }
  await f.write(f.retain, 'kept-only.bin', 'new');
  const opened = [];
  const io = Object.create(fs);
  io.open = async (...args) => { opened.push(args[0]); return fs.open(...args); };
  const report = await compareTrees(f.candidate, f.retain, { io });
  assert.equal(report.comparisonComplete, true);
  assert.equal(report.candidateTotals.logicalBytes, 12);
  assert.equal(report.candidateTotals.files, 4);
  assert.equal(Object.values(report.summary).reduce((sum, row) => sum + row.logicalBytes, 0), 12);
  assert.equal(report.summary.identical.files, 1);
  assert.equal(report.summary.different.files, 2);
  assert.equal(report.summary.candidateOnly.files, 1);
  assert.equal(report.summary.unknown.files, 0);
  assert.equal(report.retainedOnly[0].relativePath, 'kept-only.bin');
  assert.equal(report.hashReadBytes, 12);
  assert.equal(opened.length, 4);
  assert.ok(opened.every(filename => /(?:same|different)\.bin$/.test(filename)));
  assert.match(report.warning, /does not prove.*dispensable/);
  const text = formatReport(report, { top: 0 });
  assert.match(text, /Presentation residual: 1 files, .*3 bytes/);
  assert.match(text, /Audit consumers/);
  assert.equal(await fs.readFile(path.join(f.candidate, 'missing.bin'), 'utf8'), 'only');
});

test('relative locations and file-directory conflicts are respected without basename matching', async t => {
  const f = await fixture(t);
  await f.write(f.candidate, 'old/model.bin', 'same');
  await f.write(f.retain, 'new/model.bin', 'same');
  await f.write(f.candidate, 'conflict', 'file');
  await fs.mkdir(path.join(f.retain, 'conflict'));
  const io = Object.create(fs);
  io.open = async () => { throw new Error('No file in this fixture should be hashed.'); };
  const report = await compareTrees(f.candidate, f.retain, { io });
  assert.equal(report.summary.candidateOnly.files, 1);
  assert.equal(report.summary.different.files, 1);
  assert.equal(report.retainedOnly.length, 1);
  assert.equal(report.hashedPairs, 0);
  assert.equal(report.comparisonComplete, true);
});

test('roots must be explicit, separate, non-redirected directories; nested links are unknown', async t => {
  const f = await fixture(t);
  const nested = path.join(f.candidate, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(compareTrees('relative', f.retain), /absolute/);
  await assert.rejects(compareTrees(path.parse(f.parent).root, f.retain), /Drive\/filesystem roots/);
  await assert.rejects(compareTrees(f.candidate, nested), /non-overlapping/);
  await assert.rejects(compareTrees(f.candidate, f.candidate), /non-overlapping/);
  const outside = path.join(f.parent, 'outside');
  await f.write(outside, 'important.bin', 'do not read linked source');
  const link = path.join(f.parent, 'linked-root');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(outside, link, linkType);
  await assert.rejects(compareTrees(link, f.retain), /non-redirected/);
  await f.write(f.candidate, 'linked/important.bin', 'candidate');
  await fs.symlink(outside, path.join(f.retain, 'linked'), linkType);
  const report = await compareTrees(f.candidate, f.retain);
  assert.equal(report.summary.unknown.files, 1);
  assert.equal(report.summary.candidateOnly.files, 0);
  assert.equal(report.hashReadBytes, 0);
  assert.equal(report.comparisonComplete, false);
  assert.equal(report.unmeasured.retainedLogicalBytes, null);
  assert.equal(report.issues[0].kind, 'link');
  assert.equal(await fs.readFile(path.join(outside, 'important.bin'), 'utf8'), 'do not read linked source');
});

test('unreadable counterparts and unreadable candidate subtrees remain unknown, never absent', async t => {
  const f = await fixture(t);
  await f.write(f.candidate, 'unreadable/data.bin', 'original');
  await f.write(f.retain, 'unreadable/data.bin', 'original');
  await f.write(f.retain, 'unreadable/other.bin', 'retained');
  const io = Object.create(fs);
  io.readdir = async (filename, options) => {
    if (filename === path.join(f.candidate, 'unreadable')) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return fs.readdir(filename, options);
  };
  const report = await compareTrees(f.candidate, f.retain, { io });
  assert.equal(report.comparisonComplete, false);
  assert.equal(report.retainedOnly.length, 0);
  assert.equal(report.retainedUnknown.length, 2);
  assert.equal(report.unmeasured.candidateLogicalBytes, null);
  const counterpartIO = Object.create(fs);
  counterpartIO.lstat = async filename => {
    if (filename === path.join(f.retain, 'unreadable', 'data.bin')) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return fs.lstat(filename);
  };
  const counterpart = await compareTrees(f.candidate, f.retain, { io: counterpartIO });
  assert.equal(counterpart.summary.unknown.files, 1);
  assert.equal(counterpart.summary.candidateOnly.files, 0);
  assert.equal(counterpart.hashReadBytes, 0);
});

test('read failures and metadata mutation on either hash stream cannot count as identical', async t => {
  for (const mode of ['read-error', 'candidate-metadata', 'retain-metadata']) {
    const f = await fixture(t);
    await f.write(f.candidate, 'asset.bin', 'content');
    await f.write(f.retain, 'asset.bin', 'content');
    const io = Object.create(fs);
    io.open = async (...args) => {
      const handle = await fs.open(...args);
      const targeted = args[0].startsWith(mode === 'retain-metadata' ? f.retain : f.candidate);
      let reads = 0;
      return {
        close: () => handle.close(),
        stat: async () => {
          const info = await handle.stat();
          if (targeted && reads > 0 && mode !== 'read-error') info.mtimeMs += 1000;
          return info;
        },
        read: async (...readArgs) => {
          if (targeted && mode === 'read-error') throw Object.assign(new Error('Simulated read failure'), { code: 'EIO' });
          reads++;
          return handle.read(...readArgs);
        },
      };
    };
    const report = await compareTrees(f.candidate, f.retain, { io });
    assert.equal(report.summary.identical.files, 0, mode);
    assert.equal(report.summary.unknown.files, 1, mode);
    assert.equal(report.summary.unknown.logicalBytes, 7, mode);
    assert.equal(report.comparisonComplete, false, mode);
    assert.equal(await fs.readFile(path.join(f.candidate, 'asset.bin'), 'utf8'), 'content');
  }
});

test('new files appearing during hashing make directory coverage uncertain', async t => {
  const f = await fixture(t);
  await f.write(f.candidate, 'asset.bin', 'content');
  await f.write(f.retain, 'asset.bin', 'content');
  const io = Object.create(fs);
  let changed = false;
  io.open = async (...args) => {
    if (!changed) { changed = true; await f.write(f.candidate, 'new-important.cs', 'new source'); }
    return fs.open(...args);
  };
  const report = await compareTrees(f.candidate, f.retain, { io });
  assert.equal(report.summary.identical.files, 0);
  assert.equal(report.summary.unknown.files, 1);
  assert.equal(report.unmeasured.candidateLogicalBytes, null);
  assert.ok(report.issues.some(row => /Directory changed/.test(row.reason)));
});

test('CLI JSON stays parseable, makes no files, and rejects ambiguous arguments', async t => {
  const f = await fixture(t);
  await f.write(f.candidate, 'a.bin', 'same');
  await f.write(f.retain, 'a.bin', 'same');
  const before = await fs.readdir(f.parent);
  const result = await run(process.execPath, [script, '--candidate', f.candidate, '--retain', f.retain, '--json', '--progress'], { windowsHide: true });
  assert.equal(JSON.parse(result.stdout).summary.identical.files, 1);
  assert.match(result.stderr, /Compare finished/);
  assert.deepEqual(await fs.readdir(f.parent), before);
  for (const args of [[], ['--candidate', f.candidate], ['--top', '-1'], ['--candidate', 'a', '--candidate', 'b'], ['--delete']]) assert.throws(() => parseArguments(args), /Usage/);
  assert.equal(parseArguments(['--candidate', 'a', '--retain', 'b', '--top', '0']).top, 0);
});
