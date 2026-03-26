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

  // Log session token for debugging
  console.log("Session token:", JSON.stringify(sessionToken, null, 2));

  // Get request body
  const body = await request.json();
  const { filename, mimeType, fileSize } = body;

  if (!filename || !mimeType) {
    return respond({ error: "Missing required fields: filename, mimeType" }, 400);
  }

  // Get shop domain from session token dest claim
  // dest can be "https://shop.myshopify.com" or just "shop.myshopify.com"
  if (!sessionToken.dest) {
    console.error("No dest in session token:", sessionToken);
    return respond({ error: "Invalid session token: missing dest" }, 401);
  }

  let shopDomain: string;
  try {
    // Try parsing as URL first
    if (sessionToken.dest.startsWith("http")) {
      shopDomain = new URL(sessionToken.dest).hostname;
    } else {
      // It's already just a domain
      shopDomain = sessionToken.dest;
    }
  } catch (e) {
    console.error("Failed to parse dest:", sessionToken.dest, e);
    return respond({ error: "Invalid session token: invalid dest format" }, 401);
  }

  console.log("Shop domain:", shopDomain);

  // Get admin client for the shop
  const { admin } = await unauthenticated.admin(shopDomain);

  // Create staged upload
  const response = await admin.graphql(
    `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: [
          {
            filename,
            mimeType,
            resource: "FILE",
            httpMethod: "POST",
            ...(fileSize ? { fileSize: String(fileSize) } : {}),
          },
        ],
      },
    }
  );

  const responseJson = await response.json();

  if (responseJson.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    return respond(
      { error: responseJson.data.stagedUploadsCreate.userErrors[0].message },
      400
    );
  }

  const target = responseJson.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!target) {
    return respond({ error: "Failed to create staged upload" }, 500);
  }

  return respond({
    url: target.url,
    resourceUrl: target.resourceUrl,
    parameters: target.parameters,
  });
};
