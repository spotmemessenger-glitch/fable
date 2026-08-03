/**
 * Load an OPTIONAL dependency lazily, hidden from the TypeScript module graph
 * and the bundler so it is neither a hard dependency nor a build-time resolve.
 *
 * The `new Function` wrapper keeps the specifier opaque to tsc (no "cannot find
 * module") and preserves a real dynamic `import()` under CommonJS — the same
 * technique `src/main.ts` uses for the Vercel handler bridge. Returns null when
 * the package is not installed, so callers stay no-op instead of crashing.
 */
const dynImport = new Function('m', 'return import(m)') as (
  m: string,
) => Promise<unknown>;

export async function optionalImport<T = unknown>(
  moduleName: string,
): Promise<T | null> {
  try {
    return (await dynImport(moduleName)) as T;
  } catch {
    return null;
  }
}
