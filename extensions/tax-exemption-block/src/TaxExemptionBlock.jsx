// @ts-nocheck
import { render } from "preact";
import { useState, useRef } from "preact/hooks";

const WORKER_URL = "https://tax-exemption-service.jdlindustries.workers.dev";

export default async () => {
  const {
    customerId,
    taxExemptionType,
    taxExemptionCertificate,
    certificateFilename,
    certificateUrl,
    taxExemptionAttestation,
    taxExemptionExpiration,
  } = await getTaxExemptionFields();

  render(
    <TaxExemptionBlock
      customerId={customerId}
      taxExemptionType={taxExemptionType}
      taxExemptionCertificate={taxExemptionCertificate}
      certificateFilename={certificateFilename}
      certificateUrl={certificateUrl}
      taxExemptionAttestation={taxExemptionAttestation}
      taxExemptionExpiration={taxExemptionExpiration}
    />,
    document.body,
  );
};

function TaxExemptionBlock(props) {
  const { i18n } = shopify;
  const modalRef = useRef();
  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // null | 'uploading' | 'success' | 'error'
  const [uploadError, setUploadError] = useState(null);
  const [taxExemptionCertificate, setTaxExemptionCertificate] = useState(
    props.taxExemptionCertificate ?? null,
  );
  const [certificateFilename, setCertificateFilename] = useState(
    props.certificateFilename ?? null,
  );
  const [certificateUrl, setCertificateUrl] = useState(
    props.certificateUrl ?? null,
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
    props.taxExemptionAttestation ?? false,
  );
  const [pendingFile, setPendingFile] = useState(null); // File object waiting to be uploaded on Save

  // Determine if a certificate exists (either saved or pending selection)
  const hasCertificate = !!taxExemptionCertificate || !!pendingFile;
  const displayFilename = pendingFile?.name || certificateFilename;

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

  // Handle file selection from drop-zone - just store the file, don't upload yet
  const handleFileChange = (event) => {
    const files = event.target.files || event.currentTarget.files;
    if (!files || files.length === 0) {
      console.log("No files selected");
      return;
    }

    const file = files[0];
    console.log("File selected:", file.name, file.type, file.size);

    // Store the file for upload on Save
    setPendingFile(file);
    setUploadStatus(null);
    setUploadError(null);
  };

  // Upload file to Shopify and save metafield reference
  const uploadCertificate = async (file) => {
    const sessionToken = await shopify.sessionToken.get();
    console.log("Got session token");

    // Step 1: Get staged upload URL from worker
    const stagedUploadResponse = await fetch(
      `${WORKER_URL}/api/b2b/staged-upload-url`,
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
    for (const param of parameters) {
      formData.append(param.name, param.value);
    }
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
      `${WORKER_URL}/api/b2b/customer-metafields`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          customerId: props.customerId,
          namespace: "$app",
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
    return file.name;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Validate: must have certificate (existing or pending) and attestation checked
    if (!hasCertificate || !newTaxExemptionAttestation) {
      return;
    }

    setLoading(true);
    setUploadStatus(null);
    setUploadError(null);

    try {
      // Upload pending file if there is one
      let uploadedFilename = certificateFilename;
      if (pendingFile) {
        setUploadStatus("uploading");
        uploadedFilename = await uploadCertificate(pendingFile);
        setTaxExemptionCertificate("uploaded"); // Mark as having a certificate
        setCertificateFilename(uploadedFilename);
        setUploadStatus("success");
      }

      // Save type and attestation metafields
      const { type, attestation } = await saveTaxExemptionFields(
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
      // Clear pending file
      setPendingFile(null);

      setLoading(false);
      modalRef.current?.hideOverlay?.() || modalRef.current?.hide?.();
    } catch (error) {
      console.error("Save error:", error);
      setUploadError(error.message);
      setUploadStatus("error");
      setLoading(false);
    }
  };

  const handleCancel = () => {
    // Reset form state and close modal
    setNewTaxExemptionType(taxExemptionType);
    setNewTaxExemptionAttestation(taxExemptionAttestation);
    setUploadStatus(null);
    setUploadError(null);
    setPendingFile(null);
    modalRef.current?.hideOverlay?.() || modalRef.current?.hide?.();
  };

  return (
    <>
      <s-section>
        <s-stack direction="block" gap="large-200">
          <s-heading>
            <s-stack direction="inline" gap="large-300">
              <s-text>{i18n.translate("taxExemptionCard.heading")}</s-text>
              {showExemptView ? (
                <s-clickable
                  aria-label={i18n.translate("taxExemptionCard.edit")}
                  command="--show"
                  commandFor="profile-preference-modal"
                >
                  <s-text tone="custom">
                    <s-icon type="edit" size="small" />
                  </s-text>
                </s-clickable>
              ) : (
                <s-clickable
                  command="--show"
                  commandFor="profile-preference-modal"
                >
                  <s-text tone="custom">
                    + {i18n.translate("taxExemptionCard.add")}
                  </s-text>
                </s-clickable>
              )}
            </s-stack>
          </s-heading>

          {showExemptView ? (
            /* Exempt state: show all fields */
            <>
              <s-stack direction="block">
                <s-text color="subdued">
                  {i18n.translate("taxExemptionCard.statusLabel")}
                </s-text>
                <s-text>{status}</s-text>
              </s-stack>
              <s-stack direction="block">
                <s-text color="subdued">
                  {i18n.translate("taxExemptionCard.typeLabel")}
                </s-text>
                <s-text>
                  {taxExemptionType ||
                    i18n.translate("taxExemptionCard.notSet")}
                </s-text>
              </s-stack>
              <s-stack direction="block">
                <s-text color="subdued">
                  {i18n.translate("taxExemptionCard.certificateLabel")}
                </s-text>
                {taxExemptionCertificate ? (
                  certificateUrl ? (
                    <s-link href={certificateUrl} target="_blank">
                      {displayFilename || i18n.translate("taxExemptionCard.uploaded")}
                    </s-link>
                  ) : (
                    <s-text>
                      {displayFilename || i18n.translate("taxExemptionCard.uploaded")}
                    </s-text>
                  )
                ) : (
                  <s-text>{i18n.translate("taxExemptionCard.notUploaded")}</s-text>
                )}
              </s-stack>
              <s-stack direction="block">
                <s-text color="subdued">
                  {i18n.translate("taxExemptionCard.expirationLabel")}
                </s-text>
                <s-text>
                  {props.taxExemptionExpiration ||
                    i18n.translate("taxExemptionCard.notSet")}
                </s-text>
              </s-stack>
            </>
          ) : (
            /* Empty state: show placeholder matching addresses section style */
            <>
              <s-stack
                background="subdued"
                borderRadius="base"
                borderWidth="base"
                padding="large-100"
                direction="inline"
                gap="base"
              >
                <s-icon type="info" />
                <s-paragraph>
                  {i18n.translate("taxExemptionCard.noExemptionInfo")}
                </s-paragraph>
              </s-stack>
            </>
          )}
        </s-stack>
      </s-section>

      <s-modal
        id="profile-preference-modal"
        ref={modalRef}
        heading={i18n.translate("taxExemptionCard.modalHeading")}
      >
        <s-form onSubmit={handleSubmit}>
          <s-stack direction="block" gap="large">
            <s-stack direction="block" gap="base">
              <s-select
                label={i18n.translate("taxExemptionCard.typeLabel")}
                value={newTaxExemptionType}
                onChange={(e) => setNewTaxExemptionType(e.target.value)}
              >
                <s-option value="">
                  {i18n.translate("taxExemptionCard.selectType")}
                </s-option>
                <s-option value="Resale">
                  {i18n.translate("taxExemptionCard.resale")}
                </s-option>
                <s-option value="Government/Military">
                  {i18n.translate("taxExemptionCard.governmentMilitary")}
                </s-option>
                <s-option value="Manufacturing/Industrial">
                  {i18n.translate("taxExemptionCard.manufacturingIndustrial")}
                </s-option>
                <s-option value="Other">
                  {i18n.translate("taxExemptionCard.other")}
                </s-option>
              </s-select>

              <s-stack direction="block" gap="small">
                <s-text color="subdued">
                  {i18n.translate("taxExemptionCard.certificateLabel")}
                </s-text>
                {displayFilename && (
                  <s-text>{displayFilename}</s-text>
                )}
              </s-stack>

              <s-drop-zone
                label={hasCertificate
                  ? i18n.translate("taxExemptionCard.updateFile")
                  : i18n.translate("taxExemptionCard.addFile")
                }
                accessibilityLabel={i18n.translate(
                  "taxExemptionCard.certificateLabel",
                )}
                accept=".pdf,.jpg,.jpeg,.png,.gif"
                disabled={loading}
                onChange={handleFileChange}
              />

              {uploadStatus === "uploading" && (
                <s-text color="subdued">
                  {i18n.translate("taxExemptionCard.uploading")}
                </s-text>
              )}
              {uploadStatus === "success" && (
                <s-text color="success">
                  {i18n.translate(
                    "taxExemptionCard.certificateUploadedSuccessfully",
                  )}
                </s-text>
              )}
              {uploadStatus === "error" && (
                <s-text color="critical">
                  {i18n.translate("taxExemptionCard.certificateUploadFailed", {
                    error: uploadError,
                  })}
                </s-text>
              )}

              <s-checkbox
                checked={newTaxExemptionAttestation}
                required
                label={i18n.translate("taxExemptionCard.attestationLabel")}
                onChange={(e) =>
                  setNewTaxExemptionAttestation(e.target.checked)
                }
              />
            </s-stack>

            <s-stack direction="inline" gap="base" justifyContent="end">
              <s-button
                slot="secondary-actions"
                variant="secondary"
                disabled={loading}
                onClick={handleCancel}
              >
                {i18n.translate("taxExemptionCard.cancel")}
              </s-button>
              <s-button
                slot="primary-action"
                type="submit"
                variant="primary"
                loading={loading}
                disabled={
                  loading ||
                  !newTaxExemptionAttestation ||
                  !hasCertificate
                }
              >
                {i18n.translate("taxExemptionCard.save")}
              </s-button>
            </s-stack>
          </s-stack>
        </s-form>
      </s-modal>
    </>
  );
}

async function getTaxExemptionFields() {
  const response = await fetch(
    "shopify:customer-account/api/2026-01/graphql.json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query taxExemptionFields($namespace: String!) {
          customer {
            id
            taxExemptionType: metafield(namespace: $namespace, key: "tax_exemption_type") {
              value
            }
            taxExemptionCertificate: metafield(namespace: $namespace, key: "tax_exemption_certificate") {
              value
              reference {
                ... on GenericFile {
                  url
                  originalFileSize
                  mimeType
                }
              }
            }
            taxExemptionAttestation: metafield(namespace: $namespace, key: "tax_exemption_attestation") {
              value
            }
            taxExemptionExpiration: metafield(namespace: $namespace, key: "tax_exemption_certification_expiration") {
              value
            }
          }
        }`,
        variables: {
          namespace: "$app",
        },
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
      certificateFilename: null,
      certificateUrl: null,
      taxExemptionAttestation: false,
      taxExemptionExpiration: null,
    };
  }

  // Extract filename and URL from file reference if available
  let certificateFilename = null;
  let certificateUrl = null;
  const fileRef = data.customer.taxExemptionCertificate?.reference;
  if (fileRef?.url) {
    certificateUrl = fileRef.url;
    try {
      const url = new URL(fileRef.url);
      const pathParts = url.pathname.split("/");
      certificateFilename = decodeURIComponent(pathParts[pathParts.length - 1]);
    } catch (e) {
      console.warn("Could not extract filename from URL:", e);
    }
  }

  return {
    customerId: data.customer.id,
    taxExemptionType: data.customer.taxExemptionType?.value,
    taxExemptionCertificate: data.customer.taxExemptionCertificate?.value,
    certificateFilename,
    certificateUrl,
    taxExemptionAttestation:
      data.customer.taxExemptionAttestation?.value === "true",
    taxExemptionExpiration: data.customer.taxExemptionExpiration?.value,
  };
}

async function saveTaxExemptionFields(
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
        query: `mutation saveTaxExemptionFields($metafields: [MetafieldsSetInput!]!) {
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
              namespace: "$app",
              type: "single_line_text_field",
              ownerId: customerId,
              value: taxExemptionType ?? "",
            },
            {
              key: "tax_exemption_attestation",
              namespace: "$app",
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
  console.log(
    "Save tax exemption fields response:",
    JSON.stringify(json, null, 2),
  );

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
