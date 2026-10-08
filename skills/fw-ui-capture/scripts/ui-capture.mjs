#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const usage = `Usage: node ui-capture.mjs <serve|validate|export> --manifest <capture.json> [--fw-root <FW workspace>]
  serve:    [--fwe-path <FWE directory>] [--port <0..65535>] [--open]
  export:   --out <NEW directory>
FW lookup: --fw-root, then FW_HOME, then the physical FWS sibling workspace.
Requires the existing FWV UI backend; serve also requires FWE. Nothing is installed.`;

async function packageAt(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch { return null; }
}

export async function resolveUiBackend({ fwRoot, env = process.env, entryPath = scriptPath } = {}) {
  const explicit = fwRoot !== undefined;
  const source = explicit ? '--fw-root' : env.FW_HOME?.trim() ? 'FW_HOME' : 'physical FWS location';
  const candidate = explicit ? fwRoot : env.FW_HOME?.trim()
    ? env.FW_HOME : path.resolve(path.dirname(await realpath(entryPath)), '../../../..');
  const failure = () => new Error(`FWV UI backend was not found or verified from ${source}: ${candidate || '(empty)'}. Expected fwv/package.json (name=fwv) and fwv/ui/cli.mjs. Set --fw-root or FW_HOME to the existing FW workspace; no automatic install is performed.`);
  if (typeof candidate !== 'string' || !candidate.trim()) throw failure();
  let location;
  try { location = await realpath(candidate); } catch { throw failure(); }
  const candidates = [path.join(location, 'fwv')];
  const program = await packageAt(location);
  // Support both the workbench and its fw/ program, including installed skill junctions.
  if (program?.name === 'fw' && program.fwWorkspace === true) candidates.push(path.resolve(location, '../fwv'));
  for (const directory of candidates) {
    if ((await packageAt(directory))?.name !== 'fwv') continue;
    const cli = path.join(directory, 'ui', 'cli.mjs');
    try { if ((await stat(cli)).isFile()) return await realpath(cli); } catch { /* try the verified program's sibling */ }
  }
  throw failure();
}

export async function runUiCapture(argv = process.argv.slice(2)) {
  if (!argv.length || (argv.length === 1 && ['-h', '--help'].includes(argv[0]))) {
    console.log(usage);
    return 0;
  }
  if (!['serve', 'validate', 'export'].includes(argv[0])) throw new Error(usage);
  const forwarded = [argv[0]];
  let fwRoot;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] !== '--fw-root') { forwarded.push(argv[index]); continue; }
    const value = argv[++index];
    if (fwRoot !== undefined || !value || value.startsWith('--')) throw new Error('--fw-root requires one non-empty directory and cannot be repeated.');
    fwRoot = value;
  }
  const cli = await resolveUiBackend({ fwRoot });
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...forwarded], { stdio: 'inherit', shell: false, windowsHide: true });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

export async function main(argv = process.argv.slice(2)) {
  try { process.exitCode = await runUiCapture(argv); }
  catch (error) { console.error(`fw-ui-capture: ${error.message}`); process.exitCode = 1; }
}

// Node resolves import.meta.url through junctions; argv[1] may retain the installed path.
if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) await main();
