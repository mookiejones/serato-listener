/**
 * Read Serato cue points, loops, flips, and beatgrids from audio files.
 *
 * Serato stores these in GEOB frames (`Serato Markers2` and `Serato BeatGrid`),
 * not in the library database. This module only reads. It does not rewrite
 * audio files, because replacing an ID3 tag can drop those frames. The Python
 * `tags.py` this was ported from has no write path for the same reason.
 */

import * as fs from 'node:fs';

/** One Serato cue point. `start_ms` is milliseconds from the start of the file. */
export interface Cue {
  index: number;
  start_ms: number;
  color: string | null;
  name: string;
}

/** One Serato loop. `locked` is the loop lock flag Serato stores in the record. */
export interface Loop {
  index: number;
  start_ms: number;
  end_ms: number;
  color: string | null;
  locked: boolean;
  name: string;
}

/** One Serato flip. `enabled` is the on/off flag stored with the flip. */
export interface Flip {
  index: number;
  enabled: boolean;
  name: string;
}

/**
 * One beatgrid marker.
 * Earlier markers store a beat count. The last marker stores BPM.
 */
export interface BeatMarker {
  position: number;
  bpm?: number;
  beats?: number;
}

/** Cues, loops, and flips from one Markers2 payload. */
export interface MarkerEntries {
  cues: Cue[];
  loops: Loop[];
  flips: Flip[];
}

/**
 * Cue data read from an audio file.
 * `unavailable` is set when the file was not read. `found` is true when a
 * Serato GEOB frame was present, even if it held no entries.
 */
export interface SeratoTags {
  cues: Cue[];
  loops: Loop[];
  flips: Flip[];
  beatgrid: BeatMarker[];
  found: boolean;
  unavailable?: boolean;
}

const EMPTY_TAGS: SeratoTags = { cues: [], loops: [], flips: [], beatgrid: [], found: false };

/**
 * Reads Serato cue, loop, flip, and beatgrid data from an audio file.
 * The read covers the first 2,000,000 bytes and, for a longer file, the last
 * 512,000 bytes. A missing path or an unreadable file returns an empty result.
 *
 * @param filePath Filesystem path of the audio file, or null.
 * @returns Cues, loops, flips, beatgrid, and whether a Serato frame was found.
 *
 * Side effects: reads the audio file when the path points at a file. Does not write it.
 */
export function readSeratoTags(filePath: string | null | undefined): SeratoTags {
  if (!filePath) return { ...EMPTY_TAGS, cues: [], loops: [], flips: [], beatgrid: [] };
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  try {
    if (!fs.statSync(filePath).isFile()) return { ...EMPTY_TAGS, cues: [], loops: [], flips: [], beatgrid: [] };
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    try {
      // Cues sit in the tag header. The tail covers ID3 written at the end of a WAV.
      const headLen = Math.min(size, 2_000_000);
      head = Buffer.alloc(headLen);
      if (headLen) fs.readSync(fd, head, 0, headLen, 0);
      if (size > 2_000_000) {
        const tailLen = Math.min(512_000, size);
        tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, Math.max(0, size - 512_000));
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ...EMPTY_TAGS, cues: [], loops: [], flips: [], beatgrid: [] };
  }

  const frames = [...geobFrames(head), ...geobFrames(tail)];
  const cues: Cue[] = [];
  const loops: Loop[] = [];
  const flips: Flip[] = [];
  let beatgrid: BeatMarker[] = [];
  let found = false;
  for (const frame of frames) {
    if (frame.name === 'Serato Markers2') {
      found = true;
      const parsed = parseMarkers2(frame.payload);
      cues.push(...parsed.cues);
      loops.push(...parsed.loops);
      flips.push(...parsed.flips);
    } else if (frame.name === 'Serato BeatGrid') {
      found = true;
      beatgrid = parseBeatgrid(frame.payload);
    }
  }
  cues.sort((a, b) => a.index - b.index || a.start_ms - b.start_ms);
  loops.sort((a, b) => a.index - b.index || a.start_ms - b.start_ms);
  return { cues, loops, flips, beatgrid, found };
}

/**
 * Reads cue data when the audio file is on disk.
 * A path that is not on disk is not opened. The lists come back empty and
 * `unavailable` is true.
 *
 * @param filePath Resolved audio path, or null.
 * @param onDisk False skips the file read.
 * @returns Cue, loop, flip, and beatgrid lists, plus `found` and `unavailable`.
 *
 * Side effects: reads the audio file when `onDisk` is true.
 */
