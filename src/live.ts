/**
 * Serato iOS Remote codec and live session.
 *
 * Serato DJ Pro still speaks the OSC protocol of its old iPhone remote.
 * This module pretends to be that remote: it frames messages with the
 * 16-byte sentinel, answers the authorize and pair handshake, subscribes
 * to the status topics, and keeps the four decks' file paths so the library
 * can match a playing track.
 *
 * The sentinel and `SECRET` were taken from the Serato DJ Pro 5.0.0.1251
 * binary. Changing either one makes Serato go silent. The library manager
 * does not speak this protocol; the handshake and topic list follow the
 * scratch-chart listener.
 */

import * as crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { OscArg, OscMessage, LiveEvent, AppState } from './types';
import type { PlayingDeckInput } from './library/db';

/**
 * Shared secret appended to the authorize nonce before MD5.
 * Serato checks this digest and drops the socket when it does not match.
 */
export const SECRET = Buffer.from(
  'd25db261a4411bc1f3788f57723b8977c541a4b619b94a9a8b45c46f8511c2f8',
  'hex',
);

/**
 * Frame delimiter. Serato TCP messages have no length prefix, so each OSC
 * packet is followed by these 16 bytes.
 */
export const SENTINEL = Buffer.from([
  0x4c, 0xaa, 0xc2, 0xae, 0x35, 0xb1, 0xc4, 0x76,
  0xdb, 0x5a, 0x64, 0x44, 0x03, 0xbd, 0x41, 0x70,
]);

/**
 * Loop and slicer subscriptions present in the Serato 5.0 binary.
 * Argument shapes are from public notes, not from a measured session.
 * Registering them asks Serato to push whatever it has. Unexpected
 * addresses are still forwarded as `ex` events.
 */
export const EXTRA_TOPICS: string[] = [
  '/Register/Status/Deck/Loop/AutoLoopOn',
  '/Register/Status/Deck/Loop/BeatLength',
  '/Register/Status/Deck/Loop/LoopRollOn',
  '/Register/Status/Deck/Loop/LoopInOutPoint',
  '/Register/Status/Deck/Loop/ManualLoopIn',
  '/Register/Status/Deck/Loop/ManualLoopOut',
  '/Register/Status/Deck/Loop/ManualLoopOn',
  '/Register/Status/Deck/Loop/ManualLoopSetting',
  '/Register/Status/Deck/Slicer/Loop',
];

/**
 * Status subscriptions sent after a successful pair.
 * The first seven were recorded on a live Serato DJ Pro 5.0.0.1251 session.
 * File path is included so a deck can be matched to a library row.
 */
export const TOPICS: string[] = [
  '/Register/Status/Deck/Playhead',
  '/Register/Status/Deck/Song/Title',
  '/Register/Status/Deck/Song/Artist',
  '/Register/Status/Deck/Song/Filepath',
  '/Register/Status/Deck/Song/Valid',
  '/Register/Status/Video/Deck/Mixer/Upfader',
  '/Register/Status/Video/Mixer/Crossfader',
  ...EXTRA_TOPICS,
];

/** Name Serato shows for this remote. */
export const PEER_NAME = 'Serato Listener';

const HISTORY_MS = 20000;

/** Something that can receive one OSC frame. A TCP socket satisfies this. */
export interface FrameWriter {
  write(chunk: Buffer): void;
}

/** Lines the session prints while a socket is open. */
export interface SessionLog {
  info(text: string): void;
  error(text: string): void;
}

/**
 * Rounds a byte length up to the next multiple of 4.
 * OSC pads every string and blob so the next field starts on a word boundary.
 *
 * @param n Byte length before padding.
 * @returns The padded length.
 *
 * Side effects: none.
 */
export function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Encodes one OSC string, including the null terminator and the padding.
 * The terminator is required even when the text is empty, so the size is
 * always at least 4 bytes.
 *
 * @param value Text to put on the wire. OSC strings are UTF-8.
 * @returns A buffer whose length is a multiple of 4.
 *
 * Side effects: none.
 */
