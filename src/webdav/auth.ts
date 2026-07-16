import type { WebDavCredentials } from "./types";

export function createBasicAuthHeader(credentials: WebDavCredentials): string {
  if (credentials.username.includes(":")) {
    throw new Error("Basic Auth usernames cannot contain a colon.");
  }
  const input = `${credentials.username}:${credentials.password}`;
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${globalThis.btoa(binary)}`;
}
