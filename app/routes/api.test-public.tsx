import type { LoaderFunctionArgs } from "react-router";
import { getAdminClient } from "../lib/shopify-client-credentials";

/**
 * Test endpoint using Client Credentials Grant for server-to-server API access.
 * No user session required - authenticates directly with Shopify using app credentials.
 * Access token is cached in KV for up to 23 hours.
 */
export const loader = async ({ context }: LoaderFunctionArgs) => {
  const shopDomain = "mike-robinson-demo-store.myshopify.com";

  try {
    // Get admin client using Client Credentials (with caching)
    const admin = await getAdminClient(shopDomain, context);

    // Make a simple GraphQL query
    const result = await admin.graphql<{
      products: {
        nodes: Array<{ id: string; title: string }>;
      };
    }>(`
      query GetFirstProduct {
        products(first: 1) {
          nodes {
            id
            title
          }
        }
      }
    `);

    const product = result.data?.products?.nodes?.[0];

    return Response.json({
      success: true,
      product: product || null,
    });
  } catch (error) {
    console.error("Error in test-public endpoint:", error);
    return Response.json(
      { error: "Internal server error", message: String(error) },
      { status: 500 }
    );
  }
};
