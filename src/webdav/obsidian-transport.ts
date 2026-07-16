import { requestUrl } from "obsidian";
import type { WebDavTransport } from "./types";

export class ObsidianWebDavTransport implements WebDavTransport {
  async request(request: Parameters<WebDavTransport["request"]>[0]) {
    const response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      throw: false,
    });

    return {
      status: response.status,
      headers: response.headers,
      text: response.text,
      arrayBuffer: response.arrayBuffer,
    };
  }
}
