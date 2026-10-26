/**
 * Create, rename, delete, and fill Serato crates.
 *
 * Writes go to `master.sqlite` after a backup, then mirror into `root.sqlite`
 * when that location database is connected. Each crate stores an export path
 * in `dj_container_metadata.filename`: ancestor names joined by `%%`, with a
 * `.crate` suffix, or `.scrate` for a smart crate. The audio file is never moved.
 */

import type { SQLInputValue } from 'node:sqlite';
import { LibraryError } from './errors';
import {
  NAME_SPLIT,
  LIBRARY_SPACE,
  asInt,
  asText,
  assetLocation,
  assign,
  beginWrite,
  columns,
  containerById,
  displayName,
  hiddenSuffix,
  invalidateLibraryCache,
  locationPaths,
  nextRevision,
  spaceId,
  spaceRoot,
  sqlAll,
  sqlGet,
  sqlRun,
  tables,
  withLocation,
  type SqlDb,
} from './db';

/** The result of one crate edit. `warning` is set when the drive database was left behind. */
export interface CrateResult {
  ok: true;
  id: number;
  name?: string;
  warning: string | null;
}

/**
 * Runs one crate edit.
 * Actions are `create`, `rename`, `delete`, `add`, and `remove`. The master
 * write is committed only after the action returns. A thrown error rolls it back.
 *
 * @param payload JSON object with `action` and the fields that action requires.
 * @returns The action result.
 *
 * Side effects: may back up the library, write `master.sqlite`, and mirror into `root.sqlite`.
 */
export async function crateAction(payload: Record<string, unknown>): Promise<CrateResult> {
  const action = payload.action;
  const space = typeof payload.space === 'string' && payload.space ? payload.space : LIBRARY_SPACE;
  const db = await beginWrite();
  try {
    let result: CrateResult;
    if (action === 'create') {
      result = await createCrate(db, space, payload.parent, textArg(payload.name), Boolean(payload.smart), payload.rules);
    } else if (action === 'rename') {
      result = await renameCrate(db, space, requiredId(payload.id, 'crate'), textArg(payload.name));
    } else if (action === 'delete') {
      result = await deleteCrate(db, space, requiredId(payload.id, 'crate'));
    } else if (action === 'add') {
      result = await membership(db, requiredId(payload.id, 'crate'), requiredId(payload.asset, 'track'), space, true);
    } else if (action === 'remove') {
      result = await membership(db, requiredId(payload.id, 'crate'), requiredId(payload.asset, 'track'), space, false);
    } else {
      throw new LibraryError('That crate action is not available.');
    }
    db.exec('COMMIT');
    invalidateLibraryCache();
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The write transaction did not start, or it was already rolled back.
    }
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Reads a name field as text.
 * A missing name becomes an empty string, which the name check then rejects.
 *
 * @param value Submitted name.
 * @returns The text, or an empty string.
 *
 * Side effects: none.
 */
function textArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads an id the action cannot proceed without.
 *
 * @param value Submitted id.
 * @param label Word used in the error, such as `crate` or `track`.
 * @returns The integer id.
 *
 * Side effects: none.
 */
function requiredId(value: unknown, label: string): number {
  if (value == null || value === '') throw new LibraryError(`That ${label} is missing.`);
  return asInt(value);
}

/**
 * Returns crate names from the space root down to one crate.
 * The space root itself is omitted.
 *
 * @param db Open connection.
 * @param crateId Container id.
 * @returns Display names, root first.
 *
 * Side effects: none beyond the read.
 */
function ancestry(db: SqlDb, crateId: number): string[] {
  const names: string[] = [];
  const seen = new Set<number>();
  let current = crateId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = sqlGet(db, 'SELECT parent_id, name, type FROM container WHERE id = ?', [current]);
    if (!row) break;
    if (Number(row.type) === 0) break;
    names.push(displayName(asText(row.name)));
    if (row.parent_id == null) break;
    current = Number(row.parent_id);
  }
  names.reverse();
  return names;
}

/**
 * Returns a crate id and the ids of crates nested under it.
 *
 * @param db Open connection.
 * @param crateId Container id.
 * @returns Ids from a recursive container query, including `crateId`.
 *
 * Side effects: none beyond the read.
 */
