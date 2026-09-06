import fs from 'node:fs/promises';
import path from 'node:path';

export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new ToolError(code, message, details);
}

export function errorResult(error) {
  return { ok: false, error: { code: error.code ?? 'operation-failed', message: error.message, ...error.details } };
}

export async function statOrNull(filename, io = fs) {
  try { return await io.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readUtf8(filename, io = fs) {
  const bytes = await io.readFile(filename);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('invalid-utf8', 'Text must be valid UTF-8.', { path: filename }); }
}

// The metadata contract uses scalar YAML fields, not arbitrary YAML objects.
export function yamlScalar(text, key) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(new RegExp(`^(\\s*)${key}:\\s*(.*)$`));
    if (!match) continue;
    const value = match[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const body = [];
      for (let next = index + 1; next < lines.length; next++) {
        if (lines[next].trim() && lines[next].search(/\S/) <= match[1].length) break;
        body.push(lines[next].trim());
      }
      return body.join(value[0] === '>' ? ' ' : '\n').trim();
    }
    if (value.startsWith('"')) {
      try { return JSON.parse(value); } catch { return null; }
    }
    if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : null;
    return value.replace(/\s+#.*$/, '').trim();
  }
  return null;
}

export function frontmatter(text, filename) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail('invalid-frontmatter', 'SKILL.md requires YAML frontmatter.', { path: filename });
  if ([...match[1].matchAll(/^name:/gm)].length !== 1 || [...match[1].matchAll(/^description:/gm)].length !== 1) {
    fail('invalid-frontmatter', 'Frontmatter name and description must each occur exactly once at the top level.', { path: filename });
  }
  const name = yamlScalar(match[1], 'name');
  const description = yamlScalar(match[1], 'description');
  if (typeof name !== 'string' || !name || typeof description !== 'string' || !description) {
    fail('invalid-frontmatter', 'Frontmatter requires nonempty scalar name and description.', { path: filename });
  }
  return { name, description };
}

export function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

export function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function loadCatalog(root, io = fs) {
  const filename = path.join(root, 'catalog.json');
  let catalog;
  try { catalog = JSON.parse(await readUtf8(filename, io)); }
  catch (error) {
    if (error instanceof ToolError) throw error;
    fail('invalid-catalog', 'Cannot read valid catalog.json.', { path: filename });
  }
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.skills) || !catalog.skills.length) {
    fail('invalid-catalog', 'Expected schemaVersion 1 and a nonempty skills array.', { path: filename });
  }
  const identities = new Set();
  for (const skill of catalog.skills) {
    if (!skill || !/^[a-z][a-z0-9-]*$/.test(skill.name ?? '') || !Array.isArray(skill.legacyNames)) {
      fail('invalid-catalog', 'Each skill needs a safe name and legacyNames array.', { path: filename });
    }
    for (const name of [skill.name, ...skill.legacyNames]) {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name) || identities.has(name)) {
        fail('invalid-catalog', 'Names and legacy names must be safe and globally unique.', { path: filename });
      }
      identities.add(name);
    }
  }
  return catalog;
}

export async function validateSource(root, io = fs) {
  const rootStat = await io.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('invalid-source', 'Source root must be a real directory.');
  const realRoot = await io.realpath(root);
  const catalog = await loadCatalog(realRoot, io);
  const skillsRoot = path.join(realRoot, 'skills');
  const skillsStat = await io.lstat(skillsRoot);
  if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) fail('invalid-source', 'Source skills must be a real directory.');
  for (const skill of catalog.skills) {
    const directory = path.join(skillsRoot, skill.name);
    const info = await io.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('invalid-source', 'Source skill must be a real directory.', { path: directory });
    const filename = path.join(directory, 'SKILL.md');
    const fileInfo = await io.lstat(filename);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) fail('invalid-source', 'Source SKILL.md must be a regular file.', { path: filename });
    const metadata = frontmatter(await readUtf8(filename, io), filename);
    if (metadata.name !== skill.name) fail('identity-mismatch', 'Source directory and frontmatter name differ.', { path: filename });
  }
  return { root: realRoot, catalog };
}
