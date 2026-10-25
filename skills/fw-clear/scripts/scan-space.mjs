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

function counters(relativePath, fileDetails) {
  return {
    relativePath,
    parentRelativePath: relativePath === '.' ? null : path.dirname(relativePath),
    logicalBytes: 0, files: 0, directories: 1,
    directBytes: 0, directFiles: 0, childDirectories: 0,
    directGitMarkers: [],
    directFileEntries: fileDetails ? [] : null,
    errorCount: 0, skippedCount: 0, directErrorCount: 0, directSkippedCount: 0,
    earliestFileMtime: null, latestFileMtime: null,
  };
}

function merge(total, child) {
  total.logicalBytes += child.logicalBytes;
  total.files += child.files;
  total.directories += child.directories;
  total.errorCount += child.errorCount ?? 0;
  total.skippedCount += child.skippedCount ?? 0;
  if (child.earliestFileMtime && (!total.earliestFileMtime || child.earliestFileMtime < total.earliestFileMtime)) total.earliestFileMtime = child.earliestFileMtime;
  if (child.latestFileMtime && (!total.latestFileMtime || child.latestFileMtime > total.latestFileMtime)) total.latestFileMtime = child.latestFileMtime;
}

// Keep the worst retained item at the root: bounded O(log K) insertion also
// avoids re-sorting for every equal-sized small file in a large cache.
class TopEntries {
  constructor(limit, compare) { this.limit = limit; this.compare = compare; this.values = []; }
  add(value) {
    if (!this.limit) return;
    const heap = this.values;
    if (heap.length < this.limit) {
      heap.push(value);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.compare(heap[index], heap[parent]) <= 0) break;
        [heap[index], heap[parent]] = [heap[parent], heap[index]];
        index = parent;
      }
      return;
    }
    if (this.compare(value, heap[0]) >= 0) return;
    heap[0] = value;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && this.compare(heap[child + 1], heap[child]) > 0) child++;
      if (this.compare(heap[child], heap[index]) <= 0) break;
      [heap[index], heap[child]] = [heap[child], heap[index]];
      index = child;
    }
  }
  sorted() { return this.values.sort(this.compare); }
}

