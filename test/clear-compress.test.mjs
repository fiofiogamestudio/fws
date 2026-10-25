import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const script = fileURLToPath(new URL('../skills/fw-clear/scripts/compress-logs.ps1', import.meta.url));
const ps = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const oldTime = new Date('2024-02-03T04:05:06Z');
const compressible = Buffer.alloc(1024 * 1024, 'repeated historical test log line\r\n');

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-compress-test-'));
  if (windows) assert.match(parent, /^C:\\/i, 'All compression fixtures must stay in C: OS Temp.');
  const root = path.join(parent, "工程 & old's logs");
  await fs.mkdir(root);
  t.after(async () => {
    const real = await fs.realpath(parent), temporary = await fs.realpath(os.tmpdir());
    const relative = path.relative(temporary, real);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.equal(real.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(real, { recursive: true, force: true });
  });
  return { parent, root, serial: 0 };
}

async function log(f, name = 'output/历史 & capture.log', body = compressible, age = oldTime) {
  const filename = path.join(f.root, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, body);
  await fs.utimes(filename, age, age);
  return filename;
}
const json = async filename => JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
const target = filename => ({ path: filename, reason: 'Completed isolated test log; retain its exact content and original path',
  evidence: ['Synthetic completed test receipt; no live consumer writes this old fixture'] });
async function state(filename) {
  const stat = await fs.stat(filename, { bigint: true });
  return { bytes: stat.size, ino: stat.ino, mtime: stat.mtimeNs,
    sha256: crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex') };
}
async function execute(f, mode, planPath, manifestPath) {
  const resultPath = path.join(f.parent, `result-${++f.serial}.json`);
  const args = [...ps, '-File', script, '-Mode', mode, '-PlanPath', planPath, '-ResultPath', resultPath,
    ...(manifestPath ? ['-ManifestPath', manifestPath] : [])];
  let exitCode = 0, output = '';
  try { const r = await run('powershell.exe', args, { windowsHide: true, maxBuffer: 4 * 1024 ** 2 }); output = r.stdout + r.stderr; }
  catch (e) { exitCode = e.code; output = (e.stdout || '') + (e.stderr || ''); }
  const report = await json(resultPath).catch(() => null);
  if (report) assert.equal(report.exitCode, exitCode, 'Persisted result exit code must match the process outcome.');
  return { exitCode, output, report, resultPath };
}
async function plan(f, paths, entries = paths.map(target)) {
  const id = ++f.serial;
  const manifestPath = path.join(f.parent, `manifest-${id}.json`), planPath = path.join(f.parent, `plan-${id}.json`);
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, root: f.root, targets: entries }));
  return { ...await execute(f, 'Plan', planPath, manifestPath), planPath, manifestPath };
}

async function allocation(f, filename) {
  const helper = path.join(f.parent, 'allocation.ps1');
  await fs.writeFile(helper, `param([string] $Target)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class AllocationReading {
 public long allocatedBytes, logicalBytes, compressionInfoBytes, compressedFileSizeBytes;
 public uint clusterBytes;
 public bool compressed;
}
public static class IndependentAllocation {
 [StructLayout(LayoutKind.Sequential)] struct StandardInfo { public long allocation, eof; public uint links; public byte pending, directory; }
 [StructLayout(LayoutKind.Sequential)] struct CompressionInfo { public long size; public ushort format; public byte unit,chunk,cluster,r1,r2,r3; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out StandardInfo info,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out CompressionInfo info,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetCompressedFileSize(string path, out uint high);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetDiskFreeSpace(string root,out uint sectors,out uint bytes,out uint free,out uint total);
 static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static AllocationReading Read(string path) {
  using(var file=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)) {
   StandardInfo standard; CompressionInfo compression;
   Check(GetFileInformationByHandleEx(file.SafeFileHandle,1,out standard,(uint)Marshal.SizeOf(typeof(StandardInfo))));
   Check(GetFileInformationByHandleEx(file.SafeFileHandle,8,out compression,(uint)Marshal.SizeOf(typeof(CompressionInfo))));
   uint high; uint low=GetCompressedFileSize(path,out high); if(low==0xffffffff && Marshal.GetLastWin32Error()!=0)throw new Win32Exception();
   uint sectors,bytes,free,total;Check(GetDiskFreeSpace(Path.GetPathRoot(path),out sectors,out bytes,out free,out total));
   return new AllocationReading {allocatedBytes=standard.allocation,logicalBytes=standard.eof,compressionInfoBytes=compression.size,
    compressedFileSizeBytes=((long)high<<32)|low,clusterBytes=sectors*bytes,compressed=(File.GetAttributes(path)&FileAttributes.Compressed)!=0};
  }
 }
}
'@
[IndependentAllocation]::Read($Target) | ConvertTo-Json
`);
  const result = await run('powershell.exe', [...ps, '-File', helper, '-Target', filename], { windowsHide: true });
  return JSON.parse(result.stdout);
}

