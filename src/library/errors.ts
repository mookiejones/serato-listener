/**
 * Errors the library routes return as JSON.
 *
 * A missing crate or a bad field is a `LibraryError`. Serato DJ Pro still
 * holding the database lock is a `SeratoOpen`, which the HTTP layer sends
 * as 409. Neither one is a crash report.
 */

/**
 * A library request that cannot be completed.
 * `status` is the HTTP status the route should send. The message is safe
 * to show in the page.
 */
export class LibraryError extends Error {
  readonly status: number;

  /**
   * Stores the message and the HTTP status.
   *
   * @param message Text returned to the page.
   * @param status HTTP status. Defaults to 400.
   *
   * Side effects: none.
   */
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'LibraryError';
    this.status = status;
  }
}

/**
 * The lock status the page uses to decide whether edits are offered.
 * `open` means a live Serato process holds the lock, or the database itself is locked.
 */
export interface LibraryLock {
  open: boolean;
  writable: boolean;
  pid: number | null;
  process: string | null;
  message: string;
  file_manager: string;
}

/**
 * Serato DJ Pro still has the library open, so a write was refused.
 * The HTTP status is 409. `info` is the lock payload.
 */
export class SeratoOpen extends LibraryError {
  readonly info: LibraryLock;

  /**
   * Builds a lock error from a status payload.
   *
   * @param info Lock status, including the message shown in the page.
   *
   * Side effects: none.
   */
  constructor(info: LibraryLock) {
    super(info.message, 409);
    this.name = 'SeratoOpen';
    this.info = info;
  }
}
