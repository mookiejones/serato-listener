/**
 * Locate and read the Serato DJ Pro library databases.
 *
 * `master.sqlite` is the library Serato displays. On macOS it lives in
 * `~/Library/Application Support/Serato/Library`. On Windows it lives in
 * `%LOCALAPPDATA%\Serato\Library`. `root.sqlite` beside it is the on-disk
 * location database and is updated when a crate write is mirrored.
 *
 * Reads open the file with `node:sqlite` in read-only mode. The first write
 * in a process copies both databases into `Library/Backups`. Writes are
 * refused while Serato DJ Pro holds the lock. The OSC remote connection
 * does not go through this file; the listener passes deck file paths in
 * when it asks for a library payload.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { LibraryError, SeratoOpen, type LibraryLock } from './errors';

const nodeRequire = createRequire(__filename);

/** A row from `node:sqlite`. Values are the SQLite types Node returns. */
export type SqlRow = Record<string, SQLOutputValue>;

/** An open Serato database. Callers close it. */
export type SqlDb = DatabaseSync;

/** The space the page shows when a request does not name one. */
export const LIBRARY_SPACE = 'Serato Library';

/** Spaces this server will read or edit. Other Serato spaces are refused. */
export const ALLOWED_SPACES = ['Serato Library', 'Serato Video', 'Apple Music', 'Prepare'] as const;

/**
 * Serato stores a crate's visible name and a unique suffix in one column,
 * split by this private-use character. `displayName` keeps the text before it.
 */
export const NAME_SPLIT = '\u{105e8a}';

const KEY_VALUES: Record<string, number> = {
  'g#m': 0, abm: 0, '1a': 0,
  ebm: 1, 'd#m': 1, '2a': 1,
  bbm: 2, 'a#m': 2, '3a': 2,
  fm: 3, '4a': 3,
  cm: 4, '5a': 4,
  gm: 5, '6a': 5,
  dm: 6, '7a': 6,
  am: 7, '8a': 7,
  em: 8, '9a': 8,
  bm: 9, '10a': 9,
  'f#m': 10, gbm: 10, '11a': 10,
  'c#m': 11, dbm: 11, '12a': 11,
  b: 12, '1b': 12,
  'f#': 13, gb: 13, '2b': 13,
  'c#': 14, db: 14, '3b': 14,
  'g#': 15, ab: 15, '4b': 15,
  'd#': 16, eb: 16, '5b': 16,
  'a#': 17, bb: 17, '6b': 17,
  f: 18, '7b': 18,
  c: 19, '8b': 19,
  g: 20, '9b': 20,
  d: 21, '10b': 21,
  a: 22, '11b': 22,
  e: 23, '12b': 23,
};

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;
let masterOverride: string | null = null;
const backedUp = new Set<string>();

type ProcessRunner = (command: string, args: string[]) => { status: number | null; stdout: string };
let processRunner: ProcessRunner | null = null;
let processHook: ((pid: number) => boolean) | null = null;

interface CacheBucket {
  stamp: string | null;
  libraries: Map<string, CachedLibrary>;
}

const cache: CacheBucket = { stamp: null, libraries: new Map() };

/** One track row the library page lists. */
export interface LibraryTrack {
  id: number;
  name: string;
  artist: string;
  album: string;
  genre: string;
  bpm: number | null;
  key: string;
  length_ms: number | null;
  color: number | null;
  missing: boolean;
  format: string;
  file: string;
  file_size: number | null;
  time_added: number | null;
  rating: number | null;
  emoji: string;
  beatgrid_locked: boolean;
  play_count: number | null;
  stems: boolean;
  bitrate: number | null;
  portable_id: string | null;
  resolved_path: string | null;
  on_disk: boolean | null;
}

/** One crate, including the asset ids it contains. The space root is omitted. */
export interface LibraryCrate {
  id: number;
  parent: number | null;
  name: string;
  smart: boolean;
  order: number | null;
  color: number | null;
  expanded: boolean;
  added: number | null;
  tracks: number[];
  rules?: unknown;
  filename: string | null;
}

/** A deck the live OSC stream is playing, before it is matched to a library row. */
export interface PlayingDeckInput {
  deck: number;
  filepath?: string | null;
  title?: string | null;
  artist?: string | null;
}

/** A deck plus the library track id its file path resolved to, when one did. */
export interface PlayingDeckLink {
  deck: number;
  filepath: string | null;
  title: string;
  artist: string;
  track_id: number | null;
}

/** Tracks, crates, lock status, and the decks currently linked to a library row. */
export interface LibraryPayload {
  source: string;
  space: string;
  spaces: string[];
  track_count: number;
  root_id: number | null;
  tracks: LibraryTrack[];
  crates: LibraryCrate[];
  serato: LibraryLock;
  writable: boolean;
  decks: PlayingDeckLink[];
}

interface CachedLibrary {
  source: string;
  space: string;
  spaces: string[];
  track_count: number;
  root_id: number | null;
  tracks: LibraryTrack[];
  crates: LibraryCrate[];
}

/** The drive and external id Serato stored for one asset. */
export interface AssetLocation {
  id: number;
  locationId: number | null;
  externalId: number | null;
  portableId: string | null;
  fileName: string | null;
}

