// Derived view of the active session's omp task plan. Everything recomputes
// from `active.state`, which the state poll (refreshQueued) refreshes and
// active.close() clears on session switch.
import { active } from './active.svelte';
import { countDone, countTotal, normalizePhases, pickActiveTask } from './plan';

class PlanStore {
  /** Normalized phases for the open session; [] when it has no plan or nothing is open. */
  phases = $derived(normalizePhases(active.state?.todoPhases));
  total = $derived(countTotal(this.phases));
  done = $derived(countDone(this.phases));
  /** First in_progress, else first pending, else first blocked. */
  activeTask = $derived(pickActiveTask(this.phases));
  hasPlan = $derived(this.total > 0);
  /** Narrow screens: the plan opens as a full-height sheet; this is that sheet's open flag. */
  sheet = $state(false);

  /** Session switch: the derivation follows active.state on its own, this clears the transient sheet. */
  reset(): void {
    this.sheet = false;
  }
}

export const plan = new PlanStore();
