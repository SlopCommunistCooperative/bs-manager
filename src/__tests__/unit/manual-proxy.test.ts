import { EventEmitter } from "node:events";
import { setImmediate as flushChanges } from "node:timers/promises";
import { app, session } from "electron";
import { autoUpdater } from "electron-updater";
import type { ClientRequest } from "electron";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { EMPTY } from "rxjs";
import { configureProxy } from "main/helpers/proxy.helpers";
import { attachManualProxyAuth, setManualProxy } from "main/helpers/manual-proxy-state";
import { downloaderEnvironment } from "main/models/bs-downloader.class";
import { StaticConfigurationService } from "main/services/static-configuration.service";
import { parseManualProxy } from "shared/helpers/manual-proxy.helpers";

jest.mock("electron", () => ({
    app: new (jest.requireActual("node:events").EventEmitter)(),
    net: { request: jest.fn(() => new (jest.requireActual("node:events").EventEmitter)()) },
    session: { defaultSession: { setProxy: jest.fn(), clearAuthCache: jest.fn(), closeAllConnections: jest.fn() }, fromPartition: jest.fn() },
}));
jest.mock("electron-updater", () => {
    const updater = new (jest.requireActual("node:events").EventEmitter)();
    const { ElectronHttpExecutor: Executor } = jest.requireActual<{ ElectronHttpExecutor: typeof ElectronHttpExecutor }>("electron-updater/out/electronHttpExecutor");
    return { autoUpdater: Object.assign(updater, {
        httpExecutor: new Executor((auth, callback) => updater.emit("login", auth, callback)),
        netSession: { setProxy: jest.fn(), clearAuthCache: jest.fn(), closeAllConnections: jest.fn() },
    }) };
});
jest.mock("electron-log", () => ({ error: jest.fn() }));
jest.mock("electron-store", () => class extends Map<string, unknown> {
    get(key: string, fallback?: unknown) { return super.has(key) ? super.get(key) : fallback; }
});
jest.mock("regedit-rs", () => ({ list: jest.fn() }));
jest.mock("global-agent", () => ({ bootstrap: () => { Object.assign(global, { GLOBAL_AGENT: {} }); return true; } }));
jest.mock("main/services/utils.service", () => ({ UtilsService: { getInstance: jest.fn() } }));

const { list } = jest.requireMock<{ list: jest.Mock }>("regedit-rs");
const httpProxy = "http://proxy.example:8080";
const socksProxy = "socks5://proxy.example:1080";
const saved = StaticConfigurationService.getInstance();

it.each([
    ["  http://proxy.example:80  ", "http://proxy.example/"],
    ["http://user:p%40ss@proxy.example:8080", "http://user:p%40ss@proxy.example:8080/"],
    ["socks5://proxy.example:1080/", socksProxy],
    ["socks5://[::1]:1080", "socks5://[::1]:1080"],
])("accepts and normalizes %s", (input, expected) => {
    expect(parseManualProxy(input)?.href).toBe(expected);
});

it.each(["", "  "])("treats %j as no manual proxy", input => {
    expect(parseManualProxy(input)).toBeNull();
});

it.each([
    "junk", "http://missing-port", "http://:8080", "http://proxy:0", "http://proxy:65536", "http://proxy:abc",
    "http://bad host:8080", "http://proxy;direct:8080", "http://proxy:8080/path", "http://proxy:8080?query",
    "https://proxy:8080", "socks4://proxy:1080", "socks5://user:secret@proxy:1080", "http://user:%zz@proxy:8080",
])("rejects %s without including the value in the error", input => {
    expect(() => parseManualProxy(input)).toThrow(/^Invalid manual proxy URL$/);
});

it("submits manual proxy credentials only once per updater request", async () => {
    const { autoUpdater: { httpExecutor } } = jest.requireMock<{ autoUpdater: { httpExecutor: ElectronHttpExecutor } }>("electron-updater");
    const { createRequest } = httpExecutor;
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const watch = jest.spyOn(saved, "$watch").mockReturnValue(EMPTY);
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    jest.mocked(session.fromPartition).mockReturnValue(autoUpdater.netSession);
    try {
        await saved.set("manual-proxy", "http://user:p%40ss@proxy.example:8080");
        await configureProxy();

        const auth = { isProxy: true, host: "proxy.example", port: 8080 };
        const challenge = (request: ClientRequest) => {
            const callback = jest.fn();
            // Electron cancels with no arguments when no request login listener handles the challenge.
            if (!request.emit("login", auth, callback)) { callback(); }
            return callback.mock.calls;
        };
        const request = httpExecutor.createRequest({}, jest.fn());
        expect(challenge(request)).toEqual([["user", "p@ss"]]);
        expect(challenge(request)).toEqual([[]]);
        expect(challenge(httpExecutor.createRequest({}, jest.fn()))).toEqual([["user", "p@ss"]]);
    } finally {
        httpExecutor.createRequest = createRequest;
        jest.mocked(session.fromPartition).mockReset();
        Object.defineProperty(process, "platform", platform);
        watch.mockRestore();
        saved.delete("manual-proxy");
        Reflect.deleteProperty(global, "GLOBAL_AGENT");
        setManualProxy(null);
        app.removeAllListeners("login");
    }
});

