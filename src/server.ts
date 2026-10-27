/**
 * HTTP and OSC entry point for the Serato listener.
 *
 * One process advertises `_SeratoIOSRemote._tcp` on macOS, accepts Serato's
 * TCP connection, and serves a localhost JSON API for the library. The browser
 * feed is `GET /events`. `GET /` is the live page. Library reads, related
 * tracks, and crate edits are under `/api/`. Deck file paths from the OSC
 * stream are passed into that API so a playing track can be linked to its
 * library row, and a track change publishes related matches.
 *
 * On macOS, `main` also subscribes to the DJM-S11 and PLX-CRSS12 CoreMIDI
 * inputs. `GET /api/midi` returns those controls. Tests leave that helper off.
 *
 * The page port is `127.0.0.1:8787` unless `PORT` is set. The OSC port is
 * ephemeral. Discovery uses the macOS `dns-sd` command; on Windows and Linux
 * the advert fails and the HTTP API still runs.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logError, logInfo } from './log';
import { LiveSession, PEER_NAME, selfTest } from './live';
import { LIVE_PAGE } from './live-page';
import { MidiHub } from './midi';
import { answerLibrary, readLibraryBody } from './library/http';
import { LibraryError } from './library/errors';
import { masterPath, rootPath } from './library/db';
import { currentRelatedPath, relatedForDecks, unavailableRelated, type RelatedBody } from './library/related';

const DEFAULT_HTTP_PORT = Number(process.env.PORT || 8787);

/** Header a same-origin client sets on library writes. A cross-site page cannot set it. */
export const CLIENT_HEADER = 'x-serato-listener';

/**
 * True when the library write header is present.
 *
 * @param req The incoming request.
 * @returns Whether `X-Serato-Listener` is `1`.
 *
 * Side effects: none.
 */
export function fromClient(req: IncomingMessage): boolean {
  return req.headers[CLIENT_HEADER] === '1';
}

/**
 * Sends a JSON response and does not cache it.
 *
 * @param res The HTTP response.
 * @param status HTTP status code.
 * @param body A JSON value.
 *
 * Side effects: writes the response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Sends an HTML document and does not cache it.
 *
 * @param res The HTTP response.
 * @param status HTTP status code.
 * @param html The document.
 *
 * Side effects: writes the response.
 */
function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

/** A listener that is bound and can be stopped without exiting the process. */
export interface RunningListener {
  /** HTTP port actually bound on `127.0.0.1`. */
  port: number;
  /** OSC port published to Serato. */
  oscPort: number;
  /** Live deck state. Tests can feed messages here without a real Serato socket. */
  session: LiveSession;
  /** MIDI controls. Tests can `ingestLine` without spawning the CoreMIDI helper. */
  midi: MidiHub;
  /**
   * Closes the HTTP server, the OSC server, the Bonjour advert, and the MIDI helper.
   *
   * Side effects: stops listening and drops open sockets.
   */
  stop(): Promise<void>;
}

/**
 * Passes the codec self-test, then listens for HTTP and for Serato.
 *
 * @param options.httpPort Port for the JSON API. `0` asks the OS for a free port.
 * @param options.advertise When false, `dns-sd` is not spawned. The default is true.
 * @param options.midi When true, compile and spawn the CoreMIDI helper. The default is false.
 * @returns The bound ports, the live session, the MIDI hub, and `stop`.
 *
 * Side effects: runs `selfTest`, listens on localhost and on `0.0.0.0`, and may spawn `dns-sd` and `swiftc`.
 */
