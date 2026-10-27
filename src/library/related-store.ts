/**
 * Read-only adapter for serato-library-manager's Related Tracks sidecar.
 *
 * The library manager is adding `docs/related-tracks.md`. Until that file
 * is merged, this module is the only place that knows where the sidecar
 * lives and which tables it accepts. Callers ask for saved matches. They
 * do not open the database themselves.
 *
 * The file sits beside `master.sqlite` and is named `related-tracks.sqlite`,
 * or `related_tracks.sqlite` when only that name is present.
 * `SERATO_RELATED_PATH` replaces that location. A missing file, a database
 * without a recognized table, or a file that cannot be read yields no saved
 * matches. The connection is read-only and closed before this module returns.
 *
 * Canonical table:
 *
 * ```sql
 * CREATE TABLE related_track (
 *   id INTEGER PRIMARY KEY,
 *   asset_id INTEGER,
 *   related_asset_id INTEGER,
 *   portable_id TEXT,
 *   related_portable_id TEXT,
 *   note TEXT,
 *   position INTEGER
 * );
 * ```
 *
 * A row is undirected. `position` orders the matches, lowest first.
 * `track_relation` (`left_asset_id`, `right_asset_id`) and a few other
 * names are accepted so a nearby schema still loads. Anything else is
 * reported as `schema` and ignored.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

const nodeRequire = createRequire(__filename);

/** DDL for the canonical `related_track` table. Tests build the sidecar from this. */
export const RELATED_TRACK_DDL = `
CREATE TABLE related_track (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER,
  related_asset_id INTEGER,
  portable_id TEXT,
  related_portable_id TEXT,
  note TEXT,
  position INTEGER
)`;

/** File names checked beside `master.sqlite`, in preference order. */
export const SIDECAR_NAMES = ['related-tracks.sqlite', 'related_tracks.sqlite'] as const;

/**
 * Why saved matches are empty or present.
 * `ok` means the sidecar opened and had a recognized table.
 * `missing` means the file is not there. `schema` means it opened but no
 * table had a source and a target. `unavailable` means it could not be read.
 */
export type SidecarStatus = 'ok' | 'missing' | 'schema' | 'unavailable';

/** One saved relation, before it is filled in from the Serato library. */
export interface SavedMatch {
  assetId: number | null;
  portableId: string | null;
  note: string | null;
  position: number | null;
}

/** The playing track the sidecar is searched with. */
export interface RelationLookup {
  assetId: number | null;
  paths: string[];
}

/** An open sidecar's rows, already read, so the file handle is not kept. */
export interface SidecarSnapshot {
  status: SidecarStatus;
  /**
   * Returns saved matches for one playing track.
   *
   * @param lookup Asset id and file paths of the playing track.
   * @returns Matches in sidecar order. Empty when the sidecar has no rows.
   *
   * Side effects: none.
   */
  matchesFor(lookup: RelationLookup): SavedMatch[];
}

/** Tables accepted as the relations list, most specific first. */
const TABLE_CANDIDATES = [
  'related_track',
  'related_tracks',
  'track_relation',
  'track_relations',
  'related',
  'relation',
  'relations',
];

/** Column names that identify the row's first track. */
const SOURCE_ID_COLUMNS = ['asset_id', 'source_asset_id', 'from_asset_id', 'left_asset_id', 'track_id', 'track_a'];

/** Column names that identify the row's other track. */
const TARGET_ID_COLUMNS = [
  'related_asset_id',
  'target_asset_id',
  'to_asset_id',
  'right_asset_id',
  'match_asset_id',
  'related_track_id',
  'related_id',
  'track_b',
];

/** Column names that store the first track's path. */
const SOURCE_PATH_COLUMNS = [
  'portable_id',
  'source_portable_id',
  'from_portable_id',
  'source_path',
  'filepath',
  'left_portable_id',
  'path',
];

/** Column names that store the other track's path. */
const TARGET_PATH_COLUMNS = [
  'related_portable_id',
  'target_portable_id',
  'to_portable_id',
  'related_path',
  'match_path',
  'right_portable_id',
];

