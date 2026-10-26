/**
 * Wire shapes for the Serato OSC listener.
 *
 * OSC arguments, the compact events sent on the browser feed, and the
 * in-memory state of the pairing. Nothing here runs.
 */

/** One OSC argument. `i` is int32, `f` is float32, `s` is a string, and `b` is a blob. */
export type OscArg =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 's'; value: string }
  | { type: 'b'; value: Buffer };

/** One decoded OSC message: an address and its typed arguments. */
export type OscMessage = {
  address: string;
  args: OscArg[];
};

/**
 * One event from a Serato status message.
 * `ph` is the playhead, `xf` the crossfader, `up` an upfader, `tr` a title
 * and artist, and `ex` any other `/Status/` address (file path, loops, slicer).
 */
export type LiveEvent =
  | { kind: 'ph'; t?: number; deck: number; pos: number; rate: number; bpm: number }
  | { kind: 'xf'; t?: number; v: number }
  | { kind: 'up'; t?: number; deck: number; v: number }
  | { kind: 'tr'; t?: number; deck: number; title: string; artist: string }
  | { kind: 'ex'; t?: number; address: string; args: Array<number | string | null> };

/** Title, artist, file path, and loaded flag for one deck. */
export interface TrackInfo {
  title: string;
  artist: string;
  filepath?: string;
  valid?: number;
}

/** The last playhead sample for one deck, kept so a quiet deck is not logged on every message. */
export interface PlayheadSnap {
  pos: number;
  rate: number;
  bpm: number | null;
  at: number;
}

/** Pairing, faders, and tracks held while Serato is connected. */
export interface AppState {
  paired: boolean;
  peerName: string;
  connections: number;
  crossfader: number | null;
  upfaders: (number | null)[];
  tracks: TrackInfo[];
  lastPlayhead: (PlayheadSnap | null)[];
}
