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

/**
 * Write the tax exemption type and attestation metafields.
 *
 * The extension used to call metafieldsSet on the Customer Account API directly.
 * That works for a customer owner but is rejected for a CompanyLocation owner
 * with "Access to this namespace and key on Metafields for this resource type is
 * not allowed", so both owner kinds now go through the Admin API here -- the
 * same route the certificate and Tax ID writes already take.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const respond = (data: object, status = 200) => {
    return cors(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      })
    );
  };

  const body = (await request.json()) as {
    ownerId?: unknown;
    taxExemptionType?: unknown;
    taxExemptionAttestation?: unknown;
  };
  const { ownerId, taxExemptionType, taxExemptionAttestation } = body;

  if (typeof ownerId !== "string" || ownerId === "") {
    return respond({ error: "ownerId is required" }, 400);
  }

  if (typeof taxExemptionType !== "string") {
    return respond({ error: "taxExemptionType must be a string" }, 400);
  }

  if (typeof taxExemptionAttestation !== "boolean") {
    return respond({ error: "taxExemptionAttestation must be a boolean" }, 400);
  }

  // The session token's `sub` claim carries the logged-in customer's GID.
  if (!sessionToken.sub) {
    return respond({ error: "Invalid session token: missing sub" }, 401);
  }

  const isLocationOwner = isCompanyLocationGid(ownerId);

  // A customer may only ever write to their own record. Anything that is not
  // their own customer GID has to be a company location they administer.
  if (!isLocationOwner && sessionToken.sub !== ownerId) {
    return respond({ error: "Unauthorized: owner ID mismatch" }, 403);
  }

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

  const admin = await getAdminClient(shopDomain, context);

  // Never trust the location ID from the request body -- confirm from the Admin
  // API that this customer really is a Location admin there.
  if (isLocationOwner) {
    const check = await verifyLocationAdmin(admin, sessionToken.sub, ownerId);
    if (!check.authorized) {
      return respond({ error: check.reason ?? "Forbidden" }, 403);
    }
  }

  const response = await admin.graphql<{
    metafieldsSet: {
      metafields: Array<{ key: string; value: string }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation SaveTaxExemptionFields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          key
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
          namespace: "$app",
          key: "tax_exemption_type",
          type: "single_line_text_field",
          value: taxExemptionType,
        },
        {
          ownerId,
          namespace: "$app",
          key: "tax_exemption_attestation",
          type: "boolean",
          value: taxExemptionAttestation ? "true" : "false",
        },
      ],
    }
  );

  if (response.errors?.length) {
    console.error("metafieldsSet errors:", response.errors);
    return respond({ error: response.errors[0].message }, 500);
  }

  const result = response.data?.metafieldsSet;

  if (result?.userErrors?.length) {
    return respond({ error: result.userErrors[0].message }, 400);
  }

  const metafields = result?.metafields ?? [];

  return respond({
    success: true,
    type: metafields.find((m) => m.key === "tax_exemption_type")?.value ?? "",
    attestation:
      metafields.find((m) => m.key === "tax_exemption_attestation")?.value === "true",
  });
};