function numberOption(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

// Metadata-only: no file contents, writes, deletion, or engine-specific exclusions.
export async function scanSpace(root, { depth = 2, dirs = 100, top = 30, hotspots = 50, inventory = false, fileDetails = false, onProgress, io = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('root must be an absolute directory path.');
  numberOption(depth, 'depth', 0, 32);
  numberOption(dirs, 'dirs', 0, 1000);
  numberOption(top, 'top', 0, 1000);
  numberOption(hotspots, 'hotspots', 0, 1000);
  if (typeof inventory !== 'boolean') throw new Error('inventory must be a boolean.');
  if (typeof fileDetails !== 'boolean') throw new Error('fileDetails must be a boolean.');
  if (fileDetails) inventory = true;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('onProgress must be a function.');
  const requestedRoot = path.resolve(root);
  const rootInfo = await io.lstat(requestedRoot);
  const realRoot = await io.realpath(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(requestedRoot, realRoot)) throw new Error('root must be a real, non-redirected directory.');
  const start = Date.now();
  const report = {
    schemaVersion: 2,
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
    directoryDepthOmitted: 0,
    largestFilesOmitted: 0,
    deepHotspotLimit: hotspots,
    deepHotspotCount: 0,
    deepHotspotsOmitted: 0,
    deepHotspots: [],
    inventoryEnabled: inventory,
    fileDetailsEnabled: fileDetails,
    inventoryComplete: inventory ? true : null,
    inventory: inventory ? [] : null,
    measurementComplete: null,
    unmeasured: null,
    totals: null,
    directories: [],
    largestFiles: [],
    errorCount: 0,
    errors: [],
    skippedCount: 0,
    skipped: [],
  };
  const progress = { files: 0, directories: 0, logicalBytes: 0, currentPath: realRoot };
  let lastProgress = start - 5000;
  const notifyProgress = final => {
    const now = Date.now();
    if (onProgress && (final || now - lastProgress >= 5000)) {
      onProgress({ ...progress, elapsedMs: now - start, errorCount: report.errorCount, skippedCount: report.skippedCount, final });
      lastProgress = now;
    }
  };
  const recordError = (filename, error, summary) => {
    report.errorCount++;
    summary.errorCount++;
    summary.directErrorCount++;
    if (report.errors.length < 100) report.errors.push({ path: filename, code: error.code ?? 'scan-error', message: error.message });
  };
  const skip = (filename, reason, summary) => {
    report.skippedCount++;
    summary.skippedCount++;
    summary.directSkippedCount++;
    if (report.skipped.length < 100) report.skipped.push({ path: filename, reason });
  };
  const byBytes = (a, b) => b.logicalBytes - a.logicalBytes || a.relativePath.localeCompare(b.relativePath);
  const largestFileDetails = new TopEntries(top, byBytes);
  const directoryDetails = new TopEntries(dirs, byBytes);
  const hotspotDetails = new TopEntries(hotspots, (a, b) => b.directBytes - a.directBytes || a.relativePath.localeCompare(b.relativePath));
  const keepDirectory = (value, level) => {
    if (inventory) report.inventory.push(value);
    if (value.directBytes > 0) { report.deepHotspotCount++; hotspotDetails.add(value); }
    if (level > depth) return;
    report.directoryDetailCount++;
    directoryDetails.add(value);
  };

  async function visit(directory, level) {
    progress.directories++;
    progress.currentPath = directory;
    notifyProgress(false);
    const summary = counters(path.relative(realRoot, directory) || '.', fileDetails);
    let entries;
    try { entries = await io.readdir(directory, { withFileTypes: true }); }
    catch (error) { recordError(directory, error, summary); keepDirectory(summary, level); return summary; }
    // Repository metadata can be a .git FILE (worktree/submodule), a link, a
    // directory, a bare repository, or a linked-worktree administration area.
    // Record names without following or reading them; this is a protection
    // signal for review, never proof that any other directory is disposable.
    const names = new Map(entries.map(entry => [entry.name.toLowerCase(), entry.name]));
    if (names.has('.git')) summary.directGitMarkers.push(names.get('.git'));
    for (const group of [['head', 'objects', 'refs'], ['head', 'commondir', 'gitdir']]) {
      if (group.every(name => names.has(name))) {
        for (const name of group) if (!summary.directGitMarkers.includes(names.get(name))) summary.directGitMarkers.push(names.get(name));
      }
    }
    for (const entry of entries) {
      progress.currentPath = directory;
      const filename = path.join(directory, entry.name);
      try {
        const info = await io.lstat(filename);
        if (info.isSymbolicLink()) { skip(filename, 'symbolic-link-or-junction', summary); notifyProgress(false); continue; }
        if (info.isDirectory()) {
          const real = await io.realpath(filename);
          if (!within(real, realRoot) || !samePath(real, filename)) { skip(filename, 'redirected-directory', summary); notifyProgress(false); continue; }
          summary.childDirectories++;
          merge(summary, await visit(filename, level + 1));
        } else if (info.isFile()) {
          const modifiedAt = info.mtime.toISOString();
          const value = { path: filename, relativePath: path.relative(realRoot, filename), logicalBytes: info.size, modifiedAt };
          largestFileDetails.add(value);
          if (fileDetails) summary.directFileEntries.push({ name: entry.name, logicalBytes: info.size, modifiedAt });
          summary.directBytes += info.size;
          summary.directFiles++;
          progress.files++;
          progress.logicalBytes += info.size;
          merge(summary, { logicalBytes: info.size, files: 1, directories: 0, earliestFileMtime: modifiedAt, latestFileMtime: modifiedAt });
        } else skip(filename, 'special-file', summary);
      } catch (error) { recordError(filename, error, summary); }
      notifyProgress(false);
    }
    keepDirectory(summary, level);
    return summary;
  }

  report.totals = await visit(realRoot, 0);
  report.directories = directoryDetails.sorted();
  report.largestFiles = largestFileDetails.sorted();
  report.deepHotspots = hotspotDetails.sorted();
  report.directoryDetailsOmitted = report.directoryDetailCount - report.directories.length;
  report.directoryDepthOmitted = report.totals.directories - report.directoryDetailCount;
  report.largestFilesOmitted = report.totals.files - report.largestFiles.length;
  report.deepHotspotsOmitted = report.deepHotspotCount - report.deepHotspots.length;
  report.measurementComplete = report.errorCount === 0 && report.skippedCount === 0;
  report.unmeasured = {
    errorCount: report.errorCount, skippedCount: report.skippedCount,
    logicalBytes: report.measurementComplete ? 0 : null,
    errorsOmitted: report.errorCount - report.errors.length,
    skippedOmitted: report.skippedCount - report.skipped.length,
  };
  const end = Date.now();
  report.finishedAt = new Date(end).toISOString();
  report.elapsedMs = end - start;
  notifyProgress(true);
  return report;
}

const usage = 'Usage: node scan-space.mjs --root <absolute-directory> [--depth 0..32] [--dirs 0..1000] [--top 0..1000] [--hotspots 0..1000] [--inventory] [--file-details] [--json] [--progress]';

export function parseArguments(args) {
  const options = { depth: 2, dirs: 100, top: 30, hotspots: 50, inventory: false, fileDetails: false, json: false, progress: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--root', '--depth', '--dirs', '--top', '--hotspots', '--inventory', '--file-details', '--json', '--progress', '--help'].includes(key) || seen.has(key)) throw new Error(usage);
    seen.add(key);
    if (key === '--help') { options.help = true; continue; }
    if (key === '--json') { options.json = true; continue; }
    if (key === '--progress') { options.progress = true; continue; }
    if (key === '--inventory') { options.inventory = true; continue; }
    if (key === '--file-details') { options.fileDetails = true; options.inventory = true; continue; }
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
    `Directory details (through depth ${report.detailDepth}; ${report.directoryDetailsOmitted} omitted by limit, ${report.directoryDepthOmitted ?? 'unknown'} deeper directories omitted; parent/child sizes overlap; totals always scan the full tree):`,
    ...report.directories.map(value => `${mib(value.logicalBytes)}\t${value.files} files\t${path.resolve(report.root, value.relativePath)}`),
    `Largest files (${report.largestFilesOmitted ?? 'unknown'} files omitted):`,
    ...report.largestFiles.map(value => `${mib(value.logicalBytes)}\t${value.modifiedAt}\t${value.path}`),
    `Deep direct-file hotspots (all depths; ${report.deepHotspotsOmitted ?? 'unknown'} omitted; direct bytes exclude child directories and do not overlap):`,
    ...(report.deepHotspots ?? []).map(value => `${mib(value.directBytes)}\t${value.directFiles} direct files\t${path.resolve(report.root, value.relativePath)}`),
    report.inventoryEnabled
      ? `Full directory inventory: ${report.inventory.length} rows; sum of directBytes equals measured total. Each row describes a directory and its direct-file bucket, not an authorized deletion target. Use --json to inspect all rows.`
      : 'Full directory inventory disabled; use --inventory --json for every directory and exact non-overlapping direct-file accounting.',
    report.fileDetailsEnabled
      ? 'Per-file metadata enabled: directFileEntries lists every measured regular file by name, logical bytes and modification time; no contents were read.'
      : 'Per-file metadata disabled; use --file-details --json on a focused scope to separate mixed direct-file buckets.',
    report.measurementComplete === true
      ? 'Unmeasured entries: none reported. This is still a live scan, not a consistent snapshot.'
      : 'Unmeasured bytes: unknown because of errors/skipped entries. Counts do not establish the size of unreadable or redirected content.',
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
      const onProgress = options.progress ? value => console.error(`Scan progress: ${value.files} files, ${value.directories} directories, ${value.logicalBytes} logical bytes, ${value.errorCount} errors, ${value.skippedCount} skipped (${value.elapsedMs} ms)${value.final ? ' finished' : ''} [${value.currentPath}]`) : undefined;
      const report = await scanSpace(options.root, { ...options, onProgress });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
      if (report.errorCount) process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