const NOTE_COLUMNS = ['note', 'comment', 'reason'];
const POSITION_COLUMNS = ['position', 'list_order', 'rank', 'sort_order'];

interface ColumnMap {
  table: string;
  sourceId?: string;
  targetId?: string;
  sourcePath?: string;
  targetPath?: string;
  note?: string;
  position?: string;
  id?: string;
}

interface StoredRow {
  rowId: number | null;
  leftId: number | null;
  rightId: number | null;
  leftPath: string | null;
  rightPath: string | null;
  note: string | null;
  position: number | null;
}

interface LoadedSidecar {
  status: SidecarStatus;
  rows: StoredRow[];
}

let pathOverride: string | null = null;

/**
 * Points related-track reads at one sidecar for a test.
 * Pass null to follow `SERATO_RELATED_PATH` or the file beside the master database.
 *
 * @param next Sidecar path, or null to clear the override.
 *
 * Side effects: changes the process-wide sidecar path.
 */
export function setRelatedPathForTests(next: string | null): void {
  pathOverride = next;
}

/**
 * Returns the sidecar path for a master database.
 * A test override wins, then `SERATO_RELATED_PATH`, then the first existing
 * candidate beside the master file. When none of those files exist, the
 * canonical name is returned so the caller can report it as missing.
 *
 * @param masterFile Path of `master.sqlite`. It is not opened.
 * @returns The sidecar path. The file may not exist.
 *
 * Side effects: checks whether candidate files exist.
 */
export function sidecarPath(masterFile: string): string {
  if (pathOverride) return pathOverride;
  const fromEnv = process.env.SERATO_RELATED_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const dir = path.dirname(path.resolve(masterFile));
  for (const name of SIDECAR_NAMES) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // A path the process cannot stat is skipped.
    }
  }
  return path.join(dir, SIDECAR_NAMES[0]);
}

/**
 * Compares two track paths without case or slash differences.
 * A stored portable id also matches a live path that ends with it.
 *
 * @param left A file path or portable id.
 * @param right Another file path or portable id.
 * @returns True when both names are present and refer to the same file.
 *
 * Side effects: none.
 */
export function sameTrackPath(left: string, right: string): boolean {
  const a = normalizeTrackPath(left);
  const b = normalizeTrackPath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * Reads the sidecar once and closes it.
 * Later `matchesFor` calls filter the rows already in memory.
 *
 * @param file Sidecar path from `sidecarPath`.
 * @returns The status and a matcher. The matcher returns an empty list when nothing was stored.
 *
 * Side effects: opens and closes `file` when it exists.
 */
export function openSidecar(file: string): SidecarSnapshot {
  const loaded = loadSidecar(file);
  return {
    status: loaded.status,
    /**
     * Filters the loaded rows for one playing track.
     *
     * @param lookup Asset id and paths of the playing track.
     * @returns Saved matches in position order.
     *
     * Side effects: none.
     */
    matchesFor(lookup: RelationLookup): SavedMatch[] {
      return filterSaved(loaded.rows, lookup);
    },
  };
}

/**
 * Lowers a path and turns backslashes into slashes.
 *
 * @param value A file path.
 * @returns The comparable form, without a trailing slash.
 *
 * Side effects: none.
 */
function normalizeTrackPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/u, '').toLowerCase();
}

/**
 * Opens the sidecar, or reports why it could not be used.
 *
 * @param file Sidecar path.
 * @returns Rows from the first recognized table, and the status.
 *
 * Side effects: opens and closes `file` when it exists.
 */
function loadSidecar(file: string): LoadedSidecar {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { status: 'missing', rows: [] };
  }
  if (!stat.isFile()) return { status: 'unavailable', rows: [] };
  let db: DatabaseSync;
  try {
    db = openReadOnly(file);
  } catch {
    return { status: 'unavailable', rows: [] };
  }
  try {
    const names = tableNames(db);
    for (const candidate of TABLE_CANDIDATES) {
      const actual = names.get(candidate);
      if (!actual) continue;
      const columns = columnMap(db, actual);
      if (!columns) continue;
      return { status: 'ok', rows: readRows(db, columns) };
    }
    return { status: 'schema', rows: [] };
  } catch {
    return { status: 'unavailable', rows: [] };
  } finally {
    db.close();
  }
}

