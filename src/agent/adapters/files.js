'use strict';

// File tools for BRO 2.0.
//
// Every path is resolved against an allowlist of roots: the user's standard
// folders plus any project registered in BRO. A model-supplied path can never
// escape those roots, and destructive work (overwrite, move) is gated by the
// agent policy.

const fs = require('node:fs');
const path = require('node:path');
const tools = require('../../tools');

const MAX_READ_BYTES = 200_000;
const SEARCH_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.next', '.cache', '__pycache__']);

function cleanPath(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}

function expandHome(value) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let text = cleanPath(value);
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(home, text.slice(2));
  text = text.replace(/%USERPROFILE%/gi, home);
  return text;
}

function projectRoots(projects) {
  const roots = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || !project.root) continue;
    try {
      const canonical = fs.realpathSync(project.root);
      if (fs.statSync(canonical).isDirectory()) roots.push({ root: canonical, name: project.name || path.basename(canonical), project: true });
    } catch {
      // A stale project is simply not usable.
    }
  }
  return roots;
}

function allowedRoots(ctx = {}) {
  const roots = [];
  const seen = new Set();
  const push = (root, label) => {
    if (!root || seen.has(root)) return;
    try {
      const canonical = fs.realpathSync(root);
      if (!fs.statSync(canonical).isDirectory()) return;
      seen.add(canonical);
      roots.push({ root: canonical, label });
    } catch { /* ignore missing root */ }
  };
  for (const root of tools.userFileRoots()) push(root, path.basename(root));
  for (const item of projectRoots(ctx.projects)) push(item.root, item.name);
  for (const item of Array.isArray(ctx.extraRoots) ? ctx.extraRoots : []) push(item, path.basename(item));
  return roots;
}

function defaultRoot(roots) {
  const desktop = roots.find((item) => item.label.toLowerCase() === 'desktop');
  return desktop || roots[0] || null;
}

function withinAnyRoot(candidate, roots) {
  return roots.some((item) => tools.isWithinRoot(item.root, candidate));
}

function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }
  return null;
}

// Resolves a requested path and proves it is inside an allowed root.
function resolveSafe(requested, ctx = {}, { allowMissing = false } = {}) {
  const roots = allowedRoots(ctx);
  if (!roots.length) throw new Error('No writable folders are available.');
  let text = expandHome(requested);
  if (!text) text = defaultRoot(roots).root;
  if (!path.isAbsolute(text)) text = path.join(defaultRoot(roots).root, text);
  const absolute = path.resolve(text);

  if (fs.existsSync(absolute)) {
    const canonical = fs.realpathSync(absolute);
    if (!withinAnyRoot(canonical, roots)) throw new Error('That path is outside the folders BRO is allowed to use.');
    return canonical;
  }
  if (!allowMissing) throw new Error('That path does not exist.');
  if (!withinAnyRoot(absolute, roots)) throw new Error('That path is outside the folders BRO is allowed to use.');
  const ancestor = nearestExistingAncestor(path.dirname(absolute));
  if (!ancestor) throw new Error('That path has no existing parent folder.');
  const canonicalAncestor = fs.realpathSync(ancestor);
  if (!withinAnyRoot(canonicalAncestor, roots)) throw new Error('That path is outside the folders BRO is allowed to use.');
  return path.join(canonicalAncestor, path.relative(ancestor, absolute));
}

function safeName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

function ensureParent(target) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  return parent;
}

function statEntry(fullPath) {
  const stat = fs.statSync(fullPath);
  return {
    name: path.basename(fullPath),
    path: fullPath,
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.isFile() ? stat.size : 0,
    modified: stat.mtime.toISOString(),
  };
}

function listDirectory({ path: requested, limit = 200 } = {}, ctx = {}) {
  const target = resolveSafe(requested || '', ctx, { allowMissing: false });
  const stat = fs.statSync(target);
  const directory = stat.isDirectory() ? target : path.dirname(target);
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)))
    .map((entry) => {
      const full = path.join(directory, entry.name);
      try { return statEntry(full); } catch { return { name: entry.name, path: full, type: entry.isDirectory() ? 'directory' : 'file', size: 0, modified: '' }; }
    });
  return { path: directory, entries };
}

function walkFiles(root, { depth = 4, limit = 200, extension = '' } = {}) {
  const results = [];
  const wantedExt = String(extension || '').toLowerCase().replace(/^\./, '');
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && results.length < limit) {
    const { dir, depth: level } = queue.shift();
    if (level > depth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith('.') || SEARCH_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push({ dir: full, depth: level + 1 });
      else if (entry.isFile()) {
        if (wantedExt && path.extname(entry.name).toLowerCase() !== `.${wantedExt}`) continue;
        results.push(full);
      }
    }
  }
  return results;
}