function assertRejected(result, pattern) {
  assert.equal(result.exitCode, 2, result.output);
  assert.ok(result.report, result.output);
  assert.equal(result.report.removedLogicalBytes, 0);
  assert.equal(result.report.removedFiles, 0);
  assert.equal(result.report.savedAllocatedBytes, 0, 'Rejected targets cannot claim storage savings.');
  for (const entry of result.report.targets) {
    assert.equal(entry.status, 'skipped', entry.message);
    assert.equal(entry.savedAllocatedBytes, 0);
    if (pattern) assert.match(entry.message, pattern);
  }
}

test('NTFS Plan is read-only; Apply saves allocation with exact bytes path identity and mtime; Restore reverses it', { skip: !windows }, async t => {
  const f = await fixture(t), filename = await log(f), before = await state(filename);
  const physicalBefore = await allocation(f, filename);
  assert.equal(physicalBefore.compressed, false);
  const preview = await plan(f, [filename]);
  assert.equal(preview.exitCode, 0, preview.output);
  assert.deepEqual(await state(filename), before, 'Planning must not modify source content, identity or mtime.');
  assert.equal(preview.report.targets[0].status, 'sealed');
  assert.equal(preview.report.savedAllocatedBytes, 0);
  const sealed = (await json(preview.planPath)).targets[0].snapshot;
  assert.equal(sealed.compression, 0);
  assert.deepEqual(await allocation(f, filename), physicalBefore);
  assert.equal(sealed.sha256, before.sha256);
  const applied = await execute(f, 'Apply', preview.planPath);
  assert.equal(applied.exitCode, 0, applied.output);
  assert.equal(applied.report.targets[0].status, 'compressed');
  assert.deepEqual(await state(filename), before);
  assert.equal(applied.report.targets[0].after.identity, sealed.identity);
  assert.equal(applied.report.targets[0].after.lastWriteTicks, sealed.lastWriteTicks);
  assert.equal(applied.report.targets[0].after.compression, 2);
  const physicalAfter = await allocation(f, filename);
  assert.equal(physicalAfter.compressed, true);
  assert.ok(physicalAfter.allocatedBytes < physicalBefore.allocatedBytes);
  assert.equal(physicalAfter.allocatedBytes, applied.report.targets[0].after.allocatedBytes);
  assert.ok(applied.report.targets[0].after.allocatedBytes < sealed.allocatedBytes);
  assert.equal(applied.report.savedAllocatedBytes, sealed.allocatedBytes - applied.report.targets[0].after.allocatedBytes);
  assert.equal(applied.report.removedLogicalBytes, 0);
  assert.equal(applied.report.removedFiles, 0);
  const restored = await execute(f, 'Restore', preview.planPath);
  assert.equal(restored.exitCode, 0, restored.output);
  assert.equal(restored.report.targets[0].status, 'restored');
  assert.equal(restored.report.targets[0].after.compression, 0);
  assert.equal(restored.report.targets[0].after.allocatedBytes, sealed.allocatedBytes);
  assert.equal(restored.report.savedAllocatedBytes, -applied.report.savedAllocatedBytes);
  assert.deepEqual(await state(filename), before);
  assert.deepEqual(await allocation(f, filename), physicalBefore);
});

