import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createCleanupBundle, parseArguments } from '../skills/fw-clear/scripts/create-cleanup-bundle.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-bundle-test-'));
  if (windows) assert.match(parent, /^C:\\/i, 'Destructive fixtures must live in C: OS Temp.');
  const root = path.join(parent, '工程 & % !');
  const target = path.join(root, '缓存 & % !');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, '文件 & % !.bin'), 'fixture data');
  await fs.writeFile(path.join(root, 'keep-source.cs'), 'must remain');
  t.after(async () => {
    const realParent = await fs.realpath(parent);
    const temp = await fs.realpath(os.tmpdir());
    const relative = path.relative(temp, realParent);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.equal(realParent.toLowerCase(), path.resolve(parent).toLowerCase());
    await fs.rm(realParent, { recursive: true, force: true });
  });
  return { parent, root, target };
}

async function generate(f, options = {}) {
  const manifest = path.join(f.parent, 'manifest.json');
  const out = path.join(f.parent, '清理包 & % !');
  await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: [f.root], targets: [{ path: f.target, reason: 'Disposable test cache', ...options }] }), 'utf8');
  return { ...await createCleanupBundle({ manifest, out }), manifest, out };
}

async function execute(bundle, apply = false) {
  try {
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundle.out, 'execute-cleanup.ps1'), '-PlanPath', path.join(bundle.out, 'cleanup-plan.json'), ...(apply ? ['-Apply'] : [])], { windowsHide: true });
    return { exitCode: 0, output: result.stdout, report: JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8')) };
  } catch (error) {
    const report = await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8').then(JSON.parse).catch(() => null);
    return { exitCode: error.code, output: error.stdout + error.stderr, report };
  }
}

test('cleanup CLI refuses missing, repeated, unknown and relative arguments', () => {
  assert.throws(() => parseArguments([]), /required/);
  assert.throws(() => parseArguments(['--out', 'x', '--out', 'y']), /Usage/);
  assert.throws(() => parseArguments(['--delete-all', 'x']), /Usage/);
  assert.deepEqual(parseArguments(['--manifest', 'a', '--out', 'b']), { manifest: 'a', out: 'b' });
});