function descendantIds(db: SqlDb, crateId: number): number[] {
  return sqlAll(
    db,
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM container WHERE id = ?
       UNION ALL
       SELECT c.id
       FROM container c
       JOIN tree t ON c.parent_id = t.id
       WHERE c.parent_id != c.id
     )
     SELECT id FROM tree`,
    [crateId],
  ).map((row) => Number(row.id));
}

/**
 * Builds a unique stored crate name.
 * A clash with another crate under the same parent adds a hidden Serato suffix.
 *
 * @param db Open connection.
 * @param parentId Parent container id.
 * @param display Name typed in the page.
 * @param crateType Container type. Smart crates use 2.
 * @param existingId Crate being renamed, or null for a new crate.
 * @returns The name to store.
 *
 * Side effects: none beyond the read.
 */
function storedName(db: SqlDb, parentId: number, display: string, crateType: number, existingId: number | null): string {
  const text = (display || '').trim();
  if (!text || text.includes(NAME_SPLIT)) {
    throw new LibraryError('Use a crate name without the Serato name separator.');
  }
  if (text.length > 400) throw new LibraryError('That crate name is too long.');
  let suffix = '';
  if (existingId != null) {
    const current = sqlGet(db, 'SELECT name FROM container WHERE id = ?', [existingId]);
    if (current && asText(current.name).includes(NAME_SPLIT)) {
      const stored = asText(current.name);
      suffix = stored.slice(stored.indexOf(NAME_SPLIT));
    }
  }
  const candidate = text + suffix;
  const clash = sqlGet(
    db,
    `SELECT id FROM container
     WHERE parent_id = ? AND name = ? COLLATE NOCASE AND type = ? AND id != ?`,
    [parentId, candidate, crateType, existingId == null ? -1 : existingId],
  );
  if (!clash) return candidate;
  if (suffix) throw new LibraryError('A crate with that name already exists here.');
  return text + NAME_SPLIT + hiddenSuffix();
}

/**
 * Builds the export filename Serato stores for a crate.
 * Ancestor display names are joined by `%%`. Smart crates use `.scrate`.
 *
 * @param db Open connection.
 * @param crateId Container id.
 * @param crateType 2 for a smart crate, otherwise a normal crate.
 * @returns The export path, such as `Warmup%%Drums.crate`.
 *
 * Side effects: none beyond the read.
 */
export function crateFilename(db: SqlDb, crateId: number, crateType: number): string {
  const ext = Number(crateType) === 2 ? '.scrate' : '.crate';
  return `${ancestry(db, crateId).join('%%')}${ext}`;
}

/**
 * Stores a crate export filename.
 *
 * @param db Open connection.
 * @param crateId Container id.
 * @param filename Export filename.
 * @param revision Revision to store when the table has that column.
 *
 * Side effects: inserts or updates `dj_container_metadata`.
 */
function upsertFilename(db: SqlDb, crateId: number, filename: string, revision?: number): void {
  const present = columns(db, 'dj_container_metadata');
  if (present.has('revision')) {
    sqlRun(
      db,
      `INSERT INTO dj_container_metadata (container_id, revision, export_state, filename)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(container_id) DO UPDATE SET
         filename = excluded.filename,
         revision = excluded.revision`,
      [crateId, revision ?? Math.floor(Date.now() / 1000), filename],
    );
    return;
  }
  sqlRun(
    db,
    `INSERT INTO dj_container_metadata (container_id, export_state, filename)
     VALUES (?, 0, ?)
     ON CONFLICT(container_id) DO UPDATE SET filename = excluded.filename`,
    [crateId, filename],
  );
}

/**
 * Rebuilds export filenames for a crate and its descendants.
 *
 * @param db Open connection.
 * @param crateId Container id.
 * @param revision Revision passed to each filename update.
 *
 * Side effects: updates `dj_container_metadata` for the crate and nested crates.
 */
function refreshFilenames(db: SqlDb, crateId: number, revision?: number): void {
  for (const current of descendantIds(db, crateId)) {
    const row = sqlGet(db, 'SELECT type FROM container WHERE id = ?', [current]);
    if (!row || Number(row.type) === 0) continue;
    upsertFilename(db, current, crateFilename(db, current, Number(row.type)), revision);
  }
}

/**
 * Records a smart crate as needing a refresh when that table exists.
 *
 * @param db Open write connection.
 * @param crateId Smart crate id.
 *
 * Side effects: may insert into `updated_smart_crate`.
 */
function markSmart(db: SqlDb, crateId: number): void {
  const exists = sqlGet(db, "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'updated_smart_crate'");
  if (!exists || !columns(db, 'updated_smart_crate').has('container_id')) return;
  sqlRun(db, 'INSERT INTO updated_smart_crate (container_id) VALUES (?)', [crateId]);
}

/**
 * Normalizes smart-crate rules to a JSON string.
 *
 * @param rules A rules object, or a JSON string of that object.
 * @returns Compact JSON.
 *
 * Side effects: none.
 */
function rulesBlob(rules: unknown): string {
  let parsed: unknown = rules;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new LibraryError('Smart crate rules need to be JSON.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LibraryError('Smart crate rules need a rules list.');
  }
  const raw = parsed as Record<string, unknown>;
  const list = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(list)) throw new LibraryError('Smart crate rules need a rules list.');
  return JSON.stringify(raw);
}

/**
 * Returns true when smart-crate rules were omitted and the default set should be used.
 * An empty list counts as omitted, matching the Python writer.
 *
 * @param rules Submitted rules.
 * @returns True when the caller should substitute the default rule object.
 *
 * Side effects: none.
 */
function rulesOmitted(rules: unknown): boolean {
  if (rules == null || rules === false || rules === '') return true;
  return Array.isArray(rules) && rules.length === 0;
}

/**
 * Inserts a crate and mirrors it to the main drive database.
 *
 * @param db Open master write connection.
 * @param space Space name.
 * @param parentArg Parent crate id. Null or the space root places the crate at the top level.
 * @param name Display name.
 * @param smart True to create a smart crate.
 * @param rules Smart-crate rules. An empty value gets a default rule set.
 * @returns The new crate id, display name, and any mirror warning.
 *
 * Side effects: inserts the crate, its filename, and, when connected, the `root.sqlite` copy.
 */
async function createCrate(
  db: SqlDb,
  space: string,
  parentArg: unknown,
  name: string,
  smart: boolean,
  rules: unknown,
): Promise<CrateResult> {
  const rootId = spaceRoot(db, space);
  let parent = parentArg == null || parentArg === '' ? rootId : asInt(parentArg);
  if (parent !== rootId) {
    const parentRow = containerById(db, parent, space);
    if (parentRow.type === 2) throw new LibraryError('A smart crate cannot contain another crate.');
    if (parentRow.type === 0) parent = rootId;
  }
  const crateType = smart ? 2 : 1;
  const stored = storedName(db, parent, name, crateType, null);
  let blob: string | null = null;
  if (smart) {
    const chosen = rulesOmitted(rules)
      ? { conjunction: 'AND', live_updates: true, rules: [], spaces: [space] }
      : rules;
    blob = rulesBlob(chosen);
  }
  const orderRow = sqlGet(db, 'SELECT COALESCE(MAX(list_order), 0) + 1 AS n FROM container WHERE parent_id = ?', [parent]);
  const order = Number(orderRow?.n ?? 1);
  const inserted = sqlRun(
    db,
    `INSERT INTO container (parent_id, name, type, list_order, space_id, time_added, expanded, portable_id, color)
     VALUES (?, ?, ?, ?, ?, ?, 0, '', NULL)`,
    [parent, stored, crateType, order, spaceId(db, space), Math.floor(Date.now() / 1000)],
  );
  const crateId = inserted.lastInsertRowid;
  upsertFilename(db, crateId, crateFilename(db, crateId, crateType));
  if (smart && blob != null) {
    sqlRun(db, 'INSERT INTO smart_crate_rules (container_id, version, rules) VALUES (?, 1, ?)', [crateId, blob]);
    markSmart(db, crateId);
  }
  const warning = await linkNewCrate(db, crateId, parent, stored, crateType, space, blob);
  return { ok: true, id: crateId, name: displayName(stored), warning };
}

/**
 * Finds the parent container id in `root.sqlite` for a master crate.
 *
 * @param master Master connection.
 * @param root Location connection.
 * @param parentId Parent id in the master database.
 * @param space Space name.
 * @returns The location parent id, or null when the space is missing there.
 *
 * Side effects: none beyond the reads.
 */
function rootParent(master: SqlDb, root: SqlDb, parentId: number, space: string): number | null {
  const row = sqlGet(
    master,
    `SELECT external_container_id FROM location_container
     WHERE container_id = ? AND location_id = 3 AND external_container_id IS NOT NULL`,
    [parentId],
  );
  if (row) return Number(row.external_container_id);
  const spaceRow = sqlGet(root, 'SELECT id FROM space WHERE name = ?', [space]);
  if (!spaceRow) return null;
  const rootRow = sqlGet(root, 'SELECT id FROM container WHERE space_id = ? AND type = 0', [Number(spaceRow.id)]);
  return rootRow ? Number(rootRow.id) : null;
}

/**
 * Inserts a crate into a location database.
 *
 * @param root Location connection.
 * @param parentId Parent container id in that database.
 * @param name Stored crate name.
 * @param crateType 1 for a normal crate, 2 for a smart crate.
 * @param space Space name.
 * @param rules Smart-crate JSON, or null.
 * @returns The new container id, or null when the space is missing.
 *
 * Side effects: inserts the container, its filename, and smart-crate rules when needed.
 */
function insertRootContainer(
  root: SqlDb,
  parentId: number,
  name: string,
  crateType: number,
  space: string,
  rules: string | null,
): number | null {
  const spaceRow = sqlGet(root, 'SELECT id FROM space WHERE name = ?', [space]);
  if (!spaceRow) return null;
  const revision = nextRevision(root);
  const orderRow = sqlGet(root, 'SELECT COALESCE(MAX(list_order), 0) + 1 AS n FROM container WHERE parent_id = ?', [parentId]);
  const inserted = sqlRun(
    root,
    `INSERT INTO container (revision, parent_id, name, type, list_order, space_id, time_added, expanded, portable_id, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', NULL)`,
    [revision, parentId, name, crateType, Number(orderRow?.n ?? 1), Number(spaceRow.id), Math.floor(Date.now() / 1000)],
  );
  const crateId = inserted.lastInsertRowid;
  upsertFilename(root, crateId, crateFilename(root, crateId, crateType), revision);
  if (crateType === 2 && rules != null && tables(root).has('smart_crate_rules')) {
    sqlRun(
      root,
      `INSERT INTO smart_crate_rules (container_id, revision, version, rules, needs_refresh)
       VALUES (?, ?, 1, ?, 1)`,
      [crateId, revision, rules],
    );
  }
  return crateId;
}

