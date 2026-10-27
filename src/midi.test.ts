/**
 * MIDI parser and HTTP checks.
 *
 * These cases feed JSON lines into the hub. They do not compile the Swift
 * helper, spawn it, or open a CoreMIDI device.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIDI_PENDING_LIMIT, MidiHub, MidiParser } from './midi';
import { start } from './server';

test('parser reads channel voice messages', () => {
  const parser = new MidiParser();
  const messages = parser.push(
    [
      0x91, 60, 100,
      0x91, 60, 0,
      0x82, 61, 40,
      0xb0, 7, 100,
      0xb0, 32, 3,
      0xe0, 0, 64,
      0xe0, 0, 0,
      0xe0, 127, 127,
      0xd0, 40,
      0xc3, 12,
      0xa4, 70, 9,
    ],
    50,
  );
  assert.deepEqual(
    messages.map(({ message, channel, number, value, on }) => ({ message, channel, number, value, on })),
    [
      { message: 'note', channel: 2, number: 60, value: 100, on: true },
      { message: 'note', channel: 2, number: 60, value: 0, on: false },
      { message: 'note', channel: 3, number: 61, value: 40, on: false },
      { message: 'cc', channel: 1, number: 7, value: 100, on: undefined },
      { message: 'cc', channel: 1, number: 32, value: 3, on: undefined },
      { message: 'bend', channel: 1, number: 0, value: 0, on: undefined },
      { message: 'bend', channel: 1, number: 0, value: -8192, on: undefined },
      { message: 'bend', channel: 1, number: 0, value: 8191, on: undefined },
      { message: 'pressure', channel: 1, number: 0, value: 40, on: undefined },
      { message: 'program', channel: 4, number: 12, value: 12, on: undefined },
      { message: 'poly', channel: 5, number: 70, value: 9, on: undefined },
    ],
  );
});

test('running status survives clock, and sysex and system common cancel it', () => {
  const parser = new MidiParser();
  assert.deepEqual(parser.push([0xb0, 7], 1), []);
  const continued = parser.push([0xf8, 100, 0xfe, 8, 40], 2);
  assert.deepEqual(
    continued.map(({ number, value }) => [number, value]),
    [[7, 100], [8, 40]],
  );

  const afterSysex = parser.push([0xf0, 0xf8, 1, 2, 0xf7, 9, 1, 0xb0, 1, 2], 3);
  assert.deepEqual(
    afterSysex.map(({ number, value }) => [number, value]),
    [[1, 2]],
  );

  const afterSongPosition = parser.push([0xf2, 0, 0, 3, 4, 0xb1, 5, 6], 4);
  assert.equal(afterSongPosition.length, 1);
  assert.equal(afterSongPosition[0].channel, 2);
  assert.equal(afterSongPosition[0].number, 5);
  assert.equal(afterSongPosition[0].value, 6);
});

test('hub keeps the latest control and drops a port that disconnects', () => {
  const hub = new MidiHub();
  hub.ingestLine('not json');
  hub.ingestLine(JSON.stringify({ type: 'ports', ports: ['DJM-S11', 'PLX-CRSS12 #1'] }));
  hub.ingestLine(JSON.stringify({ type: 'data', port: 'DJM-S11', bytes: [0xb0, 7] }), 1);
  hub.ingestLine(JSON.stringify({ type: 'data', port: 'PLX-CRSS12 #1', bytes: [100] }), 2);
  assert.equal(hub.controlsList().length, 0);
  hub.ingestLine(JSON.stringify({ type: 'data', port: 'DJM-S11', bytes: [100] }), 3);
  assert.equal(hub.controlsList()[0].port, 'DJM-S11');
  assert.equal(hub.controlsList()[0].value, 100);
  hub.takePending();

  for (let i = 0; i < MIDI_PENDING_LIMIT + 1; i += 1) {
    hub.ingestLine(JSON.stringify({ type: 'data', port: 'DJM-S11', bytes: [0xb0, 7, i & 0x7f] }), 1000 + i);
  }
  hub.ingestLine(JSON.stringify({ type: 'data', port: 'DJM-S11', bytes: [0xc0, 4] }), 3000);
  hub.ingestLine(JSON.stringify({ type: 'data', port: 'DJM-S11', bytes: [0xc0, 9] }), 3001);
  hub.ingestLine(JSON.stringify({ type: 'data', port: 'PLX-CRSS12 #1', bytes: [0xb0, 1, 2] }), 3002);

  const pending = hub.takePending();
  assert.equal(pending.length, MIDI_PENDING_LIMIT);
  assert.equal(pending[0].message, 'cc');
  assert.equal(pending[0].value, 4);
  assert.equal(pending[pending.length - 1].port, 'PLX-CRSS12 #1');
  assert.equal(pending[pending.length - 2].value, 9);
  assert.equal(pending[pending.length - 3].value, 4);

  const controls = hub.controlsList();
  assert.deepEqual(
    controls.map(({ port, message, number, value }) => ({ port, message, number, value })),
    [
      { port: 'DJM-S11', message: 'cc', number: 7, value: MIDI_PENDING_LIMIT & 0x7f },
      { port: 'DJM-S11', message: 'program', number: 9, value: 9 },
      { port: 'PLX-CRSS12 #1', message: 'cc', number: 1, value: 2 },
    ],
  );

  hub.ingestLine(JSON.stringify({ type: 'ports', ports: ['PLX-CRSS12 #1'] }));
  assert.deepEqual(hub.portNames(), ['PLX-CRSS12 #1']);
  assert.equal(hub.controlsList().length, 1);
  assert.equal(hub.controlsList()[0].port, 'PLX-CRSS12 #1');
});

test('http midi route and the event feed accept ingested packets without a device', async () => {
  const running = await start({ httpPort: 0, advertise: false });
  const signal = AbortSignal.timeout(1000);
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/events`, { signal });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let text = '';
    let sawBatch = false;
    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      const healthBody = await health.json() as { midi: boolean; midiPorts: string[] };
      assert.equal(healthBody.midi, false);
      assert.deepEqual(healthBody.midiPorts, []);

      while (!sawBatch) {
        const split = text.indexOf('\n\n');
        if (split >= 0) {
          const payload = JSON.parse(text.slice(0, split).replace(/^data: /, '')) as {
            type: string;
            midiPorts?: string[];
            midiControls?: unknown[];
            midi?: Array<{ port: string; message: string; channel: number; number: number; value: number }>;
          };
          text = text.slice(split + 2);
          if (payload.type === 'snapshot') {
            assert.deepEqual(payload.midiPorts, []);
            assert.deepEqual(payload.midiControls, []);
            running.midi.ingestLine(JSON.stringify({
              type: 'ports',
              ports: ['DJM-S11', 'PLX-CRSS12 #1', 'PLX-CRSS12 #2'],
            }));
            running.midi.ingestLine(JSON.stringify({
              type: 'data',
              port: 'PLX-CRSS12 #2',
              bytes: [0xb0, 7, 64],
            }), 10);
            continue;
          }
          if (payload.type === 'batch') {
            assert.deepEqual(payload.midi, [{
              t: 10,
              port: 'PLX-CRSS12 #2',
              message: 'cc',
              channel: 1,
              number: 7,
              value: 64,
            }]);
            sawBatch = true;
          }
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      assert.equal(sawBatch, true);

      const listed = await fetch(`http://127.0.0.1:${running.port}/api/midi`);
      const body = await listed.json() as {
        ok: boolean;
        ports: string[];
        controls: Array<{ port: string; value: number }>;
      };
      assert.equal(listed.status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.ports, ['DJM-S11', 'PLX-CRSS12 #1', 'PLX-CRSS12 #2']);
      assert.equal(body.controls.length, 1);
      assert.equal(body.controls[0].port, 'PLX-CRSS12 #2');
      assert.equal(body.controls[0].value, 64);
    } finally {
      await reader.cancel();
    }
  } finally {
    await running.stop();
  }
});
