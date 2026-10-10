import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function counters(relativePath) {
  return { relativePath, logicalBytes: 0, files: 0, directories: 1, earliestFileMtime: null, latestFileMtime: null };
}

function merge(total, child) {
  total.logicalBytes += child.logicalBytes;
  total.files += child.files;
  total.directories += child.directories;
  if (child.earliestFileMtime && (!total.earliestFileMtime || child.earliestFileMtime < total.earliestFileMtime)) total.earliestFileMtime = child.earliestFileMtime;
  if (child.latestFileMtime && (!total.latestFileMtime || child.latestFileMtime > total.latestFileMtime)) total.latestFileMtime = child.latestFileMtime;
}

function numberOption(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

// Metadata-only: no file contents, writes, deletion, or engine-specific exclusions.
export async function scanSpace(root, { depth = 2, dirs = 100, top = 30, onProgress, io = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('root must be an absolute directory path.');
  numberOption(depth, 'depth', 0, 32);
  numberOption(dirs, 'dirs', 0, 1000);
  numberOption(top, 'top', 0, 1000);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('onProgress must be a function.');
  const requestedRoot = path.resolve(root);
  const rootInfo = await io.lstat(requestedRoot);
  const realRoot = await io.realpath(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(requestedRoot, realRoot)) throw new Error('root must be a real, non-redirected directory.');
  const start = Date.now();
  const report = {
    schemaVersion: 1,
    root: realRoot,
    startedAt: new Date(start).toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    measurement: 'logical-file-lengths',
    consistentSnapshot: false,
    detailDepth: depth,
    directoryDetailLimit: dirs,
    directoryDetailCount: 0,
    directoryDetailsOmitted: 0,
    totals: null,
    directories: [],
    largestFiles: [],
    errorCount: 0,
    errors: [],
    skippedCount: 0,
    skipped: [],
  };
  const progress = { files: 0, directories: 0, logicalBytes: 0 };
  let lastProgress = start - 5000;
  const notifyProgress = final => {
    const now = Date.now();
    if (onProgress && (final || now - lastProgress >= 5000)) {
      onProgress({ ...progress, elapsedMs: now - start, errorCount: report.errorCount, skippedCount: report.skippedCount, final });
      lastProgress = now;
    }
  };
  const recordError = (filename, error) => {
    report.errorCount++;
    if (report.errors.length < 100) report.errors.push({ path: filename, code: error.code ?? 'scan-error', message: error.message });
  };
  const skip = (filename, reason) => {
    report.skippedCount++;
    if (report.skipped.length < 100) report.skipped.push({ path: filename, reason });
  };
  const keepFile = value => {
    if (!top || (report.largestFiles.length === top && value.logicalBytes < report.largestFiles.at(-1).logicalBytes)) return;
    report.largestFiles.push(value);
    report.largestFiles.sort((a, b) => b.logicalBytes - a.logicalBytes || a.relativePath.localeCompare(b.relativePath));
    if (report.largestFiles.length > top) report.largestFiles.pop();
  };
  const keepDirectory = (value, level) => {
    if (level > depth) return;
    report.directoryDetailCount++;
    if (!dirs || (report.directories.length === dirs && value.logicalBytes < report.directories.at(-1).logicalBytes)) return;
    report.directories.push(value);
    report.directories.sort((a, b) => b.logicalBytes - a.logicalBytes || a.relativePath.localeCompare(b.relativePath));
    if (report.directories.length > dirs) report.directories.pop();
  };

  async function visit(directory, level) {
    progress.directories++;
    notifyProgress(false);
    const summary = counters(path.relative(realRoot, directory) || '.');
    let entries;
    try { entries = await io.readdir(directory, { withFileTypes: true }); }
    catch (error) { recordError(directory, error); keepDirectory(summary, level); return summary; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      try {
        const info = await io.lstat(filename);
        if (info.isSymbolicLink()) { skip(filename, 'symbolic-link-or-junction'); continue; }
        if (info.isDirectory()) {
          const real = await io.realpath(filename);
          if (!within(real, realRoot) || !samePath(real, filename)) { skip(filename, 'redirected-directory'); continue; }
          merge(summary, await visit(filename, level + 1));
        } else if (info.isFile()) {
          const modifiedAt = info.mtime.toISOString();
          const value = { path: filename, relativePath: path.relative(realRoot, filename), logicalBytes: info.size, modifiedAt };
          keepFile(value);
          progress.files++;
          progress.logicalBytes += info.size;
          merge(summary, { logicalBytes: info.size, files: 1, directories: 0, earliestFileMtime: modifiedAt, latestFileMtime: modifiedAt });
        } else skip(filename, 'special-file');
      } catch (error) { recordError(filename, error); }
      notifyProgress(false);
    }
    keepDirectory(summary, level);
    return summary;
  }

  report.totals = await visit(realRoot, 0);
  report.directoryDetailsOmitted = report.directoryDetailCount - report.directories.length;
  const end = Date.now();
  report.finishedAt = new Date(end).toISOString();
  report.elapsedMs = end - start;
  notifyProgress(true);
  return report;
}

const usage = 'Usage: node scan-space.mjs --root <absolute-directory> [--depth 0..32] [--dirs 0..1000] [--top 0..1000] [--json] [--progress]';

export function parseArguments(args) {
  const options = { depth: 2, dirs: 100, top: 30, json: false, progress: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--root', '--depth', '--dirs', '--top', '--json', '--progress', '--help'].includes(key) || seen.has(key)) throw new Error(usage);
    seen.add(key);
    if (key === '--help') { options.help = true; continue; }
    if (key === '--json') { options.json = true; continue; }
    if (key === '--progress') { options.progress = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(usage);
    if (key === '--root') options.root = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error(usage);
      options[key.slice(2)] = Number(value);
    }
  }
  if (!options.help && !options.root) throw new Error(usage);
  return options;
}

export function formatReport(report) {
  const mib = bytes => `${(bytes / 1024 ** 2).toFixed(2)} MiB (${bytes} bytes)`;
  const lines = [
    `Root: ${report.root}`,
    `Scan: ${report.startedAt} to ${report.finishedAt} (${report.elapsedMs} ms)`,
    `Logical file lengths: ${mib(report.totals.logicalBytes)}, ${report.totals.files} files, ${report.totals.directories} directories`,
    'Logical bytes are not allocated disk space or reclaimable space. Files may change during this scan; no deletion classification is performed.',
    `Directory details (through depth ${report.detailDepth}; ${report.directoryDetailsOmitted} omitted; parent/child sizes overlap; totals always scan the full tree):`,
    ...report.directories.map(value => `${mib(value.logicalBytes)}\t${value.files} files\t${path.resolve(report.root, value.relativePath)}`),
    'Largest files:',
    ...report.largestFiles.map(value => `${mib(value.logicalBytes)}\t${value.modifiedAt}\t${value.path}`),
    `Errors: ${report.errorCount}; skipped links/special entries: ${report.skippedCount} (details capped at 100 each)`,
    ...report.errors.map(value => `ERROR ${value.code}\t${value.path}\t${value.message}`),
    ...report.skipped.map(value => `SKIPPED ${value.reason}\t${value.path}`),
  ];
  return lines.join('\n');
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      const onProgress = options.progress ? value => console.error(`Scan progress: ${value.files} files, ${value.directories} directories, ${value.logicalBytes} logical bytes, ${value.errorCount} errors, ${value.skippedCount} skipped (${value.elapsedMs} ms)${value.final ? ' finished' : ''}`) : undefined;
      const report = await scanSpace(options.root, { ...options, onProgress });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
      if (report.errorCount) process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