export function encodeString(value: string): Buffer {
  const utf8Len = Buffer.byteLength(value, 'utf8');
  const buf = Buffer.alloc(pad4(utf8Len + 1));
  buf.write(value, 0, 'utf8');
  return buf;
}

/**
 * Reads one padded OSC string and reports where the next field starts.
 * Scanning stops at the first zero byte, then skips the pad that follows it.
 *
 * @param buf Packet bytes.
 * @param offset Index of the first byte of the string.
 * @returns The text and the index just past its padding.
 * @throws If the buffer ends before a null terminator.
 *
 * Side effects: none.
 */
export function decodeString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  if (end >= buf.length) throw new Error('OSC string not null-terminated');
  const value = buf.toString('utf8', offset, end);
  return { value, next: offset + pad4(end - offset + 1) };
}

/**
 * Encodes one OSC message.
 * The type tag string is a comma plus one letter per argument (`i`, `f`,
 * `s`, or `b`). Blobs are a big-endian length followed by padded bytes.
 *
 * @param address OSC address, such as `/Ping`.
 * @param args Typed arguments, in wire order.
 * @returns The message bytes, with no sentinel attached.
 *
 * Side effects: none.
 */
export function encodeOsc(address: string, args: OscArg[]): Buffer {
  const parts: Buffer[] = [encodeString(address), encodeString(',' + args.map((arg) => arg.type).join(''))];
  for (const arg of args) {
    if (arg.type === 'i') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg.value | 0, 0);
      parts.push(b);
    } else if (arg.type === 'f') {
      const b = Buffer.alloc(4);
      b.writeFloatBE(arg.value, 0);
      parts.push(b);
    } else if (arg.type === 's') {
      parts.push(encodeString(arg.value));
    } else if (arg.type === 'b') {
      const padded = Buffer.alloc(4 + pad4(arg.value.length));
      padded.writeUInt32BE(arg.value.length, 0);
      arg.value.copy(padded, 4);
      parts.push(padded);
    } else {
      const unreachable: never = arg;
      throw new Error(`bad osc arg ${(unreachable as OscArg).type}`);
    }
  }
  return Buffer.concat(parts);
}

/**
 * Decodes one OSC packet into the messages inside it.
 * A `#bundle` is flattened, including bundles nested inside it. Handshake
 * messages arrive bare. Status messages arrive inside bundles. The 8-byte
 * OSC timetag that follows the bundle header is skipped; events use the
 * local clock instead.
 *
 * @param buf One OSC packet, without the Serato sentinel.
 * @returns Every message in the packet, in order.
 * @throws If a bundle element claims more bytes than the packet has.
 *
 * Side effects: none.
 */
export function decodePacket(buf: Buffer): OscMessage[] {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const out: OscMessage[] = [];
    let cursor = 16;
    while (cursor + 4 <= buf.length) {
      const size = buf.readUInt32BE(cursor);
      cursor += 4;
      if (size === 0) continue;
      if (cursor + size > buf.length) throw new Error('OSC bundle element overruns packet');
      out.push(...decodePacket(buf.subarray(cursor, cursor + size)));
      cursor += size;
    }
    return out;
  }
  return [decodeMessage(buf)];
}

/**
 * Decodes one OSC message into an address and typed arguments.
 * An empty type tag means the message has no arguments. Tags other than
 * `i`, `f`, `s`, and `b` are rejected because Serato does not send them here.
 *
 * @param buf One message, not a bundle.
 * @returns The address and its arguments.
 * @throws If a tag runs past the end of the buffer or is not supported.
 *
 * Side effects: none.
 */
