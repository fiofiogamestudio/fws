import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findDuplicates, readFileList, parseArguments, formatReport } from '../skills/fw-clear/scripts/find-duplicates.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../skills/fw-clear/scripts/find-duplicates.mjs', import.meta.url));
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-duplicates-'));
  const roots = [path.join(parent, '旧 output & %'), path.join(parent, '新 TestResults')];
  await Promise.all(roots.map(root => fs.mkdir(root)));
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const relative = path.relative(await fs.realpath(os.tmpdir()), realParent);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.equal(realParent.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(realParent, { recursive: true, force: true });
  });
  const write = async (index, relative, content) => {
    const filename = path.join(roots[index], relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
    return filename;
  };
  return { parent, roots, write };
}
const patchStat = (info, changes) => Object.assign(Object.create(info), changes);
const error = code => Object.assign(new Error(`injected ${code}`), { code });

test('discovers full content across different paths and names, hashing only peer size buckets', async t => {
  const f = await fixture(t);
  const one = await f.write(0, 'old/recording.mp4', 'same media');
  const two = await f.write(1, 'copy/renamed.bin', 'same media');
  const three = await f.write(0, 'same-root-too.bin', 'same media');
  await f.write(1, 'equal-size-different.bin', 'other data');
  await f.write(0, 'unique-size.bin', 'no peers at this size');
  await f.write(1, 'empty', '');
  const opened = [];
  const io = Object.create(fs);
  io.open = async (...args) => { opened.push(args[0]); return fs.open(...args); };
  const report = await findDuplicates(f.roots, { io });
  assert.equal(report.discoveryComplete, true);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(new Set(report.groups[0].members.map(file => file.path)), new Set([one, two, three]));
  assert.equal(report.groups[0].independentPhysicalFiles, 3);
  assert.equal(report.theoreticalDuplicateLogicalBytes, 20);
  assert.equal(report.hashReadBytes, 40);
  assert.equal(opened.length, 4);
  assert.ok(opened.every(filename => !filename.endsWith('unique-size.bin') && !filename.endsWith('empty')));
  assert.equal(report.excludedByFilters.files, 1);
  assert.equal(report.stablePhysicalFilesWithoutObservedSizePeer, 1);
  assert.equal(report.stableHashedPhysicalFilesOutsideDuplicateGroups, 1);
  assert.equal(report.deletionAuthorized, false);
  assert.equal(report.keeperRecommended, false);
  assert.equal(report.consistentSnapshot, false);
  assert.equal(report.physicalReclaimableBytes, null);
  assert.match(formatReport(report, { top: 0 }), /residual: 1 groups, 20 duplicate logical bytes/);
  assert.match(report.warning, /not physical reclaimable space/);
  assert.equal(await fs.readFile(one, 'utf8'), 'same media');
});

test('same prefix and length are not a full-content match', async t => {
  const f = await fixture(t);
  const first = Buffer.alloc(1024 * 1024 + 11, 65);
  const second = Buffer.from(first);
  second[second.length - 1] = 66;
  await f.write(0, 'first.bin', first);
  await f.write(1, 'second.bin', second);
  const report = await findDuplicates(f.roots);
  assert.equal(report.groups.length, 0);
  assert.equal(report.hashedPhysicalFiles, 2);
  assert.equal(report.hashReadBytes, first.length * 2);
  assert.equal(report.discoveryComplete, true);
});

