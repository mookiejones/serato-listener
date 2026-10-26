/**
 * Library reads and writes against a temporary database.
 *
 * Each case points the master path at a throwaway file and closes it before
 * the directory is removed. The live Serato library is not opened. Tag cases
 * build their own ID3 bytes and do not touch a database.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { crateAction, crateFilename } from './crates';
import {
  clearBackupsForTests,
  defaultLibraryPath,
  defaultRootPath,
  fileManagerName,
  invalidateLibraryCache,
  libraryStatus,
  loadLibrary,
  masterPath,
  rootPath,
  openRead,
  processIsSerato,
  seratoProcessCommand,
  setMasterPathForTests,
  setProcessIsSeratoForTests,
  setProcessRunnerForTests,
  trackIdForFile,
} from './db';
import { LibraryError, SeratoOpen } from './errors';
import { buildDatabase } from './fixture';
import { answerLibrary } from './http';
import { parseBeatgrid, parseCue, parseMarkers2, readSeratoTags } from './tags';

/**
 * Points the library at a new fixture database.
 *
 * @returns The directory, the database path, and a stop function that restores the live path.
 *
 * Side effects: creates a temporary directory and redirects the process-wide master path.
 */
function useLibrary(): { dir: string; db: string; stop: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serato-lib-'));
  const db = path.join(dir, 'master.sqlite');
  buildDatabase(db);
  setMasterPathForTests(db);
  clearBackupsForTests();
  setProcessIsSeratoForTests(null);
  setProcessRunnerForTests(null);
  invalidateLibraryCache();
  return {
    dir,
    db,
    /**
     * Restores the live master path and deletes the temporary directory.
     *
     * Side effects: clears test hooks and removes the directory.
     */
    stop() {
      setMasterPathForTests(null);
      clearBackupsForTests();
      setProcessIsSeratoForTests(null);
      setProcessRunnerForTests(null);
      invalidateLibraryCache();
      const leaked = openHandles(db);
      fs.rmSync(dir, { recursive: true, force: true });
      if (leaked.length) {
        throw new Error(`The temporary library still has an open SQLite handle (${leaked[0]}).`);
      }
    },
  };
}

/**
 * Returns this process's open descriptors for a database and its sidecars.
 *
 * @param file Database path.
 * @returns Descriptor targets from `/proc`. Empty on systems without that directory.
 *
 * Side effects: none.
 */
function openHandles(file: string): string[] {
  const dir = path.join('/proc', String(process.pid), 'fd');
  if (!fs.existsSync(dir)) return [];
  const needle = path.normalize(file);
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    try {
      const target = fs.readlinkSync(path.join(dir, entry)).replace(/ \(deleted\)$/, '');
      const base = path.normalize(target);
      if (base === needle || base.startsWith(`${needle}-`)) found.push(target);
    } catch {
      // The descriptor closed while the directory was being read.
    }
  }
  return found;
}

/**
 * Runs a read against the fixture and closes the connection.
 *
 * @param file Database path.
 * @param fn Callback that receives the open database.
 * @returns Whatever the callback returns.
 *
 * Side effects: opens and closes `file`.
 */
function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Wraps one Markers2 record as a name, a length, and a payload.
 *
 * @param kind Entry name such as `CUE`, `LOOP`, or `FLIP`.
 * @param blob Record payload.
 * @returns The encoded entry.
 *
 * Side effects: none.
 */
function markerEntry(kind: string, blob: Buffer): Buffer {
  const name = Buffer.from(`${kind}\0`);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(blob.length, 0);
  return Buffer.concat([name, length, blob]);
}

/**
 * Builds a CUE record with the offsets `parseCue` expects.
 *
 * @param index Cue index stored at byte 1.
 * @param startMs Start time in milliseconds.
 * @param color Three RGB bytes.
 * @param name UTF-8 cue name.
 * @returns The record bytes.
 *
 * Side effects: none.
 */
function cueRecord(index: number, startMs: number, color: Buffer, name: string): Buffer {
  const raw = Buffer.alloc(13 + Buffer.byteLength(name) + 1);
  raw[1] = index;
  raw.writeUInt32BE(startMs, 2);
  color.copy(raw, 7);
  raw.write(name, 12, 'utf8');
  return raw;
}

