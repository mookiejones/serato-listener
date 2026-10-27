/**
 * Related-track ranking against a temporary library and sidecar.
 *
 * The cases point the master path at a throwaway file. They do not open a
 * live Serato library. The HTTP case starts the listener without a Bonjour
 * advert and closes it before the directory is removed.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildDatabase } from './fixture';
import { invalidateLibraryCache, setMasterPathForTests, type PlayingDeckInput } from './db';
import { answerLibrary } from './http';
import {
  RELATED_LIMIT,
  bpmDistance,
  currentRelatedPath,
  keysCompatible,
  relatedForDeck,
  relatedForPath,
  type RelatedBody,
  type RelatedMatch,
} from './related';
import {
  RELATED_SCHEMA_SQL,
  defaultRelatedPath,
  identityPath,
  sameTrackPath,
  setRelatedPathForTests,
} from './related-store';
import { start } from '../server';

/**
 * Points the library at a new fixture database.
 *
 * @returns The directory, the database path, and a stop function.
 *
 * Side effects: creates a temporary directory and redirects the master path.
 */
function useLibrary(): { dir: string; db: string; related: string; stop: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serato-related-'));
  const db = path.join(dir, 'master.sqlite');
  const related = path.join(dir, 'related.sqlite');
  buildDatabase(db);
  setMasterPathForTests(db);
  setRelatedPathForTests(related);
  invalidateLibraryCache();
  return {
    dir,
    db,
    related,
    /**
     * Restores the live paths and deletes the temporary directory.
     *
     * Side effects: clears test hooks and removes the directory.
     */
    stop() {
      setMasterPathForTests(null);
      setRelatedPathForTests(null);
      invalidateLibraryCache();
      const leaked = openHandles(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      if (leaked.length) throw new Error(`The temporary library still has an open SQLite handle (${leaked[0]}).`);
    },
  };
}

/**
 * Returns this process's open descriptors inside a directory.
 *
 * @param dir Directory whose files should not stay open.
 * @returns Descriptor targets from `/proc`. Empty on systems without that directory.
 *
 * Side effects: none.
 */
function openHandles(dir: string): string[] {
  const fdDir = path.join('/proc', String(process.pid), 'fd');
  if (!fs.existsSync(fdDir)) return [];
  const root = path.normalize(dir + path.sep);
  const found: string[] = [];
  for (const entry of fs.readdirSync(fdDir)) {
    try {
      const target = fs.readlinkSync(path.join(fdDir, entry)).replace(/ \(deleted\)$/, '');
      const base = path.normalize(target);
      if (base === path.normalize(dir) || base.startsWith(root)) found.push(target);
    } catch {
      // The descriptor closed while the directory was being read.
    }
  }
  return found;
}

/**
 * Runs statements against a database and closes it.
 *
 * @param file Database path.
 * @param fn Callback that receives the open database.
 *
 * Side effects: opens and closes `file`.
 */
function withDb(file: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/** Timestamp stored on sidecar rows. The reader does not compare it. */
const SIDECAR_STAMP = '2026-01-01T00:00:00Z';

/**
 * Creates a version-1 sidecar and lets the caller insert rows.
 *
 * @param file Sidecar path.
 * @param fill Inserts tracks and links.
 *
 * Side effects: creates `file` and closes it.
 */
function writeSidecar(file: string, fill: (db: DatabaseSync) => void): void {
  withDb(file, (db) => {
    db.exec(RELATED_SCHEMA_SQL);
    db.exec('PRAGMA user_version = 1');
    fill(db);
  });
}

/**
 * Inserts one sidecar track. The stored path is the canonical identity of `portable`.
 *
 * @param db Open sidecar.
 * @param id Sidecar track id.
 * @param portable Live path or portable id.
 * @param title Track title.
 * @param artist Track artist.
 * @param lengthMs Length in milliseconds, or null.
 *
 * Side effects: inserts one `track` row.
 */
function insertSidecarTrack(
  db: DatabaseSync,
  id: number,
  portable: string,
  title: string,
  artist: string,
  lengthMs: number | null,
): void {
  const stored = identityPath(portable);
  assert.ok(stored);
  db.prepare(
    'INSERT INTO track (id, path, title, artist, length_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, stored, title, artist, lengthMs, SIDECAR_STAMP, SIDECAR_STAMP);
}

/**
 * Inserts one directional link.
 *
 * @param db Open sidecar.
 * @param id Link id. Saved matches are ordered by this.
 * @param fromId Sidecar track the link starts from.
 * @param toId Sidecar track the link points at.
 * @param mutual 1 when the other track can see the link too.
 * @param note Note text. Blank becomes null in the payload.
 * @param rating Rating from 1 to 5, or null.
 *
 * Side effects: inserts one `link` row.
 */
function insertLink(
  db: DatabaseSync,
  id: number,
  fromId: number,
  toId: number,
  mutual: 0 | 1,
  note: string,
  rating: number | null,
): void {
  db.prepare(
    `INSERT INTO link (id, from_track_id, to_track_id, mutual, note, rating, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, fromId, toId, mutual, note, rating, SIDECAR_STAMP, SIDECAR_STAMP);
}

/**
 * Inserts one library track in the Serato Library space.
 *
 * @param db Open master database.
 * @param id Asset id. The space-asset id uses the same number.
 * @param name Track title.
 * @param bpm Tempo.
 * @param key Camelot key.
 * @param portableId Stored path.
 *
 * Side effects: inserts into `asset` and `space_asset`.
 */
function insertTrack(db: DatabaseSync, id: number, name: string, bpm: number, key: string, portableId: string): void {
  db.prepare(
    `INSERT INTO asset (id, name, artist, bpm, key, portable_id, is_missing, location_id)
     VALUES (?, ?, 'DJ', ?, ?, ?, 0, 1)`,
  ).run(id, name, bpm, key, portableId);
  db.prepare('INSERT INTO space_asset (id, asset_id, space_id) VALUES (?, ?, 1)').run(id, id);
}

/**
 * Returns the track ids of the matches, using null when a saved path did not resolve.
 *
 * @param body Related payload.
 * @returns Ids in display order.
 *
 * Side effects: none.
 */
function matchIds(body: RelatedBody): Array<number | null> {
  return body.matches.map((match) => match.track_id);
}

test('Camelot neighbors, relatives, and the BPM window', () => {
  assert.equal(keysCompatible('8A', '8A'), true);
  assert.equal(keysCompatible('8A', '9A'), true);
  assert.equal(keysCompatible('8A', '7A'), true);
  assert.equal(keysCompatible('12A', '1A'), true);
  assert.equal(keysCompatible('8A', '8B'), true);
  assert.equal(keysCompatible('Am', '8A'), true);
  assert.equal(keysCompatible('Am', 'C'), true);
  assert.equal(keysCompatible('Fm', '4A'), true);
  assert.equal(keysCompatible('8A', '9B'), false);
  assert.equal(keysCompatible('1A', '2B'), false);
  assert.equal(keysCompatible('12A', '1B'), false);
  assert.equal(keysCompatible('8A', '3A'), false);
  assert.equal(keysCompatible('8A', ''), false);
  assert.equal(keysCompatible('8A', 'not a key'), false);

  assert.equal(bpmDistance(128, 64), 0);
  assert.equal(bpmDistance(128, 256), 0);
  assert.equal(bpmDistance(100, 50), 0);
  assert.equal(bpmDistance(100, 200), 0);
  assert.notEqual(bpmDistance(128, 135), null);
  assert.notEqual(bpmDistance(100, 106), null);
  assert.equal(bpmDistance(100, 107), null);
  assert.equal(bpmDistance(128, 140), null);
  assert.equal(bpmDistance(128, 32), null);
  assert.equal(bpmDistance(128, 512), null);
  assert.equal(bpmDistance(0, 120), null);
  assert.equal(bpmDistance(120, -1), null);

  assert.equal(sameTrackPath('C:\\Music\\a.mp3', 'c:/music/a.mp3'), true);
  assert.equal(sameTrackPath('/Users/dj/Music/a.mp3', 'Music/a.mp3'), true);
  assert.equal(sameTrackPath('Music/a.mp3', 'Music/b.mp3'), false);
  assert.equal(sameTrackPath('', 'Music/a.mp3'), false);
});

test('a missing sidecar still suggests a harmonic match and does not create the file', () => {
  const temp = useLibrary();
  try {
    const body = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3', title: 'Same', artist: 'Artist' }], 0);
    assert.equal(body.sidecar, 'missing');
    assert.equal(body.track_id, 1);
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].source, 'suggestion');
    assert.equal(body.matches[0].track_id, 2);
    assert.equal(body.matches[0].rating, null);
    assert.deepEqual(body.matches[0].reasons, ['key', 'bpm']);
    assert.equal(fs.existsSync(temp.related), false);
    assert.equal(currentRelatedPath(), temp.related);
  } finally {
    temp.stop();
  }
});

test('an unreadable sidecar and a database that is not version 1 still leave suggestions', () => {
  const temp = useLibrary();
  try {
    fs.writeFileSync(temp.related, 'not a database');
    const broken = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(broken.sidecar, 'unavailable');
    assert.equal(broken.matches[0].track_id, 2);
    fs.rmSync(temp.related);

    withDb(temp.related, (db) => {
      db.exec(RELATED_SCHEMA_SQL);
      db.exec('PRAGMA user_version = 2');
      insertSidecarTrack(db, 1, 'Music/same-a.mp3', 'Same', 'Artist', 180000);
      insertSidecarTrack(db, 2, 'Music/same-b.mp3', 'Same', 'Artist', 180500);
      insertLink(db, 1, 1, 2, 0, 'from a future schema', 5);
    });
    const future = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(future.sidecar, 'schema');
    assert.equal(future.matches[0].source, 'suggestion');
    assert.equal(future.matches[0].track_id, 2);
    assert.equal(future.matches[0].note, null);
    assert.equal(future.matches.some((match) => match.source === 'saved'), false);

    fs.rmSync(temp.related);
    withDb(temp.related, (db) => {
      db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    });
    const schema = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(schema.sidecar, 'schema');
    assert.equal(schema.matches[0].source, 'suggestion');
  } finally {
    temp.stop();
  }
});

test('saved matches rank first, then crate, key, and tempo', async () => {
  const temp = useLibrary();
  try {
    withDb(temp.db, (db) => {
      const tracks: Array<[number, string, number, string, string]> = [
        [10, 'Source', 128, '8A', 'Music/source.mp3'],
        [11, 'Bravo', 64, '8B', 'Music/bravo.mp3'],
        [12, 'Alpha', 128, '8A', 'Music/alpha.mp3'],
        [13, 'Echo', 256, '8A', 'Music/echo.mp3'],
        [14, 'Charlie', 130, '9A', 'Music/charlie.mp3'],
        [15, 'Delta', 122, '7A', 'Music/delta.mp3'],
        [16, 'OffBpm', 140, '8A', 'Music/off-bpm.mp3'],
        [17, 'OffKey', 128, '3A', 'Music/off-key.mp3'],
        [18, 'CrateOnly', 100, '1A', 'Music/crate-only.mp3'],
        [19, 'OtherDeck', 128, '8A', 'Music/other-deck.mp3'],
        [20, 'SavedOdd', 90, '1A', 'Music/saved-odd.mp3'],
        [21, 'SavedSecond', 128, '8A', 'Music/saved-second.mp3'],
      ];
      for (const [id, name, bpm, key, portable] of tracks) insertTrack(db, id, name, bpm, key, portable);
      db.exec(
        `INSERT INTO container (id, parent_id, name, type, list_order, space_id, time_added, expanded, portable_id)
         VALUES (10, 1, 'House', 1, 1, 1, 1, 0, ''), (11, 1, 'Peak', 1, 2, 1, 1, 0, '')`,
      );
      db.exec(
        `INSERT INTO location_container (id, container_id, location_id, external_container_id)
         VALUES (10, 10, 1, 10), (11, 11, 1, 11)`,
      );
      const members: Array<[number, number, number]> = [
        [100, 10, 10],
        [101, 11, 10],
        [102, 12, 10],
        [103, 18, 10],
        [104, 10, 11],
        [105, 11, 11],
      ];
      const insertMember = db.prepare(
        'INSERT INTO container_asset (id, asset_id, location_container_id, list_order, container_id) VALUES (?, ?, ?, 0, ?)',
      );
      for (const [id, asset, locationContainer] of members) {
        insertMember.run(id, asset, locationContainer, locationContainer === 10 ? 10 : 11);
      }
    });
    writeSidecar(temp.related, (db) => {
      insertSidecarTrack(db, 1, 'Music/source.mp3', 'Source', 'DJ', null);
      insertSidecarTrack(db, 2, 'Music/external.mp3', 'External', 'Guest', null);
      insertSidecarTrack(db, 3, 'Music/saved-odd.mp3', 'SavedOdd', 'DJ', null);
      insertSidecarTrack(db, 4, 'Music/saved-second.mp3', 'SavedSecond', 'DJ', null);
      insertSidecarTrack(db, 5, 'Music/off-key.mp3', 'OffKey', 'DJ', null);
      insertLink(db, 1, 1, 2, 0, 'opens the floor', 5);
      insertLink(db, 2, 1, 3, 0, 'warm', 3);
      insertLink(db, 3, 4, 1, 1, 'both ways', null);
      insertLink(db, 4, 5, 1, 0, 'hidden', 1);
    });
    fs.chmodSync(temp.related, 0o444);
    invalidateLibraryCache();

    const decks: PlayingDeckInput[] = [
      { deck: 0, filepath: 'Music/source.mp3', title: 'Live Source', artist: 'Live DJ' },
      { deck: 1, filepath: 'Music/other-deck.mp3', title: 'OtherDeck', artist: 'DJ' },
    ];
    const body = relatedForDeck(decks, 0);
    assert.equal(body.ok, true);
    assert.equal(body.sidecar, 'ok');
    assert.equal(body.track_id, 10);
    assert.equal(body.title, 'Live Source');
    assert.equal(body.artist, 'Live DJ');
    assert.equal(body.key, '8A');
    assert.equal(body.bpm, 128);
    assert.deepEqual(matchIds(body), [null, 20, 21, 11, 12, 13, 14, 15]);
    assert.equal(body.matches[0].title, 'External');
    assert.equal(body.matches[0].artist, 'Guest');
    assert.equal(body.matches[0].filepath, identityPath('Music/external.mp3'));
    assert.equal(body.matches[0].note, 'opens the floor');
    assert.equal(body.matches[0].rating, 5);
    assert.deepEqual(body.matches[0].reasons, ['saved']);
    assert.equal(body.matches[1].title, 'SavedOdd');
    assert.equal(body.matches[1].note, 'warm');
    assert.equal(body.matches[1].rating, 3);
    assert.equal(body.matches[2].source, 'saved');
    assert.equal(body.matches[2].note, 'both ways');
    assert.equal(body.matches[2].rating, null);
    assert.equal(body.matches.some((match) => match.note === 'hidden'), false);
    const bravo = body.matches[3];
    assert.equal(bravo.title, 'Bravo');
    assert.deepEqual(bravo.reasons, ['key', 'bpm', 'crate']);
    assert.deepEqual(bravo.crates, ['House', 'Peak']);
    assert.equal(body.matches[4].title, 'Alpha');
    assert.deepEqual(body.matches[4].crates, ['House']);
    assert.deepEqual(body.matches[5].reasons, ['key', 'bpm']);
    assert.equal(body.matches[5].bpm, 256);
    const absent = new Set(matchIds(body));
    for (const id of [10, 16, 17, 18, 19, 1, 2]) assert.equal(absent.has(id), false);

    const byPath = relatedForPath(decks, 'Music/source.mp3');
    assert.equal(byPath.deck, null);
    assert.equal(byPath.title, 'Source');
    assert.deepEqual(matchIds(byPath), matchIds(body));

    const routed = await answerLibrary({
      method: 'GET',
      pathname: '/api/related',
      searchParams: new URLSearchParams({ deck: '0' }),
      fromClient: false,
      decks,
    });
    assert.equal(routed?.status, 200);
    assert.deepEqual(matchIds(routed?.body as RelatedBody), matchIds(body));
    const byQuery = await answerLibrary({
      method: 'GET',
      pathname: '/api/related',
      searchParams: new URLSearchParams({ path: 'Music/source.mp3' }),
      fromClient: false,
      decks,
    });
    assert.equal(byQuery?.status, 200);
    assert.deepEqual(matchIds(byQuery?.body as RelatedBody), matchIds(body));
  } finally {
    temp.stop();
  }
});

test('suggestions stop at the cap after the saved match', () => {
  const temp = useLibrary();
  try {
    withDb(temp.db, (db) => {
      db.prepare("UPDATE asset SET key = '6A', bpm = 90 WHERE id = 2").run();
      for (let i = 0; i < 12; i += 1) {
        const id = 30 + i;
        insertTrack(db, id, `N${id}`, 120 + i * 0.1, '1A', `Music/n${id}.mp3`);
      }
      insertTrack(db, 50, 'Saved', 90, '6A', 'Music/saved.mp3');
    });
    writeSidecar(temp.related, (db) => {
      insertSidecarTrack(db, 1, 'Music/same-a.mp3', 'Same', 'Artist', 180000);
      insertSidecarTrack(db, 2, 'Music/saved.mp3', 'Saved', 'DJ', null);
      insertLink(db, 1, 1, 2, 0, '', null);
    });
    invalidateLibraryCache();
    const body = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3', title: 'Same', artist: 'Artist' }], 0);
    assert.equal(body.matches.length, RELATED_LIMIT);
    assert.equal(body.matches[0].source, 'saved');
    assert.equal(body.matches[0].track_id, 50);
    assert.deepEqual(
      body.matches.slice(1).map((match: RelatedMatch) => match.track_id),
      [30, 31, 32, 33, 34, 35, 36, 37, 38],
    );
    assert.equal(body.matches.some((match) => match.track_id === 39 || match.track_id === 2), false);
  } finally {
    temp.stop();
  }
});

test('a unique title, artist, and whole-second length matches a moved file', () => {
  const temp = useLibrary();
  try {
    const moved = path.join(temp.dir, 'moved.mp3');
    const oldPath = path.join(temp.dir, 'old.mp3');
    withDb(temp.db, (db) => {
      insertTrack(db, 10, 'Moved', 100, '5A', moved);
      db.prepare("UPDATE asset SET artist = 'Night', length_ms = 180400 WHERE id = 10").run();
      insertTrack(db, 20, 'Partner', 70, '12A', 'Music/partner.mp3');
    });
    writeSidecar(temp.related, (db) => {
      db.prepare(
        'INSERT INTO track (id, path, title, artist, length_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(1, oldPath, ' moved ', ' night ', 180100, SIDECAR_STAMP, SIDECAR_STAMP);
      insertSidecarTrack(db, 2, 'Music/partner.mp3', 'Partner', 'DJ', null);
      insertLink(db, 1, 1, 2, 0, 'moved file', 4);
    });
    invalidateLibraryCache();
    const body = relatedForDeck([{ deck: 0, filepath: moved, title: 'Live', artist: 'Live' }], 0);
    assert.equal(body.sidecar, 'ok');
    assert.equal(body.track_id, 10);
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].source, 'saved');
    assert.equal(body.matches[0].track_id, 20);
    assert.equal(body.matches[0].note, 'moved file');
    assert.equal(body.matches[0].rating, 4);
  } finally {
    temp.stop();
  }
});

test('an ambiguous fallback and a fallback that names another library track are skipped', () => {
  const temp = useLibrary();
  try {
    const playing = path.join(temp.dir, 'playing.mp3');
    const other = path.join(temp.dir, 'other-copy.mp3');
    withDb(temp.db, (db) => {
      insertTrack(db, 10, 'Twin', 90, '3A', playing);
      db.prepare("UPDATE asset SET artist = 'Duo', length_ms = 200000 WHERE id = 10").run();
      insertTrack(db, 11, 'Twin', 90, '3A', other);
      db.prepare("UPDATE asset SET artist = 'Duo', length_ms = 200200 WHERE id = 11").run();
      insertTrack(db, 20, 'Only', 90, '3A', 'Music/only.mp3');
    });
    writeSidecar(temp.related, (db) => {
      db.prepare(
        'INSERT INTO track (id, path, title, artist, length_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(1, path.join(temp.dir, 'first-old.mp3'), 'Twin', 'Duo', 200100, SIDECAR_STAMP, SIDECAR_STAMP);
      db.prepare(
        'INSERT INTO track (id, path, title, artist, length_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(2, path.join(temp.dir, 'second-old.mp3'), 'Twin', 'Duo', 200900, SIDECAR_STAMP, SIDECAR_STAMP);
      insertSidecarTrack(db, 3, 'Music/only.mp3', 'Only', 'DJ', null);
      insertLink(db, 1, 1, 3, 0, 'ambiguous', 2);
    });
    invalidateLibraryCache();
    const ambiguous = relatedForDeck([{ deck: 0, filepath: playing }], 0);
    assert.equal(ambiguous.matches.some((match) => match.source === 'saved'), false);

    fs.chmodSync(temp.related, 0o644);
    fs.rmSync(temp.related);
    writeSidecar(temp.related, (db) => {
      insertSidecarTrack(db, 1, other, 'Twin', 'Duo', 200200);
      insertSidecarTrack(db, 2, 'Music/only.mp3', 'Only', 'DJ', null);
      insertLink(db, 1, 1, 2, 0, 'still the other copy', 2);
    });
    const rebound = relatedForDeck([{ deck: 0, filepath: playing }], 0);
    assert.equal(rebound.track_id, 10);
    assert.equal(rebound.matches.some((match) => match.note === 'still the other copy'), false);
    assert.equal(rebound.matches.some((match) => match.source === 'saved'), false);
  } finally {
    temp.stop();
  }
});

test('a unique case-insensitive path matches', () => {
  const temp = useLibrary();
  try {
    const live = path.join(temp.dir, 'Case.mp3');
    const stored = path.join(temp.dir, 'case.mp3');
    assert.notEqual(live, stored);
    withDb(temp.db, (db) => {
      insertTrack(db, 10, 'Cased', 110, '4A', live);
      insertTrack(db, 20, 'Friend', 110, '4A', 'Music/friend.mp3');
    });
    writeSidecar(temp.related, (db) => {
      db.prepare(
        'INSERT INTO track (id, path, title, artist, length_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(1, stored, 'Cased', 'DJ', null, SIDECAR_STAMP, SIDECAR_STAMP);
      insertSidecarTrack(db, 2, 'Music/friend.mp3', 'Friend', 'DJ', null);
      insertLink(db, 1, 1, 2, 0, 'folded', 2);
    });
    invalidateLibraryCache();
    const body = relatedForDeck([{ deck: 0, filepath: live }], 0);
    assert.equal(body.sidecar, 'ok');
    assert.equal(body.track_id, 10);
    assert.equal(body.matches[0].source, 'saved');
    assert.equal(body.matches[0].track_id, 20);
    assert.equal(body.matches[0].note, 'folded');
    assert.equal(body.matches[0].rating, 2);
  } finally {
    temp.stop();
  }
});

test('the related path follows the settings directory, then the environment, then the test override', () => {
  assert.equal(
    defaultRelatedPath({ platform: 'darwin', home: '/Users/dj' }),
    '/Users/dj/Library/Application Support/Serato Library/related.sqlite',
  );
  assert.equal(
    defaultRelatedPath({ platform: 'win32', home: 'C:\\Users\\dj', appData: 'C:\\Users\\dj\\AppData\\Roaming' }),
    'C:\\Users\\dj\\AppData\\Roaming\\Serato Library\\related.sqlite',
  );
  assert.equal(
    defaultRelatedPath({ platform: 'win32', home: 'C:\\Users\\dj', appData: null }),
    'C:\\Users\\dj\\AppData\\Roaming\\Serato Library\\related.sqlite',
  );
  assert.equal(
    defaultRelatedPath({ platform: 'linux', home: '/home/dj', xdgConfigHome: null }),
    '/home/dj/.config/serato-library/related.sqlite',
  );
  assert.equal(
    defaultRelatedPath({ platform: 'linux', home: '/home/dj', xdgConfigHome: '/xdg' }),
    '/xdg/serato-library/related.sqlite',
  );
  assert.equal(identityPath(''), null);
  assert.equal(identityPath('a\0b'), null);
  assert.equal(identityPath(`~${path.sep}Music${path.sep}a.mp3`), path.resolve(path.join(os.homedir(), 'Music', 'a.mp3')));
  const missing = `serato-related-missing-${process.pid}/no-such-file.mp3`;
  assert.equal(identityPath(missing), path.resolve(path.join(os.homedir(), missing)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serato-related-path-'));
  const previous = process.env.SERATO_RELATED_PATH;
  const previousConfig = process.env.SERATO_LIBRARY_CONFIG_DIR;
  try {
    setRelatedPathForTests(path.join(dir, 'override.sqlite'));
    assert.equal(currentRelatedPath(), path.join(dir, 'override.sqlite'));
    setRelatedPathForTests(null);
    process.env.SERATO_RELATED_PATH = path.join(dir, 'env.sqlite');
    process.env.SERATO_LIBRARY_CONFIG_DIR = dir;
    assert.equal(currentRelatedPath(), path.join(dir, 'env.sqlite'));
    delete process.env.SERATO_RELATED_PATH;
    assert.equal(currentRelatedPath(), path.join(dir, 'related.sqlite'));
    process.env.SERATO_LIBRARY_CONFIG_DIR = 'relative/serato-library';
    assert.equal(currentRelatedPath(), defaultRelatedPath());
  } finally {
    setRelatedPathForTests(null);
    if (previous == null) delete process.env.SERATO_RELATED_PATH;
    else process.env.SERATO_RELATED_PATH = previous;
    if (previousConfig == null) delete process.env.SERATO_LIBRARY_CONFIG_DIR;
    else process.env.SERATO_LIBRARY_CONFIG_DIR = previousConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the related route rejects a missing or bad query', async () => {
  const base = {
    pathname: '/api/related',
    fromClient: false,
    decks: [] as PlayingDeckInput[],
  };
  const missing = await answerLibrary({ ...base, method: 'GET', searchParams: new URLSearchParams() });
  assert.equal(missing?.status, 400);
  const bad = await answerLibrary({ ...base, method: 'GET', searchParams: new URLSearchParams({ deck: '9' }) });
  assert.equal(bad?.status, 400);
  const text = await answerLibrary({ ...base, method: 'GET', searchParams: new URLSearchParams({ deck: 'nope' }) });
  assert.equal(text?.status, 400);
  const posted = await answerLibrary({
    ...base,
    method: 'POST',
    searchParams: new URLSearchParams({ deck: '0' }),
  });
  assert.equal(posted?.status, 405);

  setMasterPathForTests(path.join(os.tmpdir(), 'serato-related-missing', 'master.sqlite'));
  try {
    const lost = await answerLibrary({
      ...base,
      method: 'GET',
      searchParams: new URLSearchParams({ deck: '0' }),
    });
    assert.equal(lost?.status, 404);
  } finally {
    setMasterPathForTests(null);
    invalidateLibraryCache();
  }
});

test('the live page and the event stream follow the deck that is playing', async () => {
  const temp = useLibrary();
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    running = await start({ httpPort: 0, advertise: false });
    const page = await fetch(`http://127.0.0.1:${running.port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(html, /EventSource\('\/events'\)/);
    assert.match(html, /id="decks"/);
    const live = await fetch(`http://127.0.0.1:${running.port}/live`);
    assert.equal(live.status, 200);
    assert.match(await live.text(), /Now playing/);

    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    const healthBody = (await health.json()) as { related: string };
    assert.equal(healthBody.related, temp.related);
    assert.match(html, /\/5/);

    const writer = { write() {} };
    let phase: 'snapshot' | 'loaded' | 'switched' | 'playhead' = 'snapshot';
    let playheadAt = 0;
    const events = await collectSse(running.port, (list) => {
      const session = running?.session;
      if (!session) return false;
      if (phase === 'snapshot') {
        if (!list.some((event) => event.type === 'snapshot')) return false;
        phase = 'loaded';
        session.handleMessage(writer, {
          address: '/Status/Deck/Song/Filepath',
          args: [{ type: 'i', value: 0 }, { type: 's', value: 'Music/same-a.mp3' }],
        });
        return false;
      }
      if (phase === 'loaded') {
        const deck0 = lastRelated(list, 0);
        if (!deck0 || deck0.track_id !== 1) return false;
        phase = 'switched';
        session.handleMessage(writer, {
          address: '/Status/Deck/Song/Filepath',
          args: [{ type: 'i', value: 0 }, { type: 's', value: 'Music/same-b.mp3' }],
        });
        session.handleMessage(writer, {
          address: '/Status/Deck/Song/Filepath',
          args: [{ type: 'i', value: 1 }, { type: 's', value: 'Music/same-a.mp3' }],
        });
        return false;
      }
      if (phase === 'switched') {
        const deck0 = lastRelated(list, 0);
        const deck1 = lastRelated(list, 1);
        const matches0 = (deck0?.matches as RelatedMatch[] | undefined) ?? null;
        const matches1 = (deck1?.matches as RelatedMatch[] | undefined) ?? null;
        if (!deck0 || deck0.track_id !== 2 || !deck1 || deck1.track_id !== 1) return false;
        if (!matches0 || !matches1 || matches0.length !== 0 || matches1.length !== 0) return false;
        phase = 'playhead';
        playheadAt = list.length;
        session.handleMessage(writer, {
          address: '/Status/Deck/Playhead',
          args: [
            { type: 'i', value: 0 },
            { type: 'f', value: 1 },
            { type: 'f', value: 1 },
            { type: 'f', value: 120 },
          ],
        });
        return false;
      }
      return list.slice(playheadAt).some((event) => event.type === 'batch');
    });

    const snapshot = events[0];
    assert.equal(snapshot.type, 'snapshot');
    const initial = (snapshot.related as RelatedBody[])[0];
    assert.equal(initial.matches.length, 0);
    const playing = events.find((event) => event.type === 'related' && event.deck === 0 && event.track_id === 1);
    assert.ok(playing);
    assert.equal((playing.matches as RelatedMatch[])[0].track_id, 2);
    assert.equal(playing.sidecar, 'missing');
    const done0 = lastRelated(events, 0);
    const done1 = lastRelated(events, 1);
    assert.equal(done0?.track_id, 2);
    assert.equal((done0?.matches as RelatedMatch[]).length, 0);
    assert.equal(done1?.track_id, 1);
    assert.equal((done1?.matches as RelatedMatch[]).length, 0);
    assert.equal(events.slice(playheadAt).some((event) => event.type === 'related'), false);
    assert.equal(events.slice(playheadAt).some((event) => event.type === 'batch'), true);

    const listed = await fetch(`http://127.0.0.1:${running.port}/api/related?deck=0`);
    const listedBody = (await listed.json()) as RelatedBody;
    assert.equal(listed.status, 200);
    assert.equal(listedBody.track_id, 2);
    assert.equal(listedBody.matches.length, 0);
  } finally {
    if (running) await running.stop();
    temp.stop();
  }
});

/**
 * Reads Server-Sent Events until `until` is satisfied.
 *
 * @param port HTTP port.
 * @param until Predicate over the events received so far. It may send OSC messages.
 * @returns The parsed events.
 *
 * Side effects: opens a connection to the listener and closes it.
 */
async function collectSse(
  port: number,
  until: (events: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const events: Array<Record<string, unknown>> = [];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    while (!until(events)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) events.push(JSON.parse(data) as Record<string, unknown>);
        split = buffer.indexOf('\n\n');
      }
    }
    await reader.cancel();
    return events;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`SSE timed out after ${events.map((event) => String(event.type)).join(',')}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the latest related event for one deck.
 *
 * @param events Parsed SSE messages.
 * @param deck Deck index.
 * @returns The last matching event, or undefined.
 *
 * Side effects: none.
 */
function lastRelated(events: Array<Record<string, unknown>>, deck: number): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const event of events) {
    if (event.type === 'related' && event.deck === deck) found = event;
  }
  return found;
}
