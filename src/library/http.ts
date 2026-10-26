/**
 * JSON routes for the Serato library.
 *
 * `GET /api/library` lists tracks and crates. `GET /api/crates` lists crates.
 * `POST /api/crates` runs a crate action. `GET /api/tracks/:id/tags` reads
 * cue, loop, flip, and beatgrid frames from the audio file. Writes require
 * the `X-Serato-Listener` header so a page on another site cannot post to
 * this process. The OSC stream is not touched here; the caller passes the
 * decks it already has.
 */

import type { IncomingMessage } from 'node:http';
import { LibraryError, SeratoOpen } from './errors';
import { crateAction } from './crates';
import { loadLibrary, resolvePortable, trackFile, type PlayingDeckInput } from './db';
import { markersFor } from './tags';

const BODY_LIMIT = 2_000_000;

/** One HTTP JSON answer. `log` is a detail for the local log, not the page. */
export interface LibraryAnswer {
  status: number;
  body: unknown;
  log?: string;
}

/** What the live OSC stream already knows about a deck, used to link a file path to a track. */
export type { PlayingDeckInput };

/**
 * Reads a library POST body.
 * Bodies over 2,000,000 bytes are rejected. Invalid JSON is reported and not parsed.
 *
 * @param req The incoming request.
 * @returns The parsed value, or an error flag.
 *
 * Side effects: consumes the request stream.
 */
export function readLibraryBody(req: IncomingMessage): Promise<{ body: unknown; error?: 'too-large' | 'invalid-json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    /**
     * Resolves the body promise once.
     *
     * @param value The parsed body or the error flag.
     *
     * Side effects: resolves the promise the first time it is called.
     */
    const finish = (value: { body: unknown; error?: 'too-large' | 'invalid-json' }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        finish({ body: null, error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        finish({ body: null });
        return;
      }
      try {
        finish({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      } catch {
        finish({ body: null, error: 'invalid-json' });
      }
    });
    req.on('error', () => finish({ body: null, error: 'invalid-json' }));
  });
}

/**
 * Answers a library route, or returns null when the path is not under `/api/`.
 * Unknown `/api/` paths are a JSON 404 so they are not served as static files.
 *
 * @param input.method HTTP method.
 * @param input.pathname Path beginning with `/`.
 * @param input.searchParams Query string.
 * @param input.fromClient True when `X-Serato-Listener` is present. Writes require it.
 * @param input.body Parsed POST body.
 * @param input.bodyError Set when the body was too large or not JSON.
 * @param input.decks Live decks whose file paths should be linked to library tracks.
 * @returns The status and JSON body.
 *
 * Side effects: reads the library, and for a crate POST may write it after a backup.
 */
export async function answerLibrary(input: {
  method: string | undefined;
  pathname: string;
  searchParams: URLSearchParams;
  fromClient: boolean;
  body?: unknown;
  bodyError?: 'too-large' | 'invalid-json';
  decks?: PlayingDeckInput[];
}): Promise<LibraryAnswer | null> {
  if (!input.pathname.startsWith('/api/')) return null;
  try {
    return await dispatch(input);
  } catch (err) {
    if (err instanceof SeratoOpen) {
      return { status: 409, body: { error: err.message, serato: err.info } };
    }
    if (err instanceof LibraryError) {
      return { status: err.status, body: { error: err.message } };
    }
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    return {
      status: 500,
      body: { error: 'Something went wrong.' },
      log: detail,
    };
  }
}

/**
 * Routes one `/api/` request after the error boundary.
 *
 * @param input The same fields `answerLibrary` received.
 * @returns The status and JSON body.
 *
 * Side effects: reads or writes the library, depending on the route.
 */
async function dispatch(input: {
  method: string | undefined;
  pathname: string;
  searchParams: URLSearchParams;
  fromClient: boolean;
  body?: unknown;
  bodyError?: 'too-large' | 'invalid-json';
  decks?: PlayingDeckInput[];
}): Promise<LibraryAnswer> {
  const method = input.method || 'GET';
  if (input.pathname === '/api/library' || input.pathname === '/api/crates') {
    if (method !== 'GET' && !(input.pathname === '/api/crates' && method === 'POST')) {
      return { status: 405, body: { error: 'That method is not available here.' } };
    }
  }
  if (input.pathname === '/api/library' && method === 'GET') {
    const payload = loadLibrary(input.searchParams.get('space'), input.decks || []);
    return { status: 200, body: payload };
  }
  if (input.pathname === '/api/crates' && method === 'GET') {
    const payload = loadLibrary(input.searchParams.get('space'), input.decks || []);
    return {
      status: 200,
      body: {
        source: payload.source,
        space: payload.space,
        root_id: payload.root_id,
        crates: payload.crates,
        serato: payload.serato,
        writable: payload.writable,
      },
    };
  }
  if (input.pathname === '/api/crates' && method === 'POST') {
    if (!input.fromClient) return { status: 403, body: { error: 'Forbidden' } };
    if (input.bodyError === 'too-large') return { status: 413, body: { error: 'That request is too large.' } };
    if (input.bodyError === 'invalid-json') return { status: 400, body: { error: 'That request was not JSON.' } };
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
      return { status: 400, body: { error: 'Choose a crate action.' } };
    }
    const result = await crateAction(input.body as Record<string, unknown>);
    return { status: 200, body: result };
  }
  const tags = input.pathname.match(/^\/api\/tracks\/(\d+)\/tags$/);
  if (tags) {
    if (method !== 'GET') return { status: 405, body: { error: 'That method is not available here.' } };
    const assetId = Number(tags[1]);
    const track = trackFile(assetId);
    if (!track) return { status: 404, body: { error: 'That track is not in the library.' } };
    const resolved = resolvePortable(track.portableId);
    return {
      status: 200,
      body: {
        id: track.id,
        path: resolved.path,
        on_disk: resolved.onDisk,
        tags: markersFor(resolved.path, resolved.onDisk === true),
      },
    };
  }
  return { status: 404, body: { error: 'Not found' } };
}
