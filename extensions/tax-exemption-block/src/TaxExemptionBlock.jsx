// @ts-nocheck
import { render } from "preact";
import { useState, useRef } from "preact/hooks";

// Configuration
const WORKER_URL =
  "https://jdl-tax-exemption-backend.mikerrobinson236.workers.dev";
const METAFIELD_NAMESPACE = "app--330609819649--tax_exemption";

export default async () => {
  const {
    customerId,
    taxExemptionType,
    taxExemptionCertificate,
    taxExemptionAttestation,
    taxExemptionExpiration,
  } = await getCustomerPreferences();

  render(
    <ProfilePreferenceExtension
      customerId={customerId}
      taxExemptionType={taxExemptionType}
      taxExemptionCertificate={taxExemptionCertificate}
      taxExemptionAttestation={taxExemptionAttestation}
      taxExemptionExpiration={taxExemptionExpiration}
    />,
    document.body,
  );
};

function ProfilePreferenceExtension(props) {
  const { i18n } = shopify;
  const modalRef = useRef();
  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // null | 'uploading' | 'success' | 'error'
  const [uploadError, setUploadError] = useState(null);
  const [taxExemptionCertificate, setTaxExemptionCertificate] = useState(
    props.taxExemptionCertificate ?? null,
  );
  const [taxExemptionType, setTaxExemptionType] = useState(
    props.taxExemptionType ?? "",
  );
  const [taxExemptionAttestation, setTaxExemptionAttestation] = useState(
    props.taxExemptionAttestation ?? false,
  );

  // Form state for modal
  const [newTaxExemptionType, setNewTaxExemptionType] =
    useState(taxExemptionType);
  const [newTaxExemptionAttestation, setNewTaxExemptionAttestation] = useState(
    taxExemptionAttestation,
  );
  const [pendingCertificateUrl, setPendingCertificateUrl] = useState(null);

  // Show exempt view if any field has been set
  const hasAnyFieldSet =
    !!taxExemptionType ||
    !!taxExemptionCertificate ||
    !!taxExemptionAttestation ||
    !!props.taxExemptionExpiration;
  const showExemptView = hasAnyFieldSet;

  // Determine status: Approved if expiration date is set (staff reviewed), otherwise Under Review
  const getStatus = () => {
    if (props.taxExemptionExpiration) {
      return "Approved";
    }
    if (hasAnyFieldSet) {
      return "Under Review";
    }
    return null;
  };
  const status = getStatus();

  // Handle file selection from drop-zone
  const handleFileChange = async (event) => {
    const files = event.target.files || event.currentTarget.files;
    if (!files || files.length === 0) {
      console.log("No files selected");
      return;
    }

    const file = files[0];
    console.log("File selected:", file.name, file.type, file.size);

    setUploadStatus("uploading");
    setUploadError(null);

    try {
      // Get session token for authentication
      const sessionToken = await shopify.sessionToken.get();
      console.log("Got session token");

      // Step 1: Get staged upload URL from worker
      const stagedUploadResponse = await fetch(
        `${WORKER_URL}/b2b/staged-upload-url`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            fileSize: file.size,
          }),
        },
      );

      if (!stagedUploadResponse.ok) {
        const errorData = await stagedUploadResponse.json();
        throw new Error(errorData.error || "Failed to get upload URL");
      }

      const { url, resourceUrl, parameters } =
        await stagedUploadResponse.json();
      console.log("Got staged upload URL:", url);

      // Step 2: Upload file directly to Shopify's presigned URL
      const formData = new FormData();
      // Add all the presigned URL parameters first
      for (const param of parameters) {
        formData.append(param.name, param.value);
      }
      // Add the file last
      formData.append("file", file);

      const uploadResponse = await fetch(url, {
        method: "POST",
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error(`File upload failed: ${uploadResponse.status}`);
      }
      console.log("File uploaded to Shopify");

      // Step 3: Save the file reference metafield via worker
      const metafieldResponse = await fetch(
        `${WORKER_URL}/b2b/customer-metafields`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            customerId: props.customerId,
            namespace: METAFIELD_NAMESPACE,
            metafieldKey: "tax_exemption_certificate",
            resourceUrl: resourceUrl,
          }),
        },
      );

      if (!metafieldResponse.ok) {
        const errorData = await metafieldResponse.json();
        throw new Error(errorData.error || "Failed to save file reference");
      }

      console.log("File reference saved to metafield");

      // Update state
      setPendingCertificateUrl(resourceUrl);
      setTaxExemptionCertificate(resourceUrl);
      setUploadStatus("success");
    } catch (error) {
      console.error("File upload error:", error);
      setUploadError(error.message);
      setUploadStatus("error");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { type, attestation } = await saveCustomerPreferences(
      props.customerId,
      newTaxExemptionType,
      newTaxExemptionAttestation,
    );
    // Update display state
    setTaxExemptionType(type);
    setTaxExemptionAttestation(attestation);
    // Sync form state with saved values
    setNewTaxExemptionType(type);
    setNewTaxExemptionAttestation(attestation);
    setLoading(false);
    modalRef.current?.hideOverlay?.() || modalRef.current?.hide?.();
  };

  const handleCancel = () => {
    // Reset form state and close modal
    setNewTaxExemptionType(taxExemptionType);
    setNewTaxExemptionAttestation(taxExemptionAttestation);
    setUploadStatus(null);
    setUploadError(null);
    modalRef.current?.hideOverlay?.() || modalRef.current?.hide?.();
  };

  return (
    <>
      <s-section>
        <s-stack direction="block" gap="large-200">
          <s-heading>
            <s-stack direction="inline" gap="small-100">
              <s-text>{i18n.translate("preferenceCard.heading")}</s-text>
              {showExemptView && (
                <s-link
                  aria-label={i18n.translate("preferenceCard.edit")}
                  command="--show"
                  commandFor="profile-preference-modal"
                >
                  <s-icon type="edit" size="small" />
                </s-link>
              )}
            </s-stack>
          </s-heading>

          {!showExemptView ? (
            /* Non-exempt state: show button to request exemption */
            <s-stack direction="block" gap="small-500">
              <s-button
                variant="secondary"
                disabled={loading}
                loading={loading}
                command="--show"
                icon="money"
                commandFor="profile-preference-modal"
              >
                Provide tax exemption documentation
              </s-button>
            </s-stack>
          ) : (
            /* Exempt state: show all fields */
            <>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Status</s-text>
                <s-text>{status}</s-text>
              </s-stack>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Tax exemption type</s-text>
                <s-text>{taxExemptionType || "Not set"}</s-text>
              </s-stack>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Certificate</s-text>
                <s-text>
                  {taxExemptionCertificate ? "Uploaded" : "Not uploaded"}
                </s-text>
              </s-stack>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Attestation</s-text>
                <s-text>{taxExemptionAttestation ? "Yes" : "No"}</s-text>
              </s-stack>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">Expiration</s-text>
                <s-text>{props.taxExemptionExpiration || "Not set"}</s-text>
              </s-stack>
            </>
          )}
        </s-stack>
      </s-section>

      <s-modal
        id="profile-preference-modal"
        ref={modalRef}
        heading={i18n.translate("preferenceCard.modalHeading")}
      >
        <s-form onSubmit={handleSubmit}>
          <s-stack direction="block" gap="large">
            <s-stack direction="block" gap="base">
              <s-select
                label="Tax exemption type"
                value={newTaxExemptionType}
                onChange={(e) => setNewTaxExemptionType(e.target.value)}
              >
                <s-option value="">Select a type...</s-option>
                <s-option value="Resale">Resale</s-option>
                <s-option value="Government/Military">
                  Government/Military
                </s-option>
                <s-option value="Manufacturing/Industrial">
                  Manufacturing/Industrial
                </s-option>
                <s-option value="Other">Other</s-option>
              </s-select>

              <s-drop-zone
                label="Tax exemption certificate"
                accessibilityLabel="Upload PDF, JPG, PNG, or GIF file"
                accept=".pdf,.jpg,.jpeg,.png,.gif"
                disabled={uploadStatus === "uploading"}
                onChange={handleFileChange}
              />

              {uploadStatus === "uploading" && (
                <s-text color="subdued">Uploading certificate...</s-text>
              )}
              {uploadStatus === "success" && (
                <s-text color="success">
                  Certificate uploaded successfully
                </s-text>
              )}
              {uploadStatus === "error" && (
                <s-text color="critical">Upload failed: {uploadError}</s-text>
              )}

              <s-checkbox
                checked={newTaxExemptionAttestation}
                label="By uploading this document, you certify that the certificate is valid, unexpired, and covers the jurisdiction(s) of your shipping address. All certificates are subject to manual review before tax-exempt status is granted."
                onChange={(e) =>
                  setNewTaxExemptionAttestation(e.target.checked)
                }
              />
            </s-stack>

            <s-stack direction="inline" gap="base" justifyContent="end">
              <s-button
                slot="secondary-actions"
                variant="secondary"
                disabled={loading || uploadStatus === "uploading"}
                onClick={handleCancel}
              >
                {i18n.translate("preferenceCard.cancel")}
              </s-button>
              <s-button
                slot="primary-action"
                type="submit"
                variant="primary"
                loading={loading}
                disabled={uploadStatus === "uploading"}
              >
                {i18n.translate("preferenceCard.save")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-form>
      </s-modal>
    </>
  );
}

