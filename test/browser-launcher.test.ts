// A session's browser elsewhere (`host.browserLauncher`, `browser/launchers.ts`): Chromium started through a launcher's
// command, with the DevTools pipe on that command's standard input and output, as over SSH into a VM. The fake launchers
// here run a local Chromium through `sh -c` with the same pipe trick, so no VM is needed.
import {
    type App,
    cleanUp,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, mock, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { BrowserError, Connection, launchLine, shellQuote } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { BrowserLaunchers, launcherFrom, launcherLimits } from "../src/server/browser/launchers.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** This machine's flags (`--no-sandbox` in a container): a launcher gives its own. */
const flags = process.env.PI_POCKET_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? [];

let site: Server;
let base = "";

before(async () => {
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
            request.url === "/two"
                ? "<title>Two</title><h1>Second</h1>"
                : `<title>Far away</title><h1>Hello from elsewhere</h1><input type="file" id="pick">`,
        );
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

/** Whether a process runs. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

/**
 * A launcher that runs Chromium here through `sh -c`, as `ssh … --` runs it there, and writes its process id to `pids`
 * first (`exec` keeps the id: it is Chromium's).
 */
function fakeLauncher(pids: string, profile: string) {
    return {
        command: ["sh", "-c", 'echo $$ >> "$0"; eval "$1"', pids],
        executable: chromium!,
        profile,
        args: flags,
    };
}

const pidsIn = (file: string): number[] => {
    try {
        return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number);
    } catch {
        return [];
    }
};

test("the launch line quotes every word and carries the pipe on standard input and output", () => {
    assert.equal(shellQuote("--headless=new"), "--headless=new");
    assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
    assert.equal(shellQuote("$(rm -rf /)"), `'$(rm -rf /)'`);
    const line = launchLine("/opt/my chromium", "/tmp/p", ["--no-sandbox", "--x=$HOME"]);

    assert.match(line, /^exec '\/opt\/my chromium' --headless=new .*--remote-debugging-pipe /);
    assert.match(
        line,
        / --user-data-dir=\/tmp\/p --no-sandbox '--x=\$HOME' about:blank 3<&0 4>&1 1>\/dev\/null$/,
    );
});

test("a provider's answer is checked, with defaults, and a broken one opens nothing", async () => {
    assert.deepEqual(launcherFrom({ command: ["ssh", "vm", "--"] }, 7), {
        command: ["ssh", "vm", "--"],
        executable: "chromium",
        profile: "/tmp/pi-pocket-browser-7",
        args: [],
    });

    for (const wrong of [
        "ssh vm",
        { command: [] },
        { command: "ssh vm" },
        { command: ["ssh", ""] },
        { command: ["ssh", 3] },
        { command: ["ssh\0"] },
        { command: ["ssh"], executable: "" },
        { command: ["ssh"], args: "--no-sandbox" },
        { command: Array.from({ length: launcherLimits.words + 1 }, () => "x") },
    ]) {
        assert.throws(() => launcherFrom(wrong, 1), BrowserError, JSON.stringify(wrong));
    }

    const lines: string[] = [];
    const launchers = new BrowserLaunchers((line) => lines.push(line));

    assert.equal(await launchers.for(1), undefined, "no provider: the browser here");
    assert.throws(() => launchers.add("ssh" as never), /give it a function/);

    const first = launchers.add((id) => (Number(id) === 2 ? { command: ["sh", "-c"] } : undefined));

    assert.equal(await launchers.for(1), undefined);
    assert.deepEqual((await launchers.for(2))?.command, ["sh", "-c"]);

    // One provider at a time: the last one wins, and the first one's cleanup does not remove it.
    const second = launchers.add(() => ({ command: ["ssh", "vm", "--"] }));

    assert.match(lines.join("\n"), /replaced the one before it/);
    first();
    assert.deepEqual((await launchers.for(1))?.command, ["ssh", "vm", "--"]);
    second();
    assert.equal(await launchers.for(1), undefined);

    // A failure is an error, never the browser here.
    const failing = launchers.add(async () => {
        throw new Error("the VM is gone");
    });

    await assert.rejects(launchers.for(1), /launcher failed: the VM is gone/);
    failing();
    launchers.add(async () => ({ command: [] }) as never);
    await assert.rejects(launchers.for(1), /command must be a list/);

    const was = launcherLimits.providerMs;

    launcherLimits.providerMs = 30;

    try {
        launchers.add(() => new Promise(() => {}));
        await assert.rejects(launchers.for(1), /took more than 30 ms/);
    } finally {
        launcherLimits.providerMs = was;
    }
});

test("a connection refuses what it was told to, and sends the rest", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const connection = new Connection(out, input);
    const sent: string[] = [];

    out.on("data", (chunk: Buffer) => sent.push(chunk.toString()));
    connection.refused = new Map([["DOM.setFileInputFiles", "no files from here"]]);
    await assert.rejects(
        connection.send("DOM.setFileInputFiles", { files: ["/etc/passwd"] }),
        /no files from here/,
    );
    const answer = connection.send("Browser.getVersion");

    await until(() => sent.length === 1, "the message");
    assert.match(sent[0]!, /"method":"Browser.getVersion"/);
    input.write(
        `${JSON.stringify({ id: JSON.parse(sent[0]!.slice(0, -1)).id, result: { ok: 1 } })}\0`,
    );
    assert.deepEqual(await answer, { ok: 1 });
    connection.close("done");
});

