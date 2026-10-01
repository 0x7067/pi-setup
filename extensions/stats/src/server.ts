import { timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dashboardHtml } from "./dashboard.ts";
import { collectStats, type PiStats } from "./stats.ts";

const CACHE_MS = 5_000;

function equalSecret(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function respond(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "content-type": `${type}; charset=utf-8`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

export class StatsServer {
  readonly #token: string;
  readonly #sessionDir: string;
  readonly #requestedPort: number;
  #server?: ReturnType<typeof createServer>;
  #port = 0;
  #cached?: { at: number; value: PiStats };

  constructor(token: string, sessionDir: string, port: number) {
    this.#token = token;
    this.#sessionDir = sessionDir;
    this.#requestedPort = port;
  }

  get port() {
    return this.#port;
  }

  get url() {
    return `http://127.0.0.1:${this.#port}/?token=${encodeURIComponent(this.#token)}`;
  }

  async start() {
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.#handle(request.url ?? "/", response);
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
    try {
      await listen(this.#requestedPort);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error;
      }
      await listen(0);
    }
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  async close() {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async stats() {
    if (this.#cached && Date.now() - this.#cached.at < CACHE_MS)
      return this.#cached.value;
    const value = await collectStats(this.#sessionDir);
    this.#cached = { at: Date.now(), value };
    return value;
  }

  async #handle(rawUrl: string, response: ServerResponse) {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.pathname === "/health") {
      respond(
        response,
        200,
        "application/json",
        JSON.stringify({ name: "pi-stats", version: 1 }),
      );
      return;
    }
    if (!equalSecret(url.searchParams.get("token") ?? "", this.#token)) {
      respond(
        response,
        401,
        "application/json",
        JSON.stringify({ error: "Unauthorized" }),
      );
      return;
    }
    if (url.pathname === "/") {
      respond(response, 200, "text/html", dashboardHtml());
      return;
    }
    if (url.pathname === "/api/stats") {
      try {
        respond(
          response,
          200,
          "application/json",
          JSON.stringify(await this.stats()),
        );
      } catch (error) {
        respond(
          response,
          500,
          "application/json",
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }
    respond(
      response,
      404,
      "application/json",
      JSON.stringify({ error: "Not found" }),
    );
  }
}