/**
 * Mirrors a new crate into `root.sqlite` and stores the external id.
 *
 * @param db Open master write connection.
 * @param crateId New master container id.
 * @param parentId Parent id in the master database.
 * @param name Stored name.
 * @param crateType Container type.
 * @param space Space name.
 * @param rules Smart-crate JSON, or null.
 * @returns Null, or a warning when the drive database is not updated.
 *
 * Side effects: may write `root.sqlite` and insert a `location_container` row.
 */
async function linkNewCrate(
  db: SqlDb,
  crateId: number,
  parentId: number,
  name: string,
  crateType: number,
  space: string,
  rules: string | null,
): Promise<string | null> {
  const rootPath = locationPaths(db).get(3);
  if (!rootPath) {
    return 'The crate is saved. The main drive database is not connected, so Serato may drop it on the next sync.';
  }
  const created: { id: number | null; ok: boolean } = { id: null, ok: false };
  const warning = await withLocation(rootPath, (root) => {
    const parent = rootParent(db, root, parentId, space);
    if (parent == null) {
      return 'The crate is saved. Its parent is not on the main drive, so Serato may drop it on the next sync.';
    }
    created.id = insertRootContainer(root, parent, name, crateType, space, rules);
    created.ok = true;
    return null;
  });
  if (created.ok && created.id != null) {
    sqlRun(
      db,
      `INSERT INTO location_container (container_id, location_id, external_container_id)
       VALUES (?, 3, ?)`,
      [crateId, created.id],
    );
  }
  return warning;
}

