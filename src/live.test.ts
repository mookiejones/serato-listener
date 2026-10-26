/**
 * OSC handshake and deck-link checks.
 *
 * These cases do not open the live Serato library and do not advertise on
 * the network. The HTTP case uses the same fixture database as the library
 * suite and points `master.sqlite` at that file.
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  FrameReader,
  LiveSession,
  PEER_NAME,
  SENTINEL,
  TOPICS,
  authorizeDigest,
  decodeFrame,
  encodeOsc,
  encodeString,
  frame,
  selfTest,
} from './live';
import { buildDatabase } from './library/fixture';
import { invalidateLibraryCache, setMasterPathForTests } from './library/db';
import { start } from './server';
import type { OscMessage } from './types';

const silent = { info() {}, error() {} };

/**
 * Collects frames a session writes back to a fake socket.
 *
 * @returns The writer and the buffers it received.
 *
 * Side effects: none until `write` is called.
 */
function sink(): { write(chunk: Buffer): void; frames: Buffer[] } {
  const frames: Buffer[] = [];
  return {
    frames,
    /**
     * Stores one outbound frame.
     *
     * @param chunk Bytes the session would have written to Serato.
     *
     * Side effects: appends `chunk`.
     */
    write(chunk: Buffer) {
      frames.push(Buffer.from(chunk));
    },
  };
}

test('codec self-test round-trips a message and a bundle', () => {
  assert.doesNotThrow(() => selfTest());
});

test('frame reader splits sentinel-delimited packets', () => {
  const reader = new FrameReader();
  const ping = frame('/Ping');
  const first = reader.push(ping.subarray(0, 4));
  assert.equal(first.length, 0);
  const messages = reader.push(Buffer.concat([ping.subarray(4), frame('/Ping')]));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].address, '/Ping');
  assert.equal(messages[1].address, '/Ping');
});

test('authorize, ping, and pair subscribe to every topic', () => {
  const session = new LiveSession(silent);
  const writer = sink();
  const nonce = crypto.randomBytes(16);
  session.handleMessage(writer, {
    address: '/StreamMgmt/Authorize/Request',
    args: [{ type: 'i', value: 1 }, { type: 'b', value: nonce }],
  });
  const auth = decodeFrame(writer.frames[0]);
  assert.equal(auth.address, '/StreamMgmt/Authorize/Response');
  assert.equal(auth.args[0].type === 's' && auth.args[0].value, PEER_NAME);
  assert.equal(auth.args[2].type === 'b' && auth.args[2].value.equals(authorizeDigest(nonce)), true);

  session.handleMessage(writer, { address: '/Ping', args: [] });
  assert.equal(decodeFrame(writer.frames[1]).address, '/Ping');

  session.handleMessage(writer, {
    address: '/StreamMgmt/Pairing/Pair',
    args: [{ type: 's', value: 'Serato DJ' }],
  });
  const pair = decodeFrame(writer.frames[2]);
  assert.equal(pair.args[2].type === 'i' && pair.args[2].value, 1);
  assert.equal(session.state.paired, true);
  assert.equal(session.state.peerName, 'Serato DJ');
  const subscribed = writer.frames.slice(3).map((buf) => decodeFrame(buf).address);
  assert.deepEqual(subscribed, TOPICS);
  assert.equal(subscribed.includes('/Register/Status/Deck/Song/Filepath'), true);
  assert.equal(subscribed.includes('/Register/Status/Deck/Slicer/Loop'), true);
});

test('a second status socket does not replace the first deck path', () => {
  const session = new LiveSession(silent);
  const first = sink();
  const second = sink();
  const filepath: OscMessage = {
    address: '/Status/Deck/Song/Filepath',
    args: [{ type: 'i', value: 0 }, { type: 's', value: '/Music/a.mp3' }],
  };
  session.handleMessage(first, filepath);
  session.handleMessage(second, {
    address: '/Status/Deck/Song/Title',
    args: [{ type: 'i', value: 0 }, { type: 's', value: 'Other' }],
  });
  assert.equal(session.decks()[0].filepath, '/Music/a.mp3');
  assert.equal(session.decks()[0].title, '');
});

test('a bundled file-path frame updates that deck', () => {
  const session = new LiveSession(silent);
  const inner = encodeOsc('/Status/Deck/Song/Filepath', [
    { type: 'i', value: 1 },
    { type: 's', value: '/Music/b.mp3' },
  ]);
  const sized = Buffer.alloc(4 + inner.length);
  sized.writeUInt32BE(inner.length, 0);
  inner.copy(sized, 4);
  const packet = Buffer.concat([encodeString('#bundle'), Buffer.alloc(8), sized]);
  const reader = new FrameReader();
  assert.equal(reader.push(packet.subarray(0, 8)).length, 0);
  const messages = reader.push(Buffer.concat([packet.subarray(8), SENTINEL]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].address, '/Status/Deck/Song/Filepath');
  session.handleMessage(sink(), messages[0]);
  assert.equal(session.decks()[1].filepath, '/Music/b.mp3');
});

test('http library route links the live deck path and refuses an unsigned write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serato-live-'));
  const db = path.join(dir, 'master.sqlite');
  buildDatabase(db);
  const audio = path.join(dir, 'same-a.mp3');
  fs.writeFileSync(audio, 'not audio');
  const database = new DatabaseSync(db);
  database.prepare('UPDATE asset SET portable_id = ? WHERE id = 1').run(audio);
  database.close();
  setMasterPathForTests(db);
  invalidateLibraryCache();
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    running = await start({ httpPort: 0, advertise: false });
    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    const healthBody = await health.json() as { ok: boolean; library: string; root: string };
    assert.equal(health.status, 200);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.library, db);
    assert.equal(healthBody.root, path.join(dir, 'root.sqlite'));

    const writer = sink();
    running.session.handleMessage(writer, {
      address: '/Status/Deck/Song/Filepath',
      args: [{ type: 'i', value: 0 }, { type: 's', value: audio }],
    });
    running.session.handleMessage(writer, {
      address: '/Status/Deck/Song/Title',
      args: [{ type: 'i', value: 0 }, { type: 's', value: 'Same' }],
    });
    const listed = await fetch(`http://127.0.0.1:${running.port}/api/library`);
    const body = await listed.json() as { decks: Array<{ track_id: number | null; title: string }> };
    assert.equal(listed.status, 200);
    assert.equal(body.decks[0].track_id, 1);
    assert.equal(body.decks[0].title, 'Same');

    const forbidden = await fetch(`http://127.0.0.1:${running.port}/api/crates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', name: 'Nope' }),
    });
    assert.equal(forbidden.status, 403);

    const created = await fetch(`http://127.0.0.1:${running.port}/api/crates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-serato-listener': '1' },
      body: JSON.stringify({ action: 'create', name: 'Warmup' }),
    });
    assert.equal(created.status, 200);
  } finally {
    if (running) await running.stop();
    setMasterPathForTests(null);
    invalidateLibraryCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
