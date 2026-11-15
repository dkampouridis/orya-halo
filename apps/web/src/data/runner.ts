/**
 * Source runner: schedules every `SourcePlugin` the worker runs.
 *
 * - `fetch` on a cadence (`refreshRate`, with jitter), one-shot for `static`.
 * - `viewAware`: fetch again once the camera settles somewhere new, no sooner
 *   than `refreshRate` after the last fetch.
 * - `recomputeRate`: re-normalise the last raw data, for clock-driven sources.
 *   While replaying, every source is re-normalised for the moment shown.
 * - `stream`: open, and reopen with backoff when it reports an error.
 * - Failures are read from the plugin's `SourceError` code. A missing key and
 *   a refusal ("blocked") wait a full refresh interval, and a refusal is
 *   remembered across reloads; anything else backs off exponentially and
 *   never sooner than a `Retry-After`. Sources with a `cacheTtl` (providers
 *   that ration downloads) are never retried in a hurry at all.
 * - A plugin with a `fallback` (an older copy, a bundled snapshot) has it
 *   shown, marked degraded, whenever nothing is on screen and `fetch` has
 *   failed, is held back or is slow to answer. Fresh data replaces it quietly.
 * - Nothing polls while the tab is hidden; whatever fell due runs on return.
 * - Switching a layer off aborts everything in flight for it.
 */
import type {
  EntityUpdate,
  HaloEvent,
  LayerId,
  PathSet,
  SourceContext,
  SourceErrorCode,
  SourcePlugin,
  TileOverlay,
} from "@orya-halo/schema";
import { TimeoutError, createPolicyFetch, readHold, writeHold } from "./fetching.ts";
import type { Hold, ResponseCache } from "./fetching.ts";
import { layerSubject } from "./layers.ts";
import type { FeedState } from "./layers.ts";

export interface RunnerHost {
  /** Clock time: the scrubbed moment when replaying, otherwise wall time. */
  now(): number;
  /** True while the clock follows wall time. */
  isLive(): boolean;
  view(): SourceContext["view"];
  key(name: string): string | undefined;
  readonly assetBase: string;
  readonly fetch: typeof fetch;
  readonly cache: ResponseCache | null;
  /** False when the device knows it has no network at all. Assumed true when absent. */
  online?(): boolean;
  onEntities(plugin: SourcePlugin, update: EntityUpdate): void;
  onEvents(events: HaloEvent[]): void;
  onPaths(plugin: SourcePlugin, paths: PathSet): void;
  onTiles(plugin: SourcePlugin, overlay: TileOverlay | null): void;
  onState(plugin: SourcePlugin, state: FeedState | null): void;
  /** The plugin stopped: drop what it contributed. */
  onStopped(plugin: SourcePlugin): void;
}

export interface RunnerOptions {
  /** Longest wait for response headers per request. */
  requestTimeoutMs?: number;
  /** Longest one `plugin.fetch` call may take in total. */
  fetchTimeoutMs?: number;
  /** First retry delay; doubles per consecutive failure. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** How long a first `fetch` may take before the plugin's `fallback` is shown meanwhile. */
  fallbackAfterMs?: number;
  /** Source of randomness for jitter, 0..1. Injected so tests are exact. */
  random?: () => number;
}

