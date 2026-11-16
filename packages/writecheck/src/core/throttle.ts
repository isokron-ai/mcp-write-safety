/**
 * A write throttle shared by every tester process on the host (a per-process throttle lets two
 * runs double the rate). The last write time lives in a state file;
 * a lock file taken with O_EXCL serialises the read-wait-write. A lock older than 30 s is a crashed
 * holder and is broken. Both halves of a barrier pair count as one release: the pair waits once,
 * then fires both requests, so the throttle never staggers a race.
 */

import { closeSync, constants, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { sleep } from './util.js';

export class Throttle {
  constructor(
    readonly file: string,
    readonly minIntervalMs: number,
  ) {}

  private async lock(): Promise<() => void> {
    const lock = `${this.file}.lock`;
    for (;;) {
      try {
        closeSync(openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
        return () => rmSync(lock, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
        } catch {
          /* raced with the holder releasing it */
        }
        await sleep(5);
      }
    }
  }

  /** Wait until at least `minIntervalMs` has passed since the last write by any process, then claim the slot. */
  async wait(): Promise<number> {
    if (this.minIntervalMs <= 0) return 0;
    const release = await this.lock();
    try {
      let last = 0;
      try {
        last = Number(readFileSync(this.file, 'utf8').trim()) || 0;
      } catch {
        /* first write */
      }
      const waitMs = Math.max(0, last + this.minIntervalMs - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      writeFileSync(this.file, String(Date.now()));
      return waitMs;
    } finally {
      release();
    }
  }
}
