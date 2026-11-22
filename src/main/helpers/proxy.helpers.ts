import log from "electron-log";
import { app, session } from "electron";
import type { Session } from "electron";
import { autoUpdater } from "electron-updater";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { bootstrap } from "global-agent";
import { merge } from "rxjs";
import type { list as listRegistry } from "regedit-rs";
import { parseManualProxy } from "shared/helpers/manual-proxy.helpers";
import { StaticConfigurationService } from "../services/static-configuration.service";
import { attachManualProxyAuth, getManualProxyCredentials, setManualProxy } from "./manual-proxy-state";

const internetSettings = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
type GlobalProxyAgent = { HTTP_PROXY: string | null; HTTPS_PROXY: string | null; NO_PROXY: string | null };
const proxyGlobal = global as typeof global & { GLOBAL_AGENT?: GlobalProxyAgent };

async function getWindowsProxy(): Promise<{ url: string; bypass: string } | undefined> {
    try {
        const { list } = require("regedit-rs") as { list: typeof listRegistry };
        const key = (await list(internetSettings))[internetSettings];
        const values = key?.exists ? key.values : undefined;
        const server = values?.ProxyServer?.value;
        if (values?.ProxyEnable?.value === 1 && typeof server === "string" && server) {
            const bypass = values.ProxyOverride?.value;
            return { url: server.startsWith("http://") ? server : `http://${server}`, bypass: typeof bypass === "string" ? bypass : "" };
        }
    } catch {
        log.error("Could not read Windows system proxy settings");
    }
    return undefined;
}

function applyNodeProxy(url?: string, bypass?: string): void {
    if (url && !proxyGlobal.GLOBAL_AGENT) {
        // Explicit got agents must take precedence for SOCKS5 and HTTP authentication.
        bootstrap({ forceGlobalAgent: false });
    }
    const agent = proxyGlobal.GLOBAL_AGENT;
    if (agent) {
        agent.HTTP_PROXY = url ?? null;
        agent.HTTPS_PROXY = url ?? null;
        agent.NO_PROXY = bypass || null;
    }
}

// Run after app.whenReady(): the default session is unavailable before then.
export function configureProxy(): Promise<void> {
    const staticConfig = StaticConfigurationService.getInstance();
    const { defaultSession } = session;
    let sessionProxy: URL | null = null;
    let updaterSession: Session | undefined;
    let pending = Promise.resolve();

    app.on("login", (event, webContents, details, auth, callback) => {
        if (!details.firstAuthAttempt || webContents?.session !== defaultSession) { return; }
        const credentials = getManualProxyCredentials(auth);
        if (credentials) {
            event.preventDefault();
            callback(...credentials);
        }
    });

    const apply = async () => {
        let manual: URL | null = null;
        try {
            manual = parseManualProxy(staticConfig.get("manual-proxy", ""));
        } catch {
            log.error("Ignoring invalid saved manual proxy settings");
        }

        const system = !manual && process.platform === "win32" && staticConfig.get("use-system-proxy")
            ? await getWindowsProxy() : undefined;
        applyNodeProxy(manual?.protocol === "http:" ? manual.href : system?.url, system?.bypass);
        setManualProxy(manual);

        if (manual?.href !== sessionProxy?.href) {
            if (manual && process.platform !== "linux" && !updaterSession) {
                // The launcher updater uses its own Chromium session.
                updaterSession = autoUpdater.netSession;
                // The updater's login event drops request identity, and AuthInfo has no retry flag.
                const { httpExecutor } = autoUpdater as typeof autoUpdater & { httpExecutor: ElectronHttpExecutor };
                const createRequest = httpExecutor.createRequest.bind(httpExecutor);
                httpExecutor.createRequest = (options, callback) => {
                    const request = createRequest(options, callback);
                    // Replace the updater's forwarding listener so Electron cancels unhandled retries.
                    request.removeAllListeners("login");
                    attachManualProxyAuth(request);
                    return request;
                };
            }
            for (const target of updaterSession ? [defaultSession, updaterSession] : [defaultSession]) {
                await target.setProxy(manual
                    ? { mode: "fixed_servers", proxyRules: `${manual.protocol}//${manual.host}` }
                    : { mode: "system" });
                if (manual?.username || sessionProxy?.username) { await target.clearAuthCache(); }
                await target.closeAllConnections();
            }
            sessionProxy = manual;
        }
    };

    const queueApply = () => {
        pending = pending.then(apply).catch(() => log.error("Could not apply proxy settings"));
        return pending;
    };
    merge(staticConfig.$watch("manual-proxy"), staticConfig.$watch("use-system-proxy")).subscribe(queueApply);
    return queueApply();
}
