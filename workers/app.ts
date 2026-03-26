import { createRequestHandler } from "react-router";
import { sessionStorage } from "../app/shopify.server";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight for API routes
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Set environment variables for Shopify library
    process.env.SHOPIFY_API_KEY = env.SHOPIFY_API_KEY;
    process.env.SHOPIFY_API_SECRET = env.SHOPIFY_API_SECRET;
    process.env.SCOPES = env.SCOPES;
    process.env.SHOPIFY_APP_URL = env.SHOPIFY_APP_URL;
    if (env.SHOP_CUSTOM_DOMAIN) {
      process.env.SHOP_CUSTOM_DOMAIN = env.SHOP_CUSTOM_DOMAIN;
    }

    // Set KV namespace for session storage
    if (env.SHOPIFY_SESSIONS) {
      sessionStorage.setNamespace(env.SHOPIFY_SESSIONS);
    }

    const response = await requestHandler(request, {
      cloudflare: { env, ctx },
    });

    // Add CORS headers to API responses
    if (url.pathname.startsWith("/api/")) {
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        newHeaders.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
