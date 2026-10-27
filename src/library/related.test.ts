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
import { RELATED_TRACK_DDL, sameTrackPath, setRelatedPathForTests } from './related-store';
import { start } from '../server';

/**
 * Points the library at a new fixture database.
 *
 * @returns The directory, the database path, and a stop function.
 *
 * Side effects: creates a temporary directory and redirects the master path.
 */
function useLibrary(): { dir: string; db: string; stop: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serato-related-'));
  const db = path.join(dir, 'master.sqlite');
  buildDatabase(db);
  setMasterPathForTests(db);
  setRelatedPathForTests(null);
  invalidateLibraryCache();
  return {
    dir,
    db,
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
    assert.deepEqual(body.matches[0].reasons, ['key', 'bpm']);
    assert.equal(fs.existsSync(path.join(temp.dir, 'related-tracks.sqlite')), false);
    assert.equal(currentRelatedPath(), path.join(temp.dir, 'related-tracks.sqlite'));
  } finally {
    temp.stop();
  }
});

test('an unreadable sidecar and an unrecognized schema still leave suggestions', () => {
  const temp = useLibrary();
  try {
    const corrupt = path.join(temp.dir, 'related-tracks.sqlite');
    fs.writeFileSync(corrupt, 'not a database');
    const broken = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(broken.sidecar, 'unavailable');
    assert.equal(broken.matches[0].track_id, 2);
    fs.rmSync(corrupt);

    const wrong = path.join(temp.dir, 'related-tracks.sqlite');
    withDb(wrong, (db) => {
      db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    });
    const schema = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(schema.sidecar, 'schema');
    assert.equal(schema.matches[0].track_id, 2);
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
    const sidecar = path.join(temp.dir, 'related-tracks.sqlite');
    withDb(sidecar, (db) => {
      db.exec(RELATED_TRACK_DDL);
      db.prepare(
        'INSERT INTO related_track (portable_id, related_portable_id, note, position) VALUES (?, ?, ?, ?)',
      ).run('Music/source.mp3', 'Music/external.mp3', 'opens the floor', 0);
      db.prepare('INSERT INTO related_track (asset_id, related_asset_id, note, position) VALUES (?, ?, ?, ?)').run(20, 10, 'warm', 1);
      db.prepare('INSERT INTO related_track (asset_id, related_asset_id, position) VALUES (?, ?, ?)').run(10, 21, 2);
    });
    fs.chmodSync(sidecar, 0o444);
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
    assert.equal(body.matches[0].filepath, 'Music/external.mp3');
    assert.equal(body.matches[0].note, 'opens the floor');
    assert.deepEqual(body.matches[0].reasons, ['saved']);
    assert.equal(body.matches[1].title, 'SavedOdd');
    assert.equal(body.matches[1].note, 'warm');
    assert.equal(body.matches[2].source, 'saved');
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
    const sidecar = path.join(temp.dir, 'related-tracks.sqlite');
    withDb(sidecar, (db) => {
      db.exec(RELATED_TRACK_DDL);
      db.prepare('INSERT INTO related_track (asset_id, related_asset_id, position) VALUES (1, 50, 0)').run();
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

test('the underscore sidecar is read, and the hyphen name wins when both exist', () => {
  const temp = useLibrary();
  try {
    const underscore = path.join(temp.dir, 'related_tracks.sqlite');
    withDb(underscore, (db) => {
      db.exec(RELATED_TRACK_DDL);
      db.prepare("INSERT INTO related_track (asset_id, related_asset_id, note, position) VALUES (1, 2, 'from underscore', 0)").run();
    });
    invalidateLibraryCache();
    const first = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(currentRelatedPath(), underscore);
    assert.equal(first.sidecar, 'ok');
    assert.equal(first.matches.length, 1);
    assert.equal(first.matches[0].source, 'saved');
    assert.equal(first.matches[0].track_id, 2);
    assert.equal(first.matches[0].note, 'from underscore');

    const hyphen = path.join(temp.dir, 'related-tracks.sqlite');
    withDb(hyphen, (db) => {
      db.exec(RELATED_TRACK_DDL);
      db.prepare("INSERT INTO related_track (asset_id, related_asset_id, note, position) VALUES (1, 2, 'from hyphen', 0)").run();
    });
    const second = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(currentRelatedPath(), hyphen);
    assert.equal(second.matches[0].note, 'from hyphen');
  } finally {
    temp.stop();
  }
});

test('a left and right relation table is read in either direction', () => {
  const temp = useLibrary();
  try {
    const sidecar = path.join(temp.dir, 'related-tracks.sqlite');
    withDb(sidecar, (db) => {
      db.exec(
        `CREATE TABLE track_relation (
           id INTEGER PRIMARY KEY,
           left_asset_id INTEGER,
           right_asset_id INTEGER,
           note TEXT,
           position INTEGER
         )`,
      );
      db.prepare('INSERT INTO track_relation (left_asset_id, right_asset_id, note, position) VALUES (2, 1, \'alias\', 0)').run();
    });
    const body = relatedForDeck([{ deck: 0, filepath: 'Music/same-a.mp3' }], 0);
    assert.equal(body.sidecar, 'ok');
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].source, 'saved');
    assert.equal(body.matches[0].track_id, 2);
    assert.equal(body.matches[0].note, 'alias');
  } finally {
    temp.stop();
  }
});

test('the related path honors the test override and the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serato-related-path-'));
  const previous = process.env.SERATO_RELATED_PATH;
  const previousMaster = process.env.SERATO_LIBRARY_PATH;
  try {
    setMasterPathForTests(path.join(dir, 'master.sqlite'));
    setRelatedPathForTests(path.join(dir, 'override.sqlite'));
    assert.equal(currentRelatedPath(), path.join(dir, 'override.sqlite'));
    setRelatedPathForTests(null);
    process.env.SERATO_RELATED_PATH = path.join(dir, 'env.sqlite');
    assert.equal(currentRelatedPath(), path.join(dir, 'env.sqlite'));
    delete process.env.SERATO_RELATED_PATH;
    assert.equal(currentRelatedPath(), path.join(dir, 'related-tracks.sqlite'));
  } finally {
    setRelatedPathForTests(null);
    setMasterPathForTests(null);
    if (previous == null) delete process.env.SERATO_RELATED_PATH;
    else process.env.SERATO_RELATED_PATH = previous;
    if (previousMaster == null) delete process.env.SERATO_LIBRARY_PATH;
    else process.env.SERATO_LIBRARY_PATH = previousMaster;
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
    assert.equal(healthBody.related, path.join(temp.dir, 'related-tracks.sqlite'));

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