/**
 * Builds a LOOP record with the offsets the parser expects.
 *
 * @param index Loop index.
 * @param startMs Loop start in milliseconds.
 * @param endMs Loop end in milliseconds.
 * @param locked True stores a lock flag of 1.
 * @param name UTF-8 loop name.
 * @returns The record bytes.
 *
 * Side effects: none.
 */
function loopRecord(index: number, startMs: number, endMs: number, locked: boolean, name: string): Buffer {
  const raw = Buffer.alloc(21 + Buffer.byteLength(name) + 1);
  raw[1] = index;
  raw.writeUInt32BE(startMs, 2);
  raw.writeUInt32BE(endMs, 6);
  raw[15] = 0x00;
  raw[16] = 0x11;
  raw[17] = 0x22;
  raw[19] = locked ? 1 : 0;
  raw.write(name, 20, 'utf8');
  return raw;
}

/**
 * Builds a FLIP record.
 *
 * @param index Flip index.
 * @param enabled True stores an enabled flag of 1.
 * @param name UTF-8 flip name.
 * @returns The record bytes.
 *
 * Side effects: none.
 */
function flipRecord(index: number, enabled: boolean, name: string): Buffer {
  return Buffer.concat([Buffer.from([0, index, enabled ? 1 : 0]), Buffer.from(name), Buffer.from([0])]);
}

/**
 * Encodes a cue, a loop, and a flip as a Markers2 GEOB body.
 *
 * @returns The Markers2 payload bytes.
 *
 * Side effects: none.
 */
function markersPayload(): Buffer {
  const decoded = Buffer.concat([
    markerEntry('CUE', cueRecord(3, 1500, Buffer.from([0xcc, 0x00, 0x00]), 'Drop')),
    markerEntry('LOOP', loopRecord(1, 2000, 4000, true, 'Break')),
    markerEntry('FLIP', flipRecord(2, true, 'Chop')),
  ]);
  return Buffer.concat([Buffer.from([0x01, 0x01]), Buffer.from(decoded.toString('base64'))]);
}

/**
 * Encodes a two-marker beatgrid at version 1.
 *
 * @returns The BeatGrid payload bytes.
 *
 * Side effects: none.
 */
function beatgridPayload(): Buffer {
  const body = Buffer.alloc(6 + 16);
  body[0] = 1;
  body.writeUInt32BE(2, 2);
  body.writeFloatBE(0.5, 6);
  body.writeUInt32BE(4, 10);
  body.writeFloatBE(10, 14);
  body.writeFloatBE(128, 18);
  return body;
}

/**
 * Writes a tiny ID3v2.3 file that holds one Serato Markers2 frame.
 *
 * @param payload Markers2 bytes stored in the GEOB frame.
 * @param file File to create or replace.
 *
 * Side effects: writes `file`.
 */
function writeId3(payload: Buffer, file: string): void {
  const description = Buffer.from('Serato Markers2\0');
  const body = Buffer.concat([
    Buffer.from([0]),
    Buffer.from('application/octet-stream\0'),
    Buffer.from([0]),
    description,
    payload,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  const frame = Buffer.concat([Buffer.from('GEOB'), size, Buffer.from([0, 0]), body]);
  const synchsafe = Buffer.from([
    (frame.length >> 21) & 0x7f,
    (frame.length >> 14) & 0x7f,
    (frame.length >> 7) & 0x7f,
    frame.length & 0x7f,
  ]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synchsafe, frame]));
}

/**
 * Creates a location database beside the fixture and points location 3 at it.
 *
 * @param dir Directory that holds `master.sqlite`.
 * @returns The `root.sqlite` path.
 *
 * Side effects: writes `root.sqlite` and a connection row in the master database.
 */
