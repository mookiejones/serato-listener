import pc from "picocolors";

/**
 * Terminal log for the listener.
 *
 * Lines go to stdout and stderr. Callers omit track titles and file paths;
 * this module does not redact them itself.
 */

/**
 * Prints one informational line.
 *
 * @param text Line to write.
 *
 * Side effects: writes to stdout.
 */
export function logInfo(text:string): void {
  console.log(
    `${pc.bgBlue(pc.white(pc.italic(Date.now())))} ${text}`
  )

}

/**
 * Prints one error line.
 *
 * @param text Line to write.
 *
 * Side effects: writes to stderr.
 */
export function logError(text: string): void {
  console.error(pc.red(text));
}