test('suffix and inclusive byte limits filter before content reads; empty files require opt in', async t => {
  const f = await fixture(t);
  await f.write(0, 'a.TAR.GZ', '1234');
  await f.write(1, 'renamed.tar.gz', '1234');
  await f.write(0, 'wrong.bin', '1234');
  await f.write(1, 'small.tar.gz', '123');
  await f.write(0, 'large.tar.gz', '12345');
  await f.write(0, 'empty.bin', '');
  await f.write(1, 'other-empty.bin', '');
  const report = await findDuplicates(f.roots, { minBytes: 4, maxBytes: 4, suffixes: ['.TAR.GZ'] });
  assert.equal(report.selected.files, 2);
  assert.equal(report.excludedByFilters.files, 5);
  assert.equal(report.hashReadBytes, 8);
  assert.equal(report.theoreticalDuplicateLogicalBytes, 4);
  assert.equal(report.discoveryComplete, true);
  const empty = await findDuplicates(f.roots, { minBytes: 0, maxBytes: 0 });
  assert.equal(empty.groups.length, 1);
  assert.equal(empty.groups[0].members.length, 2);
  assert.equal(empty.theoreticalDuplicateLogicalBytes, 0);
});

test('hardlink aliases never inflate independent copies or theoretical duplicate bytes', async t => {
  const f = await fixture(t);
  const original = await f.write(0, 'original.bin', '12345');
  const alias = path.join(f.roots[1], 'alias.bin');
  await fs.link(original, alias);
  const external = path.join(f.parent, 'outside-scope-link.bin');
  await fs.link(original, external);
  const io = Object.create(fs);
  io.open = async () => { throw new Error('Only one physical file: content must not be read.'); };
  const onlyLinks = await findDuplicates(f.roots, { io });
  assert.equal(onlyLinks.discoveryComplete, true);
  assert.equal(onlyLinks.groups.length, 0);
  assert.equal(onlyLinks.hashReadBytes, 0);
  assert.equal(onlyLinks.theoreticalDuplicateLogicalBytes, 0);
  assert.equal(onlyLinks.hardLinkSets[0].observedPathCount, 2);
  assert.equal(onlyLinks.hardLinkSets[0].reportedLinkCount, 3);
  assert.equal(onlyLinks.hardLinkSets[0].hasUnobservedLinks, true);
  assert.equal(onlyLinks.hardLinkSets[0].aliasLogicalBytesExcludedFromDuplicateAmount, 5);
  await f.write(1, 'independent.bin', '12345');
  const report = await findDuplicates(f.roots);
  assert.equal(report.groups[0].members.length, 3);
  assert.equal(report.groups[0].independentPhysicalFiles, 2);
  assert.equal(report.groups[0].hasUnobservedHardLinks, true);
  assert.equal(report.theoreticalDuplicateLogicalBytes, 5);
  assert.equal(report.hashReadBytes, 10);
  assert.equal(report.physicalReclaimableBytes, null);
  assert.equal(await fs.readFile(external, 'utf8'), '12345');
});

