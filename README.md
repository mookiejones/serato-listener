# serato-listener

A local interface for [Serato DJ Pro](https://serato.com/dj/pro). One Node process pretends to be Serato's old iPhone remote, and it can also read and edit the on-disk library after Serato has quit.

The live side speaks OSC. Serato browses for `_SeratoIOSRemote._tcp`, connects, and pushes deck status. The library side reads `master.sqlite` with `node:sqlite` (no native add-on) and mirrors crate edits into `root.sqlite`.

## Run

Node 22.13 or newer. `node:sqlite` is still marked experimental, so the process prints one warning the first time it opens a database. No extra flag is required. Info lines include a blue timestamp. Error lines are red.

```sh
npm install
npm run build
npm start                 # http://127.0.0.1:8787
PORT=9000 npm start
curl 127.0.0.1:8787/health
```

Open Serato DJ Pro on the same Mac. It finds the advert and connects by itself. Discovery uses the macOS `dns-sd` command, so pairing does not start on Windows or Linux. The HTTP API still does. On macOS the process also listens to the DJM-S11 and PLX-CRSS12 CoreMIDI inputs. That does not open the mixer's audio device.

Quit Serato before a crate edit. The first write in a process copies `master.sqlite` and, when it is present, `root.sqlite` into `Library/Backups`. Writes are refused while Serato DJ Pro is running.

`SERATO_LIBRARY_PATH` points the process at a different `master.sqlite`. `root.sqlite` is the file beside it, unless the `connection` table names another location database.

## Library files

| System | Master database | Location database |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Serato/Library/master.sqlite` | `root.sqlite` in that same folder |
| Windows | `%LOCALAPPDATA%\Serato\Library\master.sqlite` | `root.sqlite` in that same folder |

Reads are read-only (`PRAGMA query_only=ON`). Track and crate lists are cached until `master.sqlite` or its `-wal` file changes mtime. Lock status and the live deck links are read on every request.

## HTTP

The process binds `127.0.0.1` only.

| Method | Path | What it returns |
| --- | --- | --- |
| GET | `/health` | Pairing, the master and root paths, and whether MIDI is on |
| GET | `/events` | Server-Sent Events: a snapshot, then 16 ms batches |
| GET | `/api/midi` | DJM-S11 and PLX-CRSS12 port names, and the latest MIDI controls |
| GET | `/api/library` | Tracks, crates, metadata, lock status, and decks linked to library rows |
| GET | `/api/crates` | Crates for one space (`space` query) |
| POST | `/api/crates` | `create`, `rename`, `delete`, `add`, or `remove` |
| GET | `/api/tracks/:id/tags` | Markers2 cues, loops, and flips, plus the BeatGrid |

Crate posts require the header `X-Serato-Listener: 1`. A crate stores an export path in `dj_container_metadata.filename`: ancestor names joined by `%%`, then `.crate`, or `.scrate` for a smart crate. The same rows are mirrored into `root.sqlite` when that file is connected.

`GET /api/library` fills `decks[].track_id` when a live deck's file path matches a track's resolved path or its `portable_id`.

## MIDI

`npm start` on macOS compiles `src/midi-listen.swift` with `swiftc` into `dist/midi-listen` when the source is newer, then subscribes to CoreMIDI sources whose names contain `DJM-S11` or `PLX-CRSS12`. Serato can keep those ports open. CoreMIDI shares them. The helper does not open the DJM-S11 audio device.

Two sources with the same name are labeled in CoreMIDI unique-id order, for example `PLX-CRSS12 #1` and `PLX-CRSS12 #2`.

`GET /api/midi` returns `{ ok, ports, controls }`. A control is a note, control change, pitch bend, channel pressure, program change, or polyphonic pressure. Channels are 1 through 16. Pitch bend runs from −8192 to 8191. A note-on with velocity 0 is stored as `on: false`. Clock and active sensing are dropped. Low-half control changes (controllers 32 through 63) are kept as their own controls.

The `/events` snapshot adds `midiPorts` and `midiControls`. Each 16 ms batch adds `midi`, the messages since the previous batch. `/health` adds `midi` (true when the helper is running) and `midiPorts`.

This is the mixer's and turntables' MIDI, not the DJM-S11 HID reports, and not the fader values Serato forwards over OSC. OSC still reports upfaders and the crossfader after Serato has read them.

Passing no arguments to `dist/midi-listen` uses the same two name filters. Extra arguments are case-insensitive substrings that replace those filters.

## How the remote handshake works

Serato is the TCP client. This process is the server. The 16-byte sentinel and the shared secret come from the Serato DJ Pro 5.0.0.1251 binary.

1. `selfTest()` encodes and decodes one OSC message and one bundle. The process exits if that fails.
2. The HTTP server starts, then the OSC server on an ephemeral port, then the Bonjour advert. The service name is `Serato Listener @` plus the hostname.
3. `/StreamMgmt/Authorize/Request` is answered with the display name `Serato Listener`, a process id, and `MD5(nonce || SECRET)`.
4. `/StreamMgmt/Pairing/Pair` is answered with that name, that id, and the integer `1`, then one `/Register/Status/...` message for every topic.
5. Every `/Ping` is echoed. `/Status/` is recorded from the first socket that sends it.

Registered topics are playhead, title, artist, file path, the loaded flag, upfader, crossfader, the loop addresses, and the slicer loop. Other `/Status/` addresses are forwarded on the event feed as `ex` events. This process does not send `/Control/` messages.

The same binary also stores FX, sampler, and hardware status addresses that this process does not register. The full table is drawn in [docs/iphone-remote-channels.html](docs/iphone-remote-channels.html).

## Tests

```sh
npm test
```

The suite builds a temporary database and temporary ID3 bytes. It does not open a live Serato library, publish a Bonjour advert, or compile or spawn the MIDI helper.

## Layout

`src/live.ts` is the OSC codec and the deck session. `src/server.ts` is HTTP, the TCP listener, and `dns-sd`. `src/midi.ts` parses MIDI and spawns the helper. `src/midi-listen.swift` is that CoreMIDI client. `src/library/` reads and edits the SQLite library and the Markers2 / BeatGrid tags. `npm run build` compiles the TypeScript to `dist/`. `node dist/server.js` is what `npm start` runs, and on macOS it compiles the Swift helper into `dist/` on startup.
