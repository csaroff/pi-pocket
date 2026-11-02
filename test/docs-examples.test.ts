// The documentation's example extensions work as drop-ins.
import {
    cleanUp,
    lastText,
    loadTools,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { findBrowser } from "../src/server/browser/discovery.ts";

const DOCS = fileURLToPath(new URL("../docs/", import.meta.url));
const EXAMPLES = join(DOCS, "examples");

/** The system prompt of the newest request, and its sections by name. */
let prompt = "";
let sections: Record<string, string> = {};

const route: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);

    // The system prompt reaches the model as system messages, each with the sections that changed since the last.
    sections = Object.assign(
        {},
        ...(context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    prompt = Object.values(sections).join("\n");
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("what time")) {
        return call("clock", { zone: "UTC" });
    }

    if (text.includes("force push")) {
        return call("bash", { command: "git push --force origin main" });
    }

    if (text.includes("count the words")) {
        return call("my_word_count", { text: "one two  three" });
    }

    if (text.includes("read the local page")) {
        return call("read_page", { url: "http://localhost:9999/admin" });
    }

    if (text.includes("open the far page")) {
        return call("browser", { action: "navigate", url: "data:text/html,<title>Far</title>" });
    }

    if (text.includes("plain push")) {
        return call("bash", { command: "echo git push origin main" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    // The examples, copied in as the owner would: into the data folder's extensions/, before the server starts.
    const data = join(root, "docs-data");
    const dropIns = join(data, "extensions");

    mkdirSync(dropIns, { recursive: true });

    // The modules, and the browser module beside one of them.
    for (const file of readdirSync(EXAMPLES).filter((each) => /\.(ts|js)$/.test(each))) {
        copyFileSync(join(EXAMPLES, file), join(dropIns, file));
    }

    app = await openApp(scriptedModel(route), data);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** What Pi's last answer in a session says. */
const answer = async (id: Parameters<typeof say>[1]) => (await modelTexts(app, id)).at(-1) ?? "";

test("the example extensions load as drop-ins, off until the owner turns them on, and work", async () => {
    const listed = (await app.extensions(owner(app))).modules.filter(
        (module) => module.source === "drop-in",
    );

    assert.deepEqual(
        listed.map((module) => [module.file, module.enabled]),
        [
            ["browser-over-ssh.ts", false],
            ["clock.ts", false],
            ["my-words.ts", false],
            ["no-force-push.ts", false],
            ["read-page.ts", false],
            ["server-status.ts", false],
        ],
    );

    for (const file of [
        "browser-over-ssh.ts",
        "clock.ts",
        "my-words.ts",
        "no-force-push.ts",
        "read-page.ts",
        "server-status.ts",
    ]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    const id = await newSession(app);

    await say(app, id, "what time is it in UTC?");
    assert.match(await answer(id), /tool said: .*\d{4}.*\(UTC\)/);
    assert.match(prompt, /Do not force-push with git/);

    // The tutorial's module (docs/extensions/first-extension.md).
    await say(app, id, "count the words");
    assert.match(await answer(id), /tool said: 3 words/);

    await say(app, id, "force push it");
    assert.match(await answer(id), /Force-pushing is turned off here/);

    // host.fetchPublic refuses a name that resolves to this machine, before it connects.
    await say(app, id, "read the local page");
    assert.match(await answer(id), /tool said: The page could not be read: .*not a public address/);

    await say(app, id, "now a plain push");
    assert.match(await answer(id), /tool said: git push origin main/);

    // Server status adds to the app, not to Pi: a route, and a browser module for the owner's tabs.
    const status = app.webs.match("server-status", "GET", ["status"], owner(app));

    assert.ok(status !== undefined && "route" in status, "its route is there");
    const reading = (await status.route.handle({} as never)) as { cpus: number; load: number[] };

    assert.ok(reading.cpus > 0 && reading.load.length === 3);
    const client = app.webs.clients(owner(app)).find((each) => each.module === "server-status");

    assert.ok(client !== undefined, "its browser module is there");
});

test(
    "Browser over SSH runs a session's browser through ssh, and keeps it here without a machine",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async () => {
        // A fake `ssh` on the PATH: it runs the command here, as ssh runs it on the other machine.
        const bin = mkdtempSync(join(root, "bin-"));
        const calls = join(bin, "calls");

        writeFileSync(
            join(bin, "ssh"),
            `#!/bin/sh\necho "$@" >> "${calls}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec sh -c "$*"\n`,
        );
        chmodSync(join(bin, "ssh"), 0o755);
        const saved = { ...process.env };

        process.env.PATH = `${bin}:${process.env.PATH}`;
        process.env.POCKET_BROWSER_SSH_CHROMIUM = findBrowser()!;
        process.env.POCKET_BROWSER_SSH_ARGS = process.env.PI_POCKET_BROWSER_ARGS ?? "";

        try {
            await app.setExtensionEnabled(owner(app), "browser-over-ssh.ts", true);
            const here = await newSession(app);

            // No machine named: the browser here.
            assert.equal(await app.browsers.elsewhere(Number(here)), false);
            process.env.POCKET_BROWSER_SSH = "me@box";
            const id = await newSession(app);

            assert.equal(await app.browsers.elsewhere(Number(id)), true);
            await loadTools(app, id, "browser");
            await say(app, id, "open the far page");
            assert.match(await answer(id), /tool said: Opened data:text\/html/);
            assert.match(readFileSync(calls, "utf8"), /^-o BatchMode=yes -T me@box -- exec /);
            await app.browsers.close(Number(id));
        } finally {
            process.env = saved;
        }
    },
);