test('rejects overlapping, redirected and physically identical roots', async t => {
  const f = await fixture(t);
  const nested = path.join(f.roots[0], 'nested');
  await fs.mkdir(nested);
  await assert.rejects(findDuplicates([f.roots[0]]), /at least two/);
  await assert.rejects(findDuplicates(['relative', f.roots[1]]), /absolute/);
  await assert.rejects(findDuplicates([path.parse(f.parent).root, f.roots[1]]), /Drive\/filesystem/);
  await assert.rejects(findDuplicates([f.roots[0], nested]), /non-overlapping/);
  await assert.rejects(findDuplicates([f.roots[0], f.roots[0]]), /non-overlapping/);
  const link = path.join(f.parent, 'root-link');
  await fs.symlink(f.roots[0], link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(findDuplicates([link, f.roots[1]]), /non-redirected/);
  const firstInfo = await fs.lstat(f.roots[0], { bigint: true });
  const io = Object.create(fs);
  io.lstat = async (filename, options) => {
    const info = await fs.lstat(filename, options);
    return filename === f.roots[1] ? patchStat(info, { dev: firstInfo.dev, ino: firstInfo.ino }) : info;
  };
  await assert.rejects(findDuplicates(f.roots, { io }), /same physical directory/);
});

test('nested links and special files are skipped explicitly; unreadable subtrees remain unknown', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'good.bin', 'good');
  await f.write(1, 'also-good.bin', 'good');
  const blockedDir = path.join(f.roots[0], 'denied');
  await f.write(0, 'denied/hidden.bin', 'unknown contents');
  const outside = path.join(f.parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.bin'), 'never follow');
  await fs.symlink(outside, path.join(f.roots[1], 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const special = await f.write(1, 'special-placeholder', 'not really a fifo');
  const io = Object.create(fs);
  io.readdir = async (filename, options) => { if (filename === blockedDir) throw error('EACCES'); return fs.readdir(filename, options); };
  io.lstat = async (filename, options) => {
    const info = await fs.lstat(filename, options);
    return filename === special ? patchStat(info, { isFile: () => false, isDirectory: () => false }) : info;
  };
  const opened = [];
  io.open = async (...args) => { opened.push(args[0]); return fs.open(...args); };
  const report = await findDuplicates(f.roots, { io });
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.unknown.unmeasuredLogicalBytes, null);
  assert.ok(report.errors.some(row => row.path === blockedDir && row.code === 'EACCES'));
  assert.deepEqual(new Set(report.skips.map(row => row.kind)), new Set(['link', 'special']));
  assert.equal(report.groups.length, 1, 'unrelated stable content pairs remain useful');
  assert.equal(report.theoreticalDuplicateLogicalBytes, 4);
  assert.equal(opened.length, 2);
  assert.ok(opened.includes(first));
  assert.equal(await fs.readFile(path.join(outside, 'keep.bin'), 'utf8'), 'never follow');
});

test('physical directory aliases are not traversed or counted twice', async t => {
  const f = await fixture(t);
  await f.write(0, 'first/one.bin', 'payload');
  await f.write(1, 'alias/two.bin', 'payload');
  const firstDir = path.join(f.roots[0], 'first');
  const aliasDir = path.join(f.roots[1], 'alias');
  const firstStat = await fs.lstat(firstDir, { bigint: true });
  const io = Object.create(fs);
  io.lstat = async (filename, options) => {
    const info = await fs.lstat(filename, options);
    return filename === aliasDir ? patchStat(info, { dev: firstStat.dev, ino: firstStat.ino }) : info;
  };
  io.readdir = async (filename, options) => { assert.notEqual(filename, aliasDir); return fs.readdir(filename, options); };
  const report = await findDuplicates(f.roots, { io });
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.enumerated.files, 1);
  assert.equal(report.groups.length, 0);
  assert.match(report.skips[0].reason, /physical-directory-alias/);
});

test('unknown file identity and content read errors cannot create confirmed groups', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const io = Object.create(fs);
  io.open = async (filename, flags) => {
    if (filename === first) throw error('EIO');
    return fs.open(filename, flags);
  };
  let report = await findDuplicates(f.roots, { io });
  assert.equal(report.groups.length, 0);
  assert.equal(report.unknown.files, 1);
  assert.equal(report.unknown.logicalBytes, 4);
  assert.equal(report.errors[0].code, 'EIO');
  const noIdentity = Object.create(fs);
  noIdentity.lstat = async (filename, options) => {
    const info = await fs.lstat(filename, options);
    return filename === second ? patchStat(info, { ino: 0n }) : info;
  };
  report = await findDuplicates(f.roots, { io: noIdentity });
  assert.equal(report.groups.length, 0);
  assert.equal(report.hashReadBytes, 0);
  assert.equal(report.unknown.files, 1);
  assert.equal(report.skips[0].reason, 'file-identity-unavailable');
});

test('open-handle mutation is detected, bounded, closed and excluded from duplicate evidence', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  await f.write(1, 'second.bin', 'same');
  let mutated = false;
  let closed = 0;
  const io = Object.create(fs);
  io.open = async (filename, flags) => {
    const handle = await fs.open(filename, flags);
    return {
      stat: options => handle.stat(options),
      read: async (...args) => {
        const result = await handle.read(...args);
        if (filename === first && result.bytesRead && !mutated) {
          mutated = true;
          await fs.appendFile(first, 'growing');
        }
        return result;
      },
      close: async () => { closed++; await handle.close(); },
    };
  };
  const report = await findDuplicates(f.roots, { io, concurrency: 1 });
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.groups.length, 0);
  assert.equal(report.unknown.files, 1);
  assert.equal(report.hashReadBytes, 9, 'one additional byte detects growth without following it');
  assert.equal(closed, 2);
  assert.match(report.errors[0].reason, /changed while hashing/);
});