test(
    "a conversation with a launcher gets a Chromium of its own, which stops with its page, the idle timer, and closeAll",
    real,
    async () => {
        const folder = mkdtempSync(join(root, "launcher-"));
        const pids = join(folder, "pids");
        const asked: number[] = [];
        let failNext = false;

        // The reaper's interval, by hand: pages here are idle after 1 ms.
        mock.timers.enable({ apis: ["setInterval"] });
        const browsers = new Browsers({
            dataDir: folder,
            args: flags,
            idleMs: 1,
            launcher: async (id) => {
                asked.push(id);

                if (failNext) {
                    failNext = false;

                    throw new BrowserError("The browser's launcher failed: the VM is gone");
                }

                return id === 1 ? undefined : fakeLauncher(pids, join(folder, `profile-${id}`));
            },
        });

        try {
            // Conversation 1 keeps the browser here; 2 and 3 each get their own, through the launcher.
            const here = await browsers.open(1, { restore: false });
            const two = await browsers.open(2, { restore: false });
            const three = await browsers.open(3, { restore: false });
            const [pid2, pid3] = pidsIn(pids);

            assert.equal(pidsIn(pids).length, 2, "one Chromium for each conversation elsewhere");
            assert.ok(pid2 !== undefined && alive(pid2) && pid3 !== undefined && alive(pid3));
            assert.deepEqual(await Promise.all([1, 2, 3].map((id) => browsers.elsewhere(id))), [
                false,
                true,
                true,
            ]);

            // What comes after the launch is the same: pages load, screenshots, frames, and input.
            assert.deepEqual(await two.navigate(`${base}/`), { status: 200 });
            await until(() => two.title === "Far away", "the title", 30_000);
            assert.match((await two.snapshot()).lines, /Hello from elsewhere/);
            const shot = await two.screenshot();

            assert.ok(shot.data.length > 1000);
            const frame = await two.frame(0);

            assert.ok(frame !== undefined && frame.data.length > 1000, "a screencast frame");
            await two.navigate(`${base}/two`);
            assert.equal(await two.go(-1), true);
            await until(() => two.title === "Far away", "back", 30_000);
            assert.deepEqual(await here.navigate(`${base}/two`), { status: 200 });
            assert.equal(await here.evaluate("1 + 1"), "2");

            // Closing the page stops its browser; the one here goes on.
            await browsers.close(2);
            await until(() => !alive(pid2), "conversation 2's Chromium to stop");
            assert.ok(alive(pid3) && !here.closed && !three.closed);

            // A page opened again starts a new one.
            await browsers.open(2, { restore: false });
            const pid2again = pidsIn(pids)[2]!;

            assert.ok(alive(pid2again));

            // The idle timer: every page closes, and the browsers elsewhere stop with them.
            mock.timers.tick(60_000);
            await until(() => !alive(pid2again) && !alive(pid3), "idle browsers to stop");
            assert.equal(browsers.page(1), undefined);

            // A launcher that fails opens no page, here or elsewhere.
            failNext = true;
            await assert.rejects(browsers.open(4), /the VM is gone/);
            assert.equal(browsers.page(4), undefined);
            assert.match(browsers.state(4).problem ?? "", /the VM is gone/);

            // A launcher whose command fails says why.
            const broken = new Browsers({
                dataDir: folder,
                launcher: async () => ({
                    command: ["sh", "-c", "echo 'no route to the VM' >&2; exit 3"],
                    executable: "chromium",
                    profile: "/tmp/x",
                    args: [],
                }),
            });

            await assert.rejects(
                broken.open(1),
                /exited as it started \(code 3\)\.\nno route to the VM/,
            );
            await broken.closeAll({ final: true });

            // closeAll (the module turned off) stops them too, and a restart (the final one) likewise.
            await browsers.open(2, { restore: false });
            await browsers.open(5, { restore: false });
            const [pid2last, pid5] = pidsIn(pids).slice(-2) as [number, number];

            await browsers.closeAll();
            assert.ok(!alive(pid2last) && !alive(pid5));
            await browsers.open(5, { restore: false });
            const pid5again = pidsIn(pids).at(-1)!;

            await browsers.closeAll({ final: true });
            assert.ok(!alive(pid5again));
            assert.ok(asked.includes(1), "conversation 1 asked too");
        } finally {
            mock.timers.reset();
            await browsers.closeAll({ final: true });
        }
    },
);

