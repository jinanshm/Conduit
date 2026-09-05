/**
 * Conduit: provider-neutral Cloudflare Worker AI gateway.
 *
 * The client speaks one OpenAI-compatible contract. The Worker can route it to
 * an OpenAI-compatible API, Anthropic Messages API, or Google AI Studio while
 * keeping provider credentials server-side.
 */

import { GoogleGenAI } from "@google/genai";

export interface Env {
  // openai (OpenAI-compatible), anthropic, or google
  PROVIDER?: string;
  MODEL?: string;
  // Comma-separated models tried after MODEL/request model on retryable errors.
  FALLBACK_MODELS?: string;

  // OpenAI-compatible providers: OpenRouter, Perplexity, Groq, Together, etc.
  UPSTREAM_URL?: string;
  UPSTREAM_API_KEY?: string;

  // Google AI Studio.
  GOOGLE_API_KEY?: string;

  // Anthropic Messages API.
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_VERSION?: string;

  PROXY_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  ALLOWED_MODELS?: string;
}

const PROXY_PATHS = [
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/models",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/images/generations",
];

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

type OpenAIMessage = { role: string; content: unknown };
type ChatBody = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
};

type Provider = "openai" | "anthropic" | "google";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsResponse(null, env, request);

    if (url.pathname === "/health" || url.pathname === "/") {
      return corsResponse(Response.json({
        status: "ok",
        service: "conduit",
        provider: providerName(env),
        model: env.MODEL || null,
        fallback_models: parseModels(env.FALLBACK_MODELS),
        proxied_paths: PROXY_PATHS,
        timestamp: new Date().toISOString(),
      }), env, request);
    }

    if (!url.pathname.startsWith("/v1/")) {
      return errorResponse(404, `Not found: ${url.pathname}. Try POST /v1/chat/completions`, env, request);
    }

    if (env.PROXY_API_KEY) {
      const auth = request.headers.get("Authorization");
      const token = auth?.replace(/^Bearer\s+/i, "").trim();
      if (token !== env.PROXY_API_KEY) {
        return errorResponse(401, "Unauthorized: invalid proxy API key", env, request, "auth_error");
      }
    }

    const provider = providerName(env);
    if (provider === "google") return handleGoogleChat(request, env, url);
    if (provider === "anthropic") return handleAnthropicChat(request, env);
    return handleOpenAiCompatible(request, env, url);
  },
} satisfies ExportedHandler<Env>;

function providerName(env: Env): Provider {
  const provider = env.PROVIDER?.trim().toLowerCase();
  if (provider === "google") return "google";
  if (provider === "anthropic" || provider === "claude") return "anthropic";
  return "openai";
}

function parseModels(value?: string): string[] {
  return value?.split(",").map((model) => model.trim()).filter(Boolean) || [];
}

function modelsFor(bodyModel: string | undefined, env: Env): string[] {
  const configuredDefault = env.MODEL?.trim();
  const primary = bodyModel?.trim() || configuredDefault;
  return [...new Set([primary, ...parseModels(env.FALLBACK_MODELS)].filter(Boolean) as string[])];
}

function validateModel(model: string, env: Env): string | null {
  const allowed = parseModels(env.ALLOWED_MODELS);
  return allowed.length > 0 && !allowed.includes(model)
    ? `Model not allowed: ${model}. Allowed: ${allowed.join(", ")}`
    : null;
}

function shouldTryFallback(status: number, hasNext: boolean): boolean {
  return hasNext && RETRYABLE_STATUS_CODES.has(status);
}

async function readChatBody(request: Request, env: Env): Promise<ChatBody | Response> {
  if (request.method !== "POST") return errorResponse(405, "Method not allowed", env, request);
  try {
    return (await request.json()) as ChatBody;
  } catch {
    return errorResponse(400, "Request body must be valid JSON", env, request, "invalid_request_error");
  }
}

