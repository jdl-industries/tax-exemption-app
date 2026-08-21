import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getAdminClient, extractShopDomain } from "../lib/shopify-client-credentials";
import { isCompanyLocationGid, verifyLocationAdmin } from "../lib/company-location-auth";

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

  const body = (await request.json()) as {
    customerId?: string;
    ownerId?: string;
    namespace?: string;
    metafieldKey?: string;
    resourceUrl?: string;
  };
  const { customerId, ownerId: rawOwnerId, namespace, metafieldKey, resourceUrl } = body;

  // `ownerId` is the current field; `customerId` is kept for older extension
  // builds that only ever wrote to the logged-in customer.
  const ownerId = rawOwnerId ?? customerId;

  if (!ownerId || !metafieldKey || !resourceUrl) {
    return respond(
      { error: "Missing required fields: ownerId, metafieldKey, resourceUrl" },
      400
    );
  }

  // The session token's `sub` claim contains the logged-in customer's GID.
  if (!sessionToken.sub) {
    return respond({ error: "Invalid session token: missing sub" }, 401);
  }

  const isLocationOwner = isCompanyLocationGid(ownerId);

  // A customer may only ever write to their own record. Anything that is not
  // their own customer GID has to be a company location they administer.
  if (!isLocationOwner && sessionToken.sub !== ownerId) {
    return respond({ error: "Unauthorized: owner ID mismatch" }, 403);
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

  // For a company location owner, confirm from the Admin API that this customer
  // holds the Location admin role there rather than trusting the request body.
  if (isLocationOwner) {
    const check = await verifyLocationAdmin(admin, sessionToken.sub, ownerId);
    if (!check.authorized) {
      return respond({ error: check.reason ?? "Forbidden" }, 403);
    }
  }

  // Step 1: Create a File object from the staged upload resourceUrl
  // The resourceUrl from staged uploads is a CDN URL, but file_reference metafields
  // require a File GID (like gid://shopify/GenericFile/123456)
  const fileCreateResponse = await admin.graphql<{
    fileCreate: {
      files: Array<{
        id: string;
        alt: string;
        createdAt: string;
      }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          alt
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      files: [
        {
          originalSource: resourceUrl,
          contentType: "FILE",
        },
      ],
    }
  );

  if (fileCreateResponse.data?.fileCreate?.userErrors?.length > 0) {
    return respond(
      { error: fileCreateResponse.data.fileCreate.userErrors[0].message },
      400
    );
  }

  const createdFile = fileCreateResponse.data?.fileCreate?.files?.[0];
  if (!createdFile?.id) {
    return respond({ error: "Failed to create file object" }, 500);
  }

  console.log("Created file with GID:", createdFile.id);

  // Step 2: Set the metafield using the File GID
  const metafieldResponse = await admin.graphql<{
    metafieldsSet: {
      metafields: Array<{
        id: string;
        key: string;
        namespace: string;
        value: string;
      }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
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
      metafields: [
        {
          ownerId,
          namespace: namespace || "$app",
          key: metafieldKey,
          type: "file_reference",
          value: createdFile.id,
        },
      ],
    }
  );

  if (metafieldResponse.data?.metafieldsSet?.userErrors?.length > 0) {
    return respond(
      { error: metafieldResponse.data.metafieldsSet.userErrors[0].message },
      400
    );
  }

  return respond({
    success: true,
    fileId: createdFile.id,
    metafield: metafieldResponse.data?.metafieldsSet?.metafields?.[0],
  });
};