/** One container row joined to its space name. */
export interface ContainerRecord {
  id: number;
  parentId: number | null;
  name: string;
  type: number;
  spaceId: number;
  spaceName: string;
}

/**
 * Returns the Serato master database for an operating system.
 * Windows uses `%LOCALAPPDATA%\Serato\Library`. macOS and other hosts use
 * `~/Library/Application Support/Serato/Library`. The file is not opened.
 *
 * @param options.platform `win32` selects the Windows path. Anything else selects Application Support.
 * @param options.home Home directory used when the platform default is missing.
 * @param options.localAppData Windows local app data. `null` forces the home fallback.
 * @returns The path of `master.sqlite`.
 *
 * Side effects: none.
 */
export function defaultLibraryPath(options?: {
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string | null;
}): string {
  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? os.homedir();
  if (platform === 'win32') {
    const local = options && 'localAppData' in options ? options.localAppData : process.env.LOCALAPPDATA;
    const base = local || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, 'Serato', 'Library', 'master.sqlite');
  }
  return path.join(home, 'Library', 'Application Support', 'Serato', 'Library', 'master.sqlite');
}

/**
 * Returns the on-disk location database that sits beside `master.sqlite`.
 * Windows uses the same `%LOCALAPPDATA%\Serato\Library` directory as the
 * master file. macOS and other hosts use Application Support. The file is
 * not opened here; crate writes look it up again through the `connection` table.
 *
 * @param options The same platform and home overrides as `defaultLibraryPath`.
 * @returns The path of `root.sqlite`.
 *
 * Side effects: none.
 */
export function defaultRootPath(options?: {
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string | null;
}): string {
  const master = defaultLibraryPath(options);
  const platform = options?.platform ?? process.platform;
  if (platform === 'win32') return path.win32.join(path.win32.dirname(master), 'root.sqlite');
  return path.join(path.dirname(master), 'root.sqlite');
}

/**
 * Returns the name of the host file manager.
 *
 * @param platform Operating system name. Defaults to this process.
 * @returns `Finder` on macOS, `File Explorer` on Windows, and `file manager` elsewhere.
 *
 * Side effects: none.
 */
export function fileManagerName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'File Explorer';
  if (platform === 'darwin') return 'Finder';
  return 'file manager';
}

/**
 * Returns the master database this process reads and writes.
 * `SERATO_LIBRARY_PATH` overrides the platform default. Tests use
 * `setMasterPathForTests`, which wins over the environment variable.
 *
 * @returns The master database path. The file may not exist.
 *
 * Side effects: none.
 */
export function masterPath(): string {
  if (masterOverride) return masterOverride;
  const fromEnv = process.env.SERATO_LIBRARY_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return defaultLibraryPath();
}

/**
 * Returns `root.sqlite` beside the master database this process is using.
 * `setMasterPathForTests` and `SERATO_LIBRARY_PATH` move this path with the
 * master file. The file may not exist. Crate mirroring still prefers the
 * path stored in the `connection` table.
 *
 * @returns The location database path.
 *
 * Side effects: none.
 */
export function rootPath(): string {
  return path.join(path.dirname(path.resolve(masterPath())), 'root.sqlite');
}

/**
 * Points the library at a throwaway database for one test.
 * Pass null to follow `SERATO_LIBRARY_PATH` or the platform default again.
 * The cache is dropped so the next read cannot serve the previous file.
 *
 * @param next Database path, or null to clear the override.
 *
 * Side effects: changes the process-wide master path and drops the library cache.
 */
export function setMasterPathForTests(next: string | null): void {
  masterOverride = next;
  invalidateLibraryCache();
}

/**
 * Forgets which databases this process has already backed up.
 *
 * Side effects: clears the in-memory backup-once set.
 */
export function clearBackupsForTests(): void {
  backedUp.clear();
}

/**
 * Replaces the Serato process check for one test.
 * Pass null to ask `ps` or `tasklist` again.
 *
 * @param fn Predicate of a process id, or null.
 *
 * Side effects: changes the process check used by the next lock read.
 */
export function setProcessIsSeratoForTests(fn: ((pid: number) => boolean) | null): void {
  processHook = fn;
}

/**
 * Replaces the command runner used to ask whether a pid is Serato.
 * Pass null to spawn the real command again.
 *
 * @param fn Runner, or null.
 *
 * Side effects: changes how the next process check spawns.
 */
export function setProcessRunnerForTests(fn: ProcessRunner | null): void {
  processRunner = fn;
}

/**
 * Drops the cached library payloads.
 * The next `loadLibrary` reads `master.sqlite` again.
 *
 * Side effects: clears the in-memory cache.
 */
export function invalidateLibraryCache(): void {
  cache.stamp = null;
  cache.libraries.clear();
}

/**
 * Returns the argv used to ask whether a process id is Serato.
 * macOS and Linux use `ps`. Windows uses `tasklist`. Nothing is spawned.
 *
 * @param pid Process id from the lock table.
 * @param platform Operating system that would run the command.
 * @returns The command and its arguments.
 *
 * Side effects: none.
 */
export function seratoProcessCommand(pid: number, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'tasklist', args: ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'] };
  }
  return { command: 'ps', args: ['-p', String(pid), '-o', 'comm='] };
}

