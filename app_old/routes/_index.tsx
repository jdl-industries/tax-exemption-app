import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Redirect to /app if accessed directly
  if (url.searchParams.has("shop")) {
    return redirect(`/app${url.search}`);
  }
  return redirect("/auth/login");
};
