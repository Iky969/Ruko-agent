import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DIST_TESTS_DIR, PROJECT_ROOT, SRC_DIR, listFilesRecursive } from './helpers/platform.js';

/**
 * Zero-dependency contract guard.
 *
 * Constraint (project-wide): Ruko ships with **no external runtime
 * dependencies** — every runtime import must be a `node:*` built-in
 * (`node:url`, `node:path`, `node:fs`, `node:process`, ...) or a relative
 * module inside `src/`.
 *
 * This suite enforces that contract in CI on Linux, Windows and macOS, so a
 * stray `import x from 'some-package'` (or a new entry in `dependencies`)
 * fails the build instead of silently breaking the zero-dep promise.
 */

/**
 * Matches, in one pass:
 *  - static import/export statements with a `from` clause (incl. multi-line)
 *  - bare side-effect imports
 *  - direct calls to the CommonJS/dynamic module loaders
 *
 * The pattern is intentionally written so that its own source text cannot
 * self-match (this file is scanned like any other).
 */
const SPECIFIER_RE =
  /(?:^|[\s;}])(?:import|export)\b[^\n;]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]/gm;

function isBuiltinOrRelative(specifier: string): boolean {
  return specifier.startsWith('node:') || /^\.{1,2}\//.test(specifier);
}

/**
 * Drops comment lines (`//` and JSDoc/asterisk-prefixed lines) so that prose
 * describing the contract — or the pattern above — can never be mistaken for a
 * real runtime import. Trailing inline comments are irrelevant for imports,
 * which always live on their own line in this codebase.
 */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//');
    })
    .join('\n');
}

/** Returns every non-`node:`/non-relative specifier found in `filePath`. */
function findBareSpecifiers(filePath: string): string[] {
  const source = stripCommentLines(readFileSync(filePath, 'utf8'));
  const bare: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier && !isBuiltinOrRelative(specifier)) bare.push(specifier);
  }
  return bare;
}

describe('Zero runtime dependency guard', () => {
  test('package.json declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;

    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
      const value = pkg[field];
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        assert.equal(value.length, 0, `package.json "${field}" must stay empty (zero runtime dependency policy)`);
      } else {
        assert.deepEqual(
          Object.keys(value as Record<string, unknown>),
          [],
          `package.json "${field}" must stay empty (zero runtime dependency policy)`,
        );
      }
    }
  });

  test('package-lock.json root package declares no runtime dependencies', () => {
    const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, Record<string, unknown>>;
    };
    const root = lock.packages?.[''];
    assert.ok(root, 'package-lock.json must contain the root package entry');

    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const value: unknown = root[field];
      if (value === undefined) continue;
      assert.deepEqual(Object.keys(value as Record<string, unknown>), [], `lockfile "${field}" must stay empty`);
    }
  });

  test('every import in src/**/*.ts is a node: built-in or a relative path', () => {
    const sourceFiles = listFilesRecursive(SRC_DIR, (name) => name.endsWith('.ts'));
    assert.ok(sourceFiles.length > 50, `expected the source tree to be scanned, found ${sourceFiles.length} files`);

    const violations: string[] = [];
    for (const file of sourceFiles) {
      for (const specifier of findBareSpecifiers(file)) {
        violations.push(`${file.replace(PROJECT_ROOT, '.')} → ${specifier}`);
      }
    }
    assert.deepEqual(violations, [], 'runtime imports must use node:* built-ins or relative paths only');
  });

  test('compiled dist/**/*.js output imports only node: built-ins and relative paths', () => {
    const distDir = join(PROJECT_ROOT, 'dist');
    assert.ok(existsSync(distDir), 'dist/ must exist — run `npm run build` before the suite');
    assert.ok(existsSync(DIST_TESTS_DIR), 'dist/tests/ must exist — run `npm run build` before the suite');

    const compiledFiles = listFilesRecursive(distDir, (name) => name.endsWith('.js'));
    assert.ok(compiledFiles.length > 50, `expected compiled output, found ${compiledFiles.length} files`);

    const violations: string[] = [];
    for (const file of compiledFiles) {
      for (const specifier of findBareSpecifiers(file)) {
        violations.push(`${file.replace(PROJECT_ROOT, '.')} → ${specifier}`);
      }
    }
    assert.deepEqual(violations, [], 'shipped CLI must not require external packages at runtime');
  });
});
