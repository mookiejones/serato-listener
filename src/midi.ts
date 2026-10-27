/**
 * MIDI controls from the DJM-S11 and the PLX-CRSS12 turntables.
 *
 * A small Swift program (`src/midi-listen.swift`) subscribes to those
 * CoreMIDI sources and prints one JSON line per packet. This module parses
 * the bytes and keeps the latest control. Tests feed lines with `ingestLine`
 * and do not compile or spawn the helper.
 *
 * Channels are numbered from 1. Pitch bend is −8192 through 8191. Clock and
 * active sensing are dropped. Control-change pairs are not joined into 14-bit
 * values, so the low half (controllers 32 through 63) is kept.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** How many MIDI messages a batch can hold. Older ones are dropped. */
export const MIDI_PENDING_LIMIT = 2000;

/** Names passed to the helper. A source matches when its name contains one of these. */
const MIDI_FILTERS = ['DJM-S11', 'PLX-CRSS12'];

/** A channel voice message, before the port name is attached. */
export type MidiMessage = {
  t: number;
  message: 'note' | 'cc' | 'bend' | 'pressure' | 'program' | 'poly';
  /** Channel 1 through 16. */
  channel: number;
  /**
   * Note, controller, or program. Channel pressure and pitch bend use 0.
   * The stored program is one slot per channel; `number` is that program.
   */
  number: number;
  /** Velocity, controller value, pressure, program, or pitch bend. */
  value: number;
  /** Set for notes. Velocity 0 is a note off, so `on` is false. */
  on?: boolean;
};

/** A parsed message tagged with the CoreMIDI source it came from. */
export type MidiEvent = MidiMessage & { port: string };

/** Where compile and helper failures are written. Tests pass a silent logger. */
export type MidiLog = {
  info(text: string): void;
  error(text: string): void;
};

const silentLog: MidiLog = { info() {}, error() {} };

/**
 * Turns MIDI bytes into channel voice messages.
 *
 * One parser belongs to one port. Running status is remembered across
 * packets. Realtime bytes, including clock and active sensing, do not cancel
 * it. System common and system exclusive are not returned, and they do cancel
 * running status.
 */
export class MidiParser {
  private running: number | null = null;
  private sysex = false;
  private need = 0;
  private discard = false;
  private got: number[] = [];

  /**
   * Parses one packet.
   *
   * @param bytes MIDI bytes in wire order.
   * @param now Timestamp copied onto every message from this packet.
   * @returns The channel voice messages in the packet.
   *
   * Side effects: updates running status for the next `push`.
   */
  push(bytes: readonly number[], now: number): MidiMessage[] {
    const out: MidiMessage[] = [];
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) continue;
      if (byte >= 0xf8) continue;
      if (this.sysex) {
        if (byte === 0xf7) {
          this.sysex = false;
          this.running = null;
          this.need = 0;
          this.discard = false;
          this.got = [];
          continue;
        }
        if (byte < 0x80) continue;
        this.sysex = false;
        this.beginStatus(byte);
        continue;
      }
      if (byte >= 0x80) {
        this.beginStatus(byte);
        continue;
      }
      this.pushData(byte, out, now);
    }
    return out;
  }

  /**
   * Starts a status byte and drops any half-read message.
   *
   * @param byte A status byte below the realtime range.
   *
   * Side effects: changes parser state.
   */
  private beginStatus(byte: number): void {
    this.got = [];
    this.need = 0;
    this.discard = false;
    if (byte === 0xf0) {
      this.sysex = true;
      this.running = null;
      return;
    }
    this.sysex = false;
    if (byte >= 0xf0) {
      this.running = null;
      const extra = byte === 0xf1 || byte === 0xf3 ? 1 : byte === 0xf2 ? 2 : 0;
      if (extra > 0) {
        this.discard = true;
        this.need = extra;
      }
      return;
    }
    this.running = byte;
  }

  /**
   * Adds one data byte and emits a message when it completes.
   *
   * @param byte A data byte, 0 through 127.
   * @param out Messages collected for this packet.
   * @param now Timestamp for a completed message.
   *
   * Side effects: changes parser state and may append to `out`.
   */
  private pushData(byte: number, out: MidiMessage[], now: number): void {
    if (this.need === 0) {
      if (this.running === null) return;
      const kind = this.running & 0xf0;
      this.need = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      this.discard = false;
      this.got = [];
    }
    this.got.push(byte & 0x7f);
    if (this.got.length < this.need) return;
    const data = this.got;
    this.got = [];
    this.need = 0;
    if (this.discard || this.running === null) {
      this.discard = false;
      this.running = null;
      return;
    }
    const message = decodeChannel(this.running, data, now);
    if (message) out.push(message);
  }
}

