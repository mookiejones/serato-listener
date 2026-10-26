/**
 * Builds a temporary Serato-shaped database for tests.
 *
 * The file is not the live library. The connection is closed before
 * `buildDatabase` returns, so the directory can be removed when the test ends.
 * The schema and the two seed tracks follow `tests/fixture.py` in the
 * Serato library manager.
 */

import { DatabaseSync } from 'node:sqlite';

/** Tables the library reader and the crate writer expect. */
export const SCHEMA = `
CREATE TABLE space (
    id INTEGER PRIMARY KEY,
    name TEXT
);
CREATE TABLE asset (
    id INTEGER PRIMARY KEY,
    name TEXT,
    artist TEXT,
    album TEXT,
    genre TEXT,
    year TEXT,
    composer TEXT,
    remixer TEXT,
    label TEXT,
    grouping TEXT,
    comments TEXT,
    key TEXT,
    emoji TEXT,
    bpm REAL,
    color INTEGER,
    rating REAL,
    is_beatgrid_locked INTEGER,
    portable_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    is_missing INTEGER,
    length_ms INTEGER,
    length_sec INTEGER,
    format TEXT,
    type TEXT,
    time_added INTEGER,
    time_modified INTEGER,
    dj_play_count INTEGER,
    stems_analyze_state INTEGER,
    file_bit_rate INTEGER,
    file_sample_rate INTEGER,
    location_id INTEGER,
    external_id INTEGER,
    key_value INTEGER,
    third_party_type INTEGER,
    video_portable_id TEXT,
    part_of_set TEXT,
    track_number TEXT,
    comment_language TEXT,
    comment_descriptor TEXT,
    explicit INTEGER,
    is_corrupt INTEGER,
    corrupt_description TEXT,
    is_readonly INTEGER,
    is_whitelabel INTEGER,
    is_karaoke INTEGER,
    is_stale INTEGER,
    analysis_flags INTEGER,
    architectures INTEGER,
    pending_tempo_map_analysis INTEGER,
    dj_recently_played INTEGER,
    import_id BLOB,
    type_specific_data TEXT
);
CREATE TABLE location (
    id INTEGER PRIMARY KEY,
    path TEXT
);
CREATE TABLE space_asset (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER,
    space_id INTEGER,
    revision INTEGER
);
CREATE TABLE container (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER,
    name TEXT,
    type INTEGER,
    list_order INTEGER,
    space_id INTEGER,
    time_added INTEGER,
    expanded INTEGER,
    portable_id TEXT,
    color INTEGER,
    revision INTEGER
);
CREATE TABLE location_container (
    id INTEGER PRIMARY KEY,
    container_id INTEGER,
    location_id INTEGER,
    external_container_id INTEGER
);
CREATE TABLE container_asset (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER,
    location_container_id INTEGER,
    space_asset_id INTEGER,
    external_container_asset_id INTEGER,
    list_order INTEGER,
    time_added INTEGER,
    container_id INTEGER,
    revision INTEGER
);
CREATE TABLE smart_crate_rules (
    container_id INTEGER PRIMARY KEY,
    version INTEGER,
    rules TEXT,
    revision INTEGER,
    needs_refresh INTEGER
);
CREATE TABLE dj_container_metadata (
    container_id INTEGER PRIMARY KEY,
    revision INTEGER,
    export_state INTEGER,
    filename TEXT
);
CREATE TABLE dj_asset_metadata (
    asset_id INTEGER PRIMARY KEY,
    video_effects BLOB,
    batch_analysis_version INTEGER,
    should_loop INTEGER,
    is_itunes INTEGER,
    itunes_id TEXT,
    has_read_tags INTEGER,
    is_whitelabel_acl INTEGER,
    is_unsupported INTEGER,
    external_id TEXT
);
CREATE TABLE connection (
    location_id INTEGER,
    database_uri TEXT
);
CREATE TABLE lock (
    owner_process_id INTEGER,
    owner_process_name TEXT
);
CREATE TABLE serato (
    revision INTEGER
);
CREATE TABLE history_session (
    id INTEGER PRIMARY KEY,
    name TEXT,
    start_time INTEGER,
    end_time INTEGER,
    notes TEXT
);
CREATE TABLE history_entry (
    id INTEGER PRIMARY KEY,
    session_id INTEGER,
    asset_id INTEGER,
    name TEXT,
    artist TEXT,
    album TEXT,
    bpm REAL,
    key TEXT,
    length_ms INTEGER,
    start_time INTEGER,
    end_time INTEGER,
    played INTEGER,
    deck TEXT,
    notes TEXT,
    file_name TEXT,
    is_missing INTEGER
);
CREATE TABLE updated_smart_crate (
    container_id INTEGER
);
`;

/**
 * Creates a small library with one track pair, a space root, and history.
 *
 * @param file Database file to create. Parent directories must already exist.
 *
 * Side effects: writes `file` and closes the connection before returning.
 */
export function buildDatabase(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    db.exec("INSERT INTO serato (revision) VALUES (1)");
    db.exec("INSERT INTO space (id, name) VALUES (1, 'Serato Library')");
    db.exec("INSERT INTO space (id, name) VALUES (2, 'Prepare')");
    db.exec(
      `INSERT INTO container
         (id, parent_id, name, type, list_order, space_id, time_added, expanded, portable_id)
       VALUES (1, NULL, 'Library', 0, 0, 1, 1, 0, '')`,
    );
    db.exec(
      `INSERT INTO container
         (id, parent_id, name, type, list_order, space_id, time_added, expanded, portable_id)
       VALUES (2, NULL, 'Prepare', 1, 0, 2, 1, 0, '')`,
    );
    db.exec(
      `INSERT INTO asset
         (id, name, artist, album, bpm, key, length_ms, color, is_missing,
          file_name, portable_id, location_id, time_added, dj_play_count)
       VALUES
         (1, 'Same', 'Artist', 'Album', 120, '1A', 180000, 16711680, 0,
          'same-a.mp3', 'Music/same-a.mp3', 1, 10, 2),
         (2, 'Same', 'Artist', 'Album', 120, '1A', 180500, 16711680, 0,
          'same-b.mp3', 'Music/same-b.mp3', 1, 11, 0)`,
    );
    db.exec('INSERT INTO space_asset (id, asset_id, space_id) VALUES (1, 1, 1)');
    db.exec('INSERT INTO space_asset (id, asset_id, space_id) VALUES (2, 2, 1)');
    db.exec(
      `INSERT INTO history_session (id, name, start_time, end_time, notes)
       VALUES (1, 'Friday', 100, 200, 'club')`,
    );
    db.exec(
      `INSERT INTO history_entry
         (id, session_id, asset_id, name, artist, played, start_time, file_name, is_missing)
       VALUES (1, 1, 1, 'Same', 'Artist', 1, 100, 'same-a.mp3', 0)`,
    );
  } finally {
    db.close();
  }
}
