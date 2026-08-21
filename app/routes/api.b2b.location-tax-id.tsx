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
 * Update a company location's built-in Tax ID.
 *
 * The Tax ID lives on CompanyLocation.taxSettings.taxRegistrationId, which the
 * Customer Account API exposes read-only (as `taxIdentifier`). Writing it needs
 * the Admin API's companyLocationTaxSettingsUpdate mutation, so the customer
 * account extension proxies through here.
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
    companyLocationId?: unknown;
    taxRegistrationId?: unknown;
  };
  const { companyLocationId, taxRegistrationId } = body;

  if (!isCompanyLocationGid(companyLocationId)) {
    return respond({ error: "companyLocationId must be a CompanyLocation GID" }, 400);
  }

  if (typeof taxRegistrationId !== "string") {
    return respond({ error: "taxRegistrationId must be a string" }, 400);
  }

  // The session token's `sub` claim carries the logged-in customer's GID.
  if (!sessionToken.sub) {
    return respond({ error: "Invalid session token: missing sub" }, 401);
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
  const check = await verifyLocationAdmin(admin, sessionToken.sub, companyLocationId);
  if (!check.authorized) {
    return respond({ error: check.reason ?? "Forbidden" }, 403);
  }

  const response = await admin.graphql<{
    companyLocationTaxSettingsUpdate: {
      companyLocation: {
        id: string;
        taxSettings: { taxRegistrationId: string | null };
      } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `mutation UpdateLocationTaxId($companyLocationId: ID!, $taxRegistrationId: String) {
      companyLocationTaxSettingsUpdate(
        companyLocationId: $companyLocationId
        taxRegistrationId: $taxRegistrationId
      ) {
        companyLocation {
          id
          taxSettings {
            taxRegistrationId
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      companyLocationId,
      // Send null rather than "" so clearing the field actually unsets it.
      taxRegistrationId: taxRegistrationId.trim() === "" ? null : taxRegistrationId.trim(),
    }
  );

  if (response.errors?.length) {
    console.error("companyLocationTaxSettingsUpdate errors:", response.errors);
    return respond({ error: response.errors[0].message }, 500);
  }

  const result = response.data?.companyLocationTaxSettingsUpdate;

  if (result?.userErrors?.length) {
    return respond({ error: result.userErrors[0].message }, 400);
  }

  return respond({
    success: true,
    taxRegistrationId:
      result?.companyLocation?.taxSettings?.taxRegistrationId ?? null,
  });
};