export function markersFor(filePath: string | null, onDisk: boolean): SeratoTags {
  if (!onDisk) {
    return { cues: [], loops: [], flips: [], beatgrid: [], found: false, unavailable: true };
  }
  const parsed = readSeratoTags(filePath);
  parsed.unavailable = false;
  return parsed;
}

/**
 * Collects Serato GEOB payloads from an ID3 byte string.
 *
 * @param blob Bytes that may contain one or more ID3 tags.
 * @returns Pairs of GEOB description and payload.
 *
 * Side effects: none.
 */
function geobFrames(blob: Buffer): Array<{ name: string; payload: Buffer }> {
  const frames: Array<{ name: string; payload: Buffer }> = [];
  let cursor = 0;
  while (cursor < blob.length - 10) {
    const offset = blob.indexOf('ID3', cursor, 'ascii');
    if (offset < 0) break;
    cursor = offset + 3;
    const parsed = parseId3(blob, offset);
    if (!parsed) continue;
    frames.push(...parsed);
    cursor = offset + 10;
  }
  return frames;
}

/**
 * Decodes a synchsafe integer used by an ID3 tag size.
 * The high bit of each byte is ignored.
 *
 * @param raw Four size bytes.
 * @returns The decoded integer.
 *
 * Side effects: none.
 */
function synchsafe(raw: Buffer): number {
  let value = 0;
  for (const byte of raw) value = (value << 7) | (byte & 0x7f);
  return value;
}

/**
 * Parses one ID3v2.3 or ID3v2.4 tag and returns its GEOB frames.
 *
 * @param blob The buffer that contains the tag.
 * @param offset Index of the ID3 header.
 * @returns GEOB name and payload pairs, or null when the header is not a supported tag.
 *
 * Side effects: none.
 */
function parseId3(blob: Buffer, offset: number): Array<{ name: string; payload: Buffer }> | null {
  if (blob.subarray(offset, offset + 3).toString('ascii') !== 'ID3') return null;
  if (offset + 10 > blob.length) return null;
  const version = blob[offset + 3];
  if (version !== 3 && version !== 4) return null;
  const tagSize = synchsafe(blob.subarray(offset + 6, offset + 10));
  const start = offset + 10;
  const end = Math.min(blob.length, start + tagSize);
  if (end <= start) return null;
  const frames: Array<{ name: string; payload: Buffer }> = [];
  let pos = start;
  while (pos + 10 <= end) {
    const frameId = blob.subarray(pos, pos + 4);
    if (frameId.equals(Buffer.from([0, 0, 0, 0])) || frameId[0] === 0) break;
    // ID3v2.4 stores the frame size as a synchsafe integer. ID3v2.3
    // stores the same four bytes as a plain big-endian length.
    const frameSize = version === 4
      ? synchsafe(blob.subarray(pos + 4, pos + 8))
      : blob.readUInt32BE(pos + 4);
    const body = blob.subarray(pos + 10, pos + 10 + frameSize);
    pos += 10 + frameSize;
    if (!frameId.equals(Buffer.from('GEOB')) || !body.length) continue;
    const geob = geobBody(body);
    if (geob.name) frames.push(geob);
  }
  return frames;
}

/**
 * Splits a GEOB frame body into its description and data.
 * The first byte is the text encoding. MIME and filename come next and are discarded.
 *
 * @param body Frame bytes after the GEOB header.
 * @returns The frame description and the remaining payload.
 *
 * Side effects: none.
 */
function geobBody(body: Buffer): { name: string; payload: Buffer } {
  const encoding = body[0];
  let rest = body.subarray(1);
  rest = splitText(0, rest).rest;
  rest = splitText(encoding, rest).rest;
  const name = splitText(encoding, rest);
  return { name: name.text, payload: name.rest };
}

/**
 * Splits one encoded text field from the front of a buffer.
 *
 * @param encoding ID3 text encoding byte.
 * @param buf Remaining frame bytes.
 * @returns The decoded text and the unused tail.
 *
 * Side effects: none.
 */
