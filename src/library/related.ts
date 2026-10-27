/**
 * Related tracks for the deck that is playing.
 *
 * Saved matches come from the Related Tracks sidecar. Suggestions come from
 * `master.sqlite`: a compatible Camelot key, a BPM within 6% (half-time and
 * double-time count), and shared crates. Saved matches are listed first.
 * Tracks loaded on the other decks are left out. The list is capped at 10.
 */

import { LibraryError } from './errors';
import {
  libraryKeyType,
  loadLibrary,
  masterPath,
  trackIdForFile,
  type LibraryCrate,
  type LibraryPayload,
  type LibraryTrack,
  type PlayingDeckInput,
} from './db';
import {
  openSidecar,
  sameTrackPath,
  sidecarPath,
  type SavedMatch,
  type SidecarSnapshot,
  type SidecarStatus,
} from './related-store';

/** How many related tracks a deck shows. */
export const RELATED_LIMIT = 10;

/**
 * BPM window for a suggestion.
 * Half-time and double-time are folded into this window before the comparison.
 */
export const BPM_TOLERANCE = 0.06;

/** One track shown under the deck that is playing. */
export interface RelatedMatch {
  source: 'saved' | 'suggestion';
  track_id: number | null;
  title: string;
  artist: string;
  filepath: string | null;
  bpm: number | null;
  key: string;
  reasons: string[];
  crates: string[];
  note: string | null;
}

/** Related tracks for one deck, or for one file path. */
export interface RelatedBody {
  ok: boolean;
  deck: number | null;
  path: string | null;
  track_id: number | null;
  title: string;
  artist: string;
  bpm: number | null;
  key: string;
  sidecar: SidecarStatus;
  matches: RelatedMatch[];
  error?: string;
}

interface RankedSuggestion {
  track: LibraryTrack;
  distance: number;
  crates: string[];
}

/**
 * Returns the sidecar path the process would open.
 *
 * @returns The path from the test override, the environment, or beside `master.sqlite`.
 *
 * Side effects: may stat the candidate files. Does not open a database.
 */
export function currentRelatedPath(): string {
  return sidecarPath(masterPath());
}

/**
 * Builds an empty related payload when the library cannot be read.
 * The deck's live title is kept so the page still shows what Serato sent.
 *
 * @param deck Deck index.
 * @param track Title, artist, and file path already on that deck.
 * @returns A payload with no matches.
 *
 * Side effects: none.
 */
export function unavailableRelated(
  deck: number,
  track: { filepath?: string | null; title?: string | null; artist?: string | null },
): RelatedBody {
  return {
    ok: false,
    deck,
    path: track.filepath ?? null,
    track_id: null,
    title: track.title ?? '',
    artist: track.artist ?? '',
    bpm: null,
    key: '',
    sidecar: 'unavailable',
    matches: [],
    error: 'Related tracks could not be loaded.',
  };
}

/**
 * Returns whether two keys are compatible on the Camelot wheel.
 * Compatible keys are the same key, one step either way on the same mode,
 * or the relative major or minor. `12A` is one step from `1A`.
 *
 * @param left A Camelot or traditional key.
 * @param right Another key.
 * @returns True when the two keys mix.
 *
 * Side effects: none.
 */
export function keysCompatible(left: string, right: string): boolean {
  const a = libraryKeyType(left);
  const b = libraryKeyType(right);
  if (a == null || b == null) return false;
  const aNum = a % 12;
  const bNum = b % 12;
  const sameMode = a < 12 === b < 12;
  if (sameMode) {
    const diff = Math.abs(aNum - bNum);
    return diff === 0 || diff === 1 || diff === 11;
  }
  return aNum === bNum;
}

/**
 * Returns how close two BPMs are after half-time and double-time.
 * The distance is the fraction of the playing track's BPM. A candidate at
 * half or double tempo can be closer than the printed BPM suggests. A tempo
 * two octaves away, such as quadruple time, is not a match.
 *
 * @param source BPM of the playing track.
 * @param candidate BPM of a library track.
 * @returns The best distance within the window, or null when none of the three ratios fit.
 *
 * Side effects: none.
 */
export function bpmDistance(source: number, candidate: number): number | null {
  if (!(source > 0) || !(candidate > 0)) return null;
  let best: number | null = null;
  for (const scale of [1, 2, 0.5]) {
    const delta = Math.abs(candidate * scale - source) / source;
    if (delta <= BPM_TOLERANCE + 1e-9 && (best == null || delta < best)) best = delta;
  }
  return best;
}

