import type { ActionFunctionArgs } from "react-router";
import { authenticate, ensureKVNamespace } from "../shopify.server";
import { deleteAccessToken } from "../lib/shopify-client-credentials";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  ensureKVNamespace(context);
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Clean up cached access token for this shop
  await deleteAccessToken(shop, context);

  return new Response();
};
