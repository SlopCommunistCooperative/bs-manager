export function parseManualProxy(value: string): URL | null {
    const input = typeof value === "string" ? value.trim() : null;
    if (input === "") { return null; }

    // Match the original authority because URL normalizes away an explicit HTTP port 80.
    const match = input?.match(/^(http|socks5):\/\/([^/?#\s\\]+):(\d+)\/?$/i);
    if (match) {
        const [, scheme, authority, rawPort] = match;
        const port = Number(rawPort);
        const endpoint = `http://${authority}:${rawPort}`;
        const url = URL.canParse(endpoint) ? new URL(endpoint) : null;
        const validHost = url && (url.hostname.startsWith("[") || url.hostname.replace(/\.$/, "").split(".")
            .every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)));

        if (validHost && port > 0) {
            if (scheme.toLowerCase() === "socks5") {
                // Chromium does not support SOCKS5 authentication.
                if (!authority.includes("@")) { return new URL(`socks5://${url.hostname}:${port}`); }
            } else {
                try {
                    const username = decodeURIComponent(url.username);
                    decodeURIComponent(url.password);
                    if ((!authority.includes("@") || username) && !username.includes(":")) {
                        return url;
                    }
                } catch {
                    // Invalid encoding in user info; don't expose the input in the error.
                }
            }
        }
    }
    throw new Error("Invalid manual proxy URL");
}