test('final file recheck catches a previously hashed file changed during a later hash', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const io = Object.create(fs);
  io.open = async (filename, flags) => {
    if (filename === second) await fs.writeFile(first, 'different length');
    return fs.open(filename, flags);
  };
  const report = await findDuplicates(f.roots, { io, concurrency: 1 });
  assert.equal(report.hashedPhysicalFiles, 2);
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.groups.length, 0);
  assert.ok(report.errors.some(row => row.path === first && /changed/.test(row.reason)));
});

test('final directory recheck invalidates stale contents when a new entry appears', async t => {
  const f = await fixture(t);
  await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const io = Object.create(fs);
  io.open = async (filename, flags) => {
    if (filename === second) await f.write(0, 'arrived-after-enumeration.bin', 'new');
    return fs.open(filename, flags);
  };
  const report = await findDuplicates(f.roots, { io, concurrency: 1 });
  assert.equal(report.groups.length, 0);
  assert.equal(report.discoveryComplete, false);
  assert.ok(report.errors.some(row => row.kind === 'directory' && row.path === f.roots[0]));
  assert.equal(report.unknown.unmeasuredLogicalBytes, null);
});

test('content hashing honors bounded concurrency', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index++) await f.write(index % 2, `${index}.bin`, 'same');
  let active = 0, maximum = 0;
  const io = Object.create(fs);
  io.open = async (...args) => {
    const handle = await fs.open(...args);
    active++;
    maximum = Math.max(maximum, active);
    return {
      stat: options => handle.stat(options),
      read: async (...values) => { await new Promise(resolve => setTimeout(resolve, 5)); return handle.read(...values); },
      close: async () => { await handle.close(); active--; },
    };
  };
  const report = await findDuplicates(f.roots, { io, concurrency: 2 });
  assert.equal(report.groups[0].independentPhysicalFiles, 6);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test('explicit file scope never enumerates unlisted contents and states its limited coverage', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'somewhere/first.bin', 'same');
  const second = await f.write(1, 'different/second.bin', 'same');
  const unlisted = await f.write(0, 'not-in-scope.bin', 'same');
  const io = Object.create(fs);
  io.readdir = async () => { throw new Error('An explicit file list must not enumerate directories.'); };
  io.lstat = async (filename, options) => { assert.notEqual(filename, unlisted); return fs.lstat(filename, options); };
  const report = await findDuplicates(f.roots, { filePaths: [first, second, first], io });
  assert.equal(report.discoveryComplete, true);
  assert.equal(report.scope.mode, 'explicit-file-list');
  assert.equal(report.scope.recursiveRootCoverage, false);
  assert.equal(report.scope.requestedFileEntries, 3);
  assert.equal(report.scope.distinctRequestedFilePaths, 2);
  assert.equal(report.scope.duplicateFileEntriesIgnored, 1);
  assert.deepEqual(report.scope.requestedFilePaths, [first, second]);
  assert.equal(report.enumerated.files, 2);
  assert.equal(report.theoreticalDuplicateLogicalBytes, 4);
  assert.match(report.scope.note, /Unlisted root contents were not traversed/);
  assert.match(formatReport(report), /explicit-file-list/);
  const empty = await findDuplicates(f.roots, { filePaths: [], io });
  assert.equal(empty.enumerated.files, 0);
  assert.equal(empty.scope.recursiveRootCoverage, false);
  await assert.rejects(findDuplicates(f.roots, { filePaths: [path.join(f.parent, 'outside.bin')] }), /not below a selected root/);
  await assert.rejects(findDuplicates(f.roots, { filePaths: [f.roots[0]] }), /not below a selected root/);
  await assert.rejects(findDuplicates(f.roots, { filePaths: ['relative.bin'] }), /absolute file paths/);
});

