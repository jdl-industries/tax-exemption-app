import type { ActionFunctionArgs } from "react-router";
import { authenticate, ensureKVNamespace } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  ensureKVNamespace(context);
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  return new Response();
};
