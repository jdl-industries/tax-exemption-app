# Tax Exemption App - Development Notes

## Overview

This Shopify app allows customers to submit tax exemption documentation through a customer account UI extension, and merchants to review/approve exemptions through an admin block extension.

## Architecture

### Customer-Facing Extension
- **Location**: `extensions/tax-exemption-block/`
- **Target**: Customer account profile page
- **Features**:
  - Upload tax exemption certificate (file)
  - Select exemption type
  - Attestation checkbox
  - Displays current exemption status

### Admin Extension
- **Location**: `extensions/admin-customer-block/`
- **Target**: `admin.customer-details.block.render`
- **Features**:
  - Displays customer's tax exemption data (type, certificate link, attestation, expiration)
  - Editable expiration date field
  - When merchant saves expiration date:
    - Updates the `tax_exemption_certification_expiration` metafield
    - Automatically sets customer's `taxExempt` flag based on whether date is in the future
  - Status badge showing: Approved (green), Under Review (yellow), Expired (yellow/red)

### Backend
- **Location**: `app/` (Cloudflare Workers + React Router)
- **Key files**:
  - `app/lib/shopify-client-credentials.ts` - Client Credentials Grant auth with KV caching and auto-retry on 401/403
  - `app/routes/webhooks.app.uninstalled.tsx` - Clears cached tokens on app uninstall
  - `app/routes/api.staged-uploads.tsx` - Handles file upload staging
  - `app/routes/api.save-metafields.tsx` - Saves customer metafields

### Metafields Used (namespace: `$app`)
| Key | Type | Description |
|-----|------|-------------|
| `tax_exemption_type` | single_line_text | Type of exemption (e.g., "Resale", "Non-profit") |
| `tax_exemption_certificate` | file_reference | Uploaded certificate file |
| `tax_exemption_attestation` | boolean | Customer attestation |
| `tax_exemption_certification_expiration` | date | Expiration date (set by merchant) |

## Recent Session Work

### Completed Features

1. **Admin Block Extension** (`extensions/admin-customer-block/src/CustomerAdminBlock.jsx`):
   - Displays tax exemption data in a grid layout
   - Certificate filename is a clickable link to view/download
   - Editable expiration date field with Save button
   - Saves expiration AND updates customer `taxExempt` status automatically
   - Status logic: future date = tax exempt, past date = not tax exempt

2. **Status Badge Logic** (in progress when session ended):
   - Approved (green): expiration date is in the future
   - Under Review (yellow): no expiration date set
   - Expired (yellow): expiration in past, customer NOT tax exempt
   - Expired (red/critical): expiration in past but customer IS still tax exempt (needs attention)

3. **Token Management**:
   - Client Credentials Grant for server-to-server API calls
   - KV caching with automatic refresh
   - Webhook clears token on app uninstall
   - Auto-retry on 401/403 errors

### Current Issue

After adding the status badge logic, the admin extension shows error:
```
TypeError: Cannot destructure property 'data' of 'shopify' as it is undefined
```

This suggests a timing issue with the `shopify` global. A guard was added but may need further investigation. Try:
1. Restart dev server
2. Hard refresh the admin page
3. Check browser console for build errors

### Key Code Sections

**Status determination logic** (CustomerAdminBlock.jsx lines 223-237):
```javascript
const getStatus = () => {
  if (!taxData?.expiration) {
    return { label: "Under Review", tone: "warning" };
  }
  const isExpired = !isDateInFuture(taxData.expiration);
  if (isExpired) {
    if (taxData.taxExempt) {
      return { label: "Expired", tone: "critical" };
    }
    return { label: "Expired", tone: "warning" };
  }
  return { label: "Approved", tone: "success" };
};
```

**Save handler** updates both metafield and customer taxExempt status:
```javascript
// In handleSaveExpiration:
// 1. Save expiration metafield via metafieldsSet mutation
// 2. Update customer.taxExempt via customerUpdate mutation
// 3. Update local state
```

## GraphQL Queries/Mutations Used

### Fetch customer data (admin extension)
```graphql
query GetCustomerTaxExemption($id: ID!) {
  customer(id: $id) {
    taxExempt
    taxExemptionType: metafield(namespace: "$app", key: "tax_exemption_type") { value }
    taxExemptionCertificate: metafield(namespace: "$app", key: "tax_exemption_certificate") {
      value
      reference { ... on GenericFile { url } }
    }
    taxExemptionAttestation: metafield(namespace: "$app", key: "tax_exemption_attestation") { value }
    taxExemptionExpiration: metafield(namespace: "$app", key: "tax_exemption_certification_expiration") { value }
  }
}
```

### Update customer tax exempt status
```graphql
mutation UpdateCustomerTaxExempt($input: CustomerInput!) {
  customerUpdate(input: $input) {
    customer { id taxExempt }
    userErrors { field message }
  }
}
```

## Next Steps

1. Debug the `shopify is undefined` error in admin extension
2. Test the full flow: customer submits docs -> merchant sets expiration -> customer becomes tax exempt
3. Verify expired status turns red when taxExempt is true but date is past
4. Consider adding a way to refresh the admin page after saving (not currently possible from extension sandbox)

## File Locations

```
extensions/
  admin-customer-block/
    src/CustomerAdminBlock.jsx    # Admin block extension
    shopify.extension.toml        # Extension config with metafield access
  tax-exemption-block/
    src/TaxExemptionBlock.jsx     # Customer-facing extension
    locales/en.default.json       # Translations

app/
  lib/shopify-client-credentials.ts  # Auth token management
  routes/
    api.staged-uploads.tsx        # File upload endpoint
    api.save-metafields.tsx       # Save metafields endpoint
    webhooks.app.uninstalled.tsx  # Cleanup on uninstall
```