function splitText(encoding: number, buf: Buffer): { text: string; rest: Buffer } {
  if (encoding === 1 || encoding === 2) {
    const width = 2;
    let index = 0;
    if (buf.length >= 2) {
      const bom = buf.subarray(0, 2);
      if (bom.equals(Buffer.from([0xff, 0xfe])) || bom.equals(Buffer.from([0xfe, 0xff]))) index = 2;
    }
    while (index + 1 < buf.length) {
      if (buf[index] === 0 && buf[index + 1] === 0 && index % width === 0) {
        return { text: decodeText(encoding, buf.subarray(0, index)), rest: buf.subarray(index + 2) };
      }
      index += 2;
    }
    return { text: decodeText(encoding, buf), rest: Buffer.alloc(0) };
  }
  const nul = buf.indexOf(0);
  if (nul < 0) return { text: decodeText(encoding, buf), rest: Buffer.alloc(0) };
  return { text: decodeText(encoding, buf.subarray(0, nul)), rest: buf.subarray(nul + 1) };
}

/**
 * Decodes an ID3 text field.
 * Encoding 0 is Latin-1, 1 is UTF-16, 2 is UTF-16-BE, and anything else is UTF-8.
 *
 * @param encoding ID3 encoding byte.
 * @param raw Encoded field bytes.
 * @returns The decoded text with trailing NUL bytes removed.
 *
 * Side effects: none.
 */
function decodeText(encoding: number, raw: Buffer): string {
  let text: string;
  if (encoding === 0) text = raw.toString('latin1');
  else if (encoding === 1) text = decodeUtf16(raw);
  else if (encoding === 2) text = decodeUtf16Be(raw);
  else text = raw.toString('utf8');
  return text.replace(/\u0000+$/u, '');
}

/**
 * Decodes UTF-16, honoring a byte-order mark when one is present.
 *
 * @param raw Encoded bytes, with or without a BOM.
 * @returns The decoded text.
 *
 * Side effects: none.
 */
function decodeUtf16(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return decodeUtf16Be(raw.subarray(2));
  return raw.toString('utf16le');
}

/**
 * Decodes UTF-16 big-endian bytes by swapping each pair and reading little-endian.
 *
 * @param raw Big-endian UTF-16 bytes, without a BOM.
 * @returns The decoded text.
 *
 * Side effects: none.
 */
function decodeUtf16Be(raw: Buffer): string {
  const swapped = Buffer.alloc(raw.length - (raw.length % 2));
  for (let i = 0; i + 1 < raw.length; i += 2) {
    swapped[i] = raw[i + 1];
    swapped[i + 1] = raw[i];
  }
  return swapped.toString('utf16le');
}

/**
 * Parses a Serato Markers2 payload into cues, loops, and flips.
 * A leading `01 01` byte pair marks the base64 body. Serato omits base64 padding.
 *
 * @param payload Decoded GEOB data.
 * @returns Cues, loops, and flips. An unrecognized payload is empty.
 *
 * Side effects: none.
 */
export function parseMarkers2(payload: Buffer): MarkerEntries {
  const result: MarkerEntries = { cues: [], loops: [], flips: [] };
  if (payload.length < 2 || payload[0] !== 0x01 || payload[1] !== 0x01) return result;
  const filtered: number[] = [];
  for (const byte of payload.subarray(2)) {
    if (byte !== 0x0a && byte !== 0x00) filtered.push(byte);
  }
  if (!filtered.length) return result;
  // A length of 4n+1 is not a valid base64 group, so one alphabet character
  // is added before the standard '=' pad. Serato omits the padding.
  while (filtered.length % 4 === 1) filtered.push(0x41);
  const pad = (4 - (filtered.length % 4)) % 4;
  for (let i = 0; i < pad; i += 1) filtered.push(0x3d);
  // Node's base64 decoder drops an alphabet it cannot read instead of throwing.
  // `@` and other non-alphabet bytes produce an empty body, which is no entries.
  let decoded = Buffer.from(Buffer.from(filtered).toString('ascii'), 'base64');
  if (decoded.length >= 2 && decoded[0] === 0x01 && decoded[1] === 0x01) decoded = decoded.subarray(2);
  let pos = 0;
  while (pos < decoded.length) {
    const end = decoded.indexOf(0, pos);
    if (end < 0 || end + 5 > decoded.length) break;
    const kind = decoded.subarray(pos, end).toString('ascii');
    const length = decoded.readUInt32BE(end + 1);
    const start = end + 5;
    const blob = decoded.subarray(start, start + length);
    pos = start + length;
    if (blob.length < length) break;
    if (kind === 'CUE') {
      const cue = parseCue(blob);
      if (cue) result.cues.push(cue);
    } else if (kind === 'LOOP') {
      const loop = parseLoop(blob);
      if (loop) result.loops.push(loop);
    } else if (kind === 'FLIP') {
      const flip = parseFlip(blob);
      if (flip) result.flips.push(flip);
    }
  }
  return result;
}

