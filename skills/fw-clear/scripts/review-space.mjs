import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dispositions = ['regenerable', 'retired', 'conditional', 'keep', 'unreviewed'];
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;
const nonemptyStrings = value => Array.isArray(value) && value.length > 0 && Array.from(value).every(nonemptyString);
const normalize = value => {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^(?:[a-z]:|[\\/])/i.test(value)) throw new Error('Expected a relative inventory path.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => part === '..' || part === '') || (value !== '.' && parts.includes('.'))) throw new Error('Non-canonical relative path.');
  return parts.join('/');
};
const inside = (child, parent) => parent === '.' || child === parent || child.startsWith(`${parent}/`);
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '.';
const isGit = value => value.split('/').some(part => part.toLowerCase() === '.git');
const number = (value, name) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`); return value; };

// Hints describe what to investigate, never whether a path can be deleted.
export function reviewHint(relativePath) {
  const segments = relativePath.toLowerCase().split('/');
  if (isGit(relativePath)) return 'git-metadata';
  if (segments.some(p => /^(artsource|assets|packages|projectsettings|src|source|retained-worker-source)$/.test(p))) return 'source-or-input';
  if (segments.some(p => /^(library|temp|obj|bin|node_modules|\.godot|\.cache|cache|caches)$/.test(p))) return 'cache-or-build-needs-provenance';
  if (segments.some(p => /^(output|outputs|\.local|dist|build|builds|recordings|captures|artifacts|backup|backups|archive|archives)$/.test(p))) return 'mixed-output-split-inputs-evidence-delivery';
  return 'investigate';
}

export function reviewSpace(scan, { decisions, chunkMiB = 1024, focus = '.' } = {}) {
  if (scan?.inventoryComplete !== true || !Array.isArray(scan.inventory) || !scan.inventory.length) throw new Error('A complete --inventory scan is required; a top-N directory list cannot prove coverage.');
  if (!path.isAbsolute(scan.root)) throw new Error('Scan root must be absolute.');
  if (typeof scan.finishedAt !== 'string' || !scan.finishedAt.trim() || !Number.isFinite(Date.parse(scan.finishedAt))) throw new Error('Scan finishedAt must be a valid timestamp.');
  if (!Number.isFinite(chunkMiB) || chunkMiB <= 0) throw new Error('chunkMiB must be positive.');
  focus = normalize(focus);
  const nodes = new Map();
  for (const item of scan.inventory) {
    const relativePath = normalize(item.relativePath);
    if (nodes.has(relativePath)) throw new Error(`Duplicate inventory path: ${relativePath}`);
    for (const key of ['logicalBytes', 'directBytes', 'files', 'directFiles', 'errorCount', 'skippedCount', 'directErrorCount', 'directSkippedCount']) number(item[key], key);
    if (item.directGitMarkers !== undefined && (!Array.isArray(item.directGitMarkers) || item.directGitMarkers.some(m => typeof m !== 'string'))) throw new Error('Invalid Git markers.');
    if (item.directFileEntries != null) {
      if (!Array.isArray(item.directFileEntries)) throw new Error('Invalid file details.');
      const names = new Set();
      for (const file of item.directFileEntries) {
        if (typeof file.name !== 'string' || !file.name || /[\\/\0]/.test(file.name) || ['.', '..'].includes(file.name) || names.has(file.name)) throw new Error('Invalid or duplicate file detail name.');
        names.add(file.name);
        number(file.logicalBytes, 'file logicalBytes');
      }
      if (item.directFileEntries.length !== item.directFiles || item.directFileEntries.reduce((sum, f) => sum + f.logicalBytes, 0) !== item.directBytes) throw new Error(`File details do not reconcile: ${relativePath}`);
    }
    nodes.set(relativePath, { ...item, relativePath, children: [] });
  }
  if (!nodes.has('.') || !nodes.has(focus)) throw new Error('Inventory root/focus is missing.');
  for (const node of nodes.values()) {
    if (node.relativePath === '.') continue;
    const parent = nodes.get(parentOf(node.relativePath));
    if (!parent) throw new Error(`Inventory parent missing: ${node.relativePath}`);
    parent.children.push(node);
  }
  for (const node of nodes.values()) {
    if (node.logicalBytes !== node.directBytes + node.children.reduce((sum, child) => sum + child.logicalBytes, 0) ||
        node.files !== node.directFiles + node.children.reduce((sum, child) => sum + child.files, 0)) throw new Error(`Inventory does not reconcile: ${node.relativePath}`);
    for (const [total, direct] of [['errorCount', 'directErrorCount'], ['skippedCount', 'directSkippedCount']]) {
      if (node[total] !== node[direct] + node.children.reduce((sum, child) => sum + child[total], 0)) throw new Error(`Inventory diagnostics do not reconcile: ${node.relativePath}`);
    }
  }
  if (nodes.get('.').logicalBytes !== scan.totals.logicalBytes || nodes.get('.').files !== scan.totals.files) throw new Error('Inventory and scan totals disagree.');
  if (nodes.get('.').errorCount !== scan.errorCount || nodes.get('.').skippedCount !== scan.skippedCount) throw new Error('Inventory and scan diagnostics disagree.');
  const storageRoots = [...nodes.values()].filter(n => {
    const markers = (n.directGitMarkers ?? []).map(m => m.toLowerCase());
    return markers.includes('head') && (markers.includes('objects') || (markers.includes('commondir') && markers.includes('gitdir')));
  }).map(n => n.relativePath);
  const protectedStorage = relativePath => isGit(relativePath) || storageRoots.some(root => inside(relativePath, root));
  const reviewed = [];
  if (decisions) {
    if (decisions.schemaVersion !== 1 || typeof decisions.root !== 'string' || !path.isAbsolute(decisions.root) || path.resolve(decisions.root) !== path.resolve(scan.root) || decisions.scanFinishedAt !== scan.finishedAt || !Array.isArray(decisions.decisions)) throw new Error('Decisions must identify this exact scan root and finishedAt.');
    for (const decision of decisions.decisions) {
      const relativePath = normalize(decision.relativePath);
      const node = nodes.get(decision.scope === 'file' ? parentOf(relativePath) : relativePath);
      if (!node || !['tree', 'direct', 'file'].includes(decision.scope) || !dispositions.slice(0, -1).includes(decision.disposition)) throw new Error(`Invalid decision: ${relativePath}`);
      let file;
      if (decision.scope === 'file') {
        file = node.directFileEntries?.find(f => f.name === relativePath.split('/').at(-1));
        if (!file || nodes.has(relativePath)) throw new Error(`File decision requires matching --file-details snapshot entry: ${relativePath}`);
      }
      if (!nonemptyString(decision.reason) || !nonemptyStrings(decision.evidence)) throw new Error(`Reason and evidence required: ${relativePath}`);
      if (decision.disposition !== 'keep') {
        if (!Array.isArray(decision.prerequisites) || !Array.from(decision.prerequisites).every(nonemptyString)) throw new Error(`Prerequisites required: ${relativePath}`);
        if (decision.disposition === 'retired') {
          const retirement = decision.retirement;
          if (!retirement || typeof retirement !== 'object' || Array.isArray(retirement) ||
              !nonemptyString(retirement.generatedBy) || !nonemptyStrings(retirement.completionEvidence) ||
              !nonemptyString(retirement.consumerAudit) || !nonemptyStrings(retirement.preservedEvidence) ||
              !nonemptyString(retirement.impact)) throw new Error(`Retirement generation, completion, consumer, preserved evidence and impact required: ${relativePath}`);
        } else if (!nonemptyString(decision.regenerate)) throw new Error(`Regeneration required: ${relativePath}`);
        if (relativePath === '.') throw new Error('The project root cannot be a cleanup candidate; select exact child scopes.');
        if (protectedStorage(relativePath) || (decision.scope === 'tree' && [...nodes.keys()].some(p => inside(p, relativePath) && protectedStorage(p)))) throw new Error(`Git metadata cannot be a cleanup candidate: ${relativePath}`);
        const selectedNodes = decision.scope === 'tree' ? [...nodes.values()].filter(n => inside(n.relativePath, relativePath)) : [node];
        if (selectedNodes.some(n => !Array.isArray(n.directGitMarkers) || (decision.scope !== 'file' && n.directGitMarkers.length))) throw new Error(`Git marker evidence missing or repository boundary present: ${relativePath}`);
        if (['regenerable', 'retired'].includes(decision.disposition) && (decision.scope === 'tree' ? node.errorCount + node.skippedCount : node.directErrorCount + node.directSkippedCount)) throw new Error(`Incomplete measurement cannot be marked ${decision.disposition}: ${relativePath}`);
      }
      for (const other of reviewed) {
        if ((relativePath === other.relativePath && decision.scope === other.scope) || (other.scope === 'tree' && inside(relativePath, other.relativePath)) || (decision.scope === 'tree' && inside(other.relativePath, relativePath)) ||
            (decision.scope === 'file' && other.scope === 'direct' && parentOf(relativePath) === other.relativePath) ||
            (decision.scope === 'direct' && other.scope === 'file' && parentOf(other.relativePath) === relativePath)) throw new Error(`Overlapping decisions: ${relativePath} / ${other.relativePath}`);
      }
      reviewed.push({ ...decision, relativePath, file });
    }
  }
  const trees = new Map(reviewed.filter(d => d.scope === 'tree').map(d => [d.relativePath, d]));
  const direct = new Map(reviewed.filter(d => d.scope === 'direct').map(d => [d.relativePath, d]));
  const fileDecisions = new Map();
  for (const d of reviewed.filter(d => d.scope === 'file')) {
    const parent = parentOf(d.relativePath);
    if (!fileDecisions.has(parent)) fileDecisions.set(parent, []);
    fileDecisions.get(parent).push(d);
  }
  const mustSplit = new Set(['.']);
  for (const d of reviewed) {
    let p = d.relativePath;
    if (d.scope === 'direct') mustSplit.add(p);
    while (p !== '.') { p = parentOf(p); mustSplit.add(p); }
  }
  // Git descendants must remain visible even inside a small mixed subtree.
  for (const [p, node] of nodes) if (protectedStorage(p) || node.directGitMarkers?.length) {
    if (node.directGitMarkers?.some(m => m.toLowerCase() === '.git')) mustSplit.add(p);
    let parent = p;
    while (parent !== '.') { parent = parentOf(parent); if (!isGit(parent)) mustSplit.add(parent); }
  }
  const rows = [];
  function emit(node, scope, decision) {
    const selectedFiles = scope === 'direct' ? fileDecisions.get(node.relativePath) ?? [] : [];
    const logicalBytes = (scope === 'tree' ? node.logicalBytes : node.directBytes) - selectedFiles.reduce((sum, d) => sum + d.file.logicalBytes, 0);
    const files = (scope === 'tree' ? node.files : node.directFiles) - selectedFiles.length;
    const errorCount = scope === 'tree' ? node.errorCount : node.directErrorCount;
    const skippedCount = scope === 'tree' ? node.skippedCount : node.directSkippedCount;
    for (const d of selectedFiles) rows.push({
      relativePath: d.relativePath, path: path.resolve(scan.root, d.relativePath), scope: 'file', logicalBytes: d.file.logicalBytes, files: 1,
      disposition: d.disposition, hint: reviewHint(d.relativePath), reason: d.reason, evidence: d.evidence,
      regenerate: d.regenerate ?? null, prerequisites: d.prerequisites ?? [], errorCount: 0, skippedCount: 0, deletionApproved: false,
      retirement: d.retirement ?? null,
      modifiedAt: d.file.modifiedAt ?? null,
    });
    if (!files && !logicalBytes && !errorCount && !skippedCount) return;
    const protectedBucket = protectedStorage(node.relativePath) || (scope === 'direct' && node.directGitMarkers?.length);
    const disposition = decision?.disposition ?? (protectedBucket ? 'keep' : 'unreviewed');
    rows.push({ relativePath: node.relativePath, path: path.resolve(scan.root, node.relativePath), scope, logicalBytes, files,
      disposition, hint: protectedStorage(node.relativePath) ? 'git-metadata' : reviewHint(node.relativePath), reason: decision?.reason ?? (protectedBucket ? 'Bucket includes protected Git metadata; inspect individual files separately.' : null),
      directGitMarkers: node.directGitMarkers ?? null,
      excludedFiles: selectedFiles.map(d => d.file.name),
      evidence: decision?.evidence ?? [], regenerate: decision?.regenerate ?? null, prerequisites: decision?.prerequisites ?? [],
      retirement: decision?.retirement ?? null,
      errorCount, skippedCount, deletionApproved: false });
  }
  function visit(node) {
    const selected = trees.get(node.relativePath);
    if (selected) return emit(node, 'tree', selected);
    if (protectedStorage(node.relativePath) && !mustSplit.has(node.relativePath)) return emit(node, 'tree');
    if (node.relativePath !== focus && !mustSplit.has(node.relativePath) && node.logicalBytes <= chunkMiB * 1024 ** 2) return emit(node, 'tree');
    emit(node, 'direct', direct.get(node.relativePath));
    for (const child of node.children) visit(child);
  }
  const inherited = reviewed.find(d => d.scope === 'tree' && inside(focus, d.relativePath));
  if (inherited) emit(nodes.get(focus), 'tree', inherited); else visit(nodes.get(focus));
  rows.sort((a, b) => b.logicalBytes - a.logicalBytes || a.relativePath.localeCompare(b.relativePath));
  const totals = Object.fromEntries(dispositions.map(d => [d, { logicalBytes: 0, files: 0, rows: 0 }]));
  for (const row of rows) { const total = totals[row.disposition]; total.logicalBytes += row.logicalBytes; total.files += row.files; total.rows++; }
  const logicalBytes = rows.reduce((sum, row) => sum + row.logicalBytes, 0);
  const files = rows.reduce((sum, row) => sum + row.files, 0);
  const target = nodes.get(focus);
  if (logicalBytes !== target.logicalBytes || files !== target.files) throw new Error('Internal partition accounting mismatch.');
  return { schemaVersion: 1, root: scan.root, focus, scanFinishedAt: scan.finishedAt,
    measurement: scan.measurement, consistentSnapshot: false, deletionPlan: false,
    logicalBytes, files, partitionCoveragePercent: 100,
    reviewedPercent: logicalBytes ? (logicalBytes - totals.unreviewed.logicalBytes) / logicalBytes * 100 : 100,
    unmeasured: { errorCount: target.errorCount, skippedCount: target.skippedCount, logicalBytes: target.errorCount || target.skippedCount ? null : 0 },
    totals, rows };
}

export function formatReview(report, limit = 60) {
  number(limit, 'limit');
  const size = bytes => `${(bytes / 1024 ** 3).toFixed(3)} GiB`;
  const shown = report.rows.slice(0, limit);
  const rest = report.rows.slice(limit);
  return [
    `Root: ${report.root}; focus: ${report.focus}; scan: ${report.scanFinishedAt}`,
    `Measured: ${size(report.logicalBytes)}, ${report.files} files; partition reconciles 100%; reviewed: ${report.reviewedPercent.toFixed(2)}%`,
    'This is a review ledger, not a deletion plan. Hints, size, age and ignored status do not authorize deletion.',
    ...Object.entries(report.totals).map(([key, value]) => `${key}: ${size(value.logicalBytes)}, ${value.files} files, ${value.rows} groups`),
    `Unmeasured: ${report.unmeasured.errorCount} errors, ${report.unmeasured.skippedCount} skipped; bytes: ${report.unmeasured.logicalBytes ?? 'unknown'}`,
    ...shown.map(row => `${size(row.logicalBytes)}\t${row.files} files\t${row.disposition}\t${row.scope}\t${row.path}\t${row.hint}${row.reason ? `\t${row.reason}` : ''}`),
    `Not displayed: ${rest.length} groups, ${size(rest.reduce((sum, row) => sum + row.logicalBytes, 0))}; all retained in JSON. Use --focus or --limit for the rest.`,
    'A direct row means remaining immediate files (excluding separately listed file rows), not child directories; it is NOT a recursive deletion target.',
  ].join('\n');
}

export function parseReviewArgs(args) {
  const options = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key) || !['--scan', '--decisions', '--focus', '--chunk-mib', '--limit', '--json', '--help'].includes(key)) throw new Error('Invalid or duplicate option.');
    seen.add(key);
    if (key === '--json' || key === '--help') { options[key.slice(2)] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
    options[{'--chunk-mib': 'chunkMiB'}[key] ?? key.slice(2)] = ['--chunk-mib', '--limit'].includes(key) ? Number(value) : value;
  }
  if (!options.help && !options.scan) throw new Error('--scan is required.');
  if (options.limit !== undefined) number(options.limit, 'limit');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseReviewArgs(process.argv.slice(2));
    if (args.help) console.log('Usage: node review-space.mjs --scan <inventory.json> [--decisions <review.json>] [--focus <relative-dir>] [--chunk-mib 1024] [--limit 60] [--json]');
    else {
      const read = async filename => JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
      const result = reviewSpace(await read(args.scan), { ...args, decisions: args.decisions ? await read(args.decisions) : undefined });
      console.log(args.json ? JSON.stringify(result, null, 2) : formatReview(result, args.limit));
      if (result.unmeasured.errorCount) process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
