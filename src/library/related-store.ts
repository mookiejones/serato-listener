/**
 * Read-only adapter for serato-library-manager's Related Tracks sidecar.
 *
 * The file is `related.sqlite` in the library manager's settings directory:
 * macOS `~/Library/Application Support/Serato Library`, Windows
 * `%APPDATA%\Serato Library`, Linux `$XDG_CONFIG_HOME/serato-library` or
 * `~/.config/serato-library`. `SERATO_RELATED_PATH` replaces that file.
 * `SERATO_LIBRARY_CONFIG_DIR` replaces the directory when it is absolute.
 *
 * Schema version 1 (`PRAGMA user_version`) has `track` and `link`. A link is
 * one direction. `mutual = 1` is visible from both ends. The playing track is
 * matched by canonical path, then by a unique case-insensitive path, then by
 * a unique title, artist, and length in whole seconds. This module never
 * writes the file, including when a fallback row still points at another copy.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

/** Sidecar schema this reader understands. Anything else is left unread. */
export const RELATED_SCHEMA_VERSION = 1;

/** Filename inside the library manager's settings directory. */
export const RELATED_DB_NAME = 'related.sqlite';

/** Longest path the library manager stores. Longer values do not match. */
const PATH_LIMIT = 4096;

/**
 * Tables for schema version 1.
 * Tests set `PRAGMA user_version` themselves. The reader does not.
 */
export const RELATED_SCHEMA_SQL = `
CREATE TABLE track (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  length_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX track_path ON track(path);
CREATE INDEX track_fallback ON track(title, artist, length_ms);
CREATE TABLE link (
  id INTEGER PRIMARY KEY,
  from_track_id INTEGER NOT NULL,
  to_track_id INTEGER NOT NULL,
  mutual INTEGER NOT NULL DEFAULT 0 CHECK (mutual IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_track_id != to_track_id),
  UNIQUE (from_track_id, to_track_id)
);
CREATE INDEX link_from ON link(from_track_id);
CREATE INDEX link_to ON link(to_track_id);
`;

/** Why saved matches are present or empty. */
export type SidecarStatus = 'ok' | 'missing' | 'schema' | 'unavailable';

/** One library track, used to reject a fallback that still names another copy. */
export interface LibraryIdentity {
  id: number;
  paths: string[];
}

/** The playing track, as the live deck and the open library describe it. */
export interface RelationLookup {
  paths: string[];
  title: string;
  artist: string;
  lengthMs: number | null;
  anchorId: number | null;
  library: LibraryIdentity[];
}

/** One saved relation, already filtered to the direction the playing track can see. */
export interface SavedMatch {
  path: string;
  title: string;
  artist: string;
  lengthMs: number | null;
  note: string | null;
  rating: number | null;
  mutual: boolean;
}

/** Sidecar contents needed to answer one or more deck lookups. */
export interface SidecarSnapshot {
  status: SidecarStatus;
  matchesFor(lookup: RelationLookup): SavedMatch[];
}

interface StoredTrack {
  id: number;
  path: string;
  title: string;
  artist: string;
  lengthMs: number | null;
}

interface StoredLink {
  id: number;
  fromId: number;
  toId: number;
  mutual: boolean;
  note: string | null;
  rating: number | null;
}

interface LoadedSidecar {
  status: SidecarStatus;
  tracks: StoredTrack[];
  links: StoredLink[];
}

/** Options for {@link defaultRelatedPath}. Omitted fields follow this process. */
export interface RelatedPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string | null;
  xdgConfigHome?: string | null;
}

let pathOverride: string | null = null;

/**
 * Points related-track reads at one sidecar for a test.
 * Pass null to follow `SERATO_RELATED_PATH` or the settings directory.
 *
 * @param next Sidecar path, or null to clear the override.
 *
 * Side effects: changes the process-wide sidecar path.
 */
export function setRelatedPathForTests(next: string | null): void {
  pathOverride = next;
}

