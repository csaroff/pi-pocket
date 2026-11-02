/** The DevTools protocol over a pipe, and the Chromium process at the other end of it. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

export class BrowserError extends Error {}

/** A DevTools protocol message: untyped JSON, read field by field where it arrives. */
export type Json = any;
type EventListener = (method: string, params: Json) => void;

/** Messages are JSON, each ended by a NUL byte: Chromium reads from fd 3 and writes to fd 4. */
export class Connection {
    readonly #out: Writable;
    #parts: string[] = [];
    #next = 0;
    readonly #pending = new Map<
        number,
        { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    readonly #sessions = new Map<string, EventListener>();
    #closed: string | undefined;
    /** Methods this connection refuses, with why: a browser that runs elsewhere cannot take this machine's files. */
    refused: ReadonlyMap<string, string> | undefined;
    /** Events without a session: the browser's own, such as targets appearing. */
    onEvent: EventListener | undefined;
    onClose: (() => void) | undefined;

    constructor(out: Writable, input: Readable) {
        this.#out = out;
        input.setEncoding("utf8");
        input.on("data", (chunk: string) => this.#receive(chunk));
        input.on("close", () => this.close("The browser closed."));
        input.on("error", () => this.close("The browser closed."));
        out.on("error", () => this.close("The browser closed."));
    }

    get closed(): boolean {
        return this.#closed !== undefined;
    }

    #receive(chunk: string): void {
        let start = 0;
        let end = chunk.indexOf("\0");

        while (end !== -1) {
            this.#parts.push(chunk.slice(start, end));
            const text = this.#parts.join("");

            this.#parts = [];
            this.#dispatch(text);
            start = end + 1;
            end = chunk.indexOf("\0", start);
        }

        if (start < chunk.length) {
            this.#parts.push(chunk.slice(start));
        }
    }

    #dispatch(text: string): void {
        let message: Json;

        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        if (typeof message.id === "number") {
            const pending = this.#pending.get(message.id);

            if (pending === undefined) {
                return;
            }

            this.#pending.delete(message.id);
            clearTimeout(pending.timer);

            if (message.error !== undefined) {
                pending.reject(new BrowserError(String(message.error.message ?? message.error)));
            } else {
                pending.resolve(message.result ?? {});
            }

            return;
        }

        if (typeof message.method !== "string") {
            return;
        }

        try {
            if (typeof message.sessionId === "string") {
                this.#sessions.get(message.sessionId)?.(message.method, message.params ?? {});
            } else {
                this.onEvent?.(message.method, message.params ?? {});
            }
        } catch {
            // A listener's mistake must not stop the connection.
        }
    }

    send(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string,
        timeoutMs = 30_000,
    ): Promise<Json> {
        if (this.#closed !== undefined) {
            return Promise.reject(new BrowserError(this.#closed));
        }

        const refusal = this.refused?.get(method);

        if (refusal !== undefined) {
            return Promise.reject(new BrowserError(refusal));
        }

        const id = ++this.#next;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new BrowserError(`The browser did not answer ${method} in time.`));
            }, timeoutMs);

            timer.unref();
            this.#pending.set(id, { resolve, reject, timer });
            this.#out.write(
                `${JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId })}\0`,
            );
        });
    }

    listen(sessionId: string, listener: EventListener): void {
        this.#sessions.set(sessionId, listener);
    }

    unlisten(sessionId: string): void {
        this.#sessions.delete(sessionId);
    }

    close(reason: string): void {
        if (this.#closed !== undefined) {
            return;
        }

        this.#closed = reason;

        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new BrowserError(reason));
        }

        this.#pending.clear();
        this.#sessions.clear();
        this.onClose?.();
    }
}

const LAUNCH_ARGS = [
    "--headless=new",
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    // Pages keep running while nobody watches: Pi tests them in the background.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio",
    "--password-store=basic",
    "--use-mock-keychain",
    "--force-color-profile=srgb",
];

/**
 * How to start Chromium somewhere else, such as in a VM over SSH. `command` is a program and its first arguments (`ssh
 * … --`, `sh -c`): it gets the Chromium command line as one more argument, a shell command that reads the protocol from
 * its standard input and writes it to its standard output.
 */
export interface Launcher {
    readonly command: readonly string[];
    /** The browser to run there. */
    readonly executable: string;
    /** Its profile folder there. */
    readonly profile: string;
    /** Extra flags there, such as `--no-sandbox`. This machine's own flags do not go there. */
    readonly args?: readonly string[];
}