async function getCustomerPreferences() {
  const response = await fetch(
    "shopify:customer-account/api/2026-01/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query preferences {
          customer {
            id
            taxExemptionType: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "tax_exemption_type") {
              value
            }
            taxExemptionCertificate: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "tax_exemption_certificate") {
              value
            }
            taxExemptionAttestation: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "tax_exemption_attestation") {
              value
            }
            taxExemptionExpiration: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "tax_exemption_certification_expiration") {
              value
            }
          }
        }`,
      }),
    },
  );

  const json = await response.json();
  console.log("Customer Account API response:", JSON.stringify(json, null, 2));

  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }

  const data = json.data;
  if (!data?.customer) {
    console.error("No customer data returned");
    return {
      customerId: null,
      taxExemptionType: null,
      taxExemptionCertificate: null,
      taxExemptionAttestation: false,
      taxExemptionExpiration: null,
    };
  }

  return {
    customerId: data.customer.id,
    taxExemptionType: data.customer.taxExemptionType?.value,
    taxExemptionCertificate: data.customer.taxExemptionCertificate?.value,
    taxExemptionAttestation:
      data.customer.taxExemptionAttestation?.value === "true",
    taxExemptionExpiration: data.customer.taxExemptionExpiration?.value,
  };
}

async function saveCustomerPreferences(
  customerId,
  taxExemptionType,
  taxExemptionAttestation,
) {
  const response = await fetch(
    "shopify:customer-account/api/2026-01/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation savePreferences($metafields: [MetafieldsSetInput!]!) {
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
        variables: {
          metafields: [
            {
              key: "tax_exemption_type",
              namespace: METAFIELD_NAMESPACE,
              type: "single_line_text_field",
              ownerId: customerId,
              value: taxExemptionType ?? "",
            },
            {
              key: "tax_exemption_attestation",
              namespace: METAFIELD_NAMESPACE,
              type: "boolean",
              ownerId: customerId,
              value: taxExemptionAttestation ? "true" : "false",
            },
          ],
        },
      }),
    },
  );

  const json = await response.json();
  console.log("Save preferences response:", JSON.stringify(json, null, 2));

  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
  }

  const metafields = json.data?.metafieldsSet?.metafields || [];
  const typeField = metafields.find((m) => m.key === "tax_exemption_type");
  const attestationField = metafields.find(
    (m) => m.key === "tax_exemption_attestation",
  );

  return {
    type: typeField?.value ?? "",
    attestation: attestationField?.value === "true",
  };
}