function searchFiles({ query = '', folder = '', extension = '', limit = 20 } = {}, ctx = {}) {
  const wanted = String(query || '').toLowerCase().trim();
  const base = resolveSafe(folder || '', ctx, { allowMissing: false });
  const files = walkFiles(fs.statSync(base).isDirectory() ? base : path.dirname(base), { limit: 400, extension });
  const matches = files
    .filter((file) => !wanted || path.basename(file).toLowerCase().includes(wanted))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((file) => {
      try { return statEntry(file); } catch { return null; }
    })
    .filter(Boolean);
  return { folder: base, query: wanted, matches };
}

function latestFile({ folder = '', extension = '' } = {}, ctx = {}) {
  const base = resolveSafe(folder || '', ctx, { allowMissing: false });
  const files = walkFiles(fs.statSync(base).isDirectory() ? base : path.dirname(base), { limit: 400, extension })
    .map((file) => { try { return statEntry(file); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  return { folder: base, latest: files[0] || null };
}

function createFolder({ name = '', parent = '' } = {}, ctx = {}) {
  const safe = safeName(name);
  if (!safe) throw new Error('Tell me what to name the folder.');
  const base = resolveSafe(parent || '', ctx, { allowMissing: false });
  const target = path.join(base, safe);
  if (!tools.isWithinRoot(base, target) || target === base) throw new Error('That folder name is not allowed.');
  if (fs.existsSync(target)) return { ok: false, message: `“${safe}” already exists in ${base}.` };
  fs.mkdirSync(target, { recursive: false });
  return { created: true, path: target, name: safe };
}

function createFile({ path: requested = '', name = '', content = '' } = {}, ctx = {}) {
  let text = String(content ?? '');
  if (text.length > MAX_READ_BYTES) throw new Error('That file is too large for me to write safely.');
  let target;
  if (name) {
    const base = resolveSafe(requested || '', ctx, { allowMissing: false });
    const safe = safeName(name);
    if (!safe) throw new Error('Tell me what to name the file.');
    target = path.join(base, safe);
  } else {
    target = resolveSafe(requested, ctx, { allowMissing: true });
  }
  if (fs.existsSync(target)) return { ok: false, message: `“${path.basename(target)}” already exists. I can overwrite it if you confirm.` };
  ensureParent(target);
  fs.writeFileSync(target, text, 'utf8');
  const stat = fs.statSync(target);
  return { created: true, path: target, name: path.basename(target), size: stat.size };
}

function writeFile({ path: requested = '', content = '', overwrite = false } = {}, ctx = {}) {
  const target = resolveSafe(requested, ctx, { allowMissing: true });
  if (fs.existsSync(target) && overwrite !== true) return { ok: false, message: `“${path.basename(target)}” already exists. Confirm the overwrite first.` };
  const text = String(content ?? '');
  if (text.length > MAX_READ_BYTES) throw new Error('That file is too large for me to write safely.');
  ensureParent(target);
  fs.writeFileSync(target, text, 'utf8');
  const stat = fs.statSync(target);
  return { written: true, path: target, name: path.basename(target), size: stat.size, overwritten: Boolean(overwrite) };
}

function readFile({ path: requested = '', maxBytes = MAX_READ_BYTES } = {}, ctx = {}) {
  const target = resolveSafe(requested, ctx, { allowMissing: false });
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('That is a folder, not a file.');
  const limit = Math.max(1, Math.min(MAX_READ_BYTES, Number(maxBytes) || MAX_READ_BYTES));
  const buffer = fs.readFileSync(target);
  const slice = buffer.subarray(0, limit);
  if (slice.includes(0)) throw new Error('I will not read a binary file as text.');
  return { path: target, name: path.basename(target), content: slice.toString('utf8'), truncated: buffer.length > limit, size: stat.size };
}

function renameFile({ path: requested = '', newName = '' } = {}, ctx = {}) {
  const target = resolveSafe(requested, ctx, { allowMissing: false });
  const safe = safeName(newName);
  if (!safe) throw new Error('Tell me the new name.');
  const directory = path.dirname(target);
  const hasExtension = path.extname(safe) !== '';
  const finalName = hasExtension ? safe : `${safe}${path.extname(target)}`;
  const destination = path.join(directory, finalName);
  if (!tools.isWithinRoot(directory, destination)) throw new Error('That name is not allowed.');
  if (fs.existsSync(destination)) return { ok: false, message: `“${finalName}” already exists in that folder.` };
  fs.renameSync(target, destination);
  return { renamed: true, from: target, path: destination, name: finalName };
}

function moveFile({ path: requested = '', destination = '' } = {}, ctx = {}) {
  const source = resolveSafe(requested, ctx, { allowMissing: false });
  const folder = resolveSafe(destination, ctx, { allowMissing: false });
  const targetDirectory = fs.statSync(folder).isDirectory() ? folder : path.dirname(folder);
  const target = path.join(targetDirectory, path.basename(source));
  if (fs.existsSync(target)) return { ok: false, message: `“${path.basename(source)}” already exists there.` };
  fs.renameSync(source, target);
  return { moved: true, from: source, path: target };
}

function openFile({ path: requested = '' } = {}, ctx = {}) {
  const target = resolveSafe(requested, ctx, { allowMissing: false });
  const roots = allowedRoots(ctx);
  const owner = roots.find((item) => tools.isWithinRoot(item.root, target));
  if (!owner) throw new Error('That file is outside the folders BRO can open.');
  if (owner.project) tools.openPath(owner.root, target);
  else tools.openUserFile(target);
  return { opened: true, path: target };
}

function fileExists({ path: requested = '' } = {}, ctx = {}) {
  try {
    const target = resolveSafe(requested, ctx, { allowMissing: true });
    return { path: target, exists: fs.existsSync(target), type: fs.existsSync(target) ? (fs.statSync(target).isDirectory() ? 'directory' : 'file') : 'missing' };
  } catch (error) {
    return { path: String(requested || ''), exists: false, type: 'missing', error: error.message };
  }
}

function fileTools() {
  return [
    {
      name: 'list_directory',
      description: 'List the files and folders inside a directory in the user\'s folders or a registered project.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path. Defaults to the Desktop.' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: [],
      },
      handler: listDirectory,
    },
    {
      name: 'search_files',
      description: 'Search for files by name inside a folder, optionally filtered by extension.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          folder: { type: 'string' },
          extension: { type: 'string', maxLength: 20 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['query'],
      },
      handler: searchFiles,
    },
    {
      name: 'latest_file',
      description: 'Find the most recently modified file in a folder, optionally filtered by extension.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string' }, extension: { type: 'string', maxLength: 20 } },
        required: [],
      },
      handler: latestFile,
    },
    {
      name: 'create_folder',
      description: 'Create a folder inside the user\'s folders or a registered project.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', maxLength: 120 }, parent: { type: 'string' } },
        required: ['name'],
      },
      handler: createFolder,
    },
    {
      name: 'create_file',
      description: 'Create a new text or code file and write its content. Fails instead of overwriting.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path or parent folder.' },
          name: { type: 'string', maxLength: 120 },
          content: { type: 'string', maxLength: 200_000 },
        },
        required: [],
      },
      handler: createFile,
    },
    {
      name: 'write_file',
      description: 'Write content to a file. Overwriting requires overwrite=true after the user confirms.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', maxLength: 200_000 },
          overwrite: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
      handler: writeFile,
      confirm: (args) => (args.overwrite === true ? 'That would overwrite an existing file. Confirm the exact target first.' : ''),
    },
    {
      name: 'read_file',
      description: 'Read a text or code file from the user\'s folders or a registered project.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES } },
        required: ['path'],
      },
      handler: readFile,
    },
    {
      name: 'rename_file',
      description: 'Rename a file inside the user\'s folders or a registered project.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, newName: { type: 'string', maxLength: 120 } },
        required: ['path', 'newName'],
      },
      handler: renameFile,
    },
    {
      name: 'move_file',
      description: 'Move a file into another folder. Always requires explicit confirmation.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, destination: { type: 'string' } },
        required: ['path', 'destination'],
      },
      handler: moveFile,
      confirm: () => 'Moving a file changes what is on disk. Confirm the source and destination first.',
    },
    {
      name: 'open_file',
      description: 'Open a file with its associated application.',
      risk: 'launch',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: openFile,
    },
    {
      name: 'file_exists',
      description: 'Check whether a file or folder exists and what type it is.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: fileExists,
    },
  ];
}

module.exports = {
  fileTools,
  resolveSafe,
  allowedRoots,
  listDirectory,
  searchFiles,
  latestFile,
  createFolder,
  createFile,
  writeFile,
  readFile,
  renameFile,
  moveFile,
  openFile,
  fileExists,
  SEARCH_SKIP,
};
