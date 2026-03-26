import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [loading, setLoading] = useState(true);
  const [taxData, setTaxData] = useState(null);
  const [error, setError] = useState(null);
  const [expirationValue, setExpirationValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Guard against shopify global not being available
  if (typeof shopify === "undefined") {
    return (
      <s-admin-block heading="Tax Exemption Information" collapsedSummary="Loading...">
        <s-spinner size="base" />
      </s-admin-block>
    );
  }

  const { data, query } = shopify;
  const customerId = data?.selected?.[0]?.id;

  useEffect(() => {
    if (!customerId) {
      setLoading(false);
      return;
    }

    async function fetchTaxExemptionData() {
      try {
        const result = await query(
          `query GetCustomerTaxExemption($id: ID!) {
            customer(id: $id) {
              taxExempt
              taxExemptionType: metafield(namespace: "$app", key: "tax_exemption_type") {
                value
              }
              taxExemptionCertificate: metafield(namespace: "$app", key: "tax_exemption_certificate") {
                value
                reference {
                  ... on GenericFile {
                    url
                  }
                }
              }
              taxExemptionAttestation: metafield(namespace: "$app", key: "tax_exemption_attestation") {
                value
              }
              taxExemptionExpiration: metafield(namespace: "$app", key: "tax_exemption_certification_expiration") {
                value
              }
            }
          }`,
          { variables: { id: customerId } },
        );

        if (result.errors) {
          console.error("GraphQL errors:", result.errors);
          setError("Failed to load tax exemption data");
        } else {
          const customer = result.data?.customer;
          if (customer) {
            // Extract filename from file URL if available
            let certificateFilename = null;
            let certificateUrl = null;
            const fileRef = customer.taxExemptionCertificate?.reference;
            if (fileRef?.url) {
              certificateUrl = fileRef.url;
              try {
                const url = new URL(fileRef.url);
                const pathParts = url.pathname.split("/");
                certificateFilename = decodeURIComponent(
                  pathParts[pathParts.length - 1],
                );
              } catch (e) {
                console.warn("Could not extract filename from URL:", e);
              }
            }

            const expiration = customer.taxExemptionExpiration?.value || null;
            setTaxData({
              type: customer.taxExemptionType?.value || null,
              certificate: customer.taxExemptionCertificate?.value || null,
              certificateFilename,
              certificateUrl,
              attestation: customer.taxExemptionAttestation?.value === "true",
              expiration,
              taxExempt: customer.taxExempt || false,
            });
            setExpirationValue(expiration || "");
          }
        }
      } catch (err) {
        console.error("Error fetching tax exemption data:", err);
        setError("Failed to load tax exemption data");
      } finally {
        setLoading(false);
      }
    }

    fetchTaxExemptionData();
  }, [customerId]);

  // Determine if a date is in the future (or today)
  const isDateInFuture = (dateString) => {
    if (!dateString) return false;
    const expirationDate = new Date(dateString);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return expirationDate >= today;
  };

  // Save expiration date and update customer tax exempt status
  const handleSaveExpiration = async () => {
    if (!customerId) return;

    setSaving(true);
    setSaveError(null);

    // Determine tax exempt status based on expiration date
    const shouldBeTaxExempt = isDateInFuture(expirationValue);

    try {
      // Update the expiration metafield
      const metafieldResult = await query(
        `mutation SetCustomerExpirationDate($metafields: [MetafieldsSetInput!]!) {
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
          variables: {
            metafields: [
              {
                ownerId: customerId,
                namespace: "$app",
                key: "tax_exemption_certification_expiration",
                type: "date",
                value: expirationValue || "",
              },
            ],
          },
        },
      );

      if (
        metafieldResult.errors ||
        metafieldResult.data?.metafieldsSet?.userErrors?.length > 0
      ) {
        const errorMsg =
          metafieldResult.errors?.[0]?.message ||
          metafieldResult.data?.metafieldsSet?.userErrors?.[0]?.message ||
          "Failed to save expiration date";
        setSaveError(errorMsg);
        return;
      }

      // Update the customer's tax exempt status
      const customerResult = await query(
        `mutation UpdateCustomerTaxExempt($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
              taxExempt
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id: customerId,
              taxExempt: shouldBeTaxExempt,
            },
          },
        },
      );

      if (
        customerResult.errors ||
        customerResult.data?.customerUpdate?.userErrors?.length > 0
      ) {
        const errorMsg =
          customerResult.errors?.[0]?.message ||
          customerResult.data?.customerUpdate?.userErrors?.[0]?.message ||
          "Failed to update tax exempt status";
        setSaveError(errorMsg);
        return;
      }

      // Update local state
      setTaxData((prev) => ({
        ...prev,
        expiration: expirationValue || null,
        taxExempt: shouldBeTaxExempt,
      }));
    } catch (err) {
      console.error("Error saving expiration:", err);
      setSaveError("Failed to save expiration date");
    } finally {
      setSaving(false);
    }
  };

  // Check if expiration has changed
  const expirationChanged = expirationValue !== (taxData?.expiration || "");

  // Determine if any field has been set
  const hasAnyFieldSet =
    taxData &&
    (!!taxData.type ||
      !!taxData.certificate ||
      !!taxData.attestation ||
      !!taxData.expiration);

  // Determine status based on expiration date and tax exempt flag
  const getStatus = () => {
    if (!taxData?.expiration) {
      return { label: "Under Review", tone: "warning" };
    }
    const isExpired = !isDateInFuture(taxData.expiration);
    if (isExpired) {
      // Expired - show critical if still tax exempt (needs attention)
      if (taxData.taxExempt) {
        return { label: "Expired", tone: "critical" };
      }
      return { label: "Expired", tone: "warning" };
    }
    return { label: "Approved", tone: "success" };
  };

  const status = hasAnyFieldSet ? getStatus() : null;

  // Generate collapsed summary
  const getCollapsedSummary = () => {
    if (!hasAnyFieldSet) {
      return "No tax exemption documentation provided";
    }
    return `Status: ${status.label}`;
  };

  if (loading) {
    return (
      <s-admin-block
        heading="Tax Exemption Information"
        collapsedSummary="Loading..."
      >
        <s-stack direction="block" gap="base">
          <s-spinner size="base" />
        </s-stack>
      </s-admin-block>
    );
  }

  if (error) {
    return (
      <s-admin-block
        heading="Tax Exemption Information"
        collapsedSummary="Error loading data"
      >
        <s-banner tone="critical">{error}</s-banner>
      </s-admin-block>
    );
  }

  return (
    <s-admin-block
      heading="Tax Exemption Information"
      collapsedSummary={getCollapsedSummary()}
    >
      {hasAnyFieldSet ? (
        <s-grid
          gridTemplateColumns="100px 1fr"
          gridTemplateRows="36px 36px 36px 36px 36px"
          alignItems="center"
        >
          <s-grid-item>
            <s-text color="subdued">Status:</s-text>
          </s-grid-item>
          <s-grid-item>
            {status.tone === "success" && (
              <s-badge tone="success">{status.label}</s-badge>
            )}
            {status.tone === "warning" && (
              <s-badge tone="warning">{status.label}</s-badge>
            )}
            {status.tone === "critical" && (
              <s-badge tone="critical">{status.label}</s-badge>
            )}
          </s-grid-item>

          <s-grid-item>
            <s-text color="subdued">Type:</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-text>{taxData?.type || "Not set"}</s-text>
          </s-grid-item>

          <s-grid-item>
            <s-text color="subdued">Certificate:</s-text>
          </s-grid-item>
          <s-grid-item>
            {taxData?.certificate ? (
              taxData.certificateUrl ? (
                <s-link href={taxData.certificateUrl} target="_blank">
                  {taxData.certificateFilename || "View"}
                </s-link>
              ) : (
                <s-text>{taxData.certificateFilename || "Uploaded"}</s-text>
              )
            ) : (
              <s-text>Not uploaded</s-text>
            )}
          </s-grid-item>

          <s-grid-item>
            <s-text color="subdued">Attestation:</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-text>{taxData?.attestation ? "Yes" : "No"}</s-text>
          </s-grid-item>

          <s-grid-item>
            <s-text color="subdued">Expiration:</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-date-field
                label="Expiration"
                labelAccessibilityVisibility="exclusive"
                value={expirationValue}
                onChange={(e) => setExpirationValue(e.currentTarget.value)}
              />
              {expirationChanged && (
                <s-button
                  variant="primary"
                  loading={saving}
                  onClick={handleSaveExpiration}
                >
                  Save
                </s-button>
              )}
            </s-stack>
            {saveError && <s-banner tone="critical">{saveError}</s-banner>}
          </s-grid-item>
        </s-grid>
      ) : (
        <s-text color="subdued">No tax exemption documentation provided</s-text>
      )}
    </s-admin-block>
  );
}