/**
 * Formats three color bytes as a CSS hex color.
 *
 * @param raw At least three bytes of red, green, and blue.
 * @returns A string such as `#CC0000`, or null when `raw` is shorter than three bytes.
 *
 * Side effects: none.
 */
function color3(raw: Buffer): string | null {
  if (raw.length < 3) return null;
  const hex = (byte: number) => byte.toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(raw[0])}${hex(raw[1])}${hex(raw[2])}`;
}

/**
 * Parses one CUE entry.
 * Byte 1 is the cue index, bytes 2–5 the start in milliseconds, bytes 7–9
 * the RGB color, and the UTF-8 name begins at byte 12.
 *
 * @param blob Bytes of a single CUE record.
 * @returns Index, start time, color, and name, or null when the record is short.
 *
 * Side effects: none.
 */
export function parseCue(blob: Buffer): Cue | null {
  if (blob.length < 13) return null;
  const nameEnd = blob.indexOf(0, 12);
  const name = (nameEnd < 0 ? blob.subarray(12) : blob.subarray(12, nameEnd)).toString('utf8');
  return {
    index: blob[1],
    start_ms: blob.readUInt32BE(2),
    color: color3(blob.subarray(7, 10)),
    name,
  };
}

/**
 * Parses one LOOP entry.
 * Bytes 2–5 and 6–9 are start and end in milliseconds. The color field is
 * four bytes beginning at offset 14. Byte 19 is the lock flag.
 *
 * @param blob Bytes of a single LOOP record.
 * @returns Index, start, end, color, locked flag, and name, or null when the record is short.
 *
 * Side effects: none.
 */
export function parseLoop(blob: Buffer): Loop | null {
  if (blob.length < 20) return null;
  const color = blob.subarray(14, 18);
  const name = blob.length > 20
    ? (blob.indexOf(0, 20) < 0 ? blob.subarray(20) : blob.subarray(20, blob.indexOf(0, 20))).toString('utf8')
    : '';
  return {
    index: blob[1],
    start_ms: blob.readUInt32BE(2),
    end_ms: blob.readUInt32BE(6),
    color: color.length === 4 ? color3(color.subarray(1)) : color3(color),
    locked: Boolean(blob[19]),
    name,
  };
}

/**
 * Parses one FLIP entry.
 * Byte 1 is the index, byte 2 is the enabled flag, and the UTF-8 name follows.
 *
 * @param blob Bytes of a single FLIP record.
 * @returns Index, enabled flag, and name, or null when the record is short.
 *
 * Side effects: none.
 */
export function parseFlip(blob: Buffer): Flip | null {
  if (blob.length < 4) return null;
  const nameEnd = blob.indexOf(0, 3);
  const name = (nameEnd < 0 ? blob.subarray(3) : blob.subarray(3, nameEnd)).toString('utf8');
  return { index: blob[1], enabled: Boolean(blob[2]), name };
}

/**
 * Parses a Serato BeatGrid payload.
 * Version byte 1 is the only layout this reader accepts. More than 4096
 * markers is rejected. A payload shorter than the declared marker count is empty.
 *
 * @param payload BeatGrid bytes.
 * @returns Marker dicts. Earlier markers store a beat count. The last marker stores BPM.
 *
 * Side effects: none.
 */
export function parseBeatgrid(payload: Buffer): BeatMarker[] {
  if (payload.length < 6 || payload[0] !== 1) return [];
  const count = payload.readUInt32BE(2);
  if (count <= 0 || count > 4096) return [];
  let pos = 6;
  const markers: BeatMarker[] = [];
  for (let index = 0; index < count; index += 1) {
    if (pos + 8 > payload.length) return [];
    const position = roundTo(payload.readFloatBE(pos), 3);
    pos += 4;
    // Every marker stores a position in seconds. Earlier markers then store
    // a beat count. Only the last marker stores BPM.
    if (index === count - 1) {
      const bpm = roundTo(payload.readFloatBE(pos), 2);
      pos += 4;
      markers.push({ position, bpm });
    } else {
      const beats = payload.readUInt32BE(pos);
      pos += 4;
      markers.push({ position, beats });
    }
  }
  return markers;
}

/**
 * Rounds a number to a fixed number of decimal places.
 * Positions are kept to 3 places and BPM to 2, matching the Python reader.
 *
 * @param value The number to round.
 * @param digits Decimal places to keep.
 * @returns The rounded number.
 *
 * Side effects: none.
 */
function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