/**
 * Returns the sidecar path for this platform's settings directory.
 *
 * @param options Platform, home, and config roots. Defaults follow the process.
 * @returns `related.sqlite` under the library manager's settings directory.
 *
 * Side effects: none.
 */
export function defaultRelatedPath(options: RelatedPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Serato Library', RELATED_DB_NAME);
  }
  if (platform === 'win32') {
    const appData =
      options.appData !== undefined ? options.appData : options.platform ? null : (process.env.APPDATA ?? null);
    const base = appData && appData.trim() ? appData.trim() : join(home, 'AppData', 'Roaming');
    return join(base, 'Serato Library', RELATED_DB_NAME);
  }
  const xdg =
    options.xdgConfigHome !== undefined ? options.xdgConfigHome : options.platform ? null : (process.env.XDG_CONFIG_HOME ?? null);
  const base = xdg && xdg.trim() ? xdg.trim() : join(home, '.config');
  return join(base, 'serato-library', RELATED_DB_NAME);
}

/**
 * Returns the sidecar path the process would open.
 * A test override wins, then `SERATO_RELATED_PATH`, then an absolute
 * `SERATO_LIBRARY_CONFIG_DIR`, then the platform settings directory.
 *
 * @returns The sidecar path. The file may not exist.
 *
 * Side effects: reads environment variables. Does not open a database.
 */
export function sidecarPath(): string {
  if (pathOverride) return pathOverride;
  const fromEnv = process.env.SERATO_RELATED_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const configDir = process.env.SERATO_LIBRARY_CONFIG_DIR;
  if (configDir && configDir.trim() && path.isAbsolute(configDir.trim())) {
    return path.join(configDir.trim(), RELATED_DB_NAME);
  }
  return defaultRelatedPath();
}

/**
 * Canonical path used as the sidecar's primary key.
 * Empty values, NUL, and paths longer than 4096 characters do not match.
 * A relative path is the home copy when that file exists, otherwise the
 * filesystem-root copy when that exists, otherwise the home copy.
 *
 * @param value A live path, a portable id, or a path stored in the sidecar.
 * @returns The canonical path, or null when the value cannot be a key.
 *
 * Side effects: stats the path and its parent when resolving a relative path.
 */
