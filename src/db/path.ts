import path from "node:path";

/**
 * Resolve the SQLite database file path according to the following priority:
 *  1. `ROADMAP_DB` environment variable (if set)
 *  2. `$XDG_DATA_HOME/roadmap-tool/db.sqlite`  (only when XDG_DATA_HOME is an absolute path)
 *  3. `$HOME/.local/share/roadmap-tool/db.sqlite`
 *
 * Relative values of `XDG_DATA_HOME` are ignored per the XDG Base Directory Specification.
 * @see https://specifications.freedesktop.org/basedir-spec/0.8/
 */
export function resolveDbPath(): string {
  const envDb = process.env.ROADMAP_DB;
  if (envDb) return envDb;

  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome && path.isAbsolute(xdgDataHome)) {
    return path.join(xdgDataHome, "roadmap-tool", "db.sqlite");
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".local", "share", "roadmap-tool", "db.sqlite");
}
