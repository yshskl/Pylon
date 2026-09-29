/**
 * The window's own event bus.
 *
 * Deliberately not Node's EventEmitter: this needs one typed shape, a bounded subscriber set
 * and a sequence number, and nothing else. It carries no transport — the agent server serves
 * it over `GET /events`, and the hub merges its own window's events with the satellites'.
 */

/** What happened. Kept coarse: a subscriber re-reads the resource, it does not diff events. */
export type PylonEventKind =
  | 'terminal.started'
  | 'terminal.ended'
  | 'terminal.closed'
  | 'diagnostics.changed'
  | 'debug.stopped'
  | 'debug.started'
  | 'debug.terminated';

export interface PylonEvent {
  kind: PylonEventKind;
  /** Per-emitter monotonic counter, so a consumer can spot a gap across a reconnect. */
  seq: number;
  ts: number;
  data: Record<string, unknown>;
}

export type EventListener = (event: PylonEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  private seq = 0;

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  emit(kind: PylonEventKind, data: Record<string, unknown> = {}): void {
    // Counted even with nobody listening, because the whole point of seq is to let a
    // reconnecting consumer see that it missed something — a counter that only advances
    // while someone is watching would hand it a contiguous run and assert the opposite.
    const seq = ++this.seq;
    // Nothing is queued, though: events describe state a subscriber re-reads anyway — so skip
    // building the event object at all when there is no one to hand it to.
    if (this.listeners.size === 0) return;
    const event: PylonEvent = { kind, seq, ts: Date.now(), data };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not stop the others, nor bubble into the emitting code.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/**
 * Collapse a burst of events into one.
 *
 * Diagnostics fire on every keystroke, so forwarding them raw would melt the stream. A
 * trailing debounce turns a typing burst into a single "something changed" — which is all a
 * subscriber needs, since it re-reads the resource rather than applying a delta.
 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  waitMs: number,
): { (...args: T): void; dispose(): void } {
  let timer: NodeJS.Timeout | null = null;
  let pending: T | null = null;
  const wrapped = (...args: T): void => {
    pending = args;
    // Re-armed on every call: without clearing first this fires on the *leading* edge and
    // then once per window through a continuous burst — the opposite of what a settle-based
    // "something changed" needs.
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const held = pending;
      pending = null;
      if (held) fn(...held);
    }, waitMs);
    timer.unref?.();
  };
  wrapped.dispose = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    pending = null;
  };
  return wrapped;
}
