import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const executor = fileURLToPath(new URL('./execute-cleanup.ps1', import.meta.url));

export function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--manifest', '--out'].includes(option) || result[option.slice(2)] || !args[index + 1]) {
      throw new Error('Usage: node create-cleanup-bundle.mjs --manifest <absolute-json-path> --out <new-absolute-directory>');
    }
    result[option.slice(2)] = args[++index];
  }
  if (!result.manifest || !result.out) throw new Error('Both --manifest and --out are required.');
  return result;
}

function within(child, root) {
  const relative = path.relative(root, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function bat() {
  // No manifest data is inserted into cmd syntax. Expansion of %~dp0 happens once;
  // delayed expansion is disabled so ! and other characters in the bundle path survive.
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0execute-cleanup.ps1" -PlanPath "%~dp0cleanup-plan.json" -Apply',
    'set "CLEANUP_EXIT=%ERRORLEVEL%"',
    'echo.',
    'echo Finished. Exit code: %CLEANUP_EXIT%. See cleanup-results.json and cleanup-results.log.',
    'pause',
    'exit /b %CLEANUP_EXIT%',
    '',
  ].join('\r\n');
}

export async function createCleanupBundle({ manifest, out, onProgress } = {}) {
  if (process.platform !== 'win32') throw new Error('The one-click BAT bundle requires Windows and Windows PowerShell 5.1+.');
  for (const [label, value] of Object.entries({ manifest, out })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  }
  const output = path.resolve(out);
  if (output.split(path.sep).some(component => component.toLowerCase() === '.git')) throw new Error('Output cannot be inside Git metadata.');
  const outputParent = path.dirname(output);
  const realParent = await fs.realpath(outputParent);
  if (path.resolve(realParent).toLowerCase() !== path.resolve(outputParent).toLowerCase()) {
    throw new Error('Output parent must not be a redirected directory.');
  }
  try {
    await fs.lstat(output);
    throw new Error('Output directory already exists; choose a new directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const input = JSON.parse((await fs.readFile(manifest, 'utf8')).replace(/^\uFEFF/, ''));
  if (input.schemaVersion !== 1 || !Array.isArray(input.roots) || !Array.isArray(input.targets)) {
    throw new Error('Manifest requires schemaVersion: 1, roots: [absolute-path], and targets: [{path, reason, processGuards?}].');
  }
  for (const target of input.targets) {
    if (typeof target.path === 'string' && path.isAbsolute(target.path) && within(output, path.resolve(target.path))) {
      throw new Error('Output must not be inside a cleanup target.');
    }
  }
  // Only two known temporary files are written here. Never recursively remove a
  // user-selected output directory, including after a partial generation failure.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fws-clear-seal-'));
  const inputPath = path.join(temporary, 'manifest.json');
  const planPath = path.join(temporary, 'plan.json');
  try {
    await fs.writeFile(inputPath, JSON.stringify(input), 'utf8');
    onProgress?.('Sealing the exact target metadata and checking paths, Git ownership, and links.');
    try {
      await run('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executor,
        '-Seal', '-ManifestPath', inputPath, '-PlanPath', planPath], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      throw new Error(`Cleanup bundle was not generated: ${(error.stderr || error.stdout || error.message).trim()}`);
    }
    const sealed = JSON.parse(await fs.readFile(planPath, 'utf8'));
    await fs.mkdir(output); // Atomic refusal if another process created this path.
    await fs.copyFile(executor, path.join(output, 'execute-cleanup.ps1'), fs.constants.COPYFILE_EXCL);
    await fs.copyFile(planPath, path.join(output, 'cleanup-plan.json'), fs.constants.COPYFILE_EXCL);
    await fs.writeFile(path.join(output, 'cleanup.bat'), bat(), { encoding: 'ascii', flag: 'wx' });
    await fs.writeFile(path.join(output, 'README.txt'), [
      'Double-click cleanup.bat to delete only unchanged, safe targets in cleanup-plan.json.',
      'There is no extra confirmation. Active process guards skip their own targets.',
      'Exit codes: 0 = all ready/successful; 2 = skipped/failed items; 1 = invalid plan/fatal error.',
      'Missing paths are skipped on repeat runs. Results are written next to the BAT.',
      'If target contents change, review them and generate a NEW bundle. Do not edit the sealed plan.',
      'Logical bytes do not equal disk allocation; free-space changes include other processes.',
      '',
    ].join('\r\n'), { encoding: 'ascii', flag: 'wx' });
    return { output, targets: sealed.targets.length, logicalBytes: sealed.targets.reduce((total, item) => total + item.snapshot.logicalBytes, 0) };
  } finally {
    await fs.unlink(inputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(planPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(temporary);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await createCleanupBundle({ ...parseArguments(process.argv.slice(2)), onProgress: message => process.stderr.write(`${message}\n`) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
