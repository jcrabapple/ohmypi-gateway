// The agent config being edited in settings. Lives outside the page so switching pages keeps the
// draft, and so the overlay can ask "is there unsaved work?" before it closes.
import { host } from '../api/endpoints';

class ConfigDraft {
  /** The file as the gateway last returned or accepted it. */
  saved = $state<string | null>(null);
  text = $state('');
  file = $state<string | null>(null);
  parseError = $state<string | null>(null);
  loading = $state(false);
  loadError = $state<string | null>(null);
  saving = $state(false);
  /** The gateway's message for the last failed save, shown verbatim. */
  saveError = $state<string | null>(null);
  /** Set after a successful save, e.g. "Saved." plus any note from the gateway. */
  savedNote = $state<string | null>(null);

  get dirty(): boolean {
    return this.saved !== null && this.text !== this.saved;
  }

  async load(): Promise<void> {
    if (this.dirty || this.loading) return;
    this.loading = true;
    this.loadError = null;
    try {
      const r = await host.config();
      this.saved = r.raw ?? '';
      this.text = this.saved;
      this.file = r.file ?? r.path ?? null;
      this.parseError = r.parseError ?? null;
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : 'Could not load the config';
    } finally {
      this.loading = false;
    }
  }

  async save(): Promise<boolean> {
    if (this.saving || !this.dirty) return false;
    this.saving = true;
    this.saveError = null;
    this.savedNote = null;
    const sent = this.text;
    try {
      const r = await host.saveConfig(sent);
      this.saved = sent;
      this.parseError = null;
      this.savedNote = r.note?.trim() || 'Saved';
      return true;
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : 'Could not save the config';
      return false;
    } finally {
      this.saving = false;
    }
  }

  revert(): void {
    if (this.saved !== null) this.text = this.saved;
    this.saveError = null;
    this.savedNote = null;
  }

  /** Forget everything so the next visit loads the file fresh. */
  discard(): void {
    this.saved = null;
    this.text = '';
    this.saveError = null;
    this.savedNote = null;
    this.loadError = null;
  }
}

export const configDraft = new ConfigDraft();