async function handleGoogleChat(request: Request, env: Env, _url: URL): Promise<Response> {
  if (!env.GOOGLE_API_KEY) {
    return errorResponse(500, "Proxy misconfigured: GOOGLE_API_KEY is not set", env, request, "config_error");
  }
  const parsed = await readChatBody(request, env);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return errorResponse(400, "messages must contain at least one message", env, request, "invalid_request_error");

  const models = modelsFor(body.model, env);
  if (models.length === 0) return errorResponse(400, "model is required (or set MODEL in the environment)", env, request, "invalid_request_error");
  for (const model of models) {
    const modelError = validateModel(model, env);
    if (modelError) return errorResponse(403, modelError, env, request, "model_not_allowed");
  }

  const systemMessages = messages.filter((message) => message.role === "system");
  const contents = messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: contentToText(message.content) }],
  }));
  const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });

  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    try {
      const config = {
        systemInstruction: systemMessages.length > 0 ? systemMessages.map((message) => contentToText(message.content)).join("\n") : undefined,
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        topP: typeof body.top_p === "number" ? body.top_p : undefined,
        maxOutputTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
      };
      if (body.stream === true) {
        const stream = await ai.models.generateContentStream({ model, contents, config });
        return googleStreamResponse(stream, model, env, request);
      }
      const result = await ai.models.generateContent({ model, contents, config });
      return corsResponse(Response.json(toOpenAiResponse(result, model)), env, request);
    } catch (error) {
      if (index < models.length - 1 && isRetryableError(error)) continue;
      return errorResponse(502, `Google AI request failed: ${errorMessage(error)}`, env, request, "upstream_error");
    }
  }
  return errorResponse(502, "All configured Google models failed", env, request, "upstream_error");
}

async function handleAnthropicChat(request: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return errorResponse(500, "Proxy misconfigured: ANTHROPIC_API_KEY is not set", env, request, "config_error");
  }
  const parsed = await readChatBody(request, env);
  if (parsed instanceof Response) return parsed;
  const body = parsed;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return errorResponse(400, "messages must contain at least one message", env, request, "invalid_request_error");

  const models = modelsFor(body.model, env);
  if (models.length === 0) return errorResponse(400, "model is required (or set MODEL in the environment)", env, request, "invalid_request_error");
  for (const model of models) {
    const modelError = validateModel(model, env);
    if (modelError) return errorResponse(403, modelError, env, request, "model_not_allowed");
  }

  const upstreamBase = (env.UPSTREAM_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const endpoint = upstreamBase.endsWith("/v1") ? `${upstreamBase}/messages` : `${upstreamBase}/v1/messages`;
  const system = messages.filter((message) => message.role === "system").map((message) => contentToText(message.content)).join("\n");
  const anthropicMessages = messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: contentToText(message.content),
  }));

  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const upstreamResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": env.ANTHROPIC_VERSION || "2023-06-01",
      },
      body: JSON.stringify({
        model,
        messages: anthropicMessages,
        ...(system ? { system } : {}),
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1024,
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        ...(body.stream === true ? { stream: true } : {}),
      }),
    });

    if (shouldTryFallback(upstreamResponse.status, index < models.length - 1)) continue;
    if (body.stream === true && upstreamResponse.ok) return anthropicStreamResponse(upstreamResponse, model, env, request);
    if (!upstreamResponse.ok) return proxyErrorResponse(upstreamResponse, env, request);

    try {
      const result = await upstreamResponse.json() as { id?: string; model?: string; content?: Array<{ text?: string }> };
      return corsResponse(Response.json({
        id: result.id || `chatcmpl-anthropic-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: result.model || model,
        choices: [{ index: 0, message: { role: "assistant", content: result.content?.map((part) => part.text || "").join("") || "" }, finish_reason: "stop" }],
      }), env, request);
    } catch {
      return errorResponse(502, "Anthropic returned an invalid response", env, request, "upstream_error");
    }
  }
  return errorResponse(502, "All configured Anthropic models failed", env, request, "upstream_error");
}

async function handleOpenAiCompatible(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.UPSTREAM_URL || !env.UPSTREAM_API_KEY) {
    return errorResponse(500, "Proxy misconfigured: UPSTREAM_URL or UPSTREAM_API_KEY not set", env, request, "config_error");
  }

  let requestBody: string | undefined;
  let body: ChatBody | undefined;
  if (request.method === "POST") {
    try {
      body = (await request.clone().json()) as ChatBody;
      if (!body.model && env.MODEL) {
        body.model = env.MODEL;
        requestBody = JSON.stringify(body);
      }
    } catch {
      // Let the upstream return its normal malformed-body response.
    }
  }

  const models = body ? modelsFor(body.model, env) : [];
  for (const model of models) {
    const modelError = validateModel(model, env);
    if (modelError) return errorResponse(403, modelError, env, request, "model_not_allowed");
  }
  const attempts = models.length > 0 ? models : [undefined];
  const upstreamBase = env.UPSTREAM_URL.replace(/\/+$/, "");

  for (let index = 0; index < attempts.length; index++) {
    const model = attempts[index];
    const outgoingBody = body && model && body.model !== model
      ? JSON.stringify({ ...body, model })
      : requestBody ?? request.body;
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${env.UPSTREAM_API_KEY}`);
    headers.set("Content-Type", headers.get("Content-Type") || "application/json");
    for (const name of ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "Host"]) headers.delete(name);

    const upstreamResponse = await fetch(`${upstreamBase}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : outgoingBody,
    });
    if (shouldTryFallback(upstreamResponse.status, index < attempts.length - 1)) continue;

    const responseHeaders = new Headers(upstreamResponse.headers);
    applyCorsHeaders(responseHeaders, env, request);
    return new Response(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders });
  }
  return errorResponse(502, "All configured fallback models failed", env, request, "upstream_error");
}

function anthropicStreamResponse(upstream: Response, model: string, env: Env, request: Request): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-anthropic-${crypto.randomUUID()}`;
  let buffer = "";
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error("Anthropic returned an empty stream");
        const emit = (text: string, finishReason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", ...(text ? { content: text } : {}) }, finish_reason: finishReason }] })}\n\n`));
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as { type?: string; delta?: { text?: string } };
              if (event.type === "content_block_delta" && event.delta?.text) emit(event.delta.text);
              if (event.type === "message_stop") emit("", "stop");
            } catch {
              // Ignore incomplete or provider-specific SSE events.
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: errorMessage(error), type: "upstream_error" } })}\n\n`));
        controller.close();
      }
    },
  });
  const headers = new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  applyCorsHeaders(headers, env, request);
  return new Response(body, { status: 200, headers });
}

function googleStreamResponse(stream: AsyncIterable<unknown>, model: string, env: Env, request: Request): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const id = `chatcmpl-google-${crypto.randomUUID()}`;
      try {
        for await (const chunk of stream) {
          const text = googleChunkText(chunk);
          if (!text) continue;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: errorMessage(error), type: "upstream_error" } })}\n\n`));
        controller.close();
      }
    },
  });
  const headers = new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  applyCorsHeaders(headers, env, request);
  return new Response(body, { status: 200, headers });
}

