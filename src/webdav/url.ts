export function encodeWebDavPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  for (const segment of segments) {
    if ([".", ".."].includes(segment)) {
      throw new Error("WebDAV paths cannot contain dot segments.");
    }
  }
  return segments.map(encodeURIComponent).join("/");
}

export function isAllowedWebDavServerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1";
  } catch {
    return false;
  }
}

export function joinWebDavUrl(serverUrl: string, remoteRoot: string, relativePath = ""): string {
  const parsed = new URL(serverUrl);
  if (parsed.username || parsed.password) {
    throw new Error("Credentials must not be embedded in the WebDAV URL.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("The WebDAV URL cannot contain a query string or fragment.");
  }

  const basePath = parsed.pathname.replace(/\/+$/, "");
  const suffix = [remoteRoot, relativePath].map(encodeWebDavPath).filter(Boolean).join("/");
  parsed.pathname = suffix ? `${basePath}/${suffix}` : basePath || "/";
  return parsed.toString();
}
