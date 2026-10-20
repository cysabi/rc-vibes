// Following one of arclamp's event streams (Server-Sent Events: the scene's,
// its health's, a shader's logs): each event as it comes, for as long as
// vibes runs. A stream that ends or fails is opened again, after a wait that
// grows while it keeps failing, and picks up just after the last event heard
// (Last-Event-ID): arclamp carries on from there if it still has it, or starts
// again from what it watches as it is now.
//
// A stream can go quiet without ever ending (a dropped connection whose close
// is lost on the way, as the light stream's can be: stream.ts), so arclamp
// pings an idle one every 15 s; after `silentMs` of nothing at all, it's
// dropped and opened again.

const TIMING = { silentMs: 45_000, firstRetryMs: 500, maxRetryMs: 10_000 };

export type EventTiming = typeof TIMING;

export interface EventHandlers {
  /** One event: its name (`message` if it has none), its data, and its id, if it has one. */
  event(name: string, data: string, id: string | null): void;
  /** Connected (again). */
  open?(): void;
  /** Couldn't connect, or the connection ended: arclamp's status (401, 503, …), or 0 if it wasn't reached. */
  failed?(status: number, message: string): void;
}

export interface Following {
  stop(): void;
}

export function followEvents(url: string, key: string, on: EventHandlers, timing: Partial<EventTiming> = {}): Following {
  const { silentMs, firstRetryMs, maxRetryMs } = { ...TIMING, ...timing };
  let stopped = false;
  let lastId: string | null = null;
  let retryMs = firstRetryMs;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function connect() {
    const abort = (controller = new AbortController());
    let heard = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - heard > silentMs) abort.abort(new Error(`silent for ${silentMs} ms`));
    }, Math.min(silentMs, 5000));
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream", ...(lastId !== null ? { "Last-Event-ID": lastId } : {}) },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        on.failed?.(res.status, `arclamp returned ${res.status}`);
      } else {
        retryMs = firstRetryMs;
        on.open?.();
        await read(res.body, () => (heard = Date.now()));
        if (!stopped) on.failed?.(0, "the stream ended");
      }
    } catch (err) {
      if (!stopped) on.failed?.(0, (err as Error).message);
    } finally {
      clearInterval(watch);
    }
    if (stopped) return;
    timer = setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, maxRetryMs);
  }

  /** Reads events off the stream until it ends, as the SSE spec has them. */
  async function read(body: ReadableStream<Uint8Array>, heard: () => void) {
    const decoder = new TextDecoder();
    let buffer = "";
    let name = "";
    let data: string[] = [];
    let id: string | null = null;
    const line = (text: string) => {
      if (text === "") {
        // The end of an event: dispatched if it has data.
        if (id !== null) lastId = id;
        if (data.length > 0) on.event(name || "message", data.join("\n"), id);
        name = "";
        data = [];
        id = null;
        return;
      }
      if (text.startsWith(":")) return;
      const colon = text.indexOf(":");
      const field = colon < 0 ? text : text.slice(0, colon);
      let value = colon < 0 ? "" : text.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
      else if (field === "id" && !value.includes("\0")) id = value;
    };
    for await (const chunk of body) {
      heard();
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.search(/\r\n|\r|\n/)) >= 0) {
        // A \r last may be half of a \r\n split across chunks: wait for the next.
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
        line(text);
      }
    }
  }

  void connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