interface Task {
  plugin: SourcePlugin;
  /** One per enable: aborted when the layer is switched off. */
  session: AbortController | null;
  raw: unknown;
  hasRaw: boolean;
  /** True once any output was routed. */
  hasData: boolean;
  /** True while what is shown came from an expired cached copy. */
  staleData: boolean;
  failures: number;
  inFlight: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** Wall time the next poll is due; 0 when none is planned. */
  pollDueMs: number;
  recomputeTimer: ReturnType<typeof setTimeout> | null;
  /** Pending re-normalise for a clock change while replaying. */
  clockTimer: ReturnType<typeof setTimeout> | null;
  lastNormaliseMs: number;
  retryAfterUntilMs: number;
  closeStream: (() => void) | null;
  updatedMs: number;
  pathCount: number | null;
  /** Wall time the last request to the provider started. */
  lastFetchMs: number;
  /** The view the last fetch was made for (`viewAware` sources). */
  fetchedView: SourceContext["view"];
  /** The last tile overlay routed, serialised, so an identical one is not sent again. */
  lastTiles: string | null;
  /** The provider told us to stay away until `untilMs`. Outlives the session. */
  hold: Hold | null;
  /** True while a hold for this source is written to the cache. */
  holdStored: boolean;
  /** The plugin's fallback message while what is shown came from `fallback`, else null. */
  standIn: string | null;
  /** The fallback attempt of this session, if one was made: resolves true when it was shown. */
  fallback: Promise<boolean> | null;
  /** Shows the fallback if the first fetch is still out when it fires. */
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

/** What one attempt saw on the wire. */
interface Seen {
  status: number;
  stale: boolean;
  staleStatus: number;
  /** URLs this attempt wrote to the cache. */
  stored: string[];
}

interface Failure {
  /** A plugin's `SourceError` code, or how an untyped failure looked from here. */
  code: SourceErrorCode | "refused" | "network" | "unknown";
  status: number;
  /** The plugin's own sentence, when it gave one. */
  message: string | null;
}

const WALL = () => Date.now();
/**
 * How long a rationed provider is left alone after a request that got no
 * answer at all. In a browser a refusal without CORS headers looks exactly
 * like a dead network, so this must be long enough not to add up.
 */
const OPAQUE_HOLD_MS = 15 * 60_000;
/** While replaying, sources without a `recomputeRate` are re-normalised at most this often. */
const CLOCK_NORMALISE_MS = 200;
/** A view counts as new when its centre moved by this share of the old view's span, or a zoom level. */
const VIEW_MOVE_FRACTION = 0.25;

export class SourceRunner {
  private readonly tasks: Task[] = [];
  private readonly host: RunnerHost;
  private readonly requestTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly fallbackAfterMs: number;
  private readonly random: () => number;
  private visible = true;
  private disposed = false;

  constructor(plugins: readonly SourcePlugin[], host: RunnerHost, options: RunnerOptions = {}) {
    this.host = host;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 60_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 2_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 5 * 60_000;
    this.fallbackAfterMs = options.fallbackAfterMs ?? 1500;
    this.random = options.random ?? Math.random;
    for (const plugin of plugins) {
      // Gateway layers are fed by the gateway client; the plugin only
      // describes them (schema, attribution, detail).
      if (plugin.transport === "gateway") continue;
      this.tasks.push({
        plugin,
        session: null,
        raw: undefined,
        hasRaw: false,
        hasData: false,
        staleData: false,
        failures: 0,
        inFlight: false,
        pollTimer: null,
        pollDueMs: 0,
        recomputeTimer: null,
        clockTimer: null,
        lastNormaliseMs: 0,
        retryAfterUntilMs: 0,
        closeStream: null,
        updatedMs: 0,
        pathCount: null,
        lastFetchMs: 0,
        fetchedView: undefined,
        lastTiles: null,
        hold: null,
        holdStored: false,
        standIn: null,
        fallback: null,
        fallbackTimer: null,
      });
    }
  }

  /** Last raw data of a plugin, for `plugin.track()`. */
  raw(pluginId: string): unknown {
    return this.tasks.find((t) => t.plugin.id === pluginId)?.raw;
  }

  /** When each running source next asks its provider, and why it is waiting. For diagnostics. */
  schedule(): { id: string; nextFetchMs: number; holdUntilMs: number; failures: number }[] {
    return this.tasks
      .filter((task) => task.session !== null)
      .map((task) => ({
        id: task.plugin.id,
        nextFetchMs: task.pollDueMs,
        holdUntilMs: task.hold?.untilMs ?? 0,
        failures: task.failures,
      }));
  }

  setLayerEnabled(layer: LayerId, enabled: boolean): void {
    for (const task of this.tasks) {
      if (task.plugin.layer !== layer) continue;
      if (enabled && task.session === null) this.start(task);
      else if (!enabled && task.session !== null) this.stop(task);
    }
  }