async function proxyErrorResponse(response: Response, env: Env, request: Request): Promise<Response> {
  const text = await response.text();
  return corsResponse(new Response(text || JSON.stringify({ error: { message: "Upstream request failed", type: "upstream_error" } }), { status: response.status, headers: { "Content-Type": "application/json" } }), env, request);
}

function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return typeof status === "number" ? RETRYABLE_STATUS_CODES.has(status) : /429|rate.?limit|overloaded|temporar|unavailable/i.test(errorMessage(error));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : (part as { text?: string }).text || "").join("");
  return "";
}

function googleChunkText(chunk: unknown): string {
  const value = chunk as { text?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  if (typeof value.text === "string") return value.text;
  return value.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

function toOpenAiResponse(result: unknown, model: string) {
  return { id: `chatcmpl-google-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: googleChunkText(result) }, finish_reason: "stop" }] };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorResponse(status: number, message: string, env: Env, request: Request, type = "error"): Response { return corsResponse(Response.json({ error: { message, type } }, { status }), env, request); }

function applyCorsHeaders(headers: Headers, env: Env, request: Request) {
  const allowed = env.ALLOWED_ORIGINS?.trim() || "*";
  const origin = request.headers.get("Origin");
  if (allowed === "*") headers.set("Access-Control-Allow-Origin", "*");
  else {
    const list = allowed.split(",").map((value) => value.trim()).filter(Boolean);
    if (origin && list.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
    else if (list.length > 0) headers.set("Access-Control-Allow-Origin", list[0]);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
}

function corsResponse(response: Response | null, env: Env, request: Request): Response {
  const headers = new Headers(response?.headers);
  applyCorsHeaders(headers, env, request);
  return response ? new Response(response.body, { status: response.status, statusText: response.statusText, headers }) : new Response(null, { status: 204, headers });
}
