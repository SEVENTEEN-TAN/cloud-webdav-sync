import { createBasicAuthHeader } from "../src/webdav/auth";
import { WebDavClient } from "../src/webdav/client";
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "../src/webdav/types";
import { joinWebDavUrl } from "../src/webdav/url";

class FetchTransport implements WebDavTransport {
  async request(request: WebDavRequest): Promise<WebDavResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.method === "MOVE" ? "manual" : "follow",
    });
    const arrayBuffer = await response.arrayBuffer();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: new TextDecoder().decode(arrayBuffer),
      arrayBuffer,
    };
  }
}

const serverUrl = requireEnvironment("WEBDAV_URL");
const username = requireEnvironment("WEBDAV_USERNAME");
const password = requireEnvironment("WEBDAV_PASSWORD");
const credentials = { username, password };
const authorization = createBasicAuthHeader(credentials);
const transport = new FetchTransport();
const testDirectory = `codex-webdav-primitives-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const client = new WebDavClient({ serverUrl, remoteRoot: testDirectory, credentials }, transport);
const rootClient = new WebDavClient({ serverUrl, remoteRoot: "", credentials }, transport);
let cleanupStatus: number | null = null;

try {
  const created = await rootClient.makeCollection(testDirectory);
  if (created.status !== 201) throw new Error(`Test directory MKCOL returned HTTP ${created.status}.`);

  const mkcolRounds: number[][] = [];
  for (let round = 0; round < 20; round += 1) {
    const path = `mkcol-${round}`;
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => client.makeCollection(path)),
    );
    mkcolRounds.push(responses.map(({ status }) => status));
    await client.remove(path);
  }

  const moveRounds: Array<{ statuses: number[]; target: string }> = [];
  for (let round = 0; round < 20; round += 1) {
    const sources = ["a", "b", "c", "d"].map((suffix) => `move-${round}-${suffix}.txt`);
    const target = `move-${round}-target.txt`;
    await Promise.all(sources.map((source, index) => client.put(source, `${index}-${round}`)));
    const targetUrl = joinWebDavUrl(serverUrl, testDirectory, target);
    const move = (source: string) => transport.request({
      url: joinWebDavUrl(serverUrl, testDirectory, source),
      method: "MOVE",
      headers: {
        Authorization: authorization,
        Destination: targetUrl,
        Overwrite: "F",
      },
    });
    const responses = await Promise.all(sources.map(move));
    const targetResponse = await client.get(target);
    moveRounds.push({
      statuses: responses.map(({ status }) => status),
      target: targetResponse.status === 200 ? targetResponse.text : `HTTP ${targetResponse.status}`,
    });
    await Promise.all([...sources.map((source) => client.remove(source)), client.remove(target)]);
  }

  const mkcolExclusiveRounds = mkcolRounds.filter(
    (statuses) => statuses.filter((status) => status === 201).length === 1,
  ).length;
  const moveExclusiveRounds = moveRounds.filter(({ statuses }) =>
    statuses.filter((status) => status === 201 || status === 204).length === 1,
  ).length;
  const moveReadableRounds = moveRounds.filter(({ target }) => /^\d+-\d+$/.test(target)).length;

  console.log(JSON.stringify({
    testDirectory,
    mkcol: { exclusiveRounds: mkcolExclusiveRounds, totalRounds: mkcolRounds.length, rounds: mkcolRounds },
    moveNoOverwrite: {
      exclusiveRounds: moveExclusiveRounds,
      readableRounds: moveReadableRounds,
      totalRounds: moveRounds.length,
      rounds: moveRounds,
    },
  }, null, 2));
} finally {
  try {
    cleanupStatus = (await rootClient.remove(testDirectory)).status;
  } catch {
    cleanupStatus = null;
  }
  console.error(JSON.stringify({ cleanupDirectory: testDirectory, cleanupStatus }));
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