test('explicit file scope preserves missing-path and linked-ancestor uncertainty', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const absent = path.join(f.roots[0], 'absent.bin');
  const link = path.join(f.roots[0], 'link');
  await fs.symlink(f.roots[1], link, process.platform === 'win32' ? 'junction' : 'dir');
  const report = await findDuplicates(f.roots, { filePaths: [first, second, absent, path.join(link, 'second.bin')] });
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.enumerated.files, 2);
  assert.equal(report.groups[0].members.length, 2);
  assert.equal(report.theoreticalDuplicateLogicalBytes, 4);
  assert.equal(report.unknown.unmeasuredLogicalBytes, null);
  assert.ok(report.errors.some(row => row.path === absent && row.code === 'ENOENT'));
  assert.ok(report.errors.some(row => row.path === link && row.code === 'UNSTABLE_OR_REDIRECTED'));
});

test('explicit file scope tolerates new unlisted siblings while listed files remain stable', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const io = Object.create(fs);
  let created = false;
  io.open = async (...args) => {
    if (!created) {
      created = true;
      await f.write(0, 'unlisted-active-task.log', 'unrelated concurrent activity');
      await fs.mkdir(path.join(f.roots[1], 'unlisted-new-directory'));
    }
    return fs.open(...args);
  };
  const report = await findDuplicates(f.roots, { filePaths: [first, second], io, concurrency: 1 });
  assert.equal(report.scope.recursiveRootCoverage, false);
  assert.equal(report.discoveryComplete, true);
  assert.equal(report.groups.length, 1);
  assert.equal(report.theoreticalDuplicateLogicalBytes, 4);
  assert.equal(report.errors.length, 0);
  assert.equal(report.selected.files, 2);
});

test('explicit file scope still rejects a real ancestor directory replacement', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const displaced = path.join(f.parent, 'displaced-original-root');
  const io = Object.create(fs);
  io.open = async (filename, flags) => {
    if (filename === second) {
      // Both endpoints are verified inside this fixture's explicit temp root.
      const realParent = await fs.realpath(f.parent);
      for (const endpoint of [await fs.realpath(f.roots[0]), path.resolve(displaced)]) {
        const relative = path.relative(realParent, endpoint);
        assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      }
      await fs.rename(f.roots[0], displaced);
      await fs.mkdir(f.roots[0]);
      await fs.writeFile(first, 'same');
    }
    return fs.open(filename, flags);
  };
  const report = await findDuplicates(f.roots, { filePaths: [first, second], io, concurrency: 1 });
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.groups.length, 0);
  assert.ok(report.errors.some(row => row.kind === 'directory' && row.path === f.roots[0] && /identity/.test(row.reason)));
  assert.equal(await fs.readFile(path.join(displaced, 'first.bin'), 'utf8'), 'same');
});

test('explicit file scope keeps strict listed-file content stability checks', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'first.bin', 'same');
  const second = await f.write(1, 'second.bin', 'same');
  const io = Object.create(fs);
  io.open = async (filename, flags) => {
    if (filename === second) await fs.writeFile(first, 'changed listed content');
    return fs.open(filename, flags);
  };
  const report = await findDuplicates(f.roots, { filePaths: [first, second], io, concurrency: 1 });
  assert.equal(report.discoveryComplete, false);
  assert.equal(report.groups.length, 0);
  assert.ok(report.errors.some(row => row.kind === 'file' && row.path === first));
});

