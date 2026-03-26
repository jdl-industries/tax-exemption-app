import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getAdminClient, extractShopDomain } from "../lib/shopify-client-credentials";

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

export const action = async ({ request, context }: ActionFunctionArgs) => {
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

  // Get request body
  const body = await request.json();
  const { filename, mimeType, fileSize } = body;

  if (!filename || !mimeType) {
    return respond({ error: "Missing required fields: filename, mimeType" }, 400);
  }

  // Get shop domain from session token dest claim
  if (!sessionToken.dest) {
    console.error("No dest in session token:", sessionToken);
    return respond({ error: "Invalid session token: missing dest" }, 401);
  }

  let shopDomain: string;
  try {
    shopDomain = extractShopDomain(sessionToken.dest);
  } catch (e) {
    console.error("Failed to parse dest:", sessionToken.dest, e);
    return respond({ error: "Invalid session token: invalid dest format" }, 401);
  }

  // Get admin client using Client Credentials Grant (cached token)
  const admin = await getAdminClient(shopDomain, context);

  // Create staged upload
  const responseJson = await admin.graphql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
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
      input: [
        {
          filename,
          mimeType,
          resource: "FILE",
          httpMethod: "POST",
          ...(fileSize ? { fileSize: String(fileSize) } : {}),
        },
      ],
    }
  );

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
