import type { AuthInfo, ClientRequest } from "electron";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

let manualProxy: URL | null = null;
let requestOptions: { agent: { http: HttpProxyAgent<string> | SocksProxyAgent; https: HttpsProxyAgent<string> | SocksProxyAgent } } | undefined;
let credentials: [username: string, password: string] | undefined;

export function setManualProxy(url: URL | null): void {
    if (manualProxy?.href === url?.href) { return; }

    manualProxy = url;
    credentials = url?.username ? [decodeURIComponent(url.username), decodeURIComponent(url.password)] : undefined;
    requestOptions = undefined;
    if (url?.protocol === "socks5:") {
        // socks5h resolves the destination at the proxy, matching Chromium's SOCKS5 behavior.
        const agent = new SocksProxyAgent(`socks5h://${url.host}`);
        requestOptions = { agent: { http: agent, https: agent } };
    } else if (url && (credentials || url.hostname.startsWith("["))) {
        // global-agent doesn't decode user info or remove IPv6 brackets before connecting.
        const authorization = credentials && `Basic ${Buffer.from(credentials.join(":")).toString("base64")}`;
        const options = authorization ? { headers: () => ({ "Proxy-Authorization": authorization }) } : undefined;
        const endpoint = `http://${url.host}`;
        requestOptions = { agent: { http: new HttpProxyAgent(endpoint, options), https: new HttpsProxyAgent(endpoint, options) } };
    }
}

export function getManualProxy(): URL | null { return manualProxy; }

export function getManualProxyRequestOptions() { return requestOptions; }

export function getManualProxyCredentials(auth: AuthInfo): typeof credentials {
    if (credentials && auth.isProxy && auth.port === Number(manualProxy.port || 80)
        && auth.host.toLowerCase().replace(/^\[|\]$/g, "") === manualProxy.hostname.replace(/^\[|\]$/g, "")) {
        return credentials;
    }
    return undefined;
}

export function attachManualProxyAuth(request: ClientRequest): void {
    if (!credentials) { return; }
    request.once("login", (auth, callback) => {
        const login = getManualProxyCredentials(auth);
        if (login) { callback(...login); }
        else { callback(); }
    });
}