/**
 * Opens a sidecar without allowing writes.
 *
 * @param file Existing database file.
 * @returns A read-only connection. The caller closes it.
 *
 * Side effects: opens a file handle.
 */
function openReadOnly(file: string): DatabaseSync {
  const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(file, {
    readOnly: true,
    timeout: 0,
    enableForeignKeyConstraints: false,
    readBigInts: false,
  });
  try {
    db.exec('PRAGMA query_only=ON');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Lists user tables by their lower-case name.
 *
 * @param db Open sidecar.
 * @returns Actual table names keyed by lower-case name.
 *
 * Side effects: reads `sqlite_master`.
 */
function tableNames(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: SQLOutputValue }>;
  const names = new Map<string, string>();
  for (const row of rows) {
    const name = cellText(row.name);
    if (name) names.set(name.toLowerCase(), name);
  }
  return names;
}

/**
 * Finds a source and a target column on one table.
 *
 * @param db Open sidecar.
 * @param table Table name as stored in `sqlite_master`.
 * @returns The columns to read, or null when the table cannot describe a pair.
 *
 * Side effects: reads `PRAGMA table_info`.
 */
function columnMap(db: DatabaseSync, table: string): ColumnMap | null {
  if (!isIdent(table)) return null;
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name?: SQLOutputValue }>;
  const columns = new Map<string, string>();
  for (const row of rows) {
    const name = cellText(row.name);
    if (name && isIdent(name)) columns.set(name.toLowerCase(), name);
  }
  const sourceId = pick(columns, SOURCE_ID_COLUMNS);
  const targetId = pick(columns, TARGET_ID_COLUMNS);
  const sourcePath = pick(columns, SOURCE_PATH_COLUMNS);
  const targetPath = pick(columns, TARGET_PATH_COLUMNS);
  if (!sourceId && !sourcePath) return null;
  if (!targetId && !targetPath) return null;
  return {
    table,
    sourceId,
    targetId,
    sourcePath,
    targetPath,
    note: pick(columns, NOTE_COLUMNS),
    position: pick(columns, POSITION_COLUMNS),
    id: columns.get('id'),
  };
}

/**
 * Reads every relation row.
 * `rowid` supplies order when the table has no `id` column. A table without
 * `rowid` is read again without that column.
 *
 * @param db Open sidecar.
 * @param columns Mapped columns.
 * @returns The stored rows. Order is not significant yet.
 *
 * Side effects: reads the relation table.
 */
function readRows(db: DatabaseSync, columns: ColumnMap): StoredRow[] {
  const sqlFor = (includeRowId: boolean): string => {
    const rowId = includeRowId ? 'rowid' : columns.id ? quoteIdent(columns.id) : 'NULL';
    return `SELECT ${rowId} AS row_id, ${select(columns.sourceId, 'left_id')}, ${select(columns.targetId, 'right_id')}, ${select(columns.sourcePath, 'left_path')}, ${select(columns.targetPath, 'right_path')}, ${select(columns.note, 'note')}, ${select(columns.position, 'position')} FROM ${quoteIdent(columns.table)}`;
  };
  let rows: Record<string, SQLOutputValue>[];
  try {
    rows = db.prepare(sqlFor(true)).all() as unknown as Record<string, SQLOutputValue>[];
  } catch {
    rows = db.prepare(sqlFor(false)).all() as unknown as Record<string, SQLOutputValue>[];
  }
  return rows.map((record) => {
    return {
      rowId: cellId(record.row_id),
      leftId: cellId(record.left_id),
      rightId: cellId(record.right_id),
      leftPath: cellText(record.left_path),
      rightPath: cellText(record.right_path),
      note: cellText(record.note),
      position: cellNumber(record.position),
    };
  });
}