export function decodeMessage(buf: Buffer): OscMessage {
  const address = decodeString(buf, 0);
  if (address.next >= buf.length) return { address: address.value, args: [] };
  const tags = decodeString(buf, address.next);
  if (tags.value === '') return { address: address.value, args: [] };
  if (!tags.value.startsWith(',')) {
    throw new Error(`OSC type tag missing comma: ${tags.value}`);
  }
  const args: OscArg[] = [];
  let cursor = tags.next;
  for (const tag of tags.value.slice(1)) {
    if (tag === 'i') {
      if (cursor + 4 > buf.length) throw new Error('truncated int');
      args.push({ type: 'i', value: buf.readInt32BE(cursor) });
      cursor += 4;
    } else if (tag === 'f') {
      if (cursor + 4 > buf.length) throw new Error('truncated float');
      args.push({ type: 'f', value: buf.readFloatBE(cursor) });
      cursor += 4;
    } else if (tag === 's') {
      const text = decodeString(buf, cursor);
      args.push({ type: 's', value: text.value });
      cursor = text.next;
    } else if (tag === 'b') {
      if (cursor + 4 > buf.length) throw new Error('truncated blob');
      const len = buf.readUInt32BE(cursor);
      cursor += 4;
      if (cursor + len > buf.length) throw new Error('truncated blob data');
      args.push({ type: 'b', value: Buffer.from(buf.subarray(cursor, cursor + len)) });
      cursor += pad4(len);
    } else {
      throw new Error(`unsupported OSC tag ${tag}`);
    }
  }
  return { address: address.value, args };
}

/**
 * Builds one wire frame: an OSC packet followed by the 16-byte sentinel.
 * Serato frames have no length prefix, so the sentinel is the only delimiter.
 *
 * @param address OSC address to send.
 * @param args Arguments for that address. Empty for `/Ping` and for topic subscriptions.
 * @returns Bytes ready to write on the Serato socket.
 *
 * Side effects: none.
 */
export function frame(address: string, args: OscArg[] = []): Buffer {
  return Buffer.concat([encodeOsc(address, args), SENTINEL]);
}

/**
 * Decodes the first message in one framed buffer.
 *
 * @param buf A frame produced by `frame`, or a bare packet.
 * @returns The first decoded message.
 * @throws If the packet does not contain a message.
 *
 * Side effects: none.
 */
export function decodeFrame(buf: Buffer): OscMessage {
  const at = buf.indexOf(SENTINEL);
  const packet = at === -1 ? buf : buf.subarray(0, at);
  const messages = decodePacket(packet);
  if (!messages.length) throw new Error('empty OSC frame');
  return messages[0];
}

/**
 * MD5 of the authorize nonce with the shared secret appended.
 * This is the blob Serato expects in `/StreamMgmt/Authorize/Response`.
 *
 * @param nonce Blob from `/StreamMgmt/Authorize/Request`.
 * @returns The 16-byte digest.
 *
 * Side effects: none.
 */
export function authorizeDigest(nonce: Buffer): Buffer {
  return crypto.createHash('md5').update(nonce).update(SECRET).digest();
}

/**
 * Encodes and decodes one message and one bundle, then checks the values.
 * `start` runs this before listening. A thrown error means the codec cannot
 * talk to Serato, so the process should exit.
 *
 * Side effects: none on the network or the disk. Throws when a round trip fails.
 */
export function selfTest(): void {
  const nonce = crypto.randomBytes(16);
  const digest = authorizeDigest(nonce);
  const packet = frame('/StreamMgmt/Authorize/Response', [
    { type: 's', value: PEER_NAME },
    { type: 's', value: crypto.randomUUID() },
    { type: 'b', value: digest },
  ]);
  const decoded = decodeFrame(packet);
  if (decoded.address !== '/StreamMgmt/Authorize/Response') {
    throw new Error('OSC round-trip failed');
  }
  const replyBlob = decoded.args[2];
  if (replyBlob?.type !== 'b' || !replyBlob.value.equals(digest)) {
    throw new Error('OSC blob round-trip failed');
  }
  const inner = encodeOsc('/Status/Deck/Playhead', [
    { type: 'i', value: 0 },
    { type: 'f', value: 1.5 },
    { type: 'f', value: -0.25 },
    { type: 'f', value: 90 },
  ]);
  const sized = Buffer.alloc(4 + inner.length);
  sized.writeUInt32BE(inner.length, 0);
  inner.copy(sized, 4);
  const bundled = Buffer.concat([encodeString('#bundle'), Buffer.alloc(8), sized, SENTINEL]);
  const messages = decodePacket(bundled.subarray(0, bundled.indexOf(SENTINEL)));
  const position = messages[0]?.args[1];
  const rate = messages[0]?.args[2];
  if (position?.type !== 'f' || position.value !== 1.5 || rate?.type !== 'f' || rate.value !== -0.25) {
    throw new Error('bundle round-trip failed');
  }
}