/**
 * Renames a crate and refreshes export filenames, including nested crates.
 *
 * @param db Open master write connection.
 * @param space Space name.
 * @param crateId Container id.
 * @param name New display name.
 * @returns The crate id, display name, and any mirror warning.
 *
 * Side effects: updates the master crate and, when linked, the `root.sqlite` copy.
 */
async function renameCrate(db: SqlDb, space: string, crateId: number, name: string): Promise<CrateResult> {
  const row = containerById(db, crateId, space);
  if (row.type === 0) throw new LibraryError('The space root cannot be renamed.');
  if (row.parentId == null) throw new LibraryError('That crate has no parent.');
  const stored = storedName(db, row.parentId, name, row.type, crateId);
  sqlRun(db, 'UPDATE container SET name = ? WHERE id = ?', [stored, crateId]);
  refreshFilenames(db, crateId);
  const warning = await mirrorContainerFields(db, crateId, { name: stored }, true);
  return { ok: true, id: crateId, name: displayName(stored), warning };
}

/**
 * Returns location-database ids for crates linked to location 3.
 *
 * @param db Open master connection.
 * @param crateIds Master container ids.
 * @returns External container ids.
 *
 * Side effects: none beyond the read.
 */
function externalIds(db: SqlDb, crateIds: number[]): number[] {
  if (!crateIds.length) return [];
  const marks = crateIds.map(() => '?').join(', ');
  return sqlAll(
    db,
    `SELECT external_container_id FROM location_container
     WHERE location_id = 3 AND external_container_id IS NOT NULL
       AND container_id IN (${marks})`,
    crateIds,
  ).map((row) => Number(row.external_container_id));
}