function attachRoot(dir: string): string {
  const root = path.join(dir, 'root.sqlite');
  const db = new DatabaseSync(root);
  try {
    db.exec(`
      CREATE TABLE space (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE serato (revision INTEGER);
      CREATE TABLE container (
        id INTEGER PRIMARY KEY,
        revision INTEGER,
        parent_id INTEGER,
        name TEXT,
        type INTEGER,
        list_order INTEGER,
        space_id INTEGER,
        time_added INTEGER,
        expanded INTEGER,
        portable_id TEXT,
        color INTEGER
      );
      CREATE TABLE container_asset (
        id INTEGER PRIMARY KEY,
        revision INTEGER,
        container_id INTEGER,
        space_asset_id INTEGER,
        list_order INTEGER,
        time_added INTEGER
      );
      CREATE TABLE space_asset (
        id INTEGER PRIMARY KEY,
        asset_id INTEGER,
        space_id INTEGER,
        revision INTEGER
      );
      CREATE TABLE asset (id INTEGER PRIMARY KEY, portable_id TEXT);
      CREATE TABLE smart_crate_rules (
        container_id INTEGER PRIMARY KEY,
        revision INTEGER,
        version INTEGER,
        rules TEXT,
        needs_refresh INTEGER
      );
      CREATE TABLE dj_container_metadata (
        container_id INTEGER PRIMARY KEY,
        revision INTEGER,
        export_state INTEGER,
        filename TEXT
      );
    `);
    db.exec("INSERT INTO serato (revision) VALUES (1)");
    db.exec("INSERT INTO space (id, name) VALUES (1, 'Serato Library')");
    db.exec("INSERT INTO container (id, parent_id, name, type, list_order, space_id, time_added) VALUES (1, NULL, 'Library', 0, 0, 1, 1)");
    db.exec("INSERT INTO asset (id, portable_id) VALUES (1, 'Music/same-a.mp3')");
  } finally {
    db.close();
  }
  withDb(path.join(dir, 'master.sqlite'), (master) => {
    master.prepare('INSERT INTO connection (location_id, database_uri) VALUES (3, ?)').run(pathToFileURL(root).href);
    master.prepare('UPDATE asset SET location_id = 3, external_id = 1 WHERE id = 1').run();
  });
  return root;
}

test('default library path follows the operating system', () => {
  assert.equal(
    defaultLibraryPath({ platform: 'darwin', home: '/Users/dj' }),
    path.join('/Users/dj', 'Library', 'Application Support', 'Serato', 'Library', 'master.sqlite'),
  );
  assert.equal(
    defaultLibraryPath({ platform: 'win32', localAppData: 'C:\\Users\\dj\\AppData\\Local' }),
    path.win32.join('C:\\Users\\dj\\AppData\\Local', 'Serato', 'Library', 'master.sqlite'),
  );
  assert.equal(
    defaultLibraryPath({ platform: 'win32', home: 'C:\\Users\\dj', localAppData: null }),
    path.win32.join('C:\\Users\\dj', 'AppData', 'Local', 'Serato', 'Library', 'master.sqlite'),
  );
  assert.equal(
    defaultRootPath({ platform: 'darwin', home: '/Users/dj' }),
    path.join('/Users/dj', 'Library', 'Application Support', 'Serato', 'Library', 'root.sqlite'),
  );
  assert.equal(
    defaultRootPath({ platform: 'win32', localAppData: 'C:\\Users\\dj\\AppData\\Local' }),
    path.win32.join('C:\\Users\\dj\\AppData\\Local', 'Serato', 'Library', 'root.sqlite'),
  );
});

test('file manager name follows the operating system', () => {
  assert.equal(fileManagerName('darwin'), 'Finder');
  assert.equal(fileManagerName('win32'), 'File Explorer');
  assert.equal(seratoProcessCommand(42, 'darwin').command, 'ps');
  assert.deepEqual(seratoProcessCommand(42, 'linux').args.slice(0, 2), ['-p', '42']);
  assert.equal(seratoProcessCommand(99, 'win32').command, 'tasklist');
});

test('process check uses ps on unix and tasklist on windows', () => {
  const calls: string[][] = [];
  setProcessRunnerForTests((command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: command === 'tasklist' ? '"Serato DJ Pro.exe","99"' : 'Serato DJ Pro\n' };
  });
  try {
    assert.equal(processIsSerato(42, 'darwin'), true);
    assert.equal(processIsSerato(99, 'win32'), true);
    assert.equal(calls[0][0], 'ps');
    assert.equal(calls[1][0], 'tasklist');
    assert.equal(processIsSerato(0, 'darwin'), false);
  } finally {
    setProcessRunnerForTests(null);
  }
});

