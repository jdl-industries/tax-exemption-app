import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Handle preflight OPTIONS requests (no auth required)
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(null, { status: 405, headers: CORS_HEADERS });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  // Helper to add CORS headers to responses
  const respond = (data: object, status = 200) => {
    return cors(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      })
    );
  };

  const body = await request.json();
  const { customerId, namespace, metafieldKey, resourceUrl } = body;

  if (!customerId || !metafieldKey || !resourceUrl) {
    return respond(
      { error: "Missing required fields: customerId, metafieldKey, resourceUrl" },
      400
    );
  }

  // Validate that the customer ID in the request matches the session token
  // The session token's `sub` claim contains the customer GID
  if (sessionToken.sub && sessionToken.sub !== customerId) {
    return respond({ error: "Unauthorized: customer ID mismatch" }, 403);
  }

  // Get shop domain from session token dest claim
  // dest can be "https://shop.myshopify.com" or just "shop.myshopify.com"
  if (!sessionToken.dest) {
    console.error("No dest in session token:", sessionToken);
    return respond({ error: "Invalid session token: missing dest" }, 401);
  }

  let shopDomain: string;
  try {
    if (sessionToken.dest.startsWith("http")) {
      shopDomain = new URL(sessionToken.dest).hostname;
    } else {
      shopDomain = sessionToken.dest;
    }
  } catch (e) {
    console.error("Failed to parse dest:", sessionToken.dest, e);
    return respond({ error: "Invalid session token: invalid dest format" }, 401);
  }

  // Get admin client for the shop
  const { admin } = await unauthenticated.admin(shopDomain);

  // Set the metafield using Admin API
  const response = await admin.graphql(
    `#graphql
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
          value
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: customerId,
            namespace: namespace || "$app",
            key: metafieldKey,
            type: "file_reference",
            value: resourceUrl,
          },
        ],
      },
    }
  );

  const responseJson = await response.json();

  if (responseJson.data?.metafieldsSet?.userErrors?.length > 0) {
    return respond(
      { error: responseJson.data.metafieldsSet.userErrors[0].message },
      400
    );
  }

  return respond({
    success: true,
    metafield: responseJson.data?.metafieldsSet?.metafields?.[0],
  });
};