export async function start(options?: {
  httpPort?: number;
  advertise?: boolean;
  midi?: boolean;
}): Promise<RunningListener> {
  selfTest();
  const session = new LiveSession({ info: logInfo, error: logError });
  const midi = new MidiHub({ info: logInfo, error: logError });
  const sseClients = new Set<ServerResponse>();

  /**
   * Writes one Server-Sent Events message to every open browser.
   *
   * @param obj JSON-serializable payload. It becomes one `data:` line.
   *
   * Side effects: writes on each response in `sseClients`.
   */
  const broadcast = (obj: unknown): void => {
    const payload = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  session.onUpdate = broadcast;
  const relatedKeys = new Map<number, string>();
  /**
   * Writes a `related` event for each deck whose matches changed.
   *
   * @param bodies One payload per deck.
   *
   * Side effects: writes Server-Sent Events for the decks that changed.
   */
  const publishRelated = (bodies: RelatedBody[]): void => {
    for (const body of bodies) {
      if (body.deck == null) continue;
      const key = JSON.stringify([
        body.ok,
        body.path,
        body.track_id,
        body.title,
        body.artist,
        body.key,
        body.bpm,
        body.sidecar,
        body.error ?? '',
        body.matches.map((match) => [match.source, match.track_id, match.filepath, match.reasons, match.note]),
      ]);
      if (relatedKeys.get(body.deck) === key) continue;
      relatedKeys.set(body.deck, key);
      broadcast({ type: 'related', ...body });
    }
  };
  /**
   * Reads related tracks for the current decks.
   * A missing library is an empty result. The event stream stays open.
   *
   * @returns One payload per deck.
   *
   * Side effects: opens and closes the library and the sidecar. Logs unexpected failures.
   */
  const relatedNow = (): RelatedBody[] => {
    try {
      return relatedForDecks(session.decks());
    } catch (err) {
      if (!(err instanceof LibraryError) || err.status !== 404) {
        const detail = err instanceof Error ? err.message : String(err);
        logError(`related ${detail}`);
      }
      return session.state.tracks.map((track, deck) => unavailableRelated(deck, track));
    }
  };
  session.onDeckTrack = () => {
    publishRelated(relatedNow());
  };

  const httpPort = options?.httpPort ?? DEFAULT_HTTP_PORT;
  const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res);
  });
  const boundHttp = await listenHttp(httpServer, httpPort);
  const oscServer = net.createServer((socket) => session.attachSocket(socket));
  const oscPort = await listenOsc(oscServer);
  const advert = options?.advertise === false ? null : advertise(oscPort);
  if (options?.midi) midi.start();
  const timer = setInterval(() => {
    const events = session.takePending();
    const midiEvents = midi.takePending();
    if (!events.length && !midiEvents.length) return;
    broadcast({
      type: 'batch',
      paired: session.state.paired,
      peerName: session.state.peerName,
      connections: session.state.connections,
      crossfader: session.state.crossfader,
      upfaders: session.state.upfaders,
      tracks: session.state.tracks,
      events,
      midi: midiEvents,
    });
  }, 16);

  /**
   * Answers one HTTP request.
   * `/` and `/live` are the related-tracks page. `/events` is the live feed.
   * `/health` does not open the library. `/api/midi` is the mixer and turntable controls.
   * Other `/api/` paths read or edit the library and include the current decks.
   *
   * @param req The incoming request.
   * @param res The response.
   *
   * Side effects: writes the response. A crate POST may write the library.
   */
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const snap = session.snapshot();
        snap.midiPorts = midi.portNames();
        snap.midiControls = midi.controlsList();
        snap.related = relatedNow();
        res.write(`data: ${JSON.stringify(snap)}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          paired: session.state.paired,
          connections: session.state.connections,
          crossfader: session.state.crossfader,
          library: masterPath(),
          root: rootPath(),
          related: currentRelatedPath(),
          midi: midi.enabled,
          midiPorts: midi.portNames(),
        });
        return;
      }
      if ((url.pathname === '/' || url.pathname === '/live') && (req.method || 'GET') === 'GET') {
        sendHtml(res, 200, LIVE_PAGE);
        return;
      }
      if (url.pathname === '/api/midi' && (req.method || 'GET') === 'GET') {
        sendJson(res, 200, { ok: true, ports: midi.portNames(), controls: midi.controlsList() });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const posted = req.method === 'POST' ? await readLibraryBody(req) : undefined;
        const answered = await answerLibrary({
          method: req.method,
          pathname: url.pathname,
          searchParams: url.searchParams,
          fromClient: fromClient(req),
          body: posted?.body,
          bodyError: posted?.error,
          decks: session.decks(),
        });
        if (answered) {
          if (answered.log) logError(`library ${answered.log}`);
          sendJson(res, answered.status, answered.body);
          return;
        }
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logError(`http ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
    }
  }

  logInfo(`listener at http://127.0.0.1:${boundHttp}`);
  return {
    port: boundHttp,
    oscPort,
    session,
    midi,
    /**
     * Stops both servers, the advert, and the MIDI helper.
     * The flush timer is cleared first so a batch cannot write to a closed response.
     *
     * Side effects: closes sockets and, when they were spawned, signals `dns-sd` and the MIDI helper.
     */
    async stop() {
      clearInterval(timer);
      midi.stop();
      if (advert && !advert.killed) advert.kill('SIGTERM');
      sseClients.clear();
      await closeServer(httpServer);
      await closeServer(oscServer);
    },
  };
}

/**
 * Binds the HTTP server to localhost.
 *
 * @param server Server whose request handler is already set.
 * @param port Requested port. `0` chooses a free port.
 * @returns The port that was bound.
 *
 * Side effects: listens on `127.0.0.1`.
 */
function listenHttp(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

/**
 * Listens on an ephemeral port for Serato's TCP connection.
 * Port 0 asks the OS for a free port. The Bonjour advert publishes that port.
 *
 * @param server TCP server that already attaches sockets to the session.
 * @returns The port that was bound.
 *
 * Side effects: opens a TCP server on `0.0.0.0`.
 */
function listenOsc(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      logInfo(`OSC listening on 0.0.0.0:${port}`);
      resolve(port);
    });
  });
}

/**
 * Closes a server and the sockets still attached to it.
 *
 * @param server HTTP or TCP server returned by `listen`.
 *
 * Side effects: destroys open connections and waits until the server closes.
 */
function closeServer(server: http.Server | net.Server): Promise<void> {
  const closer = server as http.Server;
  closer.closeAllConnections?.();
  return new Promise((resolve) => {
    closer.close(() => resolve());
  });
}

/**
 * Publishes the Bonjour service Serato browses for.
 * This spawns the macOS `dns-sd` command. On Windows and Linux the spawn
 * fails and the HTTP API still serves the library.
 *
 * @param port The ephemeral OSC port.
 * @returns The `dns-sd` child.
 *
 * Side effects: spawns a process and logs its stdout, stderr, and exit.
 */
function advertise(port: number): ChildProcess {
  const instance = `${PEER_NAME} @ ${os.hostname()}`;
  const child = spawn('dns-sd', ['-R', instance, '_SeratoIOSRemote._tcp', 'local', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) logInfo(`dns-sd: ${line}`);
  });
  child.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line) logError(`dns-sd: ${line}`);
  });
  child.on('exit', (code: number | null) => {
    if (code) logError(`dns-sd exited ${code}`);
  });
  child.on('error', (err: Error) => {
    logError(`dns-sd failed: ${err.message}. Discovery needs macOS.`);
  });
  return child;
}

/**
 * Runs the listener until SIGINT or SIGTERM.
 *
 * Side effects: everything `start` does, plus signal handlers that exit the process.
 */
async function main(): Promise<void> {
  const running = await start({ midi: true });
  /**
   * Stops the servers and ends the process.
   *
   * Side effects: calls `stop`, then exits with code 0.
   */
  const shutdown = () => {
    void running.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    logError(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
