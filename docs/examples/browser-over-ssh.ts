/**
 * Runs each session's browser on another machine over SSH: the one that POCKET_BROWSER_SSH names, such as me@box.
 *
 * That machine needs Chromium (POCKET_BROWSER_SSH_CHROMIUM, default `chromium`) and a key that lets this server sign in
 * with no prompt. POCKET_BROWSER_SSH_ARGS adds Chromium flags there, such as `--no-sandbox`. Pages then load from that
 * machine: `localhost` and file paths are that machine's. Without POCKET_BROWSER_SSH, sessions use the browser here.
 */
import type { Host, Web } from "../../types/pocket.d.ts";

export default function createBrowserOverSsh(host: Host, web: Web) {
    // host.browserLauncher came in 0.28.0: an older server keeps every browser here.
    if (typeof host.browserLauncher !== "function") {
        host.notice("warning", "Browser over SSH needs Pi Pocket 0.28.0 or later.");

        return;
    }

    web.onDispose(
        host.browserLauncher(() => {
            const target = process.env.POCKET_BROWSER_SSH?.trim();

            if (target === undefined || target === "") {
                return undefined;
            }

            return {
                // Everything after `--` is the command that runs there: the Chromium command line.
                command: ["ssh", "-o", "BatchMode=yes", "-T", target, "--"],
                executable: process.env.POCKET_BROWSER_SSH_CHROMIUM ?? "chromium",
                args: (process.env.POCKET_BROWSER_SSH_ARGS ?? "").split(/\s+/).filter(Boolean),
            };
        }),
    );
}