test('NTFS non-cluster-aligned logs use StandardInfo allocation instead of uncompressed logical-length APIs', { skip: !windows }, async t => {
  const f = await fixture(t), paths = [];
  for (const bytes of [4097, 1024 * 1024 + 123]) paths.push(await log(f, `output/nonaligned-${bytes}.log`, Buffer.alloc(bytes, 65)));
  const before = await Promise.all(paths.map(state));
  const allocations = [];
  for (const filename of paths) allocations.push(await allocation(f, filename));
  for (const a of allocations) {
    assert.notEqual(a.logicalBytes % a.clusterBytes, 0);
    assert.ok(a.allocatedBytes > a.logicalBytes, 'Nonresident uncompressed allocation includes final-cluster slack.');
    assert.equal(a.allocatedBytes, Math.ceil(a.logicalBytes / a.clusterBytes) * a.clusterBytes,
      'Fresh ordinary fixture allocation must include the entire final NTFS cluster.');
    assert.equal(a.compressionInfoBytes, a.logicalBytes, 'CompressionInfo is not the uncompressed allocation counter.');
    assert.equal(a.compressedFileSizeBytes, a.logicalBytes, 'GetCompressedFileSize also returns logical length for this uncompressed file.');
  }
  const preview = await plan(f, paths); assert.equal(preview.exitCode, 0, preview.output);
  assert.equal(preview.report.allocationMeasurement, 'ntfs-file-standard-info-allocation');
  const sealed = await json(preview.planPath);
  assert.equal(sealed.allocationMeasurement, 'ntfs-file-standard-info-allocation');
  for (const measurement of [undefined, 'compression-info-size']) {
    const legacy = structuredClone(sealed);
    if (measurement === undefined) delete legacy.allocationMeasurement;
    else legacy.allocationMeasurement = measurement;
    const legacyPath = path.join(f.parent, `legacy-${measurement ?? 'missing'}.json`);
    await fs.writeFile(legacyPath, JSON.stringify(legacy));
    const refused = await execute(f, 'Apply', legacyPath);
    assert.notEqual(refused.exitCode, 0, 'An old or unknown allocation measurement must never reach Apply.');
    assert.equal(refused.report, null, 'Legacy measurement is rejected before any per-target operation.');
    assert.deepEqual(await Promise.all(paths.map(state)), before);
  }
  for (let i = 0; i < paths.length; i++) {
    assert.equal(preview.report.targets[i].before.allocatedBytes, allocations[i].allocatedBytes,
      'The plan must seal real StandardInfo allocation, not uncompressed logical length.');
  }
  const applied = await execute(f, 'Apply', preview.planPath); assert.equal(applied.exitCode, 0, applied.output);
  let saved = 0;
  for (let i = 0; i < paths.length; i++) {
    const a = await allocation(f, paths[i]), entry = applied.report.targets[i];
    assert.equal(entry.status, 'compressed');
    assert.equal(a.compressed, true);
    assert.equal(a.allocatedBytes, a.compressionInfoBytes);
    assert.equal(a.allocatedBytes, a.compressedFileSizeBytes);
    assert.equal(entry.before.allocatedBytes, allocations[i].allocatedBytes);
    assert.equal(entry.after.allocatedBytes, a.allocatedBytes);
    assert.equal(entry.savedAllocatedBytes, allocations[i].allocatedBytes - a.allocatedBytes);
    saved += allocations[i].allocatedBytes - a.allocatedBytes;
    assert.deepEqual(await state(paths[i]), before[i]);
  }
  assert.equal(applied.report.savedAllocatedBytes, saved);
  assert.equal(applied.report.removedLogicalBytes, 0);
  const restored = await execute(f, 'Restore', preview.planPath); assert.equal(restored.exitCode, 0, restored.output);
  assert.equal(restored.report.savedAllocatedBytes, -saved);
  for (let i = 0; i < paths.length; i++) {
    assert.deepEqual(await allocation(f, paths[i]), allocations[i]);
    assert.deepEqual(await state(paths[i]), before[i]);
  }
});