/** One word for a POSIX shell: quoted, so nothing in it expands. */
export function shellQuote(word: string): string {
    return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell command that runs Chromium with the pipe on standard input and output: Chromium reads fd 3 and writes fd 4,
 * so fd 3 is the input, fd 4 the output, and Chromium's own output goes nowhere. `exec` keeps one process, so it stops
 * with what started it.
 */
export function launchLine(executable: string, profile: string, extra: readonly string[]): string {
    const words = [
        executable,
        ...LAUNCH_ARGS,
        `--user-data-dir=${profile}`,
        ...extra,
        "about:blank",
    ];

    return `exec ${words.map(shellQuote).join(" ")} 3<&0 4>&1 1>/dev/null`;
}

/** One Chromium process. It exits on its own when the pipe closes, so a crashed server leaves none behind. */
export class Chromium {
    readonly connection: Connection;
    readonly #child: ChildProcess;
    readonly exited: Promise<void>;
    userAgent = "";

    private constructor(child: ChildProcess, connection: Connection) {
        this.#child = child;
        this.connection = connection;
        this.exited = new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                done();
            } else {
                child.once("exit", () => done());
            }
        });
    }

    /**
     * Start Chromium here, or with `launcher` somewhere else: then the protocol goes over the launcher's standard input
     * and output, and `executable`, `profile`, and `extra` are ignored for the launcher's own.
     */
    static async launch(
        executable: string,
        profile: string,
        extra: readonly string[],
        launcher?: Launcher,
    ): Promise<Chromium> {
        let child: ChildProcess;

        if (launcher === undefined) {
            mkdirSync(profile, { recursive: true, mode: 0o700 });
            child = spawn(
                executable,
                [...LAUNCH_ARGS, `--user-data-dir=${profile}`, ...extra, "about:blank"],
                {
                    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
                },
            );
        } else {
            const [program, ...first] = launcher.command;

            if (program === undefined) {
                throw new BrowserError("The browser's launcher has no command.");
            }

            executable = program;
            child = spawn(
                program,
                [...first, launchLine(launcher.executable, launcher.profile, launcher.args ?? [])],
                { stdio: ["pipe", "pipe", "pipe"] },
            );
        }

        let stderr = "";

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-4000);
        });
        const failed = new Promise<never>((_, reject) => {
            // Every error: one after the start (a failed kill) would otherwise be unhandled and stop the server.
            child.on("error", (error) =>
                reject(new BrowserError(`Could not start ${executable}: ${error.message}`)),
            );
            child.once("exit", (code, signal) => {
                const why = stderr.trim().split("\n").slice(-6).join("\n");

                reject(
                    new BrowserError(
                        `The browser exited as it started (${signal ?? `code ${code}`}).${why === "" ? "" : `\n${why}`}`,
                    ),
                );
            });
        });

        failed.catch(() => {});

        // Chromium's own pipe, or the launcher's standard input and output.
        const out = launcher === undefined ? child.stdio[3] : child.stdin;
        const input = launcher === undefined ? child.stdio[4] : child.stdout;

        if (out == null || input == null) {
            child.kill("SIGKILL");

            throw new BrowserError(`Could not start ${executable}.`);
        }

        const connection = new Connection(out as Writable, input as Readable);
        const chromium = new Chromium(child, connection);

        child.once("exit", () => connection.close("The browser stopped."));

        try {
            const version = await Promise.race([
                connection.send("Browser.getVersion", {}, undefined, 20_000),
                failed,
            ]);

            chromium.userAgent = String(version.userAgent ?? "").replace(
                "HeadlessChrome/",
                "Chrome/",
            );
            await connection.send("Target.setDiscoverTargets", { discover: true });
        } catch (error) {
            // The pipe can close just before the exit comes: the exit's words (and its error output) say why.
            const closed = connection.closed;

            chromium.kill();

            if (closed) {
                const exit = await Promise.race([
                    failed.then(
                        () => undefined,
                        (reason: unknown) => reason,
                    ),
                    new Promise<undefined>((done) => {
                        const timer = setTimeout(() => done(undefined), 1000);

                        timer.unref();
                    }),
                ]);

                if (exit instanceof Error) {
                    throw exit;
                }
            }

            throw error;
        }

        return chromium;
    }

    kill(): void {
        this.connection.close("The browser stopped.");

        if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
            return;
        }

        this.#child.kill("SIGTERM");
        const force = setTimeout(() => this.#child.kill("SIGKILL"), 3000);

        force.unref();
        this.#child.once("exit", () => clearTimeout(force));
    }
}
