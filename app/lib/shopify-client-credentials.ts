import type { AppLoadContext } from "react-router";

interface TokenData {
  access_token: string;
  scope: string;
  expires_in: number;
  obtained_at: number; // timestamp when token was obtained
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; field?: string[] }>;
}

// Token cache TTL - refresh 1 hour before expiry to be safe
const TOKEN_CACHE_BUFFER_SECONDS = 3600;

/**
 * Get the KV namespace from the request context.
 * Returns undefined if not available (e.g., in some dev environments).
 */
function getKVNamespace(context: AppLoadContext): KVNamespace | undefined {
  return context?.cloudflare?.env?.SHOPIFY_SESSIONS;
}

/**
 * Get a cache key for storing the access token for a specific shop.
 */
export function getTokenCacheKey(shopDomain: string): string {
  return `client_credentials_token:${shopDomain}`;
}

/**
 * Delete the cached access token for a shop.
 * Call this when the app is uninstalled to ensure stale tokens are removed.
 */
export async function deleteAccessToken(
  shopDomain: string,
  context: AppLoadContext
): Promise<void> {
  const kv = getKVNamespace(context);
  if (kv) {
    const cacheKey = getTokenCacheKey(shopDomain);
    try {
      await kv.delete(cacheKey);
      console.log(`Deleted cached access token for ${shopDomain}`);
    } catch (error) {
      console.warn("Error deleting token from cache:", error);
    }
  }
}

/**
 * Check if a cached token is still valid (not expired).
 */
function isTokenValid(tokenData: TokenData): boolean {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = tokenData.obtained_at + tokenData.expires_in - TOKEN_CACHE_BUFFER_SECONDS;
  return now < expiresAt;
}

/**
 * Fetch a new access token using Client Credentials Grant.
 */
async function fetchAccessToken(shopDomain: string): Promise<TokenData> {
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET environment variables");
  }

  const response = await fetch(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    scope: data.scope,
    expires_in: data.expires_in,
    obtained_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get an access token for a shop, using cached token if available and valid.
 * Falls back to fetching a new token if cache miss or token expired.
 */
export async function getAccessToken(
  shopDomain: string,
  context: AppLoadContext
): Promise<string> {
  const kv = getKVNamespace(context);
  const cacheKey = getTokenCacheKey(shopDomain);

  // Try to get cached token
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, "json") as TokenData | null;
      if (cached && isTokenValid(cached)) {
        console.log(`Using cached access token for ${shopDomain}`);
        return cached.access_token;
      }
    } catch (error) {
      console.warn("Error reading token from cache:", error);
    }
  }

  // Fetch new token
  console.log(`Fetching new access token for ${shopDomain}`);
  const tokenData = await fetchAccessToken(shopDomain);

  // Cache the token
  if (kv) {
    try {
      // Set TTL to token expiry minus buffer
      const ttl = tokenData.expires_in - TOKEN_CACHE_BUFFER_SECONDS;
      await kv.put(cacheKey, JSON.stringify(tokenData), { expirationTtl: ttl });
      console.log(`Cached access token for ${shopDomain}, TTL: ${ttl}s`);
    } catch (error) {
      console.warn("Error caching token:", error);
    }
  }

  return tokenData.access_token;
}

/**
 * Force refresh the access token by clearing cache and fetching a new one.
 */
async function refreshAccessToken(
  shopDomain: string,
  context: AppLoadContext
): Promise<string> {
  const kv = getKVNamespace(context);
  const cacheKey = getTokenCacheKey(shopDomain);

  // Delete the old cached token
  if (kv) {
    try {
      await kv.delete(cacheKey);
      console.log(`Cleared cached access token for ${shopDomain}`);
    } catch (error) {
      console.warn("Error clearing token from cache:", error);
    }
  }

  // Fetch new token
  console.log(`Refreshing access token for ${shopDomain}`);
  const tokenData = await fetchAccessToken(shopDomain);

  // Cache the new token
  if (kv) {
    try {
      const ttl = tokenData.expires_in - TOKEN_CACHE_BUFFER_SECONDS;
      await kv.put(cacheKey, JSON.stringify(tokenData), { expirationTtl: ttl });
      console.log(`Cached new access token for ${shopDomain}, TTL: ${ttl}s`);
    } catch (error) {
      console.warn("Error caching token:", error);
    }
  }

  return tokenData.access_token;
}

/**
 * Check if an HTTP status code indicates an auth error that should trigger token refresh.
 */
function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Get an authenticated admin client for a shop using Client Credentials Grant.
 * This is the main entry point - combines token fetching and client creation.
 *
 * The client automatically handles auth errors by refreshing the token and retrying once.
 *
 * @example
 * ```ts
 * const admin = await getAdminClient("my-shop.myshopify.com", context);
 * const result = await admin.graphql(`query { shop { name } }`);
 * ```
 */
export async function getAdminClient(
  shopDomain: string,
  context: AppLoadContext
) {
  const apiVersion = "2024-10";
  let accessToken = await getAccessToken(shopDomain, context);

  return {
    /**
     * Execute a GraphQL query or mutation against the Admin API.
     * Automatically retries once with a fresh token on auth errors.
     */
    async graphql<T = unknown>(
      query: string,
      variables?: Record<string, unknown>
    ): Promise<GraphQLResponse<T>> {
      const makeRequest = async (token: string) => {
        return fetch(
          `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": token,
            },
            body: JSON.stringify({ query, variables }),
          }
        );
      };

      // First attempt
      let response = await makeRequest(accessToken);

      // If auth error, refresh token and retry once
      if (isAuthError(response.status)) {
        console.log(`Auth error (${response.status}) for ${shopDomain}, refreshing token and retrying...`);
        accessToken = await refreshAccessToken(shopDomain, context);
        response = await makeRequest(accessToken);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GraphQL request failed: ${response.status} ${errorText}`);
      }

      return response.json();
    },
  };
}

/**
 * Extract shop domain from a session token's `dest` claim.
 * Handles both URL format (https://shop.myshopify.com) and plain domain format.
 */
export function extractShopDomain(dest: string): string {
  if (dest.startsWith("http")) {
    return new URL(dest).hostname;
  }
  return dest;
}