it("switches live between validated manual proxies and the Windows system fallback", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    let env: { restore(): void };
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
        env = jest.replaceProperty(process, "env", { ...process.env, NO_PROXY: "*", ALL_PROXY: "socks5://inherited:1080" });
        list.mockImplementation(async (key: string) => ({ [key]: {
            exists: true,
            keys: [],
            values: {
                ProxyEnable: { type: "REG_DWORD", value: 1 },
                ProxyServer: { type: "REG_SZ", value: "system.example:3128" },
                ProxyOverride: { type: "REG_SZ", value: "*.internal;<local>" },
            },
        } }));
        await saved.set("use-system-proxy", true);
        await saved.set("manual-proxy", httpProxy);
        await configureProxy();

        expect(list).not.toHaveBeenCalled();
        expect(session.defaultSession.setProxy).toHaveBeenLastCalledWith({ mode: "fixed_servers", proxyRules: httpProxy });
        expect(autoUpdater.netSession.setProxy).toHaveBeenLastCalledWith({ mode: "fixed_servers", proxyRules: httpProxy });
        expect(Reflect.get(global, "GLOBAL_AGENT")).toEqual({ HTTP_PROXY: `${httpProxy}/`, HTTPS_PROXY: `${httpProxy}/`, NO_PROXY: null });
        const httpEnv = downloaderEnvironment();
        expect(httpEnv).toMatchObject({ HTTP_PROXY: `${httpProxy}/`, https_proxy: `${httpProxy}/` });
        expect(httpEnv.NO_PROXY).toBeUndefined();
        expect(httpEnv.ALL_PROXY).toBeUndefined();

        await expect(saved.set("manual-proxy", "invalid")).rejects.toThrow("Invalid manual proxy URL");
        expect(saved.get("manual-proxy")).toBe(httpProxy);
        await saved.set("manual-proxy", socksProxy);
        await flushChanges();
        expect(session.defaultSession.setProxy).toHaveBeenLastCalledWith({ mode: "fixed_servers", proxyRules: socksProxy });
        expect(Reflect.get(global, "GLOBAL_AGENT")).toMatchObject({ HTTP_PROXY: null, HTTPS_PROXY: null });
        expect(downloaderEnvironment()).toMatchObject({ HTTP_PROXY: socksProxy, HTTPS_PROXY: socksProxy, ALL_PROXY: socksProxy, all_proxy: socksProxy });

        await saved.set("use-system-proxy", false);
        await saved.set("use-system-proxy", true);
        await flushChanges();
        expect(list).not.toHaveBeenCalled();
        await saved.set("manual-proxy", "");
        await flushChanges();
        expect(session.defaultSession.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
        expect(autoUpdater.netSession.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
        expect(downloaderEnvironment()).toMatchObject({ HTTP_PROXY: "http://system.example:3128", HTTPS_PROXY: "http://system.example:3128", NO_PROXY: ".internal" });

        await saved.set("use-system-proxy", false);
        await flushChanges();
        expect(downloaderEnvironment().NO_PROXY).toBe("*");
        expect(downloaderEnvironment().HTTPS_PROXY).toBe(process.env.HTTPS_PROXY);
    } finally {
        env?.restore();
        Object.defineProperty(process, "platform", platform);
        Reflect.deleteProperty(global, "GLOBAL_AGENT");
        setManualProxy(null);
        app.removeAllListeners("login");
    }
});

it("only answers Electron net auth challenges from the configured proxy", () => {
    setManualProxy(parseManualProxy("http://user:p%40ss@proxy.example:8080"));
    try {
        const hostChallenge = { isProxy: false, host: "proxy.example", port: 8080 };
        for (const [challenge, expected] of [
            [hostChallenge, []],
            [{ ...hostChallenge, isProxy: true, host: "other.example" }, []],
            [{ ...hostChallenge, isProxy: true }, ["user", "p@ss"]],
        ] as const) {
            const request = new EventEmitter();
            const callback = jest.fn();
            attachManualProxyAuth(request as unknown as ClientRequest);
            request.emit("login", challenge, callback);
            expect(callback).toHaveBeenCalledWith(...expected);
        }
    } finally {
        setManualProxy(null);
    }
});