/**
 * Keeps rows that mention the playing track and returns the other side.
 *
 * @param rows Rows loaded from the sidecar.
 * @param lookup The playing track.
 * @returns Unique matches, saved order preserved.
 *
 * Side effects: none.
 */
function filterSaved(rows: StoredRow[], lookup: RelationLookup): SavedMatch[] {
  const found: Array<SavedMatch & { rowId: number | null }> = [];
  for (const row of rows) {
    const left = { assetId: row.leftId, portableId: row.leftPath };
    const right = { assetId: row.rightId, portableId: row.rightPath };
    const leftHit = identifies(left, lookup);
    const rightHit = identifies(right, lookup);
    if (leftHit === rightHit) continue;
    const match = leftHit ? right : left;
    if (match.assetId == null && !match.portableId) continue;
    if (identifies(match, lookup)) continue;
    found.push({ ...match, note: row.note, position: row.position, rowId: row.rowId });
  }
  found.sort((a, b) => {
    const aMissing = a.position == null ? 1 : 0;
    const bMissing = b.position == null ? 1 : 0;
    if (aMissing !== bMissing) return aMissing - bMissing;
    if (a.position != null && b.position != null && a.position !== b.position) return a.position - b.position;
    return (a.rowId ?? Number.MAX_SAFE_INTEGER) - (b.rowId ?? Number.MAX_SAFE_INTEGER);
  });
  const seen = new Set<string>();
  const matches: SavedMatch[] = [];
  for (const match of found) {
    const key = match.assetId != null ? `id:${match.assetId}` : `path:${normalizeTrackPath(match.portableId || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      assetId: match.assetId,
      portableId: match.portableId,
      note: match.note,
      position: match.position,
    });
  }
  return matches;
}

/**
 * Returns whether one side of a row is the playing track.
 *
 * @param side Asset id and path stored on that side.
 * @param lookup The playing track.
 * @returns True when the id or the path matches.
 *
 * Side effects: none.
 */
function identifies(side: { assetId: number | null; portableId: string | null }, lookup: RelationLookup): boolean {
  if (lookup.assetId != null && side.assetId != null && lookup.assetId === side.assetId) return true;
  if (!side.portableId) return false;
  return lookup.paths.some((file) => file && sameTrackPath(file, side.portableId || ''));
}

/**
 * Picks the first listed column that the table has.
 *
 * @param columns Lower-case names mapped to the stored spelling.
 * @param names Candidate names, preferred first.
 * @returns The stored column name, or undefined.
 *
 * Side effects: none.
 */
function pick(columns: Map<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const found = columns.get(name);
    if (found) return found;
  }
  return undefined;
}

/**
 * Builds one select expression.
 *
 * @param column Stored column name, or undefined to select null.
 * @param alias Result name.
 * @returns SQL for that column.
 *
 * Side effects: none.
 */
function select(column: string | undefined, alias: string): string {
  if (!column) return `NULL AS ${alias}`;
  return `${quoteIdent(column)} AS ${alias}`;
}

/**
 * Returns whether a name can be quoted as a SQLite identifier.
 *
 * @param name Table or column name.
 * @returns True for a plain identifier.
 *
 * Side effects: none.
 */
function isIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Quotes a SQLite identifier.
 *
 * @param name A name that `isIdent` already accepted.
 * @returns The quoted name.
 *
 * Side effects: none.
 */
function quoteIdent(name: string): string {
  return `"${name}"`;
}

/**
 * Returns a SQLite cell as text.
 *
 * @param value A cell value.
 * @returns The text, or null when it is empty.
 *
 * Side effects: none.
 */
function cellText(value: SQLOutputValue | undefined): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

/**
 * Returns a SQLite cell as a finite number.
 *
 * @param value A cell value.
 * @returns The number, or null.
 *
 * Side effects: none.
 */
function cellNumber(value: SQLOutputValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Returns a SQLite cell as an integer id.
 *
 * @param value A cell value.
 * @returns The truncated id, or null.
 *
 * Side effects: none.
 */
function cellId(value: SQLOutputValue | undefined): number | null {
  const parsed = cellNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}