/**
 * Splits a TCP byte stream into OSC packets on the sentinel.
 * There is no length prefix. Bytes before the first sentinel are one packet.
 * A chunk may contain several frames, or only part of one.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Appends one socket chunk and returns every complete packet now in hand.
   * An unfinished tail stays in the buffer for the next chunk. A megabyte
   * with no sentinel means the stream is not Serato's, so the caller drops it.
   *
   * @param chunk The next `data` event from the Serato socket.
   * @returns Messages from every frame that ended in this chunk.
   * @throws If the buffer grows past 1_000_000 bytes without a sentinel.
   *
   * Side effects: keeps the unparsed tail on this reader.
   */
  push(chunk: Buffer): OscMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: OscMessage[] = [];
    while (this.buffer.length > 0) {
      const at = this.buffer.indexOf(SENTINEL);
      if (at === -1) {
        if (this.buffer.length > 1_000_000) throw new Error('frame without sentinel');
        break;
      }
      if (at > 0) messages.push(...decodePacket(this.buffer.subarray(0, at)));
      this.buffer = this.buffer.subarray(at + SENTINEL.length);
    }
    return messages;
  }
}

/**
 * Reads one OSC number as an integer.
 * Floats are rounded because a deck index sometimes arrives as a float.
 * A missing argument, or a string or blob, is null rather than zero.
 *
 * @param args Arguments from one message.
 * @param index Position in that list.
 * @returns The integer, or null.
 *
 * Side effects: none.
 */
function argInt(args: OscArg[], index: number): number | null {
  const arg = args[index];
  if (!arg) return null;
  if (arg.type === 'i') return arg.value;
  if (arg.type === 'f') return Math.round(arg.value);
  return null;
}

/**
 * Reads one OSC number as a float.
 * Integers are accepted so a `1` flag and a `1.0` flag take the same path.
 *
 * @param args Arguments from one message.
 * @param index Position in that list.
 * @returns The number, or null when the argument is missing or not numeric.
 *
 * Side effects: none.
 */
function argFloat(args: OscArg[], index: number): number | null {
  const arg = args[index];
  if (!arg) return null;
  if (arg.type === 'f' || arg.type === 'i') return arg.value;
  return null;
}

/**
 * Reads one OSC string argument.
 * Missing arguments and non-strings become an empty string so a title update
 * can still be stored.
 *
 * @param args Arguments from one message.
 * @param index Position in that list.
 * @returns The text, or `''`.
 *
 * Side effects: none.
 */
function argString(args: OscArg[], index: number): string {
  const arg = args[index];
  return arg && arg.type === 's' ? arg.value : '';
}

/**
 * One live pairing with Serato.
 * The HTTP server and the tests share this object. It does not open sockets
 * itself; `server.ts` passes each TCP connection in.
 */
export class LiveSession {
  /** Display name and id sent in the authorize and pair replies. */
  readonly peerId = crypto.randomUUID();

  /** Faders, deck metadata, and whether the pair reply has been sent. */
  readonly state: AppState = {
    paired: false,
    peerName: '',
    connections: 0,
    crossfader: null,
    upfaders: [null, null, null, null],
    tracks: [
      { title: '', artist: '' },
      { title: '', artist: '' },
      { title: '', artist: '' },
      { title: '', artist: '' },
    ],
    lastPlayhead: [null, null, null, null],
  };