/**
 * Looks up related tracks for every deck.
 * The library and the sidecar are read once. A deck with nothing loaded
 * gets an empty match list and the sidecar status.
 *
 * @param decks Live decks. A missing index is treated as an empty deck.
 * @returns One payload per deck, index 0 through 3.
 *
 * Side effects: opens and closes the master database and the sidecar.
 */
export function relatedForDecks(decks: PlayingDeckInput[]): RelatedBody[] {
  const normalized = normalizeDecks(decks);
  const library = loadLibrary(undefined, normalized);
  const sidecar = openSidecar(sidecarPath(masterPath()));
  return normalized.map((deck) =>
    buildRelated(library, sidecar, deck.deck, deck.filepath ?? null, deck.title ?? '', deck.artist ?? ''),
  );
}

/**
 * Looks up related tracks for one deck.
 *
 * @param decks Live decks, including the other decks that should be excluded.
 * @param deck Deck index from 0 through 3.
 * @returns That deck's related tracks.
 *
 * Side effects: opens and closes the master database and the sidecar.
 */
export function relatedForDeck(decks: PlayingDeckInput[], deck: number): RelatedBody {
  if (!Number.isInteger(deck) || deck < 0 || deck > 3) {
    throw new LibraryError('Pick a deck from 0 to 3.');
  }
  return relatedForDecks(decks)[deck];
}

/**
 * Looks up related tracks for a file path.
 * Every loaded deck is excluded, including a deck that is playing this file.
 *
 * @param decks Live decks whose tracks should not be suggested.
 * @param filePath File path or portable id to match.
 * @returns Related tracks for that file.
 *
 * Side effects: opens and closes the master database and the sidecar.
 */
export function relatedForPath(decks: PlayingDeckInput[], filePath: string): RelatedBody {
  const trimmed = filePath.trim();
  if (!trimmed) throw new LibraryError('Pass a deck or a file path.');
  const normalized = normalizeDecks(decks);
  const library = loadLibrary(undefined, normalized);
  const sidecar = openSidecar(sidecarPath(masterPath()));
  return buildRelated(library, sidecar, null, trimmed, '', '');
}

/**
 * Fills decks 0 through 3 so an omitted deck counts as empty.
 *
 * @param decks Decks supplied by the caller.
 * @returns Four decks, in index order.
 *
 * Side effects: none.
 */
function normalizeDecks(decks: PlayingDeckInput[]): PlayingDeckInput[] {
  return [0, 1, 2, 3].map((deck) => {
    const found = decks.find((item) => item.deck === deck);
    return {
      deck,
      filepath: found?.filepath ?? null,
      title: found?.title ?? null,
      artist: found?.artist ?? null,
    };
  });
}

/**
 * Builds one related payload from a library already in memory.
 *
 * @param library Tracks and crates for the Serato Library space.
 * @param sidecar Saved relations already read.
 * @param deck Deck index, or null when the lookup is by path.
 * @param filepath Live file path, or the path query.
 * @param title Live title. Empty when the lookup is by path.
 * @param artist Live artist.
 * @returns The ranked matches.
 *
 * Side effects: none.
 */
function buildRelated(
  library: LibraryPayload,
  sidecar: SidecarSnapshot,
  deck: number | null,
  filepath: string | null,
  title: string,
  artist: string,
): RelatedBody {
  const source = resolveSource(library.tracks, filepath, title, artist);
  const paths = sourcePaths(filepath, source);
  const saved = sidecar.matchesFor({ assetId: source?.id ?? null, paths });
  const crates = cratesByAsset(library.crates);
  const blocked = elsewhere(library, deck);
  const savedIds = new Set<number>();
  const savedPaths: string[] = [];
  for (const match of saved) {
    if (match.assetId != null) savedIds.add(match.assetId);
    if (match.portableId) savedPaths.push(match.portableId);
  }
  const byId = new Map(library.tracks.map((track) => [track.id, track]));
  const shownSaved = saved
    .filter((match) => !isSource(match, source, paths))
    .filter((match) => !blockedMatch(match, byId, blocked))
    .map((match) => savedMatch(match, byId, source, crates));
  const suggestions = rankSuggestions(library.tracks, source, crates, blocked, savedIds, savedPaths);
  return {
    ok: true,
    deck,
    path: filepath,
    track_id: source?.id ?? null,
    title: title || source?.name || '',
    artist: artist || source?.artist || '',
    bpm: source?.bpm ?? null,
    key: source?.key || '',
    sidecar: sidecar.status,
    matches: [...shownSaved, ...suggestions].slice(0, RELATED_LIMIT),
  };
}