/**
 * Decodes one finished channel voice message.
 *
 * @param status Channel status byte.
 * @param data Its data bytes.
 * @param now Timestamp for the message.
 * @returns The message, or null when the status is not channel voice.
 *
 * Side effects: none.
 */
function decodeChannel(status: number, data: number[], now: number): MidiMessage | null {
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (kind === 0x80) {
    return { t: now, message: 'note', channel, number: data[0], value: data[1], on: false };
  }
  if (kind === 0x90) {
    return { t: now, message: 'note', channel, number: data[0], value: data[1], on: data[1] !== 0 };
  }
  if (kind === 0xa0) {
    return { t: now, message: 'poly', channel, number: data[0], value: data[1] };
  }
  if (kind === 0xb0) {
    return { t: now, message: 'cc', channel, number: data[0], value: data[1] };
  }
  if (kind === 0xc0) {
    return { t: now, message: 'program', channel, number: data[0], value: data[0] };
  }
  if (kind === 0xd0) {
    return { t: now, message: 'pressure', channel, number: 0, value: data[0] };
  }
  if (kind === 0xe0) {
    const raw = data[0] | (data[1] << 7);
    return { t: now, message: 'bend', channel, number: 0, value: raw - 8192 };
  }
  return null;
}

/**
 * The slot that later messages of this kind replace.
 * Notes, controllers, and poly pressure are per number. Program, channel
 * pressure, and bend are one value per channel.
 *
 * @param message A parsed message.
 * @returns The number used in the control key.
 *
 * Side effects: none.
 */
function controlSlot(message: MidiMessage): number {
  if (message.message === 'cc' || message.message === 'note' || message.message === 'poly') {
    return message.number;
  }
  return 0;
}

/**
 * Holds the latest controls and the Swift helper that feeds them.
 *
 * `start` compiles and spawns the helper on macOS. `ingestLine` is the same
 * path the helper's stdout uses, so tests can supply packets without hardware.
 */
export class MidiHub {
  /** True after the helper process has been spawned. */
  enabled = false;
  private readonly log: MidiLog;
  private names: string[] = [];
  private readonly controls = new Map<string, MidiEvent>();
  private readonly parsers = new Map<string, MidiParser>();
  private pending: MidiEvent[] = [];
  private buffer = '';
  private child: ChildProcess | null = null;
  private stopping = false;

  /**
   * @param log Where helper failures are written. The default drops them.
   *
   * Side effects: none.
   */
  constructor(log: MidiLog = silentLog) {
    this.log = log;
  }

  /**
   * Port names from the latest `ports` line, in that order.
   *
   * @returns A copy of the names.
   *
   * Side effects: none.
   */
  portNames(): string[] {
    return this.names.slice();
  }

  /**
   * The latest message for each control.
   *
   * @returns A copy sorted by port, message, channel, and number.
   *
   * Side effects: none.
   */
  controlsList(): MidiEvent[] {
    return [...this.controls.values()].sort((a, b) => {
      if (a.port !== b.port) return a.port < b.port ? -1 : 1;
      if (a.message !== b.message) return a.message < b.message ? -1 : 1;
      if (a.channel !== b.channel) return a.channel - b.channel;
      return a.number - b.number;
    });
  }

  /**
   * Messages since the last flush.
   * The HTTP batch timer calls this about every 16 ms.
   *
   * @returns The queued messages. The queue is left empty.
   *
   * Side effects: empties the pending queue.
   */
  takePending(): MidiEvent[] {
    if (!this.pending.length) return [];
    return this.pending.splice(0, this.pending.length);
  }