  /** Pause polling while hidden; on return, run whatever fell due. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const task of this.tasks) {
      if (task.session === null) continue;
      if (!visible) {
        if (task.pollTimer !== null) clearTimeout(task.pollTimer);
        task.pollTimer = null;
        if (task.recomputeTimer !== null) clearTimeout(task.recomputeTimer);
        task.recomputeTimer = null;
        if (task.clockTimer !== null) clearTimeout(task.clockTimer);
        task.clockTimer = null;
      } else {
        if (task.pollDueMs > 0) this.armPoll(task, Math.max(0, task.pollDueMs - WALL()));
        this.recompute(task);
      }
    }
  }

  /**
   * The clock jumped or changed mode. Clock-driven sources re-normalise at
   * once. So does every other source, a little more lazily: what a source
   * shows may depend on the moment (earthquakes that have not happened yet,
   * the last day of fires) even when it does not move by itself.
   */
  clockChanged(): void {
    for (const task of this.tasks) {
      if (task.session === null || !task.hasRaw) continue;
      const plugin = task.plugin;
      if (plugin.recomputeRate !== undefined) this.recompute(task);
      // Static geometry (cables) is the same at every moment.
      else if (plugin.transport !== "static" && task.pathCount === null) this.clockNormalise(task);
    }
  }

  /**
   * The camera settled. A `viewAware` source whose last fetch was for a
   * meaningfully different view fetches again, as soon as its `refreshRate`
   * allows.
   */
  viewChanged(): void {
    const view = this.host.view();
    if (view === undefined) return;
    for (const task of this.tasks) {
      const plugin = task.plugin;
      if (task.session === null || !plugin.viewAware || !plugin.fetch || plugin.stream) continue;
      // A fetch in flight, a retry or a hold already has its own next step,
      // and that step will read the view as it is then.
      if (task.inFlight || task.failures > 0 || this.activeHold(task) !== null) continue;
      if (task.lastFetchMs === 0 || !viewMoved(task.fetchedView, view)) continue;
      const dueMs = Math.max(WALL(), task.lastFetchMs + plugin.refreshRate);
      if (task.pollDueMs > 0 && task.pollDueMs <= dueMs) continue;
      this.schedulePoll(task, dueMs - WALL());
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const task of this.tasks) {
      if (task.session !== null) this.stop(task, true);
    }
  }

  private start(task: Task): void {
    const plugin = task.plugin;
    if (plugin.requiresKey !== undefined && !this.host.key(plugin.requiresKey)) {
      this.host.onState(plugin, {
        status: "needs-key",
        message: `${layerSubject(plugin.layer, "need", "needs")} a key from ${plugin.name}. Add ${plugin.requiresKey} to your .env file and reload.`,
      });
      return;
    }
    const session = new AbortController();
    task.session = session;
    task.failures = 0;
    task.retryAfterUntilMs = 0;
    this.host.onState(plugin, { status: "loading" });
    if (plugin.stream) this.openStream(task);
    else if (plugin.fetch) void this.begin(task, session);
    else {
      this.host.onState(
        plugin,
        this.failureState(task, { code: "unknown", status: 0, message: null }, null),
      );
    }
  }

  /** First poll of a session, once we know whether a hold from before a reload still runs. */
  private async begin(task: Task, session: AbortController): Promise<void> {
    if (this.activeHold(task) === null && this.host.cache !== null) {
      const hold = await readHold(this.host.cache, task.plugin.id, WALL());
      if (task.session !== session) return;
      if (hold !== null) {
        task.hold = hold;
        task.holdStored = true;
      }
    }
    void this.poll(task);
  }

  private stop(task: Task, quiet = false): void {
    task.session?.abort(new DOMException("Layer switched off", "AbortError"));
    task.session = null;
    if (task.pollTimer !== null) clearTimeout(task.pollTimer);
    if (task.recomputeTimer !== null) clearTimeout(task.recomputeTimer);
    if (task.clockTimer !== null) clearTimeout(task.clockTimer);
    if (task.fallbackTimer !== null) clearTimeout(task.fallbackTimer);
    task.pollTimer = null;
    task.recomputeTimer = null;
    task.clockTimer = null;
    task.fallbackTimer = null;
    task.pollDueMs = 0;
    if (task.closeStream) {
      try {
        task.closeStream();
      } catch {
        // A stream that fails to close is already gone.
      }
      task.closeStream = null;
    }
    task.raw = undefined;
    task.hasRaw = false;
    task.hasData = false;
    task.staleData = false;
    task.standIn = null;
    task.fallback = null;
    task.inFlight = false;
    task.pathCount = null;
    task.lastTiles = null;
    task.fetchedView = undefined;
    // `hold` and `lastFetchMs` stay: switching a layer off and on must not
    // be a way to ask a provider sooner than it allows.
    if (!quiet) {
      this.host.onStopped(task.plugin);
      this.host.onState(task.plugin, null);
    }
  }