test('status is writable without a lock', () => {
  const temp = useLibrary();
  try {
    const info = libraryStatus();
    assert.equal(info.writable, true);
    assert.equal(info.open, false);
    assert.equal(info.file_manager, fileManagerName());
    assert.equal(path.basename(masterPath()), 'master.sqlite');
    assert.equal(rootPath(), path.join(temp.dir, 'root.sqlite'));
  } finally {
    temp.stop();
  }
});

test('status blocks a live Serato process before a backup', async () => {
  const temp = useLibrary();
  try {
    withDb(temp.db, (db) => {
      db.prepare("INSERT INTO lock (owner_process_id, owner_process_name) VALUES (99, 'Serato DJ Pro')").run();
    });
    setProcessIsSeratoForTests(() => true);
    const info = libraryStatus();
    assert.equal(info.writable, false);
    assert.equal(info.pid, 99);
    await assert.rejects(() => crateAction({ action: 'create', name: 'Blocked' }), (err: unknown) => {
      return err instanceof SeratoOpen && err.status === 409;
    });
    assert.equal(fs.existsSync(path.join(temp.dir, 'Backups')), false);
  } finally {
    temp.stop();
  }
});

test('loads tracks, crates, and metadata', () => {
  const temp = useLibrary();
  try {
    const library = loadLibrary();
    assert.equal(library.track_count, 2);
    assert.equal(library.tracks[0].name, 'Same');
    assert.equal(library.tracks[0].artist, 'Artist');
    assert.equal(library.tracks[0].bpm, 120);
    assert.equal(library.tracks[0].key, '1A');
    assert.equal(library.tracks[0].portable_id, 'Music/same-a.mp3');
    assert.equal(library.root_id, 1);
    assert.equal(library.crates.length, 0);
    assert.equal(library.writable, true);
  } finally {
    temp.stop();
  }
});

test('cache invalidates when the database or wal mtime changes', () => {
  const temp = useLibrary();
  try {
    assert.equal(loadLibrary().track_count, 2);
    const stamp = `${temp.db}.stamp`;
    const copied = spawnSync('cp', ['-p', temp.db, stamp]);
    assert.equal(copied.status, 0);
    withDb(temp.db, (db) => {
      db.prepare(
        "INSERT INTO asset (id, name, artist, portable_id, location_id) VALUES (9, 'New', 'Artist', 'Music/new.mp3', 1)",
      ).run();
      db.prepare('INSERT INTO space_asset (id, asset_id, space_id) VALUES (9, 9, 1)').run();
    });
    // Put the original nanosecond mtime back so the cache key matches the first read.
    const restored = spawnSync('touch', ['-r', stamp, temp.db]);
    assert.equal(restored.status, 0);
    assert.equal(loadLibrary().track_count, 2);
    const wal = `${temp.db}-wal`;
    fs.writeFileSync(wal, '');
    assert.equal(loadLibrary().track_count, 3);
    assert.equal(loadLibrary().tracks.some((track) => track.name === 'New'), true);
  } finally {
    temp.stop();
  }
});

test('links a live deck file path to its library track', () => {
  const temp = useLibrary();
  try {
    const audio = path.join(temp.dir, 'same-a.mp3');
    fs.writeFileSync(audio, 'not audio');
    withDb(temp.db, (db) => {
      db.prepare('UPDATE asset SET portable_id = ? WHERE id = 1').run(audio);
    });
    invalidateLibraryCache();
    const library = loadLibrary(null, [{ deck: 0, filepath: audio, title: 'Same', artist: 'Artist' }]);
    assert.equal(library.decks[0].track_id, 1);
    assert.equal(trackIdForFile(library.tracks, path.join(temp.dir, 'other.mp3')), null);
  } finally {
    temp.stop();
  }
});

