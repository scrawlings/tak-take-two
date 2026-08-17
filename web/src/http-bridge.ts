// The node:http ↔ fetch bridge — the adapter that serves the Hono app's fetch
// interface to node's HTTP servers. Translation (headers, URL, set-cookie,
// status) is pure and plain-data; I/O (body reads, writes) stays in the handler.

import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App } from './app.js';
import type { Logger } from './logging.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Plain-data description of an incoming node request. */
export interface NodeRequestData {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body bytes; null for methods that carry no body. */
  body: Uint8Array | null;
}

/** What to write to a node response. Set-Cookie appears once per cookie. */
export interface NodeResponsePlan {
  statusCode: number;
  headers: Array<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
}

/** Translate a plain node request description into a fetch Request. */
export function toFetchRequest(data: NodeRequestData): Request {
  const host = data.headers.host ?? 'localhost';
  const url = new URL(data.url, `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(data.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.append(name, value);
    }
  }
  const method = data.method;
  const body = method !== 'GET' && method !== 'HEAD' ? data.body : null;
  return new Request(url, { method, headers, body });
}

/** Translate a fetch Response into a plan the node side can write. */
export function translateResponse(response: Response): NodeResponsePlan {
  const headers: Array<[string, string]> = [];
  const setCookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie' && setCookies.length > 0) continue;
    headers.push([name, value]);
  }
  for (const cookie of setCookies) headers.push(['set-cookie', cookie]);
  return { statusCode: response.status, headers, body: response.body };
}

/** The composed adapter: read node request → translate → fetch → write. */
export function createHandler({
  app,
  logger,
}: {
  app: App;
  logger: Logger;
}): (nodeReq: IncomingMessage, nodeRes: ServerResponse) => Promise<void> {
  return async function handleRequest(nodeReq, nodeRes): Promise<void> {
    try {
      const method = nodeReq.method ?? 'GET';
      let body: Uint8Array | null = null;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks);
      }
      const request = toFetchRequest({ method, url: nodeReq.url ?? '/', headers: nodeReq.headers, body });
      const response = await app.fetch(request);
      writePlan(nodeRes, translateResponse(response));
    } catch (error) {
      logger.log('error', 'request handling failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = 500;
        nodeRes.setHeader('content-type', 'application/json');
        nodeRes.end('{"error":"Internal Server Error"}');
      } else {
        nodeRes.end();
      }
    }
  };
}

function writePlan(nodeRes: ServerResponse, plan: NodeResponsePlan): void {
  nodeRes.statusCode = plan.statusCode;
  const setCookies: string[] = [];
  for (const [name, value] of plan.headers) {
    if (name.toLowerCase() === 'set-cookie') setCookies.push(value);
    else nodeRes.setHeader(name, value);
  }
  if (setCookies.length > 0) nodeRes.setHeader('set-cookie', setCookies);
  if (plan.body) {
    const stream = Readable.fromWeb(plan.body as unknown as NodeWebReadableStream);
    stream.pipe(nodeRes);
  } else {
    nodeRes.end();
  }
}