/**
 * Loads `node:sqlite` the first time a database is opened.
 * The require stays inside this function so a Node build without the module
 * can still start the OSC listener. A library route then returns an error.
 *
 * @returns The `node:sqlite` exports.
 *
 * Side effects: loads the built-in module once.
 */
function sqlite(): SqliteModule {
  if (!sqliteModule) {
    try {
      sqliteModule = nodeRequire('node:sqlite') as SqliteModule;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new LibraryError(`This Node build cannot open SQLite databases (${detail}).`, 500);
    }
  }
  return sqliteModule;
}

/**
 * Opens a Serato database.
 * Read-only connections also set `query_only`. Write connections wait up to
 * one second for a lock and leave foreign keys off, which is how Serato writes.
 *
 * @param file Database path.
 * @param readOnly True to refuse writes at the SQLite layer.
 * @returns An open connection. The caller closes it.
 *
 * Side effects: opens a file handle.
 */
function openDatabase(file: string, readOnly: boolean): SqlDb {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, {
    readOnly,
    timeout: readOnly ? 0 : 1000,
    enableForeignKeyConstraints: false,
    readBigInts: false,
  });
  if (readOnly) db.exec('PRAGMA query_only=ON');
  return db;
}

/**
 * Opens the master database for a read, or throws when the file is missing.
 *
 * @param file Database path. Defaults to the current master.
 * @returns A read-only connection.
 *
 * Side effects: opens a file handle.
 */
export function openRead(file: string = masterPath()): SqlDb {
  if (!fs.existsSync(file)) throw new LibraryError(`Serato library not found at ${file}`, 404);
  return openDatabase(file, true);
}

/**
 * Opens a database for a write. The caller starts the transaction.
 *
 * @param file Database path.
 * @returns A writable connection with Serato's comparison functions installed.
 *
 * Side effects: opens a file handle.
 */
export function openWrite(file: string): SqlDb {
  const db = openDatabase(file, false);
  register(db);
  return db;
}

/**
 * Runs one statement and returns the first row.
 *
 * @param db Open connection.
 * @param sql SQL with `?` placeholders.
 * @param params Bound values.
 * @returns The row, or undefined when the query matched nothing.
 *
 * Side effects: reads or writes through `db`, depending on the SQL.
 */
export function sqlGet(db: SqlDb, sql: string, params: SQLInputValue[] = []): SqlRow | undefined {
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

/**
 * Runs one statement and returns every row.
 *
 * @param db Open connection.
 * @param sql SQL with `?` placeholders.
 * @param params Bound values.
 * @returns The rows, in query order. Empty when nothing matched.
 *
 * Side effects: reads or writes through `db`, depending on the SQL.
 */
export function sqlAll(db: SqlDb, sql: string, params: SQLInputValue[] = []): SqlRow[] {
  return db.prepare(sql).all(...params) as unknown as SqlRow[];
}

/**
 * Runs one statement that does not return rows.
 *
 * @param db Open connection.
 * @param sql SQL with `?` placeholders.
 * @param params Bound values.
 * @returns The last inserted row id and the number of changed rows.
 *
 * Side effects: writes through `db` when the SQL is a write.
 */
export function sqlRun(db: SqlDb, sql: string, params: SQLInputValue[] = []): { lastInsertRowid: number; changes: number } {
  const result = db.prepare(sql).run(...params);
  return { lastInsertRowid: Number(result.lastInsertRowid), changes: Number(result.changes) };
}

/**
 * Quotes a table or column name that this process built.
 * Names that are not plain identifiers are rejected so a payload cannot
 * change the SQL.
 *
 * @param name Table or column name.
 * @returns The name in double quotes.
 *
 * Side effects: none.
 */
export function sqlIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new LibraryError('That field cannot be edited.');
  return `"${name}"`;
}

/**
 * Converts a JSON or SQLite number the way Python `int()` does for this library.
 * Booleans become 0 or 1. Fractional numbers are truncated toward zero.
 *
 * @param value A number or integer text.
 * @returns The integer.
 *
 * Side effects: none.
 */
export function asInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  throw new LibraryError('That id is not a number.');
}

/**
 * Returns a SQLite value as a number, or null when it is empty.
 *
 * @param value A cell value.
 * @returns The number, or null.
 *
 * Side effects: none.
 */