  /** Called when a pair or connection change should reach the browser feed immediately. */
  onUpdate: ((payload: unknown) => void) | null = null;

  private readonly history: LiveEvent[] = [];
  private readonly pending: LiveEvent[] = [];
  private statusWriter: FrameWriter | null = null;
  private logBudget = 40;

  /**
   * Stores the logger used for connect, pair, and budgeted status lines.
   *
   * @param log Destination for those lines.
   *
   * Side effects: none until a message arrives.
   */
  constructor(private readonly log: SessionLog) {}

  /**
   * Returns the four decks in the shape the library linker accepts.
   * `track_id` is filled later by `loadLibrary`. A deck with no file path
   * stays unmatched.
   *
   * @returns Deck index, file path, title, and artist for decks 0 through 3.
   *
   * Side effects: none.
   */
  decks(): PlayingDeckInput[] {
    return this.state.tracks.map((track, deck) => ({
      deck,
      filepath: track.filepath ?? null,
      title: track.title,
      artist: track.artist,
    }));
  }

  /**
   * Builds the first message a browser feed subscriber gets.
   * The snapshot is current fader and track state plus the last 4000 history
   * events.
   *
   * @returns A `snapshot` object. It is not written anywhere by this function.
   *
   * Side effects: none.
   */
  snapshot(): Record<string, unknown> {
    return {
      type: 'snapshot',
      paired: this.state.paired,
      peerName: this.state.peerName,
      connections: this.state.connections,
      crossfader: this.state.crossfader,
      upfaders: this.state.upfaders,
      tracks: this.state.tracks,
      events: this.history.slice(-4000),
    };
  }

  /**
   * Returns events that arrived since the last flush, and clears that queue.
   * The HTTP server calls this about every 16 ms. An empty queue returns an
   * empty list and does not notify subscribers.
   *
   * @returns The events to put in one `batch` message.
   *
   * Side effects: empties the pending queue. Does not write the network.
   */
  takePending(): LiveEvent[] {
    if (!this.pending.length) return [];
    return this.pending.splice(0, this.pending.length);
  }

  /**
   * Records that Serato opened another socket.
   *
   * @returns The new connection count.
   *
   * Side effects: increments `state.connections` and notifies `onUpdate`.
   */
  connected(): number {
    this.state.connections += 1;
    this.emit({ type: 'connections', connections: this.state.connections, paired: this.state.paired });
    return this.state.connections;
  }

  /**
   * Records that one Serato socket closed.
   * The last socket also clears the paired flag. If that socket owned the
   * status stream, the next status message elects a new owner.
   *
   * @param writer The socket that closed.
   *
   * Side effects: updates connection state and notifies `onUpdate`.
   */
  disconnected(writer: FrameWriter): void {
    this.state.connections = Math.max(0, this.state.connections - 1);
    if (this.statusWriter === writer) this.statusWriter = null;
    if (this.state.connections === 0) this.state.paired = false;
    this.emit({ type: 'connections', connections: this.state.connections, paired: this.state.paired });
  }