/**
 * Finds the library row for a live deck or a path query.
 * A file path wins. Title and artist are used only when they name one track.
 *
 * @param tracks Tracks in the space.
 * @param filepath Live or requested path.
 * @param title Live title.
 * @param artist Live artist. An empty artist does not filter the title.
 * @returns The library track, or null when the path is unknown or the title is ambiguous.
 *
 * Side effects: none.
 */
function resolveSource(tracks: LibraryTrack[], filepath: string | null, title: string, artist: string): LibraryTrack | null {
  if (filepath) {
    const id = trackIdForFile(tracks, filepath);
    return id == null ? null : tracks.find((track) => track.id === id) ?? null;
  }
  if (!title) return null;
  const hits = tracks.filter((track) => track.name === title && (artist === '' || track.artist === artist));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Collects the paths that should count as the playing track.
 *
 * @param filepath Live or requested path.
 * @param source Library row, when one was found.
 * @returns Paths with empty values removed.
 *
 * Side effects: none.
 */
function sourcePaths(filepath: string | null, source: LibraryTrack | null): string[] {
  const paths = [filepath, source?.portable_id, source?.resolved_path];
  return paths.filter((value): value is string => Boolean(value));
}

/**
 * Indexes crate names by asset id.
 * The space root is already absent from the crate list. A track listed twice
 * in one crate is recorded once.
 *
 * @param crates Crates in the space.
 * @returns Crate display names for each asset id.
 *
 * Side effects: none.
 */
function cratesByAsset(crates: LibraryCrate[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const crate of crates) {
    const seen = new Set<number>();
    for (const id of crate.tracks) {
      if (seen.has(id)) continue;
      seen.add(id);
      const list = map.get(id);
      if (list) list.push(crate.name);
      else map.set(id, [crate.name]);
    }
  }
  return map;
}

/**
 * Collects tracks loaded on the decks that are not the source.
 * A path lookup excludes every deck.
 *
 * @param library Library payload whose deck links are already filled.
 * @param sourceDeck Deck being looked up, or null for a path lookup.
 * @returns Asset ids and paths that must not be suggested.
 *
 * Side effects: none.
 */
function elsewhere(library: LibraryPayload, sourceDeck: number | null): { ids: Set<number>; paths: string[] } {
  const ids = new Set<number>();
  const paths: string[] = [];
  for (const deck of library.decks) {
    if (sourceDeck != null && deck.deck === sourceDeck) continue;
    if (deck.track_id != null) {
      ids.add(deck.track_id);
      const track = library.tracks.find((item) => item.id === deck.track_id);
      if (track?.portable_id) paths.push(track.portable_id);
      if (track?.resolved_path) paths.push(track.resolved_path);
    }
    if (deck.filepath) paths.push(deck.filepath);
  }
  return { ids, paths };
}

/**
 * Returns whether a saved row points back at the playing track.
 *
 * @param match Saved row.
 * @param source Playing library track, if it resolved.
 * @param paths Paths of the playing track.
 * @returns True when the row should not be shown.
 *
 * Side effects: none.
 */
function isSource(match: SavedMatch, source: LibraryTrack | null, paths: string[]): boolean {
  if (source && match.assetId === source.id) return true;
  if (!match.portableId) return false;
  return paths.some((file) => sameTrackPath(file, match.portableId || ''));
}

/**
 * Returns whether a saved match is already loaded on another deck.
 *
 * @param match Saved row.
 * @param byId Library tracks by asset id.
 * @param blocked Ids and paths loaded elsewhere.
 * @returns True when the match should be hidden.
 *
 * Side effects: none.
 */
function blockedMatch(
  match: SavedMatch,
  byId: Map<number, LibraryTrack>,
  blocked: { ids: Set<number>; paths: string[] },
): boolean {
  const track = match.assetId == null ? undefined : byId.get(match.assetId);
  if (match.assetId != null && blocked.ids.has(match.assetId)) return true;
  const paths = [match.portableId, track?.portable_id, track?.resolved_path].filter((value): value is string => Boolean(value));
  return paths.some((file) => blocked.paths.some((other) => sameTrackPath(file, other)));
}

/**
 * Turns a saved row into the payload shape.
 *
 * @param match Saved row.
 * @param byId Library tracks by asset id.
 * @param source Playing track, used to name shared crates.
 * @param crates Crate names by asset id.
 * @returns The match the page shows.
 *
 * Side effects: none.
 */
function savedMatch(
  match: SavedMatch,
  byId: Map<number, LibraryTrack>,
  source: LibraryTrack | null,
  crates: Map<number, string[]>,
): RelatedMatch {
  let track = match.assetId == null ? undefined : byId.get(match.assetId);
  if (!track && match.portableId) {
    const id = trackIdForFile([...byId.values()], match.portableId);
    if (id != null) track = byId.get(id);
  }
  const shared = source && track ? sharedCrates(crates, source.id, track.id) : [];
  let title = 'Related track';
  if (track) title = track.name;
  else if (match.portableId) title = match.portableId;
  else if (match.assetId != null) title = `Track ${match.assetId}`;
  return {
    source: 'saved',
    track_id: track?.id ?? match.assetId,
    title,
    artist: track?.artist ?? '',
    filepath: track?.resolved_path ?? track?.portable_id ?? match.portableId,
    bpm: track?.bpm ?? null,
    key: track?.key ?? '',
    reasons: ['saved'],
    crates: shared,
    note: match.note,
  };
}

/**
 * Ranks library tracks that harmonically and temporally fit the playing track.
 * A suggestion needs a compatible key and a BPM inside the window. Shared
 * crates sort above an otherwise equal match. Saved rows and tracks loaded
 * on other decks are not repeated here.
 *
 * @param tracks Library tracks.
 * @param source Playing track. Suggestions are empty when it is missing or has no key or BPM.
 * @param crates Crate names by asset id.
 * @param blocked Tracks loaded on other decks.
 * @param savedIds Asset ids already returned as saved matches.
 * @param savedPaths Paths already returned as saved matches.
 * @returns Suggestion rows, best first.
 *
 * Side effects: none.
 */
function rankSuggestions(
  tracks: LibraryTrack[],
  source: LibraryTrack | null,
  crates: Map<number, string[]>,
  blocked: { ids: Set<number>; paths: string[] },
  savedIds: Set<number>,
  savedPaths: string[],
): RelatedMatch[] {
  if (!source || source.bpm == null || !source.key) return [];
  const ranked: RankedSuggestion[] = [];
  for (const track of tracks) {
    if (track.id === source.id || savedIds.has(track.id)) continue;
    if (track.bpm == null || !track.key) continue;
    if (!keysCompatible(source.key, track.key)) continue;
    const distance = bpmDistance(source.bpm, track.bpm);
    if (distance == null) continue;
    const filepath = track.resolved_path ?? track.portable_id;
    if (blocked.ids.has(track.id)) continue;
    if (filepath && blocked.paths.some((other) => sameTrackPath(filepath, other))) continue;
    if (filepath && savedPaths.some((other) => sameTrackPath(filepath, other))) continue;
    ranked.push({ track, distance, crates: sharedCrates(crates, source.id, track.id) });
  }
  ranked.sort((a, b) => {
    if (a.crates.length !== b.crates.length) return b.crates.length - a.crates.length;
    if (a.distance !== b.distance) return a.distance - b.distance;
    const name = a.track.name.localeCompare(b.track.name, 'en');
    if (name) return name;
    const artist = a.track.artist.localeCompare(b.track.artist, 'en');
    if (artist) return artist;
    return a.track.id - b.track.id;
  });
  return ranked.map((item) => ({
    source: 'suggestion' as const,
    track_id: item.track.id,
    title: item.track.name,
    artist: item.track.artist,
    filepath: item.track.resolved_path ?? item.track.portable_id,
    bpm: item.track.bpm,
    key: item.track.key,
    reasons: item.crates.length ? ['key', 'bpm', 'crate'] : ['key', 'bpm'],
    crates: item.crates,
    note: null,
  }));
}

/**
 * Returns crate names shared by two tracks, in library order.
 *
 * @param crates Crate names by asset id.
 * @param sourceId Playing track id.
 * @param otherId Candidate id.
 * @returns Shared display names. Empty when the tracks share no crate.
 *
 * Side effects: none.
 */
function sharedCrates(crates: Map<number, string[]>, sourceId: number, otherId: number): string[] {
  const source = new Set(crates.get(sourceId) ?? []);
  if (!source.size) return [];
  return (crates.get(otherId) ?? []).filter((name) => source.has(name));
}