export function asNumber(value: SQLOutputValue | unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Returns a text cell, using an empty string when it is null.
 *
 * @param value A cell value.
 * @returns The text.
 *
 * Side effects: none.
 */
export function asText(value: SQLOutputValue | unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Returns whether a SQLite flag is set.
 * Null and 0 are false. Any other number is true.
 *
 * @param value A cell value.
 * @returns The flag.
 *
 * Side effects: none.
 */
export function asFlag(value: SQLOutputValue | unknown): boolean {
  return Boolean(asNumber(value));
}

/**
 * Returns the visible portion of a stored crate name.
 *
 * @param name Name stored in `container.name`.
 * @returns Text before the Serato name separator.
 *
 * Side effects: none.
 */
export function displayName(name: string): string {
  const index = name.indexOf(NAME_SPLIT);
  return index < 0 ? name : name.slice(0, index);
}

/**
 * Normalizes text the way Serato smart crates compare strings.
 *
 * @param value A field value from SQLite.
 * @returns The lowercased text, or null when value is null.
 *
 * Side effects: none.
 */
function seratoStrNorm(value: SQLOutputValue): string | null {
  if (value == null) return null;
  return String(value).toLowerCase();
}

/**
 * Maps a key name to Serato's integer key type.
 *
 * @param value A Camelot or traditional key, or null.
 * @returns The integer key, or -1 when the name is empty or unknown.
 *
 * Side effects: none.
 */
function seratoKeyType(value: SQLOutputValue): number {
  if (value == null) return -1;
  const text = String(value).trim().toLowerCase();
  if (!text) return -1;
  return KEY_VALUES[text] ?? -1;
}

/**
 * Installs Serato comparison functions on a SQLite connection.
 *
 * @param db Connection that may run smart-crate SQL.
 *
 * Side effects: registers two deterministic functions on `db`.
 */
export function register(db: SqlDb): void {
  db.function('serato_str_norm', { deterministic: true }, seratoStrNorm);
  db.function('serato_raw_key_string_to_key_type', { deterministic: true }, seratoKeyType);
}

/**
 * Returns whether a thrown value is a SQLite error.
 *
 * @param err A thrown value.
 * @returns True when Node reported `ERR_SQLITE_ERROR`.
 *
 * Side effects: none.
 */
function isSqliteError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR';
}

/**
 * Returns whether a SQLite error is a lock.
 *
 * @param err A thrown value.
 * @returns True when the message says the database is locked.
 *
 * Side effects: none.
 */
function isLocked(err: unknown): boolean {
  return isSqliteError(err) && /locked/i.test((err as Error).message);
}

/**
 * Returns whether a process id is a live Serato process.
 * A test hook replaces the check. Otherwise the command from
 * `seratoProcessCommand` is run and its output is searched for `serato`.
 *
 * @param pid Process id from the lock table.
 * @param platform Operating system that chooses `ps` or `tasklist`.
 * @returns True when the process image name contains `serato`.
 *
 * Side effects: may spawn `ps` or `tasklist`.
 */
export function processIsSerato(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!pid || pid <= 0) return false;
  if (processHook) return processHook(pid);
  const command = seratoProcessCommand(pid, platform);
  const run = processRunner ?? defaultProcessRunner;
  let result: { status: number | null; stdout: string };
  try {
    result = run(command.command, command.args);
  } catch {
    return false;
  }
  if (result.status !== 0) return false;
  return result.stdout.toLowerCase().includes('serato');
}

/**
 * Spawns a process check and captures its text.
 *
 * @param command Program name.
 * @param args Arguments.
 * @returns The exit status and stdout. A spawn failure has a null status.
 *
 * Side effects: spawns a process with a two-second timeout.
 */
function defaultProcessRunner(command: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2000 });
  if (result.error) return { status: null, stdout: '' };
  return { status: result.status, stdout: result.stdout || '' };
}

/**
 * Reads the lock table and decides whether edits are allowed.
 * A row counts as open only when the process image contains `serato`.
 * A missing lock table is an unlocked library.
 *
 * @param db Open database connection.
 * @returns Lock fields without the file-manager name.
 *
 * Side effects: reads the lock table. May spawn a process check.
 */
function statusRows(db: SqlDb): Omit<LibraryLock, 'file_manager'> {
  let found: SqlRow[] = [];
  try {
    found = sqlAll(db, 'SELECT owner_process_id, owner_process_name FROM lock');
  } catch (err) {
    if (!(isSqliteError(err) && /no such table/i.test((err as Error).message))) throw err;
  }
  for (const row of found) {
    const pid = Number(asNumber(row.owner_process_id) ?? 0);
    const name = asText(row.owner_process_name) || 'Serato DJ Pro';
    if (processIsSerato(pid)) {
      return {
        open: true,
        writable: false,
        pid,
        process: name,
        message: `${name} is open. Edits stay off until it quits.`,
      };
    }
  }
  return {
    open: false,
    writable: true,
    pid: null,
    process: null,
    message: 'Serato is quit. Edits save to the library.',
  };
}

/**
 * Reports whether Serato has the library open.
 * A locked database is reported as open even when the lock table cannot be read.
 *
 * @param file Database path. Defaults to the current master.
 * @returns Lock status, including the host file-manager name.
 *
 * Side effects: opens and closes a read-only connection. May spawn a process check.
 */
export function libraryStatus(file: string = masterPath()): LibraryLock {
  if (!fs.existsSync(file)) throw new LibraryError(`Serato library not found at ${file}`, 404);
  let info: Omit<LibraryLock, 'file_manager'>;
  const db = openDatabase(file, true);
  try {
    try {
      info = statusRows(db);
    } catch (err) {
      if (!isLocked(err)) throw err;
      info = {
        open: true,
        writable: false,
        pid: null,
        process: 'Serato DJ Pro',
        message: 'Serato DJ Pro has the library open. Edits stay off until it quits.',
      };
    }
  } finally {
    db.close();
  }
  return { ...info, file_manager: fileManagerName() };
}

/**
 * Returns the column names of one table.
 *
 * @param db Open connection.
 * @param table Table name.
 * @returns Column names from `PRAGMA table_info`.
 *
 * Side effects: none beyond the read.
 */