test('file-list manifest validation and CLI scope preserve literal paths', async t => {
  const f = await fixture(t);
  const first = await f.write(0, 'a & % 中文.bin', 'same');
  const second = await f.write(1, 'renamed.bin', 'same');
  const manifest = path.join(f.parent, 'candidates.json');
  await fs.writeFile(manifest, `\uFEFF${JSON.stringify([first, second])}`);
  assert.deepEqual(await readFileList(manifest), [first, second]);
  const result = await run(process.execPath, [script, '--root', f.roots[0], '--root', f.roots[1], '--files-json', manifest, '--json']);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope.mode, 'explicit-file-list');
  assert.equal(report.groups[0].members.length, 2);
  await fs.writeFile(manifest, JSON.stringify({ files: [first] }));
  await assert.rejects(readFileList(manifest), /array of explicit absolute file paths/);
  await fs.writeFile(manifest, JSON.stringify(['relative.bin']));
  await assert.rejects(readFileList(manifest), /absolute file paths/);
  await assert.rejects(readFileList(f.roots[0]), /regular file/);
  assert.throws(() => parseArguments(['--root', f.roots[0], '--root', f.roots[1], '--files-json', 'relative.json']), /absolute manifest/);
  await fs.writeFile(manifest, JSON.stringify([first, second]));
  const io = Object.create(fs);
  let changed = false;
  io.open = async (...args) => {
    const handle = await fs.open(...args);
    return {
      stat: options => handle.stat(options),
      read: async (...values) => {
        const result = await handle.read(...values);
        if (!changed) { changed = true; await fs.appendFile(manifest, ' '); }
        return result;
      },
      close: () => handle.close(),
    };
  };
  await assert.rejects(readFileList(manifest, io), /grew while reading/);
});

test('arguments reject unsafe ambiguity and invalid filters', async () => {
  const roots = ['--root', path.resolve('a'), '--root', path.resolve('b')];
  const parsed = parseArguments([...roots, '--suffix', '.png,.mp4', '--min-bytes', '4', '--max-bytes', '5', '--concurrency', '1', '--json', '--progress']);
  assert.equal(parsed.roots.length, 2);
  assert.deepEqual(parsed.suffixes, ['.png', '.mp4']);
  assert.equal(parsed.minBytes, 4);
  for (const args of [[], ['--root'], ['--bogus'], [...roots, '--json', '--json'], [...roots, '--min-bytes', '-1'], [...roots, '--max-bytes', '1.2'], [...roots, '--min-bytes', '9007199254740992'], [...roots, '--min-bytes', '5', '--max-bytes', '4'], [...roots, '--concurrency', '0'], [...roots, '--concurrency', '9'], [...roots, '--suffix', '*.mp4'], [...roots, '--suffix', '.mp4,'], [...roots, '--suffix', '../media'], [...roots, '--top', '1001']]) assert.throws(() => parseArguments(args));
  await assert.rejects(findDuplicates([], { concurrency: 2.5 }), /Concurrency/);
  await assert.rejects(findDuplicates([], { suffixes: '.bin' }), /Suffixes/);
  await assert.rejects(findDuplicates([], { onProgress: true }), /onProgress/);
});

test('CLI keeps JSON on stdout, progress on stderr, reports incomplete with exit 2 and never writes output files', async t => {
  const f = await fixture(t);
  await f.write(0, 'first.bin', 'same');
  await f.write(1, 'second.bin', 'same');
  const args = [script, '--root', f.roots[0], '--root', f.roots[1], '--json', '--progress'];
  const result = await run(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).theoreticalDuplicateLogicalBytes, 4);
  const progress = result.stderr.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(progress[0].phase, 'enumerating');
  assert.equal(progress.at(-1).phase, 'finished');
  assert.deepEqual(await fs.readdir(f.roots[0]), ['first.bin']);
  assert.deepEqual(await fs.readdir(f.roots[1]), ['second.bin']);
  await fs.symlink(f.roots[1], path.join(f.roots[0], 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(process.execPath, args), failure => failure.code === 2 && JSON.parse(failure.stdout).discoveryComplete === false);
  await assert.rejects(run(process.execPath, [script, '--concurrency', '9']), failure => failure.code === 1 && failure.stdout === '');
  assert.match((await run(process.execPath, [script, '--help'])).stdout, /Read-only/);
});