export function identityPath(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (!text || text.includes('\0') || text.length > PATH_LIMIT) return null;
  const expanded = expandHome(text);
  let chosen = expanded;
  if (!path.isAbsolute(expanded)) {
    const homeCandidate = path.join(os.homedir(), expanded);
    const rootCandidate = path.join(path.parse(os.homedir()).root, expanded);
    chosen = homeCandidate;
    for (const candidate of [homeCandidate, rootCandidate]) {
      try {
        if (fs.existsSync(candidate)) {
          chosen = candidate;
          break;
        }
      } catch {
        // An unreadable candidate is skipped.
      }
    }
  }
  return resolveLoose(chosen);
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
 * Later `matchesFor` calls use the rows already in memory.
 *
 * @param file Sidecar path from `sidecarPath`.
 * @returns The status and a matcher. The matcher returns an empty list unless the schema version is 1.
 *
 * Side effects: opens and closes `file` when it exists. Does not create it.
 */
export function openSidecar(file: string): SidecarSnapshot {
  const loaded = loadSidecar(file);
  return {
    status: loaded.status,
    /**
     * Returns saved links visible from one playing track.
     *
     * @param lookup Paths, title, artist, length, and the open library.
     * @returns Matches in link-id order.
     *
     * Side effects: none.
     */
    matchesFor(lookup: RelationLookup): SavedMatch[] {
      if (loaded.status !== 'ok') return [];
      const anchor = anchorTrackId(loaded.tracks, lookup);
      if (anchor == null) return [];
      const tracks = new Map(loaded.tracks.map((track) => [track.id, track]));
      const matches: SavedMatch[] = [];
      for (const link of loaded.links) {
        if (link.fromId !== anchor && !(link.mutual && link.toId === anchor)) continue;
        const otherId = link.fromId === anchor ? link.toId : link.fromId;
        const other = tracks.get(otherId);
        if (!other) continue;
        matches.push({
          path: other.path,
          title: other.title,
          artist: other.artist,
          lengthMs: other.lengthMs,
          note: link.note,
          rating: link.rating,
          mutual: link.mutual,
        });
      }
      return matches;
    },
  };
}

/**
 * Opens the sidecar read-only when it is schema version 1.
 *
 * @param file Sidecar path.
 * @returns Tracks and links, or a status that means no saved matches.
 *
 * Side effects: opens and closes `file`. Does not create or modify it.
 */
function loadSidecar(file: string): LoadedSidecar {
  const empty = (status: SidecarStatus): LoadedSidecar => ({ status, tracks: [], links: [] });
  if (!file) return empty('missing');
  let exists = false;
  try {
    exists = fs.existsSync(file);
  } catch {
    return empty('unavailable');
  }
  if (!exists) return empty('missing');
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    db.exec('PRAGMA query_only = ON');
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: SQLOutputValue } | undefined;
    const version = asInt(versionRow?.user_version);
    if (version !== RELATED_SCHEMA_VERSION) return empty('schema');
    const tracks = db
      .prepare('SELECT id, path, title, artist, length_ms FROM track')
      .all()
      .map((row) => readTrack(row as Record<string, SQLOutputValue>))
      .filter((track): track is StoredTrack => track != null);
    const links = db
      .prepare('SELECT id, from_track_id, to_track_id, mutual, note, rating FROM link ORDER BY id')
      .all()
      .map((row) => readLink(row as Record<string, SQLOutputValue>))
      .filter((link): link is StoredLink => link != null);
    return { status: 'ok', tracks, links };
  } catch {
    return empty('unavailable');
  } finally {
    db?.close();
  }
}

/**
 * Finds the sidecar row for the playing track.
 * Path wins. A unique title, artist, and whole-second length is used only
 * when no path matches, and only when that row is not another library track.
 *
 * @param tracks Sidecar tracks.
 * @param lookup Playing track.
 * @returns Sidecar track id, or null when nothing matches.
 *
 * Side effects: none.
 */
function anchorTrackId(tracks: StoredTrack[], lookup: RelationLookup): number | null {
  const seen = new Set<string>();
  for (const file of lookup.paths) {
    const key = identityPath(file);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const found = trackByPath(tracks, key);
    if (found) return found.id;
  }
  const fallback = fallbackTrack(tracks, lookup);
  if (!fallback || secondCopy(fallback.path, lookup)) return null;
  return fallback.id;
}

/**
 * Matches a canonical path, then a unique case-insensitive path.
 *
 * @param tracks Sidecar tracks.
 * @param key Canonical path.
 * @returns The one matching track, or null.
 *
 * Side effects: none.
 */