/**
 * Deletes crates and their membership rows.
 * The master schema keys membership by `location_container_id`. The location
 * schema keys it by `container_id`. The SQL follows the columns that exist.
 *
 * @param db Open write connection.
 * @param crateIds Container ids. The space root is not deleted.
 *
 * Side effects: deletes membership, filename, rule, and container rows.
 */
function deleteIds(db: SqlDb, crateIds: number[]): void {
  if (!crateIds.length) return;
  const marks = crateIds.map(() => '?').join(', ');
  const assetColumns = columns(db, 'container_asset');
  if (assetColumns.has('location_container_id')) {
    sqlRun(
      db,
      `DELETE FROM container_asset
       WHERE location_container_id IN (
         SELECT id FROM location_container WHERE container_id IN (${marks})
       )`,
      crateIds,
    );
    sqlRun(db, `DELETE FROM location_container WHERE container_id IN (${marks})`, crateIds);
  } else if (assetColumns.has('container_id')) {
    sqlRun(db, `DELETE FROM container_asset WHERE container_id IN (${marks})`, crateIds);
  }
  if (tables(db).has('smart_crate_rules')) {
    sqlRun(db, `DELETE FROM smart_crate_rules WHERE container_id IN (${marks})`, crateIds);
  }
  if (tables(db).has('dj_container_metadata')) {
    sqlRun(db, `DELETE FROM dj_container_metadata WHERE container_id IN (${marks})`, crateIds);
  }
  for (const crateId of [...crateIds].reverse()) {
    sqlRun(db, 'DELETE FROM container WHERE id = ? AND type != 0', [crateId]);
  }
}

/**
 * Deletes a crate, its descendants, and the mirrored rows.
 *
 * @param db Open master write connection.
 * @param space Space name.
 * @param crateId Container id.
 * @returns The deleted id and any mirror warning.
 *
 * Side effects: removes the crate from the master database and from `root.sqlite` when linked.
 */
async function deleteCrate(db: SqlDb, space: string, crateId: number): Promise<CrateResult> {
  const row = containerById(db, crateId, space);
  if (row.type === 0) throw new LibraryError('The space root cannot be deleted.');
  const ids = descendantIds(db, crateId);
  const external = externalIds(db, ids);
  deleteIds(db, ids);
  const rootPath = locationPaths(db).get(3) ?? null;
  let warning: string | null = null;
  if (external.length && rootPath) {
    warning = await withLocation(rootPath, (root) => {
      const whole: number[] = [];
      for (const externalId of external) whole.push(...descendantIds(root, externalId));
      deleteIds(root, [...new Set(whole)]);
      return null;
    });
  } else if (external.length) {
    warning = 'Deleted from the main library. The drive database was not connected.';
  }
  return { ok: true, id: crateId, warning };
}