  /**
   * Answers one message from Serato.
   * Pings are echoed on the writer they arrived on. The authorize request is
   * answered with `MD5(nonce || SECRET)`. Pairing opens the stream and
   * subscribes to every topic. Status is recorded from the first writer that
   * sends any `/Status/` message; later writers are ignored for status.
   *
   * @param writer The connection the message arrived on.
   * @param msg One decoded OSC message.
   *
   * Side effects: may write OSC frames, update deck state, and notify `onUpdate`.
   */
  handleMessage(writer: FrameWriter, msg: OscMessage): void {
    if (msg.address !== '/Status/Deck/Playhead' && msg.address !== '/Ping') {
      this.logLine(`${msg.address} ${previewArgs(msg.args)}`);
    }

    if (msg.address === '/Ping') {
      writer.write(frame('/Ping'));
      return;
    }

    if (msg.address === '/StreamMgmt/Authorize/Request') {
      const nonce = msg.args.find((arg) => arg.type === 'b')?.value;
      if (!nonce) {
        this.log.error('authorize request had no nonce');
        return;
      }
      writer.write(frame('/StreamMgmt/Authorize/Response', [
        { type: 's', value: PEER_NAME },
        { type: 's', value: this.peerId },
        { type: 'b', value: authorizeDigest(nonce) },
      ]));
      this.log.info(`authorize reply sent (nonce ${nonce.length} bytes)`);
      return;
    }

    if (msg.address === '/StreamMgmt/Pairing/Pair') {
      this.state.peerName = argString(msg.args, 0) || this.state.peerName;
      writer.write(frame('/StreamMgmt/Pairing/Pair', [
        { type: 's', value: PEER_NAME },
        { type: 's', value: this.peerId },
        { type: 'i', value: 1 },
      ]));
      for (const topic of TOPICS) writer.write(frame(topic));
      this.state.paired = true;
      this.log.info('paired with Serato');
      this.emit({ type: 'paired', peerName: this.state.peerName, paired: true });
      return;
    }

    if (msg.address === '/StreamMgmt/Pairing/StatusChanged') return;

    if (msg.address.startsWith('/Status/')) {
      if (!this.statusWriter) this.statusWriter = writer;
      if (writer === this.statusWriter) this.handleStatus(msg);
    }
  }

  /**
   * Reads frames from one Serato socket and answers each message.
   * TCP_NODELAY is set so a ping echo is not held for a larger packet.
   *
   * @param socket A TCP connection Serato opened to the OSC port.
   *
   * Side effects: registers `data`, `close`, and `error` listeners and writes replies.
   */
  attachSocket(socket: Socket): void {
    socket.setNoDelay(true);
    this.connected();
    const reader = new FrameReader();
    const who = `${socket.remoteAddress}:${socket.remotePort}`;
    this.log.info(`Serato connected ${who}`);

    socket.on('data', (chunk: Buffer) => {
      let messages: OscMessage[];
      try {
        messages = reader.push(chunk);
      } catch (err) {
        this.log.error(`frame error from ${who}: ${(err as Error).message}`);
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        try {
          this.handleMessage(socket, msg);
        } catch (err) {
          this.log.error(`message error ${msg.address}: ${(err as Error).message}`);
        }
      }
    });

    socket.on('close', () => {
      this.disconnected(socket);
      this.log.info(`Serato closed ${who}`);
    });
    socket.on('error', (err: Error) => this.log.error(`socket ${who}: ${err.message}`));
  }