export function columns(db: SqlDb, table: string): Set<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new LibraryError('That field cannot be edited.');
  const rows = sqlAll(db, `PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => asText(row.name)));
}

/**
 * Returns the table names in a database.
 *
 * @param db Open connection.
 * @returns Names from `sqlite_master`.
 *
 * Side effects: none beyond the read.
 */
export function tables(db: SqlDb): Set<string> {
  return new Set(sqlAll(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => asText(row.name)));
}

/**
 * Turns a connection URI into a filesystem path.
 *
 * @param value A file URI, a plain path, or null.
 * @returns The path, or null when value is empty or the URI cannot be read.
 *
 * Side effects: none.
 */
export function parseDbPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Returns whether a location database may be updated.
 * The live master may mirror any connected location file. A relocated test
 * database may mirror only a file beside itself, or a file under the temp directory.
 *
 * @param file Location database path.
 * @returns True when a write to `file` is allowed.
 *
 * Side effects: none.
 */
export function mirrorAllowed(file: string): boolean {
  const master = path.resolve(masterPath());
  const live = path.resolve(defaultLibraryPath());
  if (master === live) return true;
  const resolved = path.resolve(file);
  if (path.dirname(resolved) === path.dirname(master)) return true;
  const temp = path.resolve(os.tmpdir());
  return resolved === temp || resolved.startsWith(`${temp}${path.sep}`) || resolved.startsWith('/tmp/');
}

/**
 * Maps location ids to database files that exist on disk.
 * Location 3 falls back to `root.sqlite` beside the master file.
 *
 * @param db Open master connection.
 * @returns Location id to database path.
 *
 * Side effects: none beyond the read and existence checks.
 */
export function locationPaths(db: SqlDb): Map<number, string> {
  const found = new Map<number, string>();
  let rows: SqlRow[] = [];
  try {
    rows = sqlAll(db, 'SELECT location_id, database_uri FROM connection');
  } catch (err) {
    if (!isSqliteError(err)) throw err;
  }
  for (const row of rows) {
    const locationFile = parseDbPath(asText(row.database_uri) || null);
    const id = asNumber(row.location_id);
    if (locationFile && id != null && fs.existsSync(locationFile) && fs.statSync(locationFile).isFile()) {
      found.set(id, locationFile);
    }
  }
  if (!found.has(3)) {
    const candidate = path.join(path.dirname(path.resolve(masterPath())), 'root.sqlite');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) found.set(3, candidate);
  }
  return found;
}

/**
 * Copies one SQLite database with the backup API.
 *
 * @param source Database to read.
 * @param dest New database file. Parent directories must already exist.
 *
 * Side effects: writes `dest` and opens `source` read-only.
 */
async function backupDatabase(source: string, dest: string): Promise<void> {
  const { backup } = sqlite();
  const db = openDatabase(source, true);
  try {
    await backup(db, dest);
  } finally {
    db.close();
  }
}

/**
 * Copies the master database once per process before the first write.
 * The copy lives in `Library/Backups/serato-web-<timestamp>/` beside `master.sqlite`.
 * `root.sqlite` is copied when it sits beside the master and mirroring it is allowed.
 *
 * @returns The new backup directory, or null when this process already backed up that path.
 *
 * Side effects: creates the backup directory and copies the database files.
 */
export async function ensureBackup(): Promise<string | null> {
  const master = path.resolve(masterPath());
  if (backedUp.has(master)) return null;
  const stamp = backupStamp(new Date());
  const folder = path.join(path.dirname(master), 'Backups', `serato-web-${stamp}`);
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  try {
    fs.mkdirSync(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LibraryError('A backup for this second already exists. Try the edit again.', 409);
    }
    throw err;
  }
  await backupDatabase(master, path.join(folder, 'master.sqlite'));
  const root = path.join(path.dirname(master), 'root.sqlite');
  if (fs.existsSync(root) && fs.statSync(root).isFile() && mirrorAllowed(root)) {
    await backupDatabase(root, path.join(folder, 'root.sqlite'));
  }
  backedUp.add(master);
  return folder;
}

/**
 * Formats a backup folder timestamp in local time.
 *
 * @param when The moment the backup is made.
 * @returns `YYYYMMDD-HHMMSS`.
 *
 * Side effects: none.
 */
function backupStamp(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
}

/**
 * Opens a write transaction after Serato has quit.
 * The first call in a process also copies the databases into `Library/Backups`.
 *
 * @returns A connection inside `BEGIN IMMEDIATE`. The caller commits and closes it.
 *
 * Side effects: may copy the databases, then holds a write lock on the master.
 */
export async function beginWrite(): Promise<SqlDb> {
  const info = libraryStatus();
  if (info.open) throw new SeratoOpen(info);
  await ensureBackup();
  const db = openWrite(masterPath());
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    db.close();
    if (isLocked(err)) throw new SeratoOpen(libraryStatus());
    throw err;
  }
  if (statusRows(db).open) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone. The connection is closed next.
    }
    db.close();
    throw new SeratoOpen(libraryStatus());
  }
  return db;
}

/**
 * Returns an allowed Serato space name.
 *
 * @param space Requested space. Null selects Serato Library.
 * @returns The space name to query.
 *
 * Side effects: none.
 */
export function requireSpace(space: string | null | undefined): string {
  const chosen = space || LIBRARY_SPACE;
  if (!(ALLOWED_SPACES as readonly string[]).includes(chosen)) {
    throw new LibraryError('That space is not available here.');
  }
  return chosen;
}

/**
 * Returns the id of an allowed space.
 *
 * @param db Open connection.
 * @param space Space name.
 * @returns The space id.
 *
 * Side effects: none beyond the read.
 */
export function spaceId(db: SqlDb, space: string): number {
  if (!(ALLOWED_SPACES as readonly string[]).includes(space)) {
    throw new LibraryError('That space is not available here.');
  }
  const row = sqlGet(db, 'SELECT id FROM space WHERE name = ?', [space]);
  if (!row) throw new LibraryError(`${space} is not in this library.`, 404);
  return Number(row.id);
}

/**
 * Returns the root container id for a space.
 *
 * @param db Open connection.
 * @param space Space name.
 * @returns The container whose type is 0.
 *
 * Side effects: none beyond the read.
 */
export function spaceRoot(db: SqlDb, space: string): number {
  const row = sqlGet(
    db,
    `SELECT c.id FROM container c
     JOIN space s ON s.id = c.space_id
     WHERE s.name = ? AND c.type = 0`,
    [space],
  );
  if (!row) throw new LibraryError(`${space} has no root crate.`, 404);
  return Number(row.id);
}

/**
 * Loads one crate that belongs to a space.
 *
 * @param db Open connection.
 * @param crateId Container id.
 * @param space Space name.
 * @returns The container row.
 *
 * Side effects: none beyond the read.
 */
export function containerById(db: SqlDb, crateId: number, space: string): ContainerRecord {
  const row = sqlGet(
    db,
    `SELECT c.id, c.parent_id, c.name, c.type, c.space_id, s.name AS space_name
     FROM container c
     JOIN space s ON s.id = c.space_id
     WHERE c.id = ? AND s.name = ?`,
    [crateId, space],
  );
  if (!row) throw new LibraryError('That crate is not in this space.', 404);
  return {
    id: Number(row.id),
    parentId: asNumber(row.parent_id),
    name: asText(row.name),
    type: Number(row.type),
    spaceId: Number(row.space_id),
    spaceName: asText(row.space_name),
  };
}

/**
 * Loads the location columns for one asset.
 *
 * @param db Open connection.
 * @param assetId Asset id.
 * @returns The location columns.
 *
 * Side effects: none beyond the read.
 */
export function assetLocation(db: SqlDb, assetId: number): AssetLocation {
  const row = sqlGet(
    db,
    'SELECT id, location_id, external_id, portable_id, file_name FROM asset WHERE id = ?',
    [assetId],
  );
  if (!row) throw new LibraryError('That track is not in the library.', 404);
  return {
    id: Number(row.id),
    locationId: asNumber(row.location_id),
    externalId: asNumber(row.external_id),
    portableId: row.portable_id == null ? null : asText(row.portable_id),
    fileName: row.file_name == null ? null : asText(row.file_name),
  };
}

/**
 * Advances the `serato.revision` counter when that column exists.
 *
 * @param db Open write connection.
 * @returns The new revision, or the current time when the column is absent.
 *
 * Side effects: updates `serato.revision` when the column exists.
 */
export function nextRevision(db: SqlDb): number {
  if (!columns(db, 'serato').has('revision')) return Math.floor(Date.now() / 1000);
  sqlRun(db, 'UPDATE serato SET revision = COALESCE(revision, 0) + 1');
  const row = sqlGet(db, 'SELECT revision FROM serato');
  if (!row) return Math.floor(Date.now() / 1000);
  return Number(row.revision);
}

/**
 * Updates columns that exist on a table.
 * Unknown columns are skipped so a payload can name a field an older library lacks.
 *
 * @param db Open write connection.
 * @param table Table name.
 * @param values Column names and values. Undefined values are skipped.
 * @param where SQL predicate with one bound parameter.
 * @param key Value for that parameter.
 *
 * Side effects: updates matching rows.
 */
export function assign(
  db: SqlDb,
  table: string,
  values: Record<string, SQLInputValue | undefined>,
  where: string,
  key: SQLInputValue,
): void {
  const present = columns(db, table);
  const pairs = Object.entries(values).filter((entry): entry is [string, SQLInputValue] => {
    return present.has(entry[0]) && entry[1] !== undefined;
  });
  if (!pairs.length) return;
  const sql = `UPDATE ${sqlIdent(table)} SET ${pairs.map(([name]) => `${sqlIdent(name)} = ?`).join(', ')} WHERE ${where}`;
  sqlRun(db, sql, [...pairs.map(([, value]) => value), key]);
}

/**
 * Runs a write against a location database and returns a warning on failure.
 * A missing file, or a path the mirror rules refuse, does not throw.
 *
 * @param file Location database path.
 * @param fn Callback that receives the location connection and returns a warning or null.
 * @returns Null on success, or a warning when the mirror is skipped or the location database raises.
 *
 * Side effects: may write `file` inside `BEGIN IMMEDIATE`.
 */
export async function withLocation(
  file: string,
  fn: (db: SqlDb) => string | null,
): Promise<string | null> {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !mirrorAllowed(file)) {
    return "Saved in the main library. That track's drive is not connected, so Serato may reconcile the edit when the drive returns.";
  }
  const db = openWrite(file);
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    const warning = fn(db);
    db.exec('COMMIT');
    return warning;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The location transaction did not start, or it is already closed.
    }
    if (isSqliteError(err) || (err instanceof Error && 'code' in err)) {
      return `Saved in the main library. The location database was not updated (${(err as Error).message}).`;
    }
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Resolves a Serato `portable_id` to a local path.
 * Relative ids are tried under the home directory, then at the filesystem root.
 * An absolute id is used as Serato stored it.
 *
 * @param portableId An absolute path, a path under the home directory, or null.
 * @returns The candidate path and whether that path exists.
 *
 * Side effects: checks whether candidate paths exist.
 */
export function resolvePortable(portableId: string | null | undefined): { path: string | null; onDisk: boolean | null } {
  if (portableId == null || portableId === '') return { path: null, onDisk: null };
  const candidates = path.isAbsolute(portableId)
    ? [portableId]
    : [path.join(os.homedir(), portableId), path.join(path.parse(os.homedir()).root, portableId)];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate, onDisk: true };
    } catch {
      // A path the process cannot stat is tried as the next candidate.
    }
  }
  return { path: candidates[0], onDisk: false };
}

/**
 * Returns the cache key for the master database and its WAL file.
 * A missing file contributes 0. A change to either mtime drops the cache.
 *
 * @param file Master database path.
 * @returns Nanosecond mtimes of the database and of `file-wal`, joined.
 *
 * Side effects: stats the two paths.
 */
function dbStamp(file: string): string {
  /**
   * Returns one file's mtime in nanoseconds, or 0 when the file is missing.
   *
   * @param candidate File to stat.
   * @returns The nanosecond mtime as text.
   *
   * Side effects: stats `candidate`.
   */
  const stamp = (candidate: string): string => {
    try {
      return fs.statSync(candidate, { bigint: true }).mtimeNs.toString();
    } catch {
      return '0';
    }
  };
  return `${stamp(file)}:${stamp(`${file}-wal`)}`;
}

/**
 * Loads the track list and crate tree for one space.
 * The track and crate lists are cached until `master.sqlite` or its `-wal`
 * file changes mtime. Lock status and the live deck links are read every call.
 *
 * @param space Space name. Null selects Serato Library.
 * @param decks Decks from the live OSC stream. Their file paths are matched to library rows.
 * @returns Tracks, crates, counts, lock status, and deck links.
 *
 * Side effects: opens and closes the master database when the cache misses. May spawn a process check.
 */
export function loadLibrary(space?: string | null, decks: PlayingDeckInput[] = []): LibraryPayload {
  const chosen = requireSpace(space);
  const cached = cachedLibrary(chosen);
  const serato = libraryStatus();
  return {
    ...cached,
    serato,
    writable: serato.writable,
    decks: decks.map((deck) => ({
      deck: deck.deck,
      filepath: deck.filepath ?? null,
      title: deck.title ?? '',
      artist: deck.artist ?? '',
      track_id: deck.filepath ? trackIdForFile(cached.tracks, deck.filepath) : null,
    })),
  };
}

/**
 * Returns the cached payload for one space, querying when the stamp changed.
 *
 * @param space An allowed space name.
 * @returns Tracks and crates for that space.
 *
 * Side effects: may read the master database and replace the cache.
 */
function cachedLibrary(space: string): CachedLibrary {
  const file = masterPath();
  const stamp = dbStamp(file);
  if (cache.stamp !== stamp) {
    cache.stamp = stamp;
    cache.libraries.clear();
  }
  const hit = cache.libraries.get(space);
  if (hit) return hit;
  const payload = queryLibrary(file, space);
  cache.libraries.set(space, payload);
  return payload;
}

/**
 * Queries tracks, crates, membership, and smart-crate rules for one space.
 *
 * @param file Master database path.
 * @param space An allowed space name.
 * @returns The payload stored in the cache. The space root crate is omitted.
 *
 * Side effects: opens and closes a read-only connection.
 */
function queryLibrary(file: string, space: string): CachedLibrary {
  const db = openRead(file);
  try {
    const tracks = sqlAll(
      db,
      `SELECT a.id, a.name, a.artist, a.album, a.genre, a.bpm, a.key,
              a.length_ms, a.color, a.is_missing, a.format, a.file_name,
              a.file_size, a.time_added, a.rating, a.emoji,
              a.is_beatgrid_locked, a.dj_play_count, a.stems_analyze_state,
              a.file_bit_rate, a.portable_id
       FROM asset a
       JOIN space_asset sa ON sa.asset_id = a.id
       JOIN space s ON s.id = sa.space_id
       WHERE s.name = ?
       ORDER BY a.name COLLATE NOCASE, a.artist COLLATE NOCASE, a.id`,
      [space],
    ).map(trackFromRow);

    const crates: LibraryCrate[] = [];
    let rootId: number | null = null;
    for (const row of sqlAll(
      db,
      `SELECT c.id, c.parent_id, c.name, c.type, c.list_order,
              c.color, c.expanded, c.time_added, m.filename
       FROM container c
       JOIN space s ON s.id = c.space_id
       LEFT JOIN dj_container_metadata m ON m.container_id = c.id
       WHERE s.name = ?
       ORDER BY c.list_order, c.id`,
      [space],
    )) {
      if (Number(row.type) === 0) rootId = Number(row.id);
      crates.push({
        id: Number(row.id),
        parent: asNumber(row.parent_id),
        name: displayName(asText(row.name)),
        smart: Number(row.type) === 2,
        order: asNumber(row.list_order),
        color: asNumber(row.color),
        expanded: asFlag(row.expanded),
        added: asNumber(row.time_added),
        tracks: [],
        filename: row.filename == null ? null : asText(row.filename),
      });
    }

    const byId = new Map(crates.map((crate) => [crate.id, crate]));
    for (const row of sqlAll(
      db,
      `SELECT lc.container_id AS crate_id, ca.asset_id
       FROM container_asset ca
       JOIN location_container lc ON lc.id = ca.location_container_id
       JOIN container c ON c.id = lc.container_id
       JOIN space s ON s.id = c.space_id
       WHERE s.name = ?
       ORDER BY lc.container_id, ca.list_order, ca.id`,
      [space],
    )) {
      const crate = byId.get(Number(row.crate_id));
      const assetId = asNumber(row.asset_id);
      if (crate && assetId != null) crate.tracks.push(assetId);
    }

    const rules = new Map<number, unknown>();
    for (const row of sqlAll(
      db,
      `SELECT r.container_id, r.rules
       FROM smart_crate_rules r
       JOIN container c ON c.id = r.container_id
       JOIN space s ON s.id = c.space_id
       WHERE s.name = ?`,
      [space],
    )) {
      const blob = row.rules;
      const id = Number(row.container_id);
      if (typeof blob === 'string') {
        try {
          rules.set(id, JSON.parse(blob) as unknown);
        } catch {
          rules.set(id, blob);
        }
      } else if (blob instanceof Uint8Array) {
        rules.set(id, Buffer.from(blob).toString('utf8'));
      }
    }
    for (const crate of crates) {
      if (rules.has(crate.id)) crate.rules = rules.get(crate.id);
    }

    return {
      source: file,
      space,
      spaces: [...ALLOWED_SPACES],
      track_count: tracks.length,
      root_id: rootId,
      tracks,
      crates: crates.filter((crate) => crate.id !== rootId),
    };
  } finally {
    db.close();
  }
}

/**
 * Builds a track list row from a SQLite asset row.
 *
 * @param row Asset columns selected by `queryLibrary`.
 * @returns The track the page and the deck linker share.
 *
 * Side effects: stats the resolved audio path when `portable_id` is set.
 */
function trackFromRow(row: SqlRow): LibraryTrack {
  const portable = row.portable_id == null ? null : asText(row.portable_id);
  const resolved = resolvePortable(portable);
  return {
    id: Number(row.id),
    name: asText(row.name),
    artist: asText(row.artist),
    album: asText(row.album),
    genre: asText(row.genre),
    bpm: asNumber(row.bpm),
    key: asText(row.key),
    length_ms: asNumber(row.length_ms),
    color: asNumber(row.color),
    missing: asFlag(row.is_missing),
    format: asText(row.format),
    file: asText(row.file_name),
    file_size: asNumber(row.file_size),
    time_added: asNumber(row.time_added),
    rating: asNumber(row.rating),
    emoji: asText(row.emoji),
    beatgrid_locked: asFlag(row.is_beatgrid_locked),
    play_count: asNumber(row.dj_play_count),
    stems: asFlag(row.stems_analyze_state),
    bitrate: asNumber(row.file_bit_rate),
    portable_id: portable,
    resolved_path: resolved.path,
    on_disk: resolved.onDisk,
  };
}

/**
 * Finds the library track a live deck file path points at.
 * An absolute path matches `resolved_path`. A Serato path also matches when
 * it ends with the stored `portable_id`. Comparison ignores case and slash direction.
 *
 * @param tracks Tracks from one space.
 * @param filepath File path from the live deck.
 * @returns The asset id, or null when nothing matches.
 *
 * Side effects: none.
 */
export function trackIdForFile(tracks: LibraryTrack[], filepath: string): number | null {
  const want = normPath(filepath);
  for (const track of tracks) {
    if (track.resolved_path && normPath(track.resolved_path) === want) return track.id;
    if (track.portable_id) {
      const portable = normPath(track.portable_id);
      if (want === portable || want.endsWith(`/${portable}`)) return track.id;
    }
  }
  return null;
}

/**
 * Compares two paths without case or slash differences.
 *
 * @param value A file path.
 * @returns Lowercase forward-slash form, without a trailing slash.
 *
 * Side effects: none.
 */
function normPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
}

/**
 * Loads the portable id of one asset so its tags can be read.
 *
 * @param assetId Asset id.
 * @returns The id and portable id, or null when the asset is missing.
 *
 * Side effects: opens and closes a read-only connection.
 */
export function trackFile(assetId: number): { id: number; portableId: string | null } | null {
  const db = openRead();
  try {
    const row = sqlGet(db, 'SELECT id, portable_id FROM asset WHERE id = ?', [assetId]);
    if (!row) return null;
    return { id: Number(row.id), portableId: row.portable_id == null ? null : asText(row.portable_id) };
  } finally {
    db.close();
  }
}

/**
 * Builds a random suffix Serato hides after the name separator.
 *
 * @returns 32 hex characters.
 *
 * Side effects: none.
 */
export function hiddenSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