test('NTFS compression rejects source configuration non-log and out-of-root paths without changing any file', { skip: !windows }, async t => {
  const f = await fixture(t);
  const names = ['Assets/source.log', 'Packages/cache.log', 'ProjectSettings/config.log', 'src/input.log',
    'output/Scripts/source.log', 'output/capture.txt'];
  const paths = [];
  for (const name of names) paths.push(await log(f, name));
  const outside = path.join(f.parent, 'outside.log');
  await fs.writeFile(outside, compressible); await fs.utimes(outside, oldTime, oldTime); paths.push(outside);
  const before = await Promise.all(paths.map(state));
  const result = await plan(f, paths);
  assertRejected(result, /protected|\.log|inside the authorized root/i);
  assert.deepEqual((await json(result.planPath)).targets, []);
  assert.deepEqual(await Promise.all(paths.map(state)), before);
});

test('NTFS compression protects HEAD index and staged deletion even when root is a repository subdirectory', { skip: !windows }, async t => {
  const f = await fixture(t);
  const git = args => run('git', ['-C', f.root, ...args], { windowsHide: true });
  await git(['init', '--quiet']);
  const committed = await log(f, 'output/committed.log');
  const deleted = await log(f, 'output/staged-delete.log');
  await git(['add', '--', committed, deleted]);
  await git(['-c', 'user.name=Compression Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  await git(['rm', '--cached', '--quiet', '--', deleted]);
  const staged = await log(f, 'output/staged-only.log');
  await git(['add', '--', staged]);
  const before = await Promise.all([committed, deleted, staged].map(state));
  // Root ownership is checked against its containing repository, not merely .git at root.
  f.root = path.join(f.root, 'output');
  const result = await plan(f, [committed, deleted, staged]);
  assertRejected(result, /Git tracked|Git HEAD/);
  assert.match(result.report.targets.find(e => e.path === deleted).message, /HEAD.*staged deletion/);
  assert.deepEqual(await Promise.all([committed, deleted, staged].map(state)), before);
});

test('NTFS compression accepts valid unborn HEAD but refuses corrupt ownership at Plan and Apply', { skip: !windows }, async t => {
  for (const corruption of ['malformed-symbolic-branch', 'detached-missing-object', 'symbolic-nonbranch-head']) {
    const f = await fixture(t), filename = await log(f), before = await state(filename);
    const git = args => run('git', ['-C', f.root, ...args], { windowsHide: true });
    await git(['init', '--quiet']);
    const preview = await plan(f, [filename]);
    assert.equal(preview.exitCode, 0, `${corruption}: ${preview.output}`);
    assert.equal(preview.report.targets[0].status, 'sealed', 'An actual unborn branch must remain supported.');
    if (corruption === 'malformed-symbolic-branch') {
      const branch = (await git(['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
      assert.match(branch, /^refs\/heads\//);
      await fs.writeFile(path.join(f.root, '.git', ...branch.split('/')), 'not-an-object-id\n');
    } else if (corruption === 'detached-missing-object') {
      await fs.writeFile(path.join(f.root, '.git', 'HEAD'), `${'1'.repeat(40)}\n`);
    } else {
      await fs.writeFile(path.join(f.root, '.git', 'HEAD'), 'ref: refs/tags/nonexistent\n');
    }
    const rejectedPlan = await plan(f, [filename]);
    assertRejected(rejectedPlan, /Git|HEAD|reference|object/i);
    assert.deepEqual((await json(rejectedPlan.planPath)).targets, []);
    // Ownership can become unreadable after sealing, so Apply must repeat the
    // guard and preserve an otherwise unchanged old log without compressing it.
    const rejectedApply = await execute(f, 'Apply', preview.planPath);
    assertRejected(rejectedApply, /Git|HEAD|reference|object/i);
    assert.deepEqual(await state(filename), before, corruption);
    assert.equal((await allocation(f, filename)).compressed, false, corruption);
  }
});

test('NTFS compression rejects junction ancestors hard links nested repositories and Git storage', { skip: !windows }, async t => {
  const f = await fixture(t);
  await run('git', ['-C', f.root, 'init', '--quiet'], { windowsHide: true });
  const outsideDir = path.join(f.parent, 'outside'); await fs.mkdir(outsideDir);
  const outside = path.join(outsideDir, 'linked.log'); await fs.writeFile(outside, compressible); await fs.utimes(outside, oldTime, oldTime);
  const junction = path.join(f.root, 'junction'); await fs.symlink(outsideDir, junction, 'junction');
  const original = await log(f, 'output/hard-original.log'), hard = path.join(f.root, 'output/hard-alias.log');
  await fs.link(original, hard);
  const nested = await log(f, 'nested/output/file.log'); await fs.mkdir(path.join(f.root, 'nested/.git'));
  const gitLog = await log(f, '.git/history.log');
  const bare = await log(f, 'bare/history.log'); await fs.mkdir(path.join(f.root, 'bare/objects')); await fs.writeFile(path.join(f.root, 'bare/HEAD'), 'ref: refs/heads/main');
  const paths = [path.join(junction, 'linked.log'), original, hard, nested, gitLog, bare];
  const before = await Promise.all(paths.map(state));
  const result = await plan(f, paths);
  assertRejected(result, /Reparse|Hard-linked|repository|Git storage/);
  assert.match(result.report.targets.find(e => e.path === original).message, /Hard-linked/);
  assert.match(result.report.targets.find(e => e.path === hard).message, /Hard-linked/);
  assert.match(result.report.targets.find(e => e.path === nested).message, /Nested repository/);
  assert.deepEqual(await Promise.all(paths.map(state)), before);
  // Remove only the junction entry before fixture cleanup, never recurse through its target.
  await fs.unlink(junction);
});

test('NTFS sealed plans reject changed content mtime and replacement identity and report no savings', { skip: !windows }, async t => {
  const f = await fixture(t);
  const content = await log(f, 'output/content.log'), mtime = await log(f, 'output/mtime.log'), identity = await log(f, 'output/identity.log');
  const preview = await plan(f, [content, mtime, identity]); assert.equal(preview.exitCode, 0, preview.output);
  await fs.writeFile(content, Buffer.alloc(compressible.length, 66)); await fs.utimes(content, oldTime, oldTime);
  const changedTime = new Date('2024-02-04T04:05:06Z'); await fs.utimes(mtime, changedTime, changedTime);
  await fs.rename(identity, identity + '.retained'); await fs.writeFile(identity, compressible); await fs.utimes(identity, oldTime, oldTime);
  const before = await Promise.all([content, mtime, identity].map(state));
  const result = await execute(f, 'Apply', preview.planPath);
  assertRejected(result, /Sealed state changed/);
  assert.match(result.report.targets[0].message, /sha256/);
  assert.match(result.report.targets[1].message, /lastWriteTicks/);
  assert.match(result.report.targets[2].message, /identity/);
  assert.deepEqual(await Promise.all([content, mtime, identity].map(state)), before);
});

test('NTFS plans reject recent logs and already compressed files without double-counting savings', { skip: !windows }, async t => {
  const f = await fixture(t), old = await log(f), recent = await log(f, 'output/current.log', compressible, new Date());
  const fresh = await plan(f, [recent]); assertRejected(fresh, /too recent|active/);
  const preview = await plan(f, [old]); assert.equal(preview.exitCode, 0, preview.output);
  const applied = await execute(f, 'Apply', preview.planPath); assert.equal(applied.exitCode, 0, applied.output);
  const again = await plan(f, [old]); assertRejected(again, /Already compressed/);
  assert.deepEqual((await json(again.planPath)).targets, []);
  const repeatedApply = await execute(f, 'Apply', preview.planPath); assertRejected(repeatedApply, /Compression state/);
  const restored = await execute(f, 'Restore', preview.planPath); assert.equal(restored.exitCode, 0, restored.output);
});

async function holdReadHandle(f, filename) {
  const helper = path.join(f.parent, 'hold-open.ps1'), ready = path.join(f.parent, 'handle-ready.txt');
  await fs.writeFile(helper, `param([string] $Target,[string] $Ready)
$ErrorActionPreference='Stop'
$h=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try { [IO.File]::WriteAllText($Ready,'ready'); [Console]::ReadLine() | Out-Null } finally { $h.Dispose() }
`);
  const child = spawn('powershell.exe', [...ps, '-File', helper, '-Target', filename, '-Ready', ready], { windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  for (let i = 0; i < 200; i++) {
    if (await fs.stat(ready).then(() => true, () => false)) return async () => { child.stdin.end('\n'); await closed; };
    if (child.exitCode !== null) throw new Error(`Lock helper exited: ${stderr}`);
    await delay(25);
  }
  child.stdin.end('\n'); await closed;
  throw new Error(`Lock helper did not become ready: ${stderr}`);
}

test('NTFS Apply rejects an active read handle and preserves the sealed file until the handle closes', { skip: !windows }, async t => {
  const f = await fixture(t), filename = await log(f), before = await state(filename);
  const preview = await plan(f, [filename]); assert.equal(preview.exitCode, 0, preview.output);
  const release = await holdReadHandle(f, filename);
  try {
    const result = await execute(f, 'Apply', preview.planPath);
    assertRejected(result);
    assert.match(result.report.targets[0].message, /used|process|使用|进程|sharing/i);
    assert.deepEqual(await state(filename), before);
  } finally { await release(); }
  const applied = await execute(f, 'Apply', preview.planPath); assert.equal(applied.exitCode, 0, applied.output);
  const restored = await execute(f, 'Restore', preview.planPath); assert.equal(restored.exitCode, 0, restored.output);
});

test('NTFS incompressible log reverses a no-saving transition and reports zero reclaimed allocation', { skip: !windows }, async t => {
  const f = await fixture(t), filename = await log(f, 'output/random.log', crypto.randomBytes(256 * 1024)), before = await state(filename);
  const preview = await plan(f, [filename]); assert.equal(preview.exitCode, 0, preview.output);
  const applied = await execute(f, 'Apply', preview.planPath); assert.equal(applied.exitCode, 0, applied.output);
  assert.equal(applied.report.targets[0].status, 'unchanged');
  assert.equal(applied.report.savedAllocatedBytes, 0);
  assert.equal(applied.report.targets[0].after.compression, 0);
  assert.deepEqual(await state(filename), before);
  assert.equal((await allocation(f, filename)).compressed, false);
});

test('NTFS mixed Apply reports only independently verified savings and remains unsuccessful when another target changed', { skip: !windows }, async t => {
  const f = await fixture(t), changed = await log(f, 'output/changed.log'), valid = await log(f, 'output/valid.log');
  const preview = await plan(f, [changed, valid]); assert.equal(preview.exitCode, 0, preview.output);
  await fs.appendFile(changed, 'changed after sealing'); await fs.utimes(changed, oldTime, oldTime);
  const changedBefore = await state(changed), validBefore = await state(valid);
  const applied = await execute(f, 'Apply', preview.planPath);
  assert.equal(applied.exitCode, 2, applied.output);
  const rejected = applied.report.targets.find(e => e.path === changed), successful = applied.report.targets.find(e => e.path === valid);
  assert.equal(rejected.status, 'skipped');
  assert.equal(rejected.savedAllocatedBytes, 0);
  assert.equal(successful.status, 'compressed');
  assert.ok(successful.savedAllocatedBytes > 0);
  assert.equal(applied.report.savedAllocatedBytes, successful.savedAllocatedBytes);
  assert.equal(applied.report.removedLogicalBytes, 0);
  assert.deepEqual(await state(changed), changedBefore);
  assert.deepEqual(await state(valid), validBefore);
  const restored = await execute(f, 'Restore', preview.planPath);
  assert.equal(restored.exitCode, 2);
  assert.equal(restored.report.targets.find(e => e.path === valid).status, 'restored');
  assert.equal(restored.report.targets.find(e => e.path === changed).savedAllocatedBytes, 0);
});
