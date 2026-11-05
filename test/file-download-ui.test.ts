// A binary file opened from a link downloads, as a link to a `.zip` does; every file has a Download button.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const zip = join(work, "download-resume.zip");
const notes = join(work, "download-notes.txt");
const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0xfe, 0, 1, 2, 3]);

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

/** The downloads the page started: each link the app clicked that has a `download` name. */
const downloads = () =>
    inPage<{ href: string; name: string }[]>(`return JSON.stringify(window.__downloads)`);

/** Open a session, and keep a record of the downloads it starts instead of saving files. */
async function opened(viewport: (typeof VIEWPORTS)[keyof typeof VIEWPORTS]): Promise<string> {
    const id = await newSession(app);

    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await inPage(`
        window.__downloads = [];
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (this.hasAttribute("download")) {
                window.__downloads.push({ href: this.getAttribute("href"), name: this.download });
                return;
            }
            return click.call(this);
        };
        return "null";`);

    return String(id);
}

const openFile = (path: string) =>
    inPage(`(await import("/ui.js")).openFile(${JSON.stringify(path)}); return "null";`);

const binaryShown = () =>
    see(
        `return JSON.stringify(document.querySelector(".file-binary button") !== null)`,
        "the binary file's Download button",
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(work, { recursive: true });
    writeFileSync(zip, bytes);
    writeFileSync(notes, "some notes\n");
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "file-download-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "opening a binary file in the sheet downloads it, once for each time it is opened",
    real,
    async () => {
        const id = await opened(VIEWPORTS.mobile);

        await openFile(zip);
        await binaryShown();
        await until(async () => (await downloads()).length === 1, "the download");

        const [first] = await downloads();

        assert.equal(first!.href, `/api/c/${id}/download?path=${encodeURIComponent(zip)}`);
        assert.equal(first!.name, "download-resume.zip");

        // The address the link names is an attachment, with the file's bytes, for this signed-in browser.
        const fetched = await inPage<{ status: number; disposition: string; bytes: number[] }>(`
        const response = await fetch(${JSON.stringify(first!.href)});
        return JSON.stringify({
            status: response.status,
            disposition: response.headers.get("content-disposition"),
            bytes: [...new Uint8Array(await response.arrayBuffer())],
        });`);

        assert.equal(fetched.status, 200);
        assert.match(fetched.disposition, /^attachment; filename="download-resume.zip"/);
        assert.deepEqual(fetched.bytes, [...bytes]);

        // Its Download button downloads it again; so does opening it again.
        await inPage(`document.querySelector(".file-binary button").click(); return "null";`);
        assert.equal((await downloads()).length, 2);
        await openFile(zip);
        await until(
            async () => (await downloads()).length === 3,
            "the download of the file opened again",
        );
    },
);

test(
    "a text file shows as text, with a Download button, and does not download by itself",
    real,
    async () => {
        const id = await opened(VIEWPORTS.mobile);

        await openFile(notes);
        await see(
            `return JSON.stringify(document.querySelector(".file-view")?.textContent.includes("some notes") === true)`,
            "the text",
        );
        assert.deepEqual(await downloads(), []);

        await inPage(
            `document.querySelector('.file-tools [aria-label="Download"]').click(); return "null";`,
        );
        assert.deepEqual(await downloads(), [
            {
                href: `/api/c/${id}/download?path=${encodeURIComponent(notes)}`,
                name: "download-notes.txt",
            },
        ]);
    },
);

test(
    "opening a binary file in the Files tile downloads it once, not each time the viewer draws",
    real,
    async () => {
        await opened(VIEWPORTS.desktop);
        await inPage(
            `(await import("/files-panel.js")).setFilesOpen(true, "files"); return "null";`,
        );
        await see(
            `return JSON.stringify(document.querySelector(".ft-view, .files-panel, .ft-row") !== null)`,
            "the tile",
        );
        await openFile(zip);
        await binaryShown();
        await until(async () => (await downloads()).length === 1, "the download");

        // Another branch draws the open file again, for the same request: no second download.
        await inPage(`
        const { store } = await import("/store.js");
        store.set((state) => ({ view: { ...state.view, branch: { name: "elsewhere" } } }));
        return "null";`);
        await binaryShown();
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal((await downloads()).length, 1);

        await openFile(zip);
        await until(
            async () => (await downloads()).length === 2,
            "the download of the file opened again",
        );
    },
);