  private context(
    task: Task,
    signal: AbortSignal,
    seen: Seen,
    held: Hold | null = null,
    offline = false,
  ): SourceContext {
    const plugin = task.plugin;
    const host = this.host;
    const context: SourceContext = {
      fetch: createPolicyFetch({
        fetch: host.fetch,
        signal,
        timeoutMs: this.requestTimeoutMs,
        cache: host.cache,
        cacheTtlMs: plugin.cacheTtl ?? 0,
        now: WALL,
        // A provider that rations downloads may count a refused request
        // against the client, so each try is one request and no more.
        quickRetry: plugin.cacheTtl === undefined,
        // A fallback never asks the provider: the cache and the app's own files only.
        cacheOnly: held !== null || offline,
        offlineError: () =>
          offline
            ? new TypeError("A fallback does not ask the provider")
            : sourceError("blocked", held?.message ?? ""),
        assetBase: host.assetBase,
        onRetryAfter: (untilMs) => {
          task.retryAfterUntilMs = untilMs;
        },
        onStatus: (status) => {
          seen.status = status;
        },
        onStale: (status) => {
          seen.stale = true;
          seen.staleStatus = status;
        },
        onStored: (url) => {
          seen.stored.push(url);
        },
      }),
      now: () => host.now(),
      key: plugin.requiresKey !== undefined ? host.key(plugin.requiresKey) : undefined,
      signal,
      assetBase: host.assetBase,
    };
    // Only for sources that say they use it: one that reads the view without
    // being refetched for it would keep showing the place it started at.
    // Read on use, so a stream that stays open for hours sees where the camera is now.
    if (plugin.viewAware) {
      Object.defineProperty(context, "view", { enumerable: true, get: () => host.view() });
    }
    return context;
  }

