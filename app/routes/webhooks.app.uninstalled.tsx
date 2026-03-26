import type { ActionFunctionArgs } from "react-router";
import { authenticate, ensureKVNamespace } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  ensureKVNamespace(context);
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