test('generated cleanup BAT safely deletes Unicode/metacharacter paths without a preview BAT; repeat runs are explicit', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  assert.deepEqual((await fs.readdir(bundle.out)).sort(), ['README.txt', 'cleanup-plan.json', 'cleanup.bat', 'execute-cleanup.ps1'].sort());
  assert.ok(!(await fs.readFile(path.join(bundle.out, 'README.txt'), 'ascii')).includes('preview.bat'));
  const plan = JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-plan.json'), 'utf8'));
  assert.equal(plan.targets[0].snapshot.logicalBytes, 12);
  assert.equal(plan.targets[0].snapshot.files, 1);
  assert.equal(plan.targets[0].snapshot.algorithm, 'sha256-sorted-path-type-length-mtimeUtcTicks-v1');
  assert.ok(!JSON.stringify(plan).includes('文件 &'), 'Plan stores an aggregate snapshot, not all file paths.');
  // Exercise the executor's internal read-only mode without a user-facing BAT.
  const validation = await execute(bundle);
  assert.equal(validation.exitCode, 0, validation.output);
  assert.equal(validation.report.targets[0].status, 'ready');
  assert.equal(validation.report.removedLogicalBytes, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'keep-source.cs'), 'utf8'), 'must remain');
  assert.ok(await fs.stat(f.target));
  // Run cmd against the real generated BAT with a newline for its final pause.
  const batResult = await new Promise((resolve, reject) => {
    const proc = spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(bundle.out, 'cleanup.bat')}""`], { windowsHide: true, windowsVerbatimArguments: true });
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { output += chunk; });
    proc.on('error', reject);
    proc.on('close', exitCode => resolve({ exitCode, output }));
    proc.stdin.end('\r\n');
  });
  assert.equal(batResult.exitCode, 0, batResult.output);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const report = JSON.parse(await fs.readFile(path.join(bundle.out, 'cleanup-results.json'), 'utf8'));
  assert.equal(report.targets[0].status, 'deleted');
  assert.equal(report.removedLogicalBytes, 12);
  const archives = (await fs.readdir(bundle.out)).filter(filename => /^cleanup-results-.*-apply\.json$/.test(filename));
  assert.equal(archives.length, 1, 'Apply evidence remains archived even after later previews.');
  assert.equal(typeof report.volumeBefore[0].freeBytes, 'number');
  assert.equal(typeof report.volumeAfter[0].freeBytes, 'number');
  const repeat = await execute(bundle, true);
  assert.equal(repeat.exitCode, 2);
  assert.equal(repeat.report.targets[0].status, 'skipped');
  assert.match(repeat.report.targets[0].message, /absent/);
});

test('generation cannot overwrite, include its output, or accept missing targets', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: bundle.out }), /already exists/);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.target, 'bundle') }), /inside a cleanup target/);
  await fs.unlink(path.join(f.target, '文件 & % !.bin'));
  await fs.rmdir(f.target);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'missing') }), /not generated/);
});

test('invalid sealed shape stops before deletion and replaces latest result with archived fatal evidence', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  assert.equal((await execute(bundle)).exitCode, 0);
  const planPath = path.join(bundle.out, 'cleanup-plan.json');
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  plan.targets[0].snapshot.files = -1;
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf8');
  const invalid = await execute(bundle, true);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.report.fatalError, /Invalid sealed snapshot count/);
  assert.equal(invalid.report.exitCode, 1);
  assert.ok(await fs.stat(f.target));
  const files = await fs.readdir(bundle.out);
  assert.ok(files.some(filename => /^cleanup-results-.*-fatal\.json$/.test(filename)));
  assert.ok(files.some(filename => /^cleanup-results-.*-preview\.json$/.test(filename)));
});

test('added source, changed file and deleted child invalidate the sealed target without deleting it', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  const file = path.join(f.target, '文件 & % !.bin');
  await fs.writeFile(path.join(f.target, 'new-source.cs'), 'new important source');
  const added = await execute(bundle, true);
  assert.equal(added.exitCode, 2);
  assert.equal(added.report.targets[0].status, 'failed');
  assert.match(added.report.targets[0].message, /changed/);
  await fs.unlink(path.join(f.target, 'new-source.cs'));
  await fs.writeFile(file, 'changed data');
  const changed = await execute(bundle, true);
  assert.equal(changed.exitCode, 2);
  assert.equal(await fs.readFile(file, 'utf8'), 'changed data');
  await fs.unlink(file);
  const removed = await execute(bundle, true);
  assert.equal(removed.exitCode, 2);
  assert.ok(await fs.stat(f.target));
});

test('outside/root/Git metadata/duplicate/overlap targets are rejected during sealing', { skip: !windows }, async t => {
  const f = await fixture(t);
  const manifest = path.join(f.parent, 'invalid.json');
  const outside = path.join(f.parent, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(f.root, '.git'));
  const cases = [
    { roots: [f.root], targets: [outside] },
    { roots: [f.root], targets: [f.root] },
    { roots: [path.parse(f.root).root], targets: [f.target] },
    { roots: [f.root], targets: [path.join(f.root, '.git')] },
    { roots: [f.root], targets: [f.target, f.target] },
    { roots: [f.root], targets: [f.target, path.join(f.target, '文件 & % !.bin')] },
  ];
  // Remove the fake marker before non-Git tests to avoid a broken-repository
  // rejection masking the path/overlap checks.
  await fs.rmdir(path.join(f.root, '.git'));
  for (let index = 0; index < cases.length; index += 1) {
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: cases[index].roots, targets: cases[index].targets.map(target => ({ path: target, reason: 'Test rejection' })) }));
    await assert.rejects(createCleanupBundle({ manifest, out: path.join(f.parent, `invalid-${index}`) }), /not generated/);
  }
  assert.ok(await fs.stat(f.target));
});

test('tracked files, nested repositories and new tracked ownership are protected', { skip: !windows }, async t => {
  const f = await fixture(t);
  await run('git', ['-C', f.root, 'init', '-q']);
  await run('git', ['-C', f.root, 'add', '--', path.relative(f.root, f.target)]);
  await assert.rejects(generate(f), /tracked files/);
  await run('git', ['-C', f.root, 'rm', '--cached', '-r', '--', path.relative(f.root, f.target)]);
  const bundle = await generate(f);
  await run('git', ['-C', f.root, 'add', '--', path.relative(f.root, f.target)]);
  const tracked = await execute(bundle, true);
  assert.equal(tracked.exitCode, 2);
  assert.match(tracked.report.targets[0].message, /tracked files/);
  await run('git', ['-C', f.root, 'rm', '--cached', '-r', '--', path.relative(f.root, f.target)]);
  await fs.mkdir(path.join(f.target, 'nested'));
  await run('git', ['-C', path.join(f.target, 'nested'), 'init', '-q']);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'nested-repo-bundle') }), /nested repository/);
});

test('subtree/ancestor junctions are rejected without touching their destination', { skip: !windows }, async t => {
  const f = await fixture(t);
  const bundle = await generate(f);
  const outside = path.join(f.parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'important.cs'), 'external source');
  await fs.symlink(outside, path.join(f.target, 'link'), 'junction');
  const changed = await execute(bundle, true);
  assert.equal(changed.exitCode, 2);
  assert.match(changed.report.targets[0].message, /Reparse point/);
  await assert.rejects(createCleanupBundle({ manifest: bundle.manifest, out: path.join(f.parent, 'linked-bundle') }), /Reparse point/);
  assert.equal(await fs.readFile(path.join(outside, 'important.cs'), 'utf8'), 'external source');
  await fs.unlink(path.join(f.target, 'link'));
  await fs.rename(f.target, path.join(f.root, 'original-cache'));
  await fs.symlink(outside, f.target, 'junction');
  const replaced = await execute(bundle, true);
  assert.equal(replaced.exitCode, 2);
  assert.match(replaced.report.targets[0].message, /Reparse point/);
  assert.equal(await fs.readFile(path.join(outside, 'important.cs'), 'utf8'), 'external source');
});

test('active project guards skip only their item and do not expose process command lines', { skip: !windows }, async t => {
  const f = await fixture(t);
  const sleeper = path.join(f.parent, 'guard-fixture.ps1');
  await fs.writeFile(sleeper, 'param([string] $projectPath)\r\nStart-Sleep -Seconds 120\r\n', 'ascii');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sleeper, '-projectPath', f.root], { windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise(resolve => setTimeout(resolve, 250));
  const bundle = await generate(f, { processGuards: [{ processName: 'powershell.exe', projectRoot: f.root }] });
  const active = await execute(bundle, true);
  assert.equal(active.exitCode, 2, active.output);
  assert.equal(active.report.targets[0].status, 'skipped', active.output);
  assert.match(active.report.targets[0].message, /guarded process is active|ownership unavailable|no readable projectPath/);
  assert.ok(!active.output.includes('Start-Sleep'));
  assert.ok(await fs.stat(f.target));
});

test('executable-root guard affects only its item; a separate sealed file target is deleted', { skip: !windows }, async t => {
  const f = await fixture(t);
  const runner = path.join(f.root, 'runner');
  await fs.mkdir(runner);
  const copiedCmd = path.join(runner, 'cmd.exe');
  await fs.copyFile(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), copiedCmd);
  const child = spawn(copiedCmd, ['/d', '/k'], { windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    const file = path.join(f.root, 'duplicate % !.zip');
    await fs.writeFile(file, 'disposable zip');
    const manifest = path.join(f.parent, 'guard-manifest.json');
    const out = path.join(f.parent, 'guard-bundle');
    await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 1, roots: [f.root.replaceAll('\\', '/')], targets: [
      { path: f.target, reason: 'Guarded cache', processGuards: [{ processName: 'cmd.exe', executableRoot: runner }] },
      { path: file, reason: 'Reviewed disposable file' },
    ] }));
    await createCleanupBundle({ manifest, out });
    const result = await execute({ out }, true);
    assert.equal(result.exitCode, 2, result.output);
    assert.equal(result.report.targets[0].status, 'skipped', result.output);
    assert.equal(result.report.targets[1].status, 'deleted', result.output);
    assert.equal(result.report.removedLogicalBytes, 14);
    assert.ok(await fs.stat(f.target));
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
});