  /**
   * Turns one `/Status` message into a live event and updates deck state.
   * File path is stored on the deck so `loadLibrary` can match it to a track.
   *
   * @param msg One status message from the writer that owns the status stream.
   *
   * Side effects: updates faders, tracks, and the event queue.
   */
  private handleStatus(msg: OscMessage): void {
    const { address, args } = msg;
    if (address === '/Status/Video/Mixer/Crossfader') {
      const value = argFloat(args, 0);
      if (value == null) return;
      this.state.crossfader = value;
      this.note({ kind: 'xf', v: value });
      return;
    }

    const rawDeck = argInt(args, 0);
    if (rawDeck == null) {
      this.noteExtra(msg);
      return;
    }

    if (address === '/Status/Video/Deck/Mixer/Upfader') {
      const deck = rawDeck >= 0 && rawDeck <= 3 ? rawDeck : rawDeck - 1;
      if (deck < 0 || deck > 3) return;
      const value = argFloat(args, 1);
      if (value == null) return;
      this.state.upfaders[deck] = value;
      this.note({ kind: 'up', deck, v: value });
      this.log.info(`upfader deck=${deck + 1} ${value.toFixed(3)}`);
      return;
    }

    const deck = rawDeck >= 0 && rawDeck <= 3 ? rawDeck : rawDeck - 1;
    if (deck < 0 || deck > 3) return;

    if (address === '/Status/Deck/Playhead') {
      const pos = argFloat(args, 1);
      const rate = argFloat(args, 2);
      const bpm = argFloat(args, 3);
      if (pos == null || rate == null) return;
      const previous = this.state.lastPlayhead[deck];
      this.state.lastPlayhead[deck] = { pos, rate, bpm, at: Date.now() };
      this.note({ kind: 'ph', deck, pos, rate, bpm: bpm ?? 0 });
      if (!previous || Date.now() - previous.at > 2000) {
        this.log.info(`playhead deck=${deck + 1} pos=${pos.toFixed(3)} rate=${rate.toFixed(3)}`);
      }
      return;
    }

    if (address === '/Status/Deck/Song/Title') {
      this.state.tracks[deck].title = argString(args, 1);
      this.note({
        kind: 'tr',
        deck,
        title: this.state.tracks[deck].title,
        artist: this.state.tracks[deck].artist,
      });
      this.logLine(`deck ${deck + 1} title set`);
      return;
    }
    if (address === '/Status/Deck/Song/Artist') {
      this.state.tracks[deck].artist = argString(args, 1);
      this.note({
        kind: 'tr',
        deck,
        title: this.state.tracks[deck].title,
        artist: this.state.tracks[deck].artist,
      });
      return;
    }
    if (address === '/Status/Deck/Song/Filepath') {
      this.state.tracks[deck].filepath = argString(args, 1);
      this.noteExtra(msg);
      this.logLine(`deck ${deck + 1} file set`);
      return;
    }
    if (address === '/Status/Deck/Song/Valid') {
      this.state.tracks[deck].valid = argFloat(args, 1) ?? undefined;
      this.noteExtra(msg);
      return;
    }
    this.noteExtra(msg);
  }

  /**
   * Records a status message that is not a fader, playhead, title, or artist.
   * Blobs become a length label so the event can travel as JSON. The file
   * path itself stays on the deck and is not copied into the log line.
   *
   * @param msg The original Serato status message.
   *
   * Side effects: appends an `ex` event.
   */
  private noteExtra(msg: OscMessage): void {
    this.note({
      kind: 'ex',
      address: msg.address,
      args: msg.args.map((arg) => (arg.type === 'b' ? `blob:${arg.value.length}` : arg.value)),
    });
  }

  /**
   * Stamps an event and keeps it for the browser feed.
   * The wall clock is applied here so Serato's own timetag is not used.
   *
   * @param event A live event. `t` is overwritten with `Date.now()`.
   *
   * Side effects: mutates `event.t` and appends it to the history and the pending queue.
   */
  private note(event: LiveEvent): void {
    event.t = Date.now();
    this.history.push(event);
    this.pending.push(event);
    const cutoff = event.t - HISTORY_MS;
    while (this.history.length && (this.history[0].t ?? 0) < cutoff) this.history.shift();
  }

  /**
   * Prints a line until the startup budget runs out.
   * Playhead messages are logged separately. This budget is the first 40
   * other lines, then silence, so a long set does not fill the terminal.
   *
   * @param text Line to write.
   *
   * Side effects: writes through the logger and decrements the budget.
   */
  private logLine(text: string): void {
    if (this.logBudget <= 0) return;
    this.logBudget -= 1;
    this.log.info(text);
  }

  /**
   * Notifies the browser feed of a pair or connection change.
   *
   * @param payload JSON-serializable object.
   *
   * Side effects: calls `onUpdate` when one is set.
   */
  private emit(payload: unknown): void {
    this.onUpdate?.(payload);
  }
}

/**
 * Describes OSC arguments without copying string contents into the log.
 * Titles, artist names, and file paths travel as strings. The log keeps the
 * type and the size. Numbers stay as numbers.
 *
 * @param args Arguments from one message.
 * @returns A single preview line.
 *
 * Side effects: none.
 */
function previewArgs(args: OscArg[]): string {
  return args
    .map((arg) => {
      if (arg.type === 'b') return `blob:${arg.value.length}`;
      if (arg.type === 's') return `s:${Buffer.byteLength(arg.value)}b`;
      return `${arg.type}:${arg.value}`;
    })
    .join(' ');
}