test(
    "an extension runs a session's browser elsewhere: Pi's tool uses it, and the panel lists none of this machine's servers",
    real,
    async () => {
        const folder = mkdtempSync(join(root, "module-"));
        const calls = join(folder, "calls");
        const results: string[] = [];

        const route: FauxResponseStep = (context) => {
            const { role, text } = lastText(context as never);

            if (role === "toolResult") {
                results.push(text);

                return fauxAssistantMessage([fauxText("done")]);
            }

            if (text.includes("open the page")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("browser", {
                            action: "navigate",
                            url: `${base}/`,
                            snapshot: true,
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([fauxText("ok")]);
        };

        const data = join(root, "module-app");

        mkdirSync(join(data, "extensions"), { recursive: true });
        // A module as a sandbox would write one: each session's browser through a command of its own.
        writeFileSync(
            join(data, "extensions", "far-browser.ts"),
            `/** Far browser: runs each session's browser through sh -c, for tests. */
export default (host, web) => {
    web.onDispose(
        host.browserLauncher((conversationId) => ({
            command: ["sh", "-c", 'echo "$0 $1" >> "$0"; eval "$1"', ${JSON.stringify(calls)}],
            executable: ${JSON.stringify(chromium)},
            profile: ${JSON.stringify(folder)} + "/profile-" + conversationId,
            args: ${JSON.stringify(flags)},
        })),
    );
};
`,
        );
        const app: App = await openApp(scriptedModel(route), data);
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
        const servers = async (id: unknown) =>
            (await (
                await fetch(`${api}/c/${id}/browser/servers`, {
                    headers: { authorization: `Bearer ${app.config.ownerToken}` },
                })
            ).json()) as { servers: unknown[] };

        try {
            const id = await newSession(app);

            assert.equal(
                await app.browsers.elsewhere(Number(id)),
                false,
                "off until the owner turns it on",
            );
            await app.setExtensionEnabled(owner(app), "far-browser.ts", true);
            assert.equal(await app.browsers.elsewhere(Number(id)), true);
            // This machine's servers mean nothing to a browser elsewhere, even before its page opens.
            assert.deepEqual(await servers(id), { servers: [] });

            await loadTools(app, id, "browser");
            await say(app, id, "open the page");
            await until(() => results.length === 1, "the navigate result");
            assert.match(results[0]!, /Opened http:\/\/127\.0\.0\.1:\d+\/ \(HTTP 200\)/);
            assert.match(results[0]!, /Hello from elsewhere/);
            assert.match(
                readFileSync(calls, "utf8"),
                / exec .*--remote-debugging-pipe .* 3<&0 4>&1/,
            );
            assert.deepEqual(await servers(id), { servers: [] });

            // Turned off, its provider goes: a page opened next runs here.
            await app.setExtensionEnabled(owner(app), "far-browser.ts", false);
            await app.browsers.close(Number(id));
            assert.equal(await app.browsers.elsewhere(Number(id)), false);
        } finally {
            server.closeAllConnections();
            server.close();
            await app.close();
        }
    },
);
