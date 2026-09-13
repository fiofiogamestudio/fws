import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const wrapper = fileURLToPath(new URL('../skills/fw-sync/scripts/fw-sync.ps1', import.meta.url));
const resolver = fileURLToPath(new URL('../skills/fw-sync/scripts/resolve-fw-root.ps1', import.meta.url));
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const shellAvailable = !spawnSync(shell, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).error;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-sync-entry-with spaces-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('fws-sync-entry-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'tools'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fw', fwWorkspace: true }));
  await fs.writeFile(path.join(root, 'tools', 'sync.ps1'), `param([string]$Action, [string]$ProjectRoot, [string]$Components, [string]$FwcTarget, [switch]$Apply, [switch]$Json)
@{ action=$Action; projectRoot=$ProjectRoot; components=$Components; target=$FwcTarget; apply=[bool]$Apply; json=[bool]$Json } | ConvertTo-Json -Compress
exit 7
`);
  return root;
}

function run(script, args = [], environment = {}) {
  const env = { ...process.env, ...environment };
  if (env.FW_HOME === undefined) delete env.FW_HOME;
  return spawnSync(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
}

test('sync entry validates explicit FW, forwards named parameters and propagates its exit code', { skip: !shellAvailable }, async t => {
  const root = await fixture(t);
  const result = run(wrapper, ['sync', '-FwRoot', root, '-ProjectRoot', 'host with spaces', '-Components', 'fwc,fwe', '-FwcTarget', 'a'.repeat(40), '-Apply', '-Json'], { FW_HOME: path.join(root, 'wrong') });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: 'sync', projectRoot: 'host with spaces', components: 'fwc,fwe', target: 'a'.repeat(40), apply: true, json: true });
});

test('nested FW program accepts explicit workbench/program roots and both FW_HOME forms', { skip: !shellAvailable }, async t => {
  const workbench = await fixture(t);
  const program = path.join(workbench, 'fw');
  await fs.mkdir(program);
  await fs.rename(path.join(workbench, 'package.json'), path.join(program, 'package.json'));
  await fs.rename(path.join(workbench, 'tools'), path.join(program, 'tools'));
  for (const root of [workbench, program]) {
    assert.equal(run(wrapper, ['status', '-FwRoot', root, '-Json'], { FW_HOME: path.join(workbench, 'wrong') }).status, 7);
    assert.equal(run(wrapper, ['status', '-Json'], { FW_HOME: root }).status, 7);
  }
});

test('nested FW program is discovered from physical FWS and installed skill junctions', { skip: !shellAvailable }, async t => {
  const workbench = await fixture(t);
  const program = path.join(workbench, 'fw');
  await fs.mkdir(program);
  await fs.rename(path.join(workbench, 'package.json'), path.join(program, 'package.json'));
  await fs.rename(path.join(workbench, 'tools'), path.join(program, 'tools'));
  const source = path.join(workbench, 'fws', 'skills', 'fw-sync');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.copyFile(wrapper, path.join(source, 'scripts', 'fw-sync.ps1'));
  await fs.copyFile(resolver, path.join(source, 'scripts', 'resolve-fw-root.ps1'));
  const direct = run(path.join(source, 'scripts', 'fw-sync.ps1'), ['status', '-Json'], { FW_HOME: undefined });
  assert.equal(direct.status, 7, direct.stderr);
  const installed = path.join(workbench, 'installed skill');
  await fs.symlink(source, installed, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = run(path.join(installed, 'scripts', 'fw-sync.ps1'), ['status', '-Json'], { FW_HOME: undefined });
  assert.equal(linked.status, 7, linked.stderr);
});

test('nested candidate identity stays mandatory and FW_HOME cannot rescue an invalid explicit root', { skip: !shellAvailable }, async t => {
  const valid = await fixture(t);
  const workbench = path.join(valid, 'invalid workbench');
  const program = path.join(workbench, 'fw');
  await fs.mkdir(path.join(program, 'tools'), { recursive: true });
  const marker = path.join(program, 'executed.txt');
  await fs.writeFile(path.join(program, 'tools', 'sync.ps1'), `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value wrong`);
  for (const identity of [
    { name: 'fwc', fwWorkspace: true },
    { name: 'fw', fwWorkspace: 'true' },
    { name: 'fw' },
  ]) {
    await fs.writeFile(path.join(program, 'package.json'), JSON.stringify(identity));
    const result = run(wrapper, ['status', '-FwRoot', workbench], { FW_HOME: valid });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /FW Git engine was not found or verified/);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  }
  await fs.writeFile(path.join(program, 'package.json'), JSON.stringify({ name: 'fw', fwWorkspace: true }));
  await fs.rename(path.join(program, 'tools', 'sync.ps1'), path.join(program, 'tools', 'unused.ps1'));
  assert.equal(run(wrapper, ['status', '-FwRoot', workbench], { FW_HOME: valid }).status, 2);
});

test('sync entry supports FW_HOME and package-verified canonical parent discovery', { skip: !shellAvailable }, async t => {
  const root = await fixture(t);
  assert.equal(run(wrapper, ['status', '-Json'], { FW_HOME: root }).status, 7);
  const canonical = path.join(root, 'fws', 'skills', 'fw-sync', 'scripts', 'fw-sync.ps1');
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.copyFile(wrapper, canonical);
  await fs.copyFile(resolver, path.join(path.dirname(canonical), 'resolve-fw-root.ps1'));
  const result = run(canonical, ['status', '-Json'], { FW_HOME: undefined });
  assert.equal(result.status, 7, result.stderr);
});

test('installed skill junction/symlink resolves physical FWS ancestors without FW_HOME', { skip: !shellAvailable }, async t => {
  const root = await fixture(t);
  const source = path.join(root, 'fws', 'skills', 'fw-sync');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.copyFile(wrapper, path.join(source, 'scripts', 'fw-sync.ps1'));
  await fs.copyFile(resolver, path.join(source, 'scripts', 'resolve-fw-root.ps1'));
  const discovery = path.join(root, 'client-skills');
  await fs.mkdir(discovery);
  const installed = path.join(discovery, 'fw-sync');
  await fs.symlink(source, installed, process.platform === 'win32' ? 'junction' : 'dir');
  const result = run(path.join(installed, 'scripts', 'fw-sync.ps1'), ['status', '-Json'], { FW_HOME: undefined });
  assert.equal(result.status, 7, result.stderr);
});

test('sync entry fails closed for an invalid explicit root without falling back to FW_HOME', { skip: !shellAvailable }, async t => {
  const root = await fixture(t);
  const wrong = path.join(root, 'fwc');
  await fs.mkdir(path.join(wrong, 'tools'), { recursive: true });
  await fs.writeFile(path.join(wrong, 'package.json'), JSON.stringify({ name: 'fwc', fwWorkspace: true }));
  const marker = path.join(wrong, 'executed.txt');
  await fs.writeFile(path.join(wrong, 'tools', 'sync.ps1'), `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value wrong`);
  const result = run(wrapper, ['status', '-FwRoot', wrong], { FW_HOME: root });
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, 7);
  assert.match(result.stderr, /FW Git engine was not found or verified/);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('sync entry reports bootstrap instructions when the required FW is missing', { skip: !shellAvailable }, async t => {
  const root = await fixture(t);
  const result = run(wrapper, ['status', '-FwRoot', path.join(root, 'missing')], { FW_HOME: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FW_HOME/);
  assert.match(result.stderr, /No download was attempted/);
});