function trackByPath(tracks: StoredTrack[], key: string): StoredTrack | null {
  const exact = tracks.find((track) => track.path === key);
  if (exact) return exact;
  const folded = key.toLowerCase();
  const hits = tracks.filter((track) => track.path.toLowerCase() === folded);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Matches title, artist, and length in whole seconds when exactly one row fits.
 *
 * @param tracks Sidecar tracks.
 * @param lookup Playing track. Length must be known.
 * @returns The one matching track, or null.
 *
 * Side effects: none.
 */
function fallbackTrack(tracks: StoredTrack[], lookup: RelationLookup): StoredTrack | null {
  const title = lookup.title.trim().toLowerCase();
  const artist = lookup.artist.trim().toLowerCase();
  if (!title || !artist || lookup.lengthMs == null || !Number.isFinite(lookup.lengthMs)) return null;
  const seconds = Math.trunc(lookup.lengthMs / 1000);
  const hits = tracks.filter((track) => {
    if (track.lengthMs == null) return false;
    return (
      track.title.trim().toLowerCase() === title &&
      track.artist.trim().toLowerCase() === artist &&
      Math.trunc(track.lengthMs / 1000) === seconds
    );
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Returns whether a fallback row's stored path is a different track in the open library.
 * The listener does not rewrite that path.
 *
 * @param stored Path stored on the fallback row.
 * @param lookup Open library and the playing track's asset id.
 * @returns True when the row should not be used.
 *
 * Side effects: none.
 */
function secondCopy(stored: string, lookup: RelationLookup): boolean {
  const hit = libraryHit(stored, lookup.library);
  if (!hit) return false;
  return lookup.anchorId == null || hit.id !== lookup.anchorId;
}

/**
 * Finds the library track named by a sidecar path.
 * An exact path or portable id wins. Otherwise the first case-insensitive path wins.
 *
 * @param stored Path stored in the sidecar.
 * @param library Tracks in the open library.
 * @returns The library track, or null.
 *
 * Side effects: none.
 */
function libraryHit(stored: string, library: LibraryIdentity[]): LibraryIdentity | null {
  const wanted = identityPath(stored);
  const raw = stored.trim();
  for (const track of library) {
    for (const file of track.paths) {
      if (!file) continue;
      if (file === raw || (wanted != null && file === wanted)) return track;
    }
  }
  if (!wanted) return null;
  const folded = wanted.toLowerCase();
  for (const track of library) {
    for (const file of track.paths) {
      if (file && file.toLowerCase() === folded) return track;
    }
  }
  return null;
}

/**
 * Reads one track row. A blank path is dropped.
 *
 * @param row Columns from `track`.
 * @returns The stored track, or null.
 *
 * Side effects: none.
 */
function readTrack(row: Record<string, SQLOutputValue>): StoredTrack | null {
  const id = asInt(row.id);
  const stored = typeof row.path === 'string' ? row.path : '';
  if (id == null || !stored) return null;
  return {
    id,
    path: stored,
    title: typeof row.title === 'string' ? row.title : '',
    artist: typeof row.artist === 'string' ? row.artist : '',
    lengthMs: asInt(row.length_ms),
  };
}

/**
 * Reads one link row. A rating outside 1 through 5 becomes null.
 *
 * @param row Columns from `link`.
 * @returns The stored link, or null.
 *
 * Side effects: none.
 */
function readLink(row: Record<string, SQLOutputValue>): StoredLink | null {
  const id = asInt(row.id);
  const fromId = asInt(row.from_track_id);
  const toId = asInt(row.to_track_id);
  if (id == null || fromId == null || toId == null) return null;
  const rating = asInt(row.rating);
  const note = typeof row.note === 'string' ? row.note.trim() : '';
  return {
    id,
    fromId,
    toId,
    mutual: asInt(row.mutual) === 1,
    note: note || null,
    rating: rating != null && rating >= 1 && rating <= 5 ? rating : null,
  };
}

/**
 * Expands a leading `~` to the home directory.
 *
 * @param text Path text, already trimmed.
 * @returns The path with a leading home marker expanded.
 *
 * Side effects: none.
 */
function expandHome(text: string): string {
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

/**
 * Resolves `.`, `..`, and an existing symlink prefix.
 * A missing file keeps its resolved parent.
 *
 * @param file Absolute or relative path.
 * @returns The resolved path.
 *
 * Side effects: stats the path and its ancestors.
 */
function resolveLoose(file: string): string {
  const absolute = path.resolve(file);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      if (fs.existsSync(current)) return path.join(fs.realpathSync(current), ...tail);
    } catch {
      // An unreadable ancestor is left unresolved.
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...tail);
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Normalizes a path for comparison.
 *
 * @param value File path or portable id.
 * @returns Lowercase path with forward slashes, or an empty string.
 *
 * Side effects: none.
 */
function normalizeTrackPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

/**
 * Reads an integer cell. Non-integers are dropped.
 *
 * @param value Cell from `node:sqlite`.
 * @returns The integer, or null.
 *
 * Side effects: none.
 */
function asInt(value: SQLOutputValue | undefined): number | null {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? value : null;
}