  /**
   * Compiles the helper when the source is newer, then subscribes.
   * Failure is logged. The OSC listener keeps running either way.
   *
   * Side effects: may run `swiftc` and spawn `dist/midi-listen`.
   */
  start(): void {
    if (this.child) return;
    if (process.platform !== 'darwin') {
      this.log.info('MIDI is off on this system. CoreMIDI is macOS only.');
      return;
    }
    const binary = this.prepareBinary();
    if (!binary) return;
    this.stopping = false;
    this.enabled = true;
    const child = spawn(binary, MIDI_FILTERS, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.ingestLine(line);
        newline = this.buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) this.log.error(`midi: ${line}`);
    });
    child.on('error', (err: Error) => {
      this.enabled = false;
      this.log.error(`midi helper failed: ${err.message}`);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.stopping) return;
      this.enabled = false;
      this.log.error(`midi helper exited ${signal ?? code ?? 0}`);
    });
    this.log.info('MIDI helper listening for DJM-S11 and PLX-CRSS12');
  }

  /**
   * Stops the helper.
   *
   * Side effects: sends SIGTERM to the child when one is running.
   */
  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }

  /**
   * Accepts one helper line.
   *
   * A `ports` line replaces the port list and drops controls for ports that
   * left. A `data` line parses one packet and updates the latest controls.
   *
   * @param line One JSON object, without the newline.
   * @param now Timestamp for messages in a `data` line. The default is the current time.
   *
   * Side effects: updates ports, controls, and the pending queue.
   */
  ingestLine(line: string, now = Date.now()): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.log.error('midi: ignored a line that was not JSON');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    if (record.type === 'ports') {
      const names = stringList(record.ports);
      if (!names) return;
      this.replacePorts(names);
      return;
    }
    if (record.type === 'data') {
      if (typeof record.port !== 'string' || !record.port) return;
      const bytes = byteList(record.bytes);
      if (!bytes) return;
      this.ingestPacket(record.port, bytes, now);
    }
  }

  /**
   * Compiles `src/midi-listen.swift` into the directory of this module.
   *
   * @returns The binary path, or null when it cannot be built.
   *
   * Side effects: may run `swiftc` and write `midi-listen` next to this file's build.
   */
  private prepareBinary(): string | null {
    const binary = path.join(__dirname, 'midi-listen');
    const source = path.resolve(__dirname, '../src/midi-listen.swift');
    if (!fs.existsSync(source)) {
      this.log.error(`MIDI helper source is missing (${source}).`);
      return null;
    }
    if (!this.sourceIsNewer(source, binary)) return binary;
    const compiled = spawnSync('swiftc', ['-O', '-o', binary, source], {
      encoding: 'utf8',
      timeout: 120000,
    });
    if (compiled.error || compiled.status !== 0) {
      const detail = compiled.stderr || compiled.stdout || compiled.error?.message || 'swiftc failed';
      this.log.error(`MIDI helper compile failed: ${detail.trim()}`);
      return null;
    }
    this.log.info('Compiled the MIDI helper.');
    return binary;
  }

  /**
   * True when the binary is missing or older than the Swift source.
   *
   * @param source Path to `midi-listen.swift`.
   * @param binary Path to the compiled helper.
   * @returns Whether `swiftc` should run.
   *
   * Side effects: reads file timestamps.
   */
  private sourceIsNewer(source: string, binary: string): boolean {
    try {
      return fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw err;
    }
  }

  /**
   * Stores a new port list and forgets controls from ports that are gone.
   *
   * @param names Port names in helper order.
   *
   * Side effects: replaces `names` and may delete controls and parsers.
   */
  private replacePorts(names: string[]): void {
    const keep = new Set(names);
    for (const [key, event] of this.controls) {
      if (!keep.has(event.port)) this.controls.delete(key);
    }
    for (const port of this.parsers.keys()) {
      if (!keep.has(port)) this.parsers.delete(port);
    }
    const changed = names.length !== this.names.length || names.some((name, index) => name !== this.names[index]);
    this.names = names;
    if (changed && this.enabled) {
      this.log.info(`MIDI ports: ${names.join(', ') || '(none)'}`);
    }
  }

  /**
   * Parses one packet and remembers each message.
   *
   * @param port Source name from the helper.
   * @param bytes MIDI bytes.
   * @param now Timestamp for each message.
   *
   * Side effects: updates the parser, the control map, and the pending queue.
   */
  private ingestPacket(port: string, bytes: number[], now: number): void {
    let parser = this.parsers.get(port);
    if (!parser) {
      parser = new MidiParser();
      this.parsers.set(port, parser);
    }
    for (const message of parser.push(bytes, now)) {
      const event: MidiEvent = { ...message, port };
      this.controls.set(JSON.stringify([port, message.message, message.channel, controlSlot(message)]), event);
      this.pending.push(event);
    }
    const extra = this.pending.length - MIDI_PENDING_LIMIT;
    if (extra > 0) this.pending.splice(0, extra);
  }
}

/**
 * Copies a JSON array of strings.
 *
 * @param value The `ports` field.
 * @returns The names, or null when the field is not an array of strings.
 *
 * Side effects: none.
 */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    names.push(item);
  }
  return names;
}

/**
 * Copies a JSON array of MIDI bytes.
 *
 * @param value The `bytes` field.
 * @returns The bytes, or null when any item is outside 0 through 255.
 *
 * Side effects: none.
 */
function byteList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const bytes: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255) return null;
    bytes.push(item);
  }
  return bytes;
}
