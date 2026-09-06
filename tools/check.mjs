import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorResult, fail, isWithin, readUtf8, samePath, validateSource, yamlScalar } from './lib/catalog.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documentExtensions = new Set(['.md', '.yaml', '.yml', '.json', '.txt']);
// Explicit unfinished markers only; prose that discusses TODOs is legitimate.
const placeholder = /\[(?:TODO|TBD|FIXME|PLACEHOLDER)(?::[^\]\n]*)?\]|\{\{(?:TODO|TBD|FIXME|PLACEHOLDER)\}\}|^\s*(?:TODO|TBD|FIXME|PLACEHOLDER)\s*:\s*\S.*$|[【\[](?:待补充|待完善|此处填写)[】\]]/m;

async function filesUnder(directory, io) {
  const files = [];
  for (const entry of await io.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('source-link', 'Skill packages cannot contain symbolic links.', { path: filename });
    if (entry.isDirectory()) files.push(...await filesUnder(filename, io));
    else if (entry.isFile()) files.push(filename);
    else fail('source-special-file', 'Skill packages require regular files and directories.', { path: filename });
  }
  return files;
}

function relativeReferences(text) {
  const plain = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  const references = [];
  for (const match of plain.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)|^\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) {
    references.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  for (const match of plain.matchAll(/`((?:references|scripts|assets|templates)\/[A-Za-z0-9_./-]+)`/g)) references.push(match[1]);
  return [...new Set(references)].filter(value => !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\\|#)/.test(value));
}

async function checkDocument(filename, sourceRoot, statistics, io) {
  const text = await readUtf8(filename, io);
  if (placeholder.test(text)) fail('unfinished-placeholder', 'Document contains an unfinished placeholder marker.', { path: filename });
  if (path.extname(filename).toLowerCase() !== '.md') return;
  for (const reference of relativeReferences(text)) {
    statistics.references++;
    let decoded;
    try { decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]); }
    catch { fail('invalid-reference', 'Reference contains invalid URL encoding.', { path: filename, reference }); }
    if (!decoded) continue;
    const destination = path.resolve(path.dirname(filename), decoded);
    if (!isWithin(destination, sourceRoot)) fail('reference-outside-source', 'Relative reference escapes this repository.', { path: filename, reference });
    try {
      const real = await io.realpath(destination);
      if (!isWithin(real, sourceRoot)) fail('reference-outside-source', 'Relative reference follows a link outside this repository.', { path: filename, reference });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fail('missing-reference', 'Relative reference does not exist.', { path: filename, reference });
    }
  }
}

export async function checkRepository(root = repositoryRoot, io = fs) {
  const errors = [];
  const statistics = { skills: 0, files: 0, documents: 0, references: 0 };
  let source;
  try { source = await validateSource(path.resolve(root), io); }
  catch (error) { return { ok: false, statistics, errors: [errorResult(error).error] }; }
  const record = async action => { try { await action(); } catch (error) { errors.push(errorResult(error).error); } };
  for (const entry of await io.readdir(source.root, { withFileTypes: true })) {
    if (!documentExtensions.has(path.extname(entry.name).toLowerCase()) || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    statistics.files++;
    statistics.documents++;
    const filename = path.join(source.root, entry.name);
    await record(async () => {
      if (entry.isSymbolicLink()) fail('source-link', 'Repository documents cannot be symbolic links.', { path: filename });
      await checkDocument(filename, source.root, statistics, io);
    });
  }
  const skillsRoot = path.join(source.root, 'skills');
  const actual = await io.readdir(skillsRoot, { withFileTypes: true });
  const expected = new Set(source.catalog.skills.map(skill => skill.name));
  for (const entry of actual) {
    if (!expected.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      errors.push({ code: 'uncatalogued-entry', message: 'Source skills directory must match catalog exactly.', path: path.join(skillsRoot, entry.name) });
    }
  }
  for (const skill of source.catalog.skills) {
    statistics.skills++;
    const skillRoot = path.join(skillsRoot, skill.name);
    await record(async () => {
      const yamlPath = path.join(skillRoot, 'agents', 'openai.yaml');
      const yaml = await readUtf8(yamlPath, io);
      if ([...yaml.matchAll(/^\s*default_prompt:/gm)].length !== 1) fail('invalid-ui-metadata', 'UI metadata requires exactly one default_prompt field.', { path: yamlPath });
      const prompt = yamlScalar(yaml, 'default_prompt');
      const names = typeof prompt === 'string' ? [...prompt.matchAll(/\$([A-Za-z0-9_-]+)/g)].map(match => match[1]) : [];
      if (!names.length || names.some(name => name !== skill.name)) fail('prompt-identity-mismatch', 'UI default_prompt must reference its own catalog skill name.', { path: yamlPath });
    });
    await record(async () => {
      const files = await filesUnder(skillRoot, io);
      statistics.files += files.length;
      for (const filename of files) {
        if (!documentExtensions.has(path.extname(filename).toLowerCase())) continue;
        statistics.documents++;
        await record(() => checkDocument(filename, source.root, statistics, io));
      }
    });
  }
  return { ok: errors.length === 0, sourceRoot: source.root, statistics, errors };
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  try {
    if (process.argv.length > 2) fail('invalid-arguments', 'Usage: node tools/check.mjs');
    const result = await checkRepository();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.log(JSON.stringify(errorResult(error), null, 2)); process.exitCode = 1; }
}
