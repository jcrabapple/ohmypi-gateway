// One remote value with the three states every panel needs: loading, failed, ready.
// A refresh keeps the old value on screen (`refreshing`) instead of blanking it.
export class Loader<T> {
  data = $state.raw<T | null>(null);
  error = $state<string | null>(null);
  loading = $state(false);
  private gen = 0;

  async run(fetcher: () => Promise<T>): Promise<T | null> {
    const gen = ++this.gen;
    this.loading = true;
    this.error = null;
    try {
      const value = await fetcher();
      if (gen === this.gen) this.data = value;
      return value;
    } catch (e) {
      if (gen === this.gen) this.error = e instanceof Error ? e.message : 'Something went wrong';
      return null;
    } finally {
      if (gen === this.gen) this.loading = false;
    }
  }

  get refreshing(): boolean {
    return this.loading && this.data !== null;
  }
}
