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

  // The shopify global isn't guaranteed to exist on the first render. Resolve
  // it to null rather than returning early here: an early return placed between
  // hook calls changes hook order between renders, which is what
  // react-hooks/rules-of-hooks flags. The fallback render happens after every
  // hook has run.
  const shopifyApi = typeof shopify === "undefined" ? null : shopify;
  const companyLocationId = shopifyApi?.data?.selected?.[0]?.id;

  useEffect(() => {
    if (!shopifyApi || !companyLocationId) {
      setLoading(false);
      return;
    }

    async function fetchTaxExemptionData() {
      try {
        const result = await shopifyApi.query(
          `query GetCompanyLocationTaxExemption($id: ID!) {
            companyLocation(id: $id) {
              id
              name
              taxSettings {
                taxExempt
                taxRegistrationId
              }
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
          { variables: { id: companyLocationId } },
        );

        if (result.errors) {
          console.error("GraphQL errors:", result.errors);
          setError("Failed to load tax exemption data");
        } else {
          const location = result.data?.companyLocation;
          if (location) {
            // Extract filename from file URL if available
            let certificateFilename = null;
            let certificateUrl = null;
            const fileRef = location.taxExemptionCertificate?.reference;
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

            const expiration = location.taxExemptionExpiration?.value || null;
            setTaxData({
              type: location.taxExemptionType?.value || null,
              certificate: location.taxExemptionCertificate?.value || null,
              certificateFilename,
              certificateUrl,
              attestation: location.taxExemptionAttestation?.value === "true",
              expiration,
              taxExempt: location.taxSettings?.taxExempt || false,
              taxRegistrationId: location.taxSettings?.taxRegistrationId || null,
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
  }, [shopifyApi, companyLocationId]);

  // Determine if a date is in the future (or today)
  const isDateInFuture = (dateString) => {
    if (!dateString) return false;
    const expirationDate = new Date(dateString);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return expirationDate >= today;
  };

  // Save expiration date and update the location's tax settings.
  //
  // Approving (an expiration date in the future) also flips the location's tax
  // settings to "Don't collect tax" so the exemption actually takes effect at
  // checkout; clearing or back-dating it re-enables tax collection.
  const handleSaveExpiration = async () => {
    if (!shopifyApi || !companyLocationId) return;

    setSaving(true);
    setSaveError(null);

    const shouldBeTaxExempt = isDateInFuture(expirationValue);

    try {
      // Update the expiration metafield
      const metafieldResult = await shopifyApi.query(
        `mutation SetLocationExpirationDate($metafields: [MetafieldsSetInput!]!) {
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
                ownerId: companyLocationId,
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

      // Update the location's tax settings to match
      const taxSettingsResult = await shopifyApi.query(
        `mutation UpdateLocationTaxSettings($companyLocationId: ID!, $taxExempt: Boolean) {
          companyLocationTaxSettingsUpdate(
            companyLocationId: $companyLocationId
            taxExempt: $taxExempt
          ) {
            companyLocation {
              id
              taxSettings {
                taxExempt
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            companyLocationId,
            taxExempt: shouldBeTaxExempt,
          },
        },
      );

      if (
        taxSettingsResult.errors ||
        taxSettingsResult.data?.companyLocationTaxSettingsUpdate?.userErrors
          ?.length > 0
      ) {
        const errorMsg =
          taxSettingsResult.errors?.[0]?.message ||
          taxSettingsResult.data?.companyLocationTaxSettingsUpdate
            ?.userErrors?.[0]?.message ||
          "Failed to update tax settings";
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

  // Determine status based on expiration date and the location's tax settings
  const getStatus = () => {
    if (!taxData?.expiration) {
      return { label: "Under Review", tone: "warning" };
    }
    const isExpired = !isDateInFuture(taxData.expiration);
    if (isExpired) {
      // Expired - show critical if the location is still exempt (needs attention)
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

  if (!shopifyApi || loading) {
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
        /* Seven rows: status, tax collection, tax ID, type, certificate,
           attestation, expiration. The expiration row is auto-height because
           it holds the date field, save button and helper text. */
        <s-grid
          gridTemplateColumns="140px 1fr"
          gridTemplateRows="36px 36px 36px 36px 36px 36px auto"
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
            <s-text color="subdued">Tax collection:</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-text>
              {taxData?.taxExempt ? "Don't collect tax" : "Collect tax"}
            </s-text>
          </s-grid-item>

          <s-grid-item>
            <s-text color="subdued">Tax ID:</s-text>
          </s-grid-item>
          <s-grid-item>
            <s-text>{taxData?.taxRegistrationId || "Not set"}</s-text>
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
            {expirationChanged && (
              <s-text color="subdued">
                {isDateInFuture(expirationValue)
                  ? "Saving will approve the exemption and stop collecting tax for this location."
                  : "Saving will resume collecting tax for this location."}
              </s-text>
            )}
            {saveError && <s-banner tone="critical">{saveError}</s-banner>}
          </s-grid-item>
        </s-grid>
      ) : (
        <s-text color="subdued">No tax exemption documentation provided</s-text>
      )}
    </s-admin-block>
  );
}
