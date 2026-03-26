import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Tax Exemption App">
      <s-section heading="Welcome">
        <s-paragraph>
          This app provides tax exemption certificate management for B2B
          customers through a customer account extension.
        </s-paragraph>
      </s-section>

      <s-section heading="How it works">
        <s-unordered-list>
          <s-list-item>
            Customers can upload tax exemption certificates from their account
          </s-list-item>
          <s-list-item>
            Certificates are stored securely and linked to customer profiles
          </s-list-item>
          <s-list-item>
            Staff can review and approve exemptions from the Shopify admin
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