test('crate create, add, rename, remove, and delete', async () => {
  const temp = useLibrary();
  try {
    const created = await crateAction({ action: 'create', name: 'Warmup' });
    const added = await crateAction({ action: 'add', id: created.id, asset: 1 });
    assert.equal(added.ok, true);
    const library = loadLibrary();
    const crate = library.crates.find((item) => item.name === 'Warmup');
    assert.ok(crate);
    assert.deepEqual(crate.tracks, [1]);
    assert.equal(crate.filename, 'Warmup.crate');
    const renamed = await crateAction({ action: 'rename', id: created.id, name: 'Evening' });
    assert.equal(renamed.name, 'Evening');
    await crateAction({ action: 'remove', id: created.id, asset: 1 });
    const child = await crateAction({ action: 'create', name: 'Drums', parent: created.id });
    const after = loadLibrary();
    const parent = after.crates.find((item) => item.id === created.id);
    const nested = after.crates.find((item) => item.id === child.id);
    assert.equal(parent?.filename, 'Evening.crate');
    assert.equal(nested?.filename, 'Evening%%Drums.crate');
    assert.deepEqual(parent?.tracks, []);
    await crateAction({ action: 'delete', id: created.id });
    const left = withDb(temp.db, (db) => {
      return db.prepare("SELECT COUNT(*) AS n FROM container WHERE name IN ('Warmup', 'Evening', 'Drums')").get() as { n: number };
    });
    assert.equal(left.n, 0);
    const backups = fs.readdirSync(path.join(temp.dir, 'Backups')).filter((name) => name.startsWith('serato-web-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.existsSync(path.join(temp.dir, 'Backups', backups[0], 'master.sqlite')), true);
  } finally {
    temp.stop();
  }
});

test('mirrors crates into root.sqlite with crate and scrate paths', async () => {
  const temp = useLibrary();
  try {
    const root = attachRoot(temp.dir);
    const created = await crateAction({ action: 'create', name: 'Warmup' });
    const smart = await crateAction({ action: 'create', name: 'Fresh', smart: true, parent: created.id });
    await crateAction({ action: 'add', id: created.id, asset: 1 });
    const masterName = withDb(temp.db, (db) => {
      return db.prepare('SELECT filename FROM dj_container_metadata WHERE container_id = ?').get(smart.id) as { filename: string };
    });
    assert.equal(masterName.filename, 'Warmup%%Fresh.scrate');
    const mirrored = withDb(root, (db) => {
      const crates = db.prepare("SELECT name, type FROM container WHERE type != 0 ORDER BY id").all() as Array<{ name: string; type: number }>;
      const files = db.prepare('SELECT filename FROM dj_container_metadata ORDER BY container_id').all() as Array<{ filename: string }>;
      const members = db.prepare('SELECT COUNT(*) AS n FROM container_asset').get() as { n: number };
      return { crates, files, members };
    });
    assert.deepEqual(mirrored.crates.map((crate) => crate.name), ['Warmup', 'Fresh']);
    assert.equal(mirrored.crates[1].type, 2);
    assert.deepEqual(mirrored.files.map((file) => file.filename), ['Warmup.crate', 'Warmup%%Fresh.scrate']);
    assert.equal(mirrored.members.n, 1);
    const backups = fs.readdirSync(path.join(temp.dir, 'Backups'));
    assert.equal(fs.existsSync(path.join(temp.dir, 'Backups', backups[0], 'root.sqlite')), true);
    await crateAction({ action: 'delete', id: created.id });
    const remaining = withDb(root, (db) => {
      return db.prepare('SELECT COUNT(*) AS n FROM container WHERE type != 0').get() as { n: number };
    });
    assert.equal(remaining.n, 0);
  } finally {
    temp.stop();
  }
});

test('parent 0 is not the space root and an unknown action rolls back', async () => {
  const temp = useLibrary();
  try {
    await assert.rejects(
      () => crateAction({ action: 'create', name: 'Orphan', parent: 0 }),
      (err: unknown) => err instanceof LibraryError && err.status === 404,
    );
    const before = withDb(temp.db, (db) => (db.prepare('SELECT COUNT(*) AS n FROM container').get() as { n: number }).n);
    await assert.rejects(() => crateAction({ action: 'explode' }), (err: unknown) => err instanceof LibraryError);
    const after = withDb(temp.db, (db) => (db.prepare('SELECT COUNT(*) AS n FROM container').get() as { n: number }).n);
    assert.equal(after, before);
  } finally {
    temp.stop();
  }
});

test('a disallowed space is rejected', () => {
  const temp = useLibrary();
  try {
    assert.throws(() => loadLibrary('Streaming'), (err: unknown) => err instanceof LibraryError);
  } finally {
    temp.stop();
  }
});

test('http library, crate, and tag routes', async () => {
  const temp = useLibrary();
  try {
    const missing = await answerLibrary({
      method: 'GET',
      pathname: '/api/library',
      searchParams: new URLSearchParams(),
      fromClient: false,
    });
    assert.equal(missing?.status, 200);
    const body = missing?.body as { track_count: number };
    assert.equal(body.track_count, 2);

    const forbidden = await answerLibrary({
      method: 'POST',
      pathname: '/api/crates',
      searchParams: new URLSearchParams(),
      fromClient: false,
      body: { action: 'create', name: 'Nope' },
    });
    assert.equal(forbidden?.status, 403);

    const created = await answerLibrary({
      method: 'POST',
      pathname: '/api/crates',
      searchParams: new URLSearchParams(),
      fromClient: true,
      body: { action: 'create', name: 'Warmup' },
    });
    assert.equal(created?.status, 200);

    const audio = path.join(temp.dir, 'tagged.mp3');
    writeId3(markersPayload(), audio);
    withDb(temp.db, (db) => {
      db.prepare('UPDATE asset SET portable_id = ? WHERE id = 1').run(audio);
    });
    const tags = await answerLibrary({
      method: 'GET',
      pathname: '/api/tracks/1/tags',
      searchParams: new URLSearchParams(),
      fromClient: false,
    });
    assert.equal(tags?.status, 200);
    const parsed = tags?.body as { tags: { found: boolean; cues: Array<{ index: number; name: string }> } };
    assert.equal(parsed.tags.found, true);
    assert.equal(parsed.tags.cues[0].index, 3);
    assert.equal(parsed.tags.cues[0].name, 'Drop');

    const absent = await answerLibrary({
      method: 'GET',
      pathname: '/api/tracks/99/tags',
      searchParams: new URLSearchParams(),
      fromClient: false,
    });
    assert.equal(absent?.status, 404);

    setMasterPathForTests(path.join(temp.dir, 'missing.sqlite'));
    const gone = await answerLibrary({
      method: 'GET',
      pathname: '/api/library',
      searchParams: new URLSearchParams(),
      fromClient: false,
    });
    assert.equal(gone?.status, 404);
  } finally {
    temp.stop();
  }
});

test('tag parser reads cues, loops, flips, and beatgrids', () => {
  assert.equal(readSeratoTags(null).found, false);
  assert.equal(parseCue(Buffer.alloc(5)), null);
  const parsed = parseMarkers2(markersPayload());
  assert.equal(parsed.cues[0].name, 'Drop');
  assert.equal(parsed.cues[0].start_ms, 1500);
  assert.equal(parsed.cues[0].color, '#CC0000');
  assert.equal(parsed.loops[0].end_ms, 4000);
  assert.equal(parsed.loops[0].locked, true);
  assert.equal(parsed.loops[0].color, '#001122');
  assert.equal(parsed.flips[0].name, 'Chop');
  assert.equal(parsed.flips[0].enabled, true);
  const markers = parseBeatgrid(beatgridPayload());
  assert.equal(markers[0].beats, 4);
  assert.equal(markers[1].bpm, 128);
  assert.equal(markers[0].position, 0.5);
  assert.deepEqual(parseBeatgrid(Buffer.from([2, 0, 0, 0, 0, 1])), []);
  const huge = Buffer.alloc(6);
  huge[0] = 1;
  huge.writeUInt32BE(4097, 2);
  assert.deepEqual(parseBeatgrid(huge), []);
  const short = Buffer.alloc(10);
  short[0] = 1;
  short.writeUInt32BE(2, 2);
  short.writeFloatBE(1, 6);
  assert.deepEqual(parseBeatgrid(short), []);
  const bad = parseMarkers2(Buffer.from([0x01, 0x01, 0x40]));
  assert.deepEqual(bad.cues, []);
  assert.deepEqual(bad.loops, []);
  assert.deepEqual(bad.flips, []);
});

test('crate filename helper is not required for the http surface', () => {
  const temp = useLibrary();
  try {
    const db = openRead();
    try {
      assert.equal(crateFilename(db, 1, 0).endsWith('.crate') || crateFilename(db, 1, 0) === '.crate', true);
    } finally {
      db.close();
    }
  } finally {
    temp.stop();
  }
});