/**
 * Copies crate columns into the linked row in `root.sqlite`.
 *
 * @param db Open master connection.
 * @param crateId Master container id.
 * @param values Columns to assign.
 * @param refreshNames True to rebuild export filenames after the assign.
 * @returns Null, or a warning when the crate is not linked to the main drive.
 *
 * Side effects: may update the linked container in `root.sqlite`.
 */
async function mirrorContainerFields(
  db: SqlDb,
  crateId: number,
  values: Record<string, SQLInputValue | undefined>,
  refreshNames = false,
): Promise<string | null> {
  const external = externalIds(db, [crateId]);
  const rootPath = locationPaths(db).get(3);
  if (!external.length || !rootPath) {
    return 'Saved in the main library. This crate is not linked to the main drive, so Serato may reconcile it later.';
  }
  return withLocation(rootPath, (root) => {
    const revision = nextRevision(root);
    assign(root, 'container', { ...values, revision }, 'id = ?', external[0]);
    if (refreshNames) refreshFilenames(root, external[0], revision);
    return null;
  });
}

/**
 * Returns the `location_container` row for a crate and a drive, creating it when needed.
 * A drive that has its own database must already store the crate. A drive
 * without a database file gets a row with no external id.
 *
 * @param db Open master write connection.
 * @param crateId Container id.
 * @param locationId Asset location id.
 * @returns The `location_container` id.
 *
 * Side effects: may insert a `location_container` row.
 */
function ensureLocationContainer(db: SqlDb, crateId: number, locationId: number): number {
  const row = sqlGet(
    db,
    'SELECT id FROM location_container WHERE container_id = ? AND location_id = ?',
    [crateId, locationId],
  );
  if (row) return Number(row.id);
  const paths = locationPaths(db);
  if (paths.has(locationId)) throw new LibraryError('That crate is not stored on the same drive as this track.');
  const inserted = sqlRun(
    db,
    `INSERT INTO location_container (container_id, location_id, external_container_id)
     VALUES (?, ?, NULL)`,
    [crateId, locationId],
  );
  return inserted.lastInsertRowid;
}

/**
 * Returns the `space_asset` id for a track.
 * `create` inserts the membership when it is missing. Crate membership does not create it.
 *
 * @param db Open write connection.
 * @param assetId Asset id.
 * @param space Space name.
 * @param create True inserts the membership when it is missing.
 * @returns The `space_asset` id.
 *
 * Side effects: may insert a `space_asset` row.
 */
function spaceAsset(db: SqlDb, assetId: number, space: string, create: boolean): number {
  const row = sqlGet(
    db,
    `SELECT sa.id FROM space_asset sa
     JOIN space s ON s.id = sa.space_id
     WHERE sa.asset_id = ? AND s.name = ?`,
    [assetId, space],
  );
  if (row) return Number(row.id);
  if (!create) throw new LibraryError('That track is not in this space.', 404);
  const inserted = sqlRun(db, 'INSERT INTO space_asset (asset_id, space_id) VALUES (?, ?)', [assetId, spaceId(db, space)]);
  return inserted.lastInsertRowid;
}

/**
 * Adds or removes a track from a normal crate.
 * Smart crates choose their own tracks. The space root is not a crate.
 *
 * @param db Open master write connection.
 * @param crateId Container id.
 * @param assetId Asset id.
 * @param space Space name.
 * @param add True adds the track. False removes it.
 * @returns The crate id and any mirror warning.
 *
 * Side effects: writes membership on the master and, when linked, on the location database.
 */
