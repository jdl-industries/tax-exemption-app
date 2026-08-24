import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/CompanyLocationAdminBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.company-location-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
