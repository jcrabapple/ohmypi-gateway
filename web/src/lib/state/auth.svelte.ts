import { ApiError, onSignedOut } from '../api/client';
import { auth as authApi } from '../api/endpoints';

export type AuthStatus = 'unknown' | 'signed-in' | 'signed-out';

class AuthStore {
  status = $state<AuthStatus>('unknown');
  busy = $state(false);
  error = $state<string | null>(null);
  /** Seconds until the gateway lets this IP try again, when the last attempt hit the lockout (429). */
  lockedSec = $state<number | null>(null);

  constructor() {
    onSignedOut(() => {
      this.status = 'signed-out';
    });
  }

  /** Ask the gateway whether the cookie is still good. Network trouble leaves the status unknown. */
  async check(): Promise<void> {
    try {
      await authApi.me();
      this.status = 'signed-in';
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.status = 'signed-out';
      else this.error = messageOf(e);
    }
  }

  async login(token: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.error = null;
    this.lockedSec = null;
    try {
      await authApi.login(token.trim());
      this.status = 'signed-in';
      return true;
    } catch (e) {
      this.error = messageOf(e);
      if (e instanceof ApiError && e.status === 429) this.lockedSec = e.retryAfterSec ?? 900;
      return false;
    } finally {
      this.busy = false;
    }
  }

  async logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch {
      /* the cookie is cleared or the gateway is gone; either way we are out */
    }
    this.status = 'signed-out';
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

export const auth = new AuthStore();
