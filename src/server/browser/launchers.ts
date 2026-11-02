/**
 * Where a conversation's browser runs (`host.browserLauncher`): an extension can start a conversation's Chromium
 * somewhere else, such as in that session's VM over SSH, through a command that carries the DevTools pipe on its
 * standard input and output. A conversation with no launcher uses the browser on this machine.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import { BrowserError, type Launcher } from "./cdp.ts";

/** What a provider gives for a conversation whose browser runs elsewhere. */
export interface BrowserLauncher {
    /** A program and its first arguments, such as `["ssh", "-o", "BatchMode=yes", "vm", "--"]`. */
    readonly command: readonly string[];
    /** The browser to run there. Default: `chromium`. */
    readonly executable?: string;
    /** Its profile folder there. Default: `/tmp/pi-pocket-browser-<conversation>`. */
    readonly profile?: string;
    /** Extra Chromium flags there, such as `--no-sandbox`. */
    readonly args?: readonly string[];
}

export type BrowserLauncherProvider = (
    conversationId: ConversationId,
) => BrowserLauncher | undefined | Promise<BrowserLauncher | undefined>;

export const launcherLimits = {
    /** How long a provider may take: it may start a VM. Tests shorten it. */
    providerMs: 60_000,
    /** Words in `command` and in `args`, each. */
    words: 64,
    /** Characters in one word. */
    wordChars: 4096,
};

function words(value: unknown, what: string, min: number): string[] {
    if (!Array.isArray(value) || value.length < min || value.length > launcherLimits.words) {
        throw new BrowserError(
            `host.browserLauncher: ${what} must be a list of ${min} to ${launcherLimits.words} words`,
        );
    }

    return value.map((word) => {
        if (
            typeof word !== "string" ||
            word === "" ||
            word.length > launcherLimits.wordChars ||
            word.includes("\0")
        ) {
            throw new BrowserError(`host.browserLauncher: ${what} has a word that is not text`);
        }

        return word;
    });
}

function word(value: unknown, what: string, fallback: string): string {
    if (value === undefined) {
        return fallback;
    }

    return words([value], what, 1)[0]!;
}

/** A provider's answer, checked and with its defaults. */
export function launcherFrom(given: unknown, conversationId: number): Launcher {
    if (typeof given !== "object" || given === null || Array.isArray(given)) {
        throw new BrowserError(
            "host.browserLauncher: a provider gave something that is not a launcher",
        );
    }

    const spec = given as Record<string, unknown>;

    return Object.freeze({
        command: Object.freeze(words(spec.command, "command", 1)),
        executable: word(spec.executable, "executable", "chromium"),
        profile: word(spec.profile, "profile", `/tmp/pi-pocket-browser-${conversationId}`),
        args: Object.freeze(spec.args === undefined ? [] : words(spec.args, "args", 0)),
    });
}

/**
 * The provider of launchers: one at a time, the last one registered. A conversation it gives nothing for uses the
 * browser on this machine. One that fails, or gives something wrong, opens no browser at all: falling back to this
 * machine would take the page out of the place the extension meant it to be.
 */
export class BrowserLaunchers {
    #provider: BrowserLauncherProvider | undefined;
    readonly #log: (line: string) => void;

    constructor(log: (line: string) => void = () => {}) {
        this.#log = log;
    }

    get any(): boolean {
        return this.#provider !== undefined;
    }

    /** Use `provider` until the returned function is called, in place of the one before it. */
    add(provider: BrowserLauncherProvider): () => void {
        if (typeof provider !== "function") {
            throw new Error("host.browserLauncher: give it a function");
        }

        if (this.#provider !== undefined && this.#provider !== provider) {
            this.#log("host.browserLauncher: a new provider replaced the one before it");
        }

        this.#provider = provider;

        return () => {
            if (this.#provider === provider) {
                this.#provider = undefined;
            }
        };
    }

    /** How to start a conversation's browser, or undefined to use the one on this machine. */
    async for(conversationId: number): Promise<Launcher | undefined> {
        const provider = this.#provider;

        if (provider === undefined) {
            return undefined;
        }

        let timer: NodeJS.Timeout | undefined;
        let given: unknown;

        try {
            given = await Promise.race([
                Promise.resolve().then(() => provider(conversationId as unknown as ConversationId)),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new BrowserError(
                                    `The browser's launcher took more than ${launcherLimits.providerMs} ms.`,
                                ),
                            ),
                        launcherLimits.providerMs,
                    );
                }),
            ]);
        } catch (error) {
            if (error instanceof BrowserError) {
                throw error;
            }

            throw new BrowserError(
                `The browser's launcher failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            clearTimeout(timer);
        }

        return given === undefined || given === null
            ? undefined
            : launcherFrom(given, conversationId);
    }
}