  private async poll(task: Task): Promise<void> {
    const session = task.session;
    const plugin = task.plugin;
    if (session === null || task.inFlight || !plugin.fetch) return;
    task.pollDueMs = 0;
    const held = this.activeHold(task);
    if (held !== null && (plugin.cacheTtl === undefined || this.host.cache === null)) {
      // Nothing on disk to show in the meantime, unless the plugin has a fallback.
      this.waitOut(task, held);
      return;
    }
    if (plugin.fallback && !task.hasData && task.fallback === null && task.fallbackTimer === null) {
      // A rationed provider may take a while to send a big file: show what
      // there is meanwhile, rather than an empty layer.
      task.fallbackTimer = setTimeout(() => {
        task.fallbackTimer = null;
        if (task.session === session && task.inFlight && !task.hasData)
          void this.showFallback(task);
      }, this.fallbackAfterMs);
    }
    task.inFlight = true;
    if (held === null) task.lastFetchMs = WALL();
    if (plugin.viewAware) task.fetchedView = this.host.view();

    // One controller per try, so a hung request can be cut without ending the session.
    const attempt = new AbortController();
    const onSessionAbort = () => attempt.abort(session.signal.reason);
    session.signal.addEventListener("abort", onSessionAbort, { once: true });
    const timer = setTimeout(
      () => attempt.abort(new TimeoutError("Source timed out")),
      this.fetchTimeoutMs,
    );
    const seen: Seen = { status: 0, stale: false, staleStatus: 0, stored: [] };
    let failure: unknown = null;
    let raw: unknown;
    try {
      // Raced as well as aborted: a plugin that ignores its signal must not
      // be able to hold the schedule hostage.
      raw = await Promise.race([
        plugin.fetch(this.context(task, attempt.signal, seen, held)),
        new Promise<never>((_, reject) => {
          attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (error) {
      failure = error ?? new Error("Source failed");
    } finally {
      clearTimeout(timer);
      session.signal.removeEventListener("abort", onSessionAbort);
    }
    // Switched off (or off and on again) while we waited: this result is nobody's.
    if (task.session !== session) return;
    task.inFlight = false;
    if (task.fallbackTimer !== null) clearTimeout(task.fallbackTimer);
    task.fallbackTimer = null;

    if (failure !== null) {
      if (held !== null) this.waitOut(task, held);
      else this.failed(task, classify(failure, seen.status), seen);
      return;
    }

    task.raw = raw;
    task.hasRaw = true;
    task.standIn = null;
    let nextMs = plugin.refreshRate > 0 ? plugin.refreshRate * (0.95 + this.random() * 0.15) : 0;
    if (held !== null) {
      // Answered from the cache alone; the provider is not asked before the hold ends.
      task.staleData = seen.stale;
      nextMs = held.untilMs - WALL();
    } else if (seen.stale && isRefusal(seen.staleStatus)) {
      // Refused, with an old copy to show: the copy keeps the layer up, and
      // the provider is left alone exactly as if there had been none.
      task.staleData = true;
      const waitMs = Math.max(this.fullInterval(plugin), task.retryAfterUntilMs - WALL());
      this.setHold(task, `${plugin.name} refused the request (HTTP ${seen.staleStatus}).`, waitMs);
      nextMs = waitMs;
    } else {
      task.staleData = seen.stale;
      if (!seen.stale) this.clearHold(task);
    }
    if (!this.normalise(task, true)) {
      // The response was fine as HTTP and useless as data.
      this.retry(task, { code: "bad-data", status: seen.status, message: null }, seen);
      return;
    }
    task.failures = 0;
    if (nextMs > 0) this.schedulePoll(task, nextMs);
    this.scheduleRecompute(task);
  }

  /** Report a failed attempt and plan the next one. */
  private failed(task: Task, failure: Failure, seen: Seen): void {
    const hold = this.retry(task, failure, seen);
    this.report(task, () => this.failureState(task, failure, hold));
  }

  /**
   * Report a state that may mean an empty layer. When the plugin has a
   * fallback and nothing is shown yet, the fallback goes first, and the
   * state is reported only if the fallback cannot be shown.
   */
  private report(task: Task, state: () => FeedState): void {
    const session = task.session;
    const shown = this.showFallback(task);
    if (shown === null) {
      this.host.onState(task.plugin, state());
      return;
    }
    void shown.then((ok) => {
      if (!ok && task.session === session) this.host.onState(task.plugin, state());
    });
  }

  /**
   * Show the plugin's fallback, at most once per session, if nothing is
   * shown yet. Null when there is no fallback to try; otherwise resolves true
   * once it is on screen. A later successful `fetch` replaces it.
   */
  private showFallback(task: Task): Promise<boolean> | null {
    const plugin = task.plugin;
    const session = task.session;
    // Something is on screen (perhaps the fallback itself): the state can be reported as it is.
    if (session === null || !plugin.fallback || task.hasData) return null;
    if (task.fallback !== null) return task.fallback;
    const seen: Seen = { status: 0, stale: false, staleStatus: 0, stored: [] };
    const attempt = new AbortController();
    const onSessionAbort = () => attempt.abort(session.signal.reason);
    session.signal.addEventListener("abort", onSessionAbort, { once: true });
    const timer = setTimeout(
      () => attempt.abort(new TimeoutError("Fallback timed out")),
      this.fetchTimeoutMs,
    );
    const fallback = plugin.fallback.bind(plugin);
    task.fallback = (async () => {
      try {
        const result = await Promise.race([
          fallback(this.context(task, attempt.signal, seen, null, true)),
          new Promise<never>((_, reject) => {
            attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), {
              once: true,
            });
          }),
        ]);
        // Switched off meanwhile, or real data got here first.
        if (task.session !== session) return false;
        if (task.hasData) return true;
        task.raw = result.raw;
        task.hasRaw = true;
        task.standIn = sentence(
          result.message.trim() || `${layerSubject(plugin.layer, "may", "may")} be out of date.`,
        );
        if (!this.normalise(task, false)) {
          task.standIn = null;
          task.hasRaw = false;
          task.raw = undefined;
          return false;
        }
        this.scheduleRecompute(task);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        session.signal.removeEventListener("abort", onSessionAbort);
      }
    })();
    return task.fallback;
  }

  /**
   * Plan the next attempt after a failure. Returns the hold when the provider
   * is to be left alone for a while.
   */
  private retry(task: Task, failure: Failure, seen: Seen): Hold | null {
    const plugin = task.plugin;
    const rationed = plugin.cacheTtl !== undefined ? plugin.cacheTtl : 0;
    if (failure.code === "bad-data") {
      // Bytes that could not be read must not be served from the cache again.
      for (const url of seen.stored) void this.host.cache?.delete(url);
    }

    let holdMs = 0;
    let holdText: string | null = null;
    if (failure.code === "blocked") {
      holdMs = this.fullInterval(plugin);
      holdText = failure.message ?? `${plugin.name} refused the request.`;
    } else if (failure.code === "needs-key") {
      // Nothing changes until somebody adds the key; look again at the usual pace.
      holdMs = this.fullInterval(plugin);
    } else if (rationed > 0 && (failure.status >= 400 || failure.code === "bad-data")) {
      holdMs = rationed;
      holdText =
        failure.message ??
        (failure.code === "bad-data"
          ? `${plugin.name} sent data in a form we don't recognise.`
          : `${plugin.name} answered HTTP ${failure.status}.`);
    } else if (rationed > 0 && failure.code === "network" && this.host.online?.() !== false) {
      holdMs = Math.min(rationed, OPAQUE_HOLD_MS);
      holdText = `${plugin.name} could not be reached, or refused the request.`;
    }

    task.failures++;
    const backoff = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (task.failures - 1));
    const jittered = backoff * (0.8 + this.random() * 0.4);
    const retryAfter = task.retryAfterUntilMs - WALL();
    const delay = Math.max(holdMs > 0 ? 0 : jittered, retryAfter, holdMs);
    this.schedulePoll(task, delay);
    return holdText === null ? null : this.setHold(task, holdText, delay);
  }

  /** The longest a source normally goes between two requests. */
  private fullInterval(plugin: SourcePlugin): number {
    if (plugin.refreshRate > 0) return plugin.refreshRate;
    return plugin.cacheTtl !== undefined && plugin.cacheTtl > 0
      ? plugin.cacheTtl
      : this.backoffMaxMs;
  }

  private activeHold(task: Task): Hold | null {
    if (task.hold !== null && task.hold.untilMs <= WALL()) task.hold = null;
    return task.hold;
  }

  private setHold(task: Task, message: string, waitMs: number): Hold {
    const hold: Hold = { untilMs: WALL() + waitMs, message };
    task.hold = hold;
    task.holdStored = true;
    void writeHold(this.host.cache, task.plugin.id, hold, WALL());
    return hold;
  }

  private clearHold(task: Task): void {
    task.hold = null;
    if (!task.holdStored) return;
    task.holdStored = false;
    void writeHold(this.host.cache, task.plugin.id, null, WALL());
  }

  /** A hold is running and there is nothing cached to show: say so and wait. */
  private waitOut(task: Task, hold: Hold): void {
    this.schedulePoll(task, Math.max(0, hold.untilMs - WALL()));
    this.report(task, () =>
      task.standIn !== null
        ? this.state(task, "degraded", task.standIn)
        : this.state(task, task.hasData ? "degraded" : "offline", holdMessage(hold)),
    );
  }

  private schedulePoll(task: Task, delayMs: number): void {
    task.pollDueMs = WALL() + delayMs;
    if (this.visible) this.armPoll(task, delayMs);
  }

  private armPoll(task: Task, delayMs: number): void {
    if (task.pollTimer !== null) clearTimeout(task.pollTimer);
    task.pollTimer = setTimeout(() => {
      task.pollTimer = null;
      if (task.plugin.stream) this.openStream(task);
      else void this.poll(task);
    }, delayMs);
  }

  private scheduleRecompute(task: Task): void {
    const rate = task.plugin.recomputeRate;
    if (rate === undefined || rate <= 0 || task.recomputeTimer !== null) return;
    // When scrubbing the clock stands still, so recomputing would repeat itself.
    if (!this.visible || !this.host.isLive()) return;
    task.recomputeTimer = setTimeout(() => {
      task.recomputeTimer = null;
      this.recompute(task);
    }, rate);
  }

  private recompute(task: Task): void {
    if (task.session === null || !task.hasRaw || task.plugin.recomputeRate === undefined) return;
    if (task.recomputeTimer !== null) clearTimeout(task.recomputeTimer);
    task.recomputeTimer = null;
    this.normalise(task, false);
    this.scheduleRecompute(task);
  }

  /** Re-normalise for a new clock moment, bounded so a dragged scrubber stays cheap. */
  private clockNormalise(task: Task): void {
    if (task.clockTimer !== null || !this.visible) return;
    const wait = Math.max(0, task.lastNormaliseMs + CLOCK_NORMALISE_MS - WALL());
    task.clockTimer = setTimeout(() => {
      task.clockTimer = null;
      if (task.session !== null && task.hasRaw) this.normalise(task, false);
    }, wait);
  }

  /**
   * Normalise the held raw data and route the output. `fresh` is true when
   * the raw data has just arrived. False when it could not be read.
   */
  private normalise(task: Task, fresh: boolean): boolean {
    const plugin = task.plugin;
    const host = this.host;
    task.lastNormaliseMs = WALL();
    try {
      const output = plugin.normalise(task.raw, { now: () => host.now() });
      if (fresh) task.updatedMs = WALL();
      switch (output.type) {
        case "entities":
          host.onEntities(plugin, output.update);
          // A replayed moment's events are old news, not ticker lines.
          if (output.events && output.events.length > 0 && host.isLive())
            host.onEvents(output.events);
          break;
        case "paths":
          task.pathCount = output.paths.count;
          host.onPaths(plugin, output.paths);
          break;
        case "tiles": {
          // The credit must be on the map whenever the overlay is.
          const overlay: TileOverlay = output.overlay.attribution
            ? output.overlay
            : { ...output.overlay, attribution: plugin.attribution };
          const serialised = JSON.stringify(overlay);
          // The renderer rebuilds its tiles for a new overlay; spare it an identical one.
          if (serialised !== task.lastTiles) {
            task.lastTiles = serialised;
            host.onTiles(plugin, overlay);
          }
          break;
        }
      }
    } catch (error) {
      const said = sourceFailure(error)?.message;
      this.host.onState(
        plugin,
        this.state(
          task,
          task.hasData ? "degraded" : "error",
          said ??
            `${layerSubject(plugin.layer, "couldn't", "couldn't")} be read. ${plugin.name} sent data in a form we don't recognise.`,
        ),
      );
      return false;
    }
    task.hasData = true;
    if (task.standIn !== null) host.onState(plugin, this.state(task, "degraded", task.standIn));
    else if (!task.staleData) host.onState(plugin, this.state(task, "live"));
    else {
      const hold = this.activeHold(task);
      host.onState(
        plugin,
        this.state(task, "degraded", hold ? holdMessage(hold) : this.lateMessage(plugin)),
      );
    }
    return true;
  }

  private state(task: Task, status: FeedState["status"], message?: string): FeedState {
    const state: FeedState = { status };
    if (message !== undefined) state.message = message;
    if (task.updatedMs > 0) state.updatedMs = task.updatedMs;
    if (task.pathCount !== null) state.count = task.pathCount;
    return state;
  }

  private lateMessage(plugin: SourcePlugin): string {
    return `${layerSubject(plugin.layer, "may", "may")} be out of date. ${plugin.name} isn't responding, so we'll keep trying.`;
  }

  /** The layer state for a failed attempt. `hold` is set when the next try is a long way off. */
  private failureState(task: Task, failure: Failure, hold: Hold | null): FeedState {
    const plugin = task.plugin;
    const { code, status } = failure;
    if (code === "needs-key") {
      return this.state(
        task,
        "needs-key",
        failure.message ??
          `${layerSubject(plugin.layer, "need", "needs")} a key from ${plugin.name}.`,
      );
    }
    // What is shown came from the fallback, whose message says how old it is.
    if (task.standIn !== null) return this.state(task, "degraded", task.standIn);
    if (hold !== null) {
      const without = code === "bad-data" ? "error" : "offline";
      return this.state(task, task.hasData ? "degraded" : without, holdMessage(hold));
    }
    if (task.hasData) {
      return this.state(
        task,
        "degraded",
        code === "bad-data" && failure.message !== null
          ? failure.message
          : this.lateMessage(plugin),
      );
    }
    const refused = status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (code === "bad-data") {
      return this.state(
        task,
        "error",
        failure.message ??
          `${layerSubject(plugin.layer, "couldn't", "couldn't")} be read. ${plugin.name} sent data in a form we don't recognise.`,
      );
    }
    if (code === "http" && failure.message !== null) {
      // The plugin said what happened; a refusal will not mend itself, anything else may.
      return refused
        ? this.state(task, "error", sentence(failure.message))
        : this.state(task, "offline", `${sentence(failure.message)} We'll keep trying.`);
    }
    if (refused) {
      const hint = status === 401 || status === 403 ? " Check the API key." : "";
      return this.state(
        task,
        "error",
        `${layerSubject(plugin.layer, "couldn't", "couldn't")} be loaded. ${plugin.name} refused the request.${hint}`,
      );
    }
    if (
      code === "network" ||
      code === "http" ||
      status >= 500 ||
      status === 408 ||
      status === 429
    ) {
      return this.state(
        task,
        "offline",
        `${layerSubject(plugin.layer, "are", "is")} offline. ${plugin.name} isn't reachable, so we'll keep trying.`,
      );
    }
    return this.state(
      task,
      "error",
      `${layerSubject(plugin.layer, "couldn't", "couldn't")} be loaded. ${plugin.name} sent data in a form we don't recognise.`,
    );
  }

  private openStream(task: Task): void {
    const session = task.session;
    const plugin = task.plugin;
    if (session === null || !plugin.stream || this.disposed) return;
    task.pollDueMs = 0;
    const seen: Seen = { status: 0, stale: false, staleStatus: 0, stored: [] };
    let closed = false;
    // Assigned after the call, but a plugin may report an error synchronously.
    let close: (() => void) | null = null;
    close = plugin.stream(
      this.context(task, session.signal, seen),
      (raw) => {
        if (closed || task.session !== session) return;
        task.raw = raw;
        task.hasRaw = true;
        if (this.normalise(task, true)) task.failures = 0;
      },
      (error) => {
        if (closed || task.session !== session) return;
        closed = true;
        try {
          close?.();
        } catch {
          // Already broken.
        }
        task.closeStream = null;
        this.failed(task, classify(error, seen.status), seen);
      },
    );
    if (closed) {
      // It failed before returning its closer: close what it opened.
      try {
        close();
      } catch {
        // Already broken.
      }
      return;
    }
    task.closeStream = () => {
      closed = true;
      close?.();
    };
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** HTTP statuses that mean "you, specifically, should stop asking". */
function isRefusal(status: number): boolean {
  return status === 403 || status === 429;
}

const SOURCE_ERROR_CODES: readonly string[] = ["needs-key", "blocked", "http", "bad-data"];

/**
 * A plugin's `SourceError`, read by shape rather than by class: the plugins
 * live in another package, and an error may have crossed a realm on its way.
 */
function sourceFailure(error: unknown): Failure | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { name?: unknown; code?: unknown; message?: unknown; status?: unknown };
  if (e.name !== "SourceError" || typeof e.code !== "string") return null;
  if (!SOURCE_ERROR_CODES.includes(e.code)) return null;
  return {
    code: e.code as SourceErrorCode,
    status: typeof e.status === "number" ? e.status : 0,
    message: typeof e.message === "string" && e.message.trim() !== "" ? e.message.trim() : null,
  };
}

/** An error of the shape plugins throw, for failures the runner raises on their behalf. */
function sourceError(code: SourceErrorCode, message: string): Error {
  return Object.assign(new Error(message), { name: "SourceError", code });
}

function classify(error: unknown, status: number): Failure {
  const typed = sourceFailure(error);
  if (typed !== null) return typed.status === 0 ? { ...typed, status } : typed;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { code: "refused", status, message: null };
  }
  const silent =
    status === 0 && (error instanceof TypeError || error instanceof TimeoutError || isAbort(error));
  if (silent) return { code: "network", status, message: null };
  return { code: "unknown", status, message: null };
}

/** `text` ending as a sentence should. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** What a hold reads as: what happened, and roughly when the next try is. */
function holdMessage(hold: Hold): string {
  const minutes = Math.round((hold.untilMs - WALL()) / 60_000);
  const when =
    minutes <= 1
      ? "in a minute"
      : minutes < 90
        ? `in about ${minutes} minutes`
        : `in about ${Math.round(minutes / 60)} hours`;
  return `${sentence(hold.message || "The provider asked us to wait")} We'll try again ${when}.`;
}

/** True when `to` shows somewhere meaningfully different from `from`. */
function viewMoved(from: SourceContext["view"], to: NonNullable<SourceContext["view"]>): boolean {
  if (from === undefined) return true;
  if (Math.abs(to.zoom - from.zoom) >= 1) return true;
  const [west, south, east, north] = from.bounds;
  // West greater than east means the view straddles the antimeridian.
  const lonSpan = west <= east ? east - west : east - west + 360;
  let dLon = Math.abs(to.lon - from.lon);
  if (dLon > 180) dLon = 360 - dLon;
  return (
    dLon > lonSpan * VIEW_MOVE_FRACTION ||
    Math.abs(to.lat - from.lat) > (north - south) * VIEW_MOVE_FRACTION
  );
}