async function membership(db: SqlDb, crateId: number, assetId: number, space: string, add: boolean): Promise<CrateResult> {
  const row = containerById(db, crateId, space);
  if (row.type === 2) throw new LibraryError('Smart crates choose their tracks from rules.');
  if (row.type === 0) throw new LibraryError('Tracks live in a crate, not the space root.');
  const asset = assetLocation(db, assetId);
  spaceAsset(db, assetId, space, false);
  if (add) {
    const existing = sqlGet(
      db,
      `SELECT ca.id FROM container_asset ca
       JOIN location_container lc ON lc.id = ca.location_container_id
       WHERE lc.container_id = ? AND ca.asset_id = ?`,
      [crateId, assetId],
    );
    if (existing) return { ok: true, id: crateId, warning: null };
    if (asset.locationId == null) throw new LibraryError('That track has no drive location.');
    const locationContainerId = ensureLocationContainer(db, crateId, asset.locationId);
    const spaceAssetId = spaceAsset(db, assetId, space, false);
    const orderRow = sqlGet(
      db,
      `SELECT COALESCE(MAX(list_order), 0) + 1 AS n FROM container_asset
       WHERE location_container_id IN (SELECT id FROM location_container WHERE container_id = ?)`,
      [crateId],
    );
    sqlRun(
      db,
      `INSERT INTO container_asset
         (asset_id, location_container_id, space_asset_id, external_container_asset_id, list_order, time_added)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      [assetId, locationContainerId, spaceAssetId, Number(orderRow?.n ?? 1), Math.floor(Date.now() / 1000)],
    );
    return { ok: true, id: crateId, warning: await mirrorMembership(db, crateId, assetId, space, true) };
  }
  sqlRun(
    db,
    `DELETE FROM container_asset
     WHERE asset_id = ? AND location_container_id IN (
       SELECT id FROM location_container WHERE container_id = ?
     )`,
    [assetId, crateId],
  );
  return { ok: true, id: crateId, warning: await mirrorMembership(db, crateId, assetId, space, false) };
}

/**
 * Mirrors a crate membership change into the location database.
 * A track that does not live on the main drive is left for Serato to reconcile.
 *
 * @param db Open master connection.
 * @param crateId Master container id.
 * @param assetId Asset id.
 * @param space Space name.
 * @param add True adds the mirrored membership. False removes it.
 * @returns Null, or a warning when the drive database is left unchanged.
 *
 * Side effects: may write membership in the location database.
 */
async function mirrorMembership(db: SqlDb, crateId: number, assetId: number, space: string, add: boolean): Promise<string | null> {
  const external = externalIds(db, [crateId]);
  const asset = assetLocation(db, assetId);
  const paths = locationPaths(db);
  let rootPath = asset.locationId == null ? undefined : paths.get(asset.locationId);
  if (asset.locationId !== 3) rootPath = external.length ? paths.get(3) : undefined;
  if (!external.length || asset.externalId == null || !rootPath) {
    return "Saved in the main library. This track's drive is not connected, so the crate membership may be reconciled later.";
  }
  if (asset.locationId !== 3 && rootPath === paths.get(3)) {
    return "Saved in the main library. This track lives on another drive, so that drive's database was not changed.";
  }
  const externalAsset = asset.externalId;
  const externalCrate = external[0];
  return withLocation(rootPath, (root) => {
    const spaceRow = sqlGet(root, 'SELECT id FROM space WHERE name = ?', [space]);
    if (!spaceRow) return 'Saved in the main library. This space is not in the drive database.';
    const assetRow = sqlGet(
      root,
      'SELECT sa.id FROM space_asset sa WHERE sa.asset_id = ? AND sa.space_id = ?',
      [externalAsset, Number(spaceRow.id)],
    );
    const revision = nextRevision(root);
    if (add) {
      let spaceAssetId: number;
      if (!assetRow) {
        const inserted = sqlRun(
          root,
          'INSERT INTO space_asset (asset_id, space_id, revision) VALUES (?, ?, ?)',
          [externalAsset, Number(spaceRow.id), revision],
        );
        spaceAssetId = inserted.lastInsertRowid;
      } else {
        spaceAssetId = Number(assetRow.id);
      }
      const found = sqlGet(
        root,
        'SELECT id FROM container_asset WHERE container_id = ? AND space_asset_id = ?',
        [externalCrate, spaceAssetId],
      );
      if (!found) {
        const orderRow = sqlGet(
          root,
          'SELECT COALESCE(MAX(list_order), 0) + 1 AS n FROM container_asset WHERE container_id = ?',
          [externalCrate],
        );
        sqlRun(
          root,
          `INSERT INTO container_asset (revision, container_id, space_asset_id, list_order, time_added)
           VALUES (?, ?, ?, ?, ?)`,
          [revision, externalCrate, spaceAssetId, Number(orderRow?.n ?? 1), Math.floor(Date.now() / 1000)],
        );
      }
    } else if (assetRow) {
      sqlRun(
        root,
        'DELETE FROM container_asset WHERE container_id = ? AND space_asset_id = ?',
        [externalCrate, Number(assetRow.id)],
      );
    }
    return null;
  });
}
