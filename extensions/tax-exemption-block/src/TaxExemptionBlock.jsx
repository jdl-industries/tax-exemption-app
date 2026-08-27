// @ts-nocheck
import { render } from "preact";
import { useState, useRef, useEffect } from "preact/hooks";

const WORKER_URL = "https://tax-exemption-service.jdlindustries.workers.dev";

/**
 * Shopify's built-in B2B roles are "Location admin" and "Ordering only". Only a
 * Location admin may edit a location's tax data. The role's GID differs per
 * shop, so the name is the only stable identifier available here.
 *
 * This gate controls the edit affordance only -- the worker independently
 * re-verifies the role before writing anything.
 */
const LOCATION_ADMIN_ROLE_NAME = "location admin";

/**
 * Buyers paying on a Tax Free Credit Card have no certificate to produce -- the
 * card itself carries the exemption -- so this is the one type that submits
 * without a document.
 *
 * These values are stored verbatim in the tax_exemption_type metafield and are
 * what the admin blocks display, so they must stay in step with the `choices`
 * validation in shopify.app.toml.
 */
const TAX_FREE_CREDIT_CARD_TYPE =
  "Government/Military (using Tax Free Credit Card)";

/** The Government/Military type whose certificate is a completed SF-1094. */
const FORM_1094_TYPE = "Government/Military (1094 required)";

/**
 * Blank fillable SF-1094, hosted on the shop's own Files CDN so buyers who pick
 * that type can fetch, complete and sign one without leaving the flow.
 */
const FORM_1094_URL =
  "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/SF1094-15c.pdf?v=1787857921";

function certificateRequiredFor(taxExemptionType) {
  return taxExemptionType !== TAX_FREE_CREDIT_CARD_TYPE;
}

export default async () => {
  const { customer, locations } = await getTaxExemptionData();

  render(
    <TaxExemptionApp customer={customer} locations={locations} />,
    document.body,
  );
};

/**
 * Track the company location currently chosen in the customer account location
 * switcher.
 *
 * Shopify exposes it as a subscribable on `authenticatedAccount`, carrying only
 * `{ company: { id }, location: { id } }` -- the location's name, Tax ID, roles
 * and metafields still come from the Customer Account API query. Subscribing
 * keeps the card in sync when the buyer changes the selection.
 */
function useSelectedLocationId() {
  const purchasingCompany = shopify.authenticatedAccount?.purchasingCompany;

  const [selectedLocationId, setSelectedLocationId] = useState(
    () => purchasingCompany?.value?.location?.id ?? null,
  );

  useEffect(() => {
    if (typeof purchasingCompany?.subscribe !== "function") {
      return undefined;
    }
    // subscribe() returns its own unsubscribe function.
    return purchasingCompany.subscribe((value) => {
      setSelectedLocationId(value?.location?.id ?? null);
    });
  }, [purchasingCompany]);

  return selectedLocationId;
}

/**
 * Reduce a company location identifier to a comparable key.
 *
 * `authenticatedAccount.purchasingCompany` reports bare numeric IDs at runtime
 * (e.g. "3381100601") while the Customer Account API returns full GIDs
 * (e.g. "gid://shopify/CompanyLocation/3381100601"), so the two can't be
 * compared directly. Shopify's own typings document the former as a GID, so
 * this normalizes either shape and keeps working if that's ever corrected.
 */
function locationIdKey(id) {
  if (!id) {
    return null;
  }
  const asString = String(id);
  const trailingNumericId = asString.match(/(\d+)$/);
  return trailingNumericId ? trailingNumericId[1] : asString;
}

/**
 * B2B contacts maintain exemption documentation on their company location(s)
 * instead of on their personal customer record, so the customer card is shown
 * only to customers with no company locations.
 */
function TaxExemptionApp({ customer, locations }) {
  const selectedLocationId = useSelectedLocationId();

  if (locations.length > 0) {
    const selectedKey = locationIdKey(selectedLocationId);
    const selectedLocation = selectedKey
      ? locations.find((location) => locationIdKey(location.id) === selectedKey)
      : undefined;

    // Show only the location the buyer currently has selected. If that
    // selection can't be resolved -- no location set, or one this contact isn't
    // assigned to -- fall back to every location they hold rather than
    // rendering an empty block.
    const visibleLocations = selectedLocation ? [selectedLocation] : locations;

    return (
      <>
        {visibleLocations.map((location) => (
          <TaxExemptionCard
            key={location.id}
            ownerId={location.id}
            ownerKind="location"
            locationName={location.name}
            canEdit={location.canEdit}
            taxIdentifier={location.taxIdentifier}
            taxExemptionType={location.taxExemptionType}
            taxExemptionCertificate={location.taxExemptionCertificate}
            certificateFilename={location.certificateFilename}
            certificateUrl={location.certificateUrl}
            taxExemptionAttestation={location.taxExemptionAttestation}
            taxExemptionExpiration={location.taxExemptionExpiration}
          />
        ))}
      </>
    );
  }

  return (
    <TaxExemptionCard
      ownerId={customer.customerId}
      ownerKind="customer"
      canEdit
      taxExemptionType={customer.taxExemptionType}
      taxExemptionCertificate={customer.taxExemptionCertificate}
      certificateFilename={customer.certificateFilename}
      certificateUrl={customer.certificateUrl}
      taxExemptionAttestation={customer.taxExemptionAttestation}
      taxExemptionExpiration={customer.taxExemptionExpiration}
    />
  );
}

function TaxExemptionCard(props) {
  const { i18n } = shopify;
  const modalRef = useRef();
  const isLocation = props.ownerKind === "location";

  // Each card renders its own modal, so the id has to be unique per owner.
  const modalId = `tax-exemption-modal-${String(props.ownerId).replace(
    /[^a-zA-Z0-9]/g,
    "-",
  )}`;

  const [loading, setLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // null | 'uploading' | 'success' | 'error'
  const [uploadError, setUploadError] = useState(null);
  const [taxExemptionCertificate, setTaxExemptionCertificate] = useState(
    props.taxExemptionCertificate ?? null,
  );
  const [certificateFilename, setCertificateFilename] = useState(
    props.certificateFilename ?? null,
  );
  // Note: the staged upload flow doesn't return the new file's CDN URL, so
  // after replacing a certificate this link still points at the previous file
  // until the page is reloaded.
  const [certificateUrl] = useState(props.certificateUrl ?? null);
  const [taxExemptionType, setTaxExemptionType] = useState(
    props.taxExemptionType ?? "",
  );
  const [taxExemptionAttestation, setTaxExemptionAttestation] = useState(
    props.taxExemptionAttestation ?? false,
  );
  const [taxIdentifier, setTaxIdentifier] = useState(props.taxIdentifier ?? "");

  // Form state for modal
  const [newTaxExemptionType, setNewTaxExemptionType] =
    useState(taxExemptionType);
  const [newTaxExemptionAttestation, setNewTaxExemptionAttestation] = useState(
    props.taxExemptionAttestation ?? false,
  );
  const [newTaxIdentifier, setNewTaxIdentifier] = useState(
    props.taxIdentifier ?? "",
  );
  const [pendingFile, setPendingFile] = useState(null); // File object waiting to be uploaded on Save

  // Determine if a certificate exists (either saved or pending selection)
  const hasCertificate = !!taxExemptionCertificate || !!pendingFile;
  const displayFilename = pendingFile?.name || certificateFilename;

  // Whether the type currently chosen in the modal calls for a document, and
  // whether the already-saved type did -- the card view follows the saved value.
  const certificateRequired = certificateRequiredFor(newTaxExemptionType);
  const savedCertificateRequired = certificateRequiredFor(taxExemptionType);

  // Show exempt view if any field has been set. The Tax ID is deliberately not
  // part of this: Shopify already surfaces it natively on the location page, so
  // it's edit-only here and shouldn't make an otherwise-empty card look filled.
  const hasAnyFieldSet =
    !!taxExemptionType ||
    !!taxExemptionCertificate ||
    !!taxExemptionAttestation ||
    !!props.taxExemptionExpiration;
  const showExemptView = hasAnyFieldSet;

  // Determine status: Approved if expiration date is set (staff reviewed), otherwise Under Review
  const getStatus = () => {
    if (props.taxExemptionExpiration) {
      return {
        label: i18n.translate("taxExemptionCard.approved"),
        tone: "success",
      };
    }
    if (hasAnyFieldSet) {
      // "info" rather than "warning": nothing is wrong, staff simply haven't
      // reviewed the submission yet.
      return {
        label: i18n.translate("taxExemptionCard.underReview"),
        tone: "info",
      };
    }
    return null;
  };
  const status = getStatus();

  const heading = isLocation
    ? i18n.translate("taxExemptionCard.locationHeading")
    : i18n.translate("taxExemptionCard.heading");

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

  const handleTypeChange = (event) => {
    const type = event.target.value;
    setNewTaxExemptionType(type);

    // Switching to a type that needs no document has to discard any file the
    // buyer already picked -- the drop-zone is about to disappear, and Save
    // would otherwise upload a certificate the chosen type never asked for.
    if (!certificateRequiredFor(type)) {
      setPendingFile(null);
      setUploadStatus(null);
      setUploadError(null);
    }
  };

  // Upload file to Shopify and save metafield reference against the owner
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

    const { url, resourceUrl, parameters } = await stagedUploadResponse.json();
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

    // Step 3: Save the file reference metafield via worker. The worker turns the
    // staged resource URL into a File GID, which a file_reference metafield
    // requires, and re-checks that we may write to this owner.
    const metafieldResponse = await fetch(
      `${WORKER_URL}/api/b2b/customer-metafields`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          ownerId: props.ownerId,
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

  // The Tax ID is independent of the exemption paperwork: a location admin may
  // record it without ever uploading a certificate.
  const taxIdChanged = isLocation && newTaxIdentifier !== taxIdentifier;
  // An exemption submission needs a certificate and an attestation -- except on
  // the Tax Free Credit Card type, where there is no document to supply and the
  // attestation alone completes it.
  const exemptionReady = certificateRequired
    ? hasCertificate && newTaxExemptionAttestation
    : newTaxExemptionAttestation;
  // A Tax ID-only save is allowed, but never while a chosen file is waiting --
  // otherwise the certificate would upload without its attestation.
  const canSubmit = exemptionReady || (taxIdChanged && !pendingFile);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) {
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

      // The Tax ID is a built-in field on the location, not a metafield, so it
      // is saved separately through the worker's Admin API route.
      if (taxIdChanged) {
        const savedTaxIdentifier = await saveLocationTaxIdentifier(
          props.ownerId,
          newTaxIdentifier,
        );
        setTaxIdentifier(savedTaxIdentifier);
        setNewTaxIdentifier(savedTaxIdentifier);
      }

      // Only write the exemption metafields when the paperwork is complete, so
      // a Tax ID-only edit doesn't blank out an existing type/attestation.
      if (exemptionReady) {
        const { type, attestation } = await saveTaxExemptionFields(
          props.ownerId,
          newTaxExemptionType,
          newTaxExemptionAttestation,
        );

        // Update display state
        setTaxExemptionType(type);
        setTaxExemptionAttestation(attestation);
        // Sync form state with saved values
        setNewTaxExemptionType(type);
        setNewTaxExemptionAttestation(attestation);
      }

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
    setNewTaxIdentifier(taxIdentifier);
    setUploadStatus(null);
    setUploadError(null);
    setPendingFile(null);
    modalRef.current?.hideOverlay?.() || modalRef.current?.hide?.();
  };

  return (
    <>
      {/*
        Shopify's profile sections (shipping address, billing address, payment
        methods) render the heading -- and its action button -- on a row *above*
        the card, not inside it. `s-section` draws the card with the heading
        within it, so this composes the native shape by hand instead: a heading
        row, then a separate bordered card below.
      */}
      <s-stack direction="block" gap="large">
        <s-stack
          direction="inline"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-heading>{heading}</s-heading>
          {/*
            s-clickable rather than s-button: ClickableProps extends BoxProps,
            so padding/border/radius are all controllable here, and it applies
            no tone of its own -- which is what removes the accent-blue label
            that s-button's `tone="auto"` default produces. s-button exposes no
            size prop, so it can't be made to match the built-in sections.
            The label colour comes from the nested s-text.
          */}
          {props.canEdit && (
            <s-clickable
              command="--show"
              commandFor={modalId}
              accessibilityLabel={i18n.translate("taxExemptionCard.edit")}
              background="base"
              borderWidth="base"
              borderRadius="base"
              paddingBlock="small-100"
              paddingInline="small"
            >
              <s-text type="strong">
                {showExemptView
                  ? i18n.translate("taxExemptionCard.editAction")
                  : i18n.translate("taxExemptionCard.add")}
              </s-text>
            </s-clickable>
          )}
        </s-stack>

        {/*
          s-section supplies the native card chrome -- background, radius,
          padding and the drop shadow. There is no shadow design token exposed
          on s-box/s-stack, so a hand-built box can't reproduce it. Its `heading`
          prop is deliberately left unset: it renders the title inside the card,
          whereas the native sections put it on the row above.
        */}
        <s-section>
          <s-stack direction="block" gap="large-200">
            {showExemptView ? (
              /* Exempt state: show all fields */
              <>
                {/* alignItems start so the badge hugs its text instead of
                  stretching to the full card width. */}
                <s-stack direction="block" alignItems="start" gap="small-100">
                  <s-text color="subdued">
                    {i18n.translate("taxExemptionCard.statusLabel")}
                  </s-text>
                  {status && (
                    <s-badge tone={status.tone}>{status.label}</s-badge>
                  )}
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
                {/* Types that carry their own proof -- the Tax Free Credit
                  Card -- have no certificate to report, so the row is dropped
                  rather than left reading "Not uploaded". */}
                {savedCertificateRequired && (
                  <s-stack direction="block">
                    <s-text color="subdued">
                      {i18n.translate("taxExemptionCard.certificateLabel")}
                    </s-text>
                    {taxExemptionCertificate ? (
                      certificateUrl ? (
                        <s-link href={certificateUrl} target="_blank">
                          {displayFilename ||
                            i18n.translate("taxExemptionCard.uploaded")}
                        </s-link>
                      ) : (
                        <s-text>
                          {displayFilename ||
                            i18n.translate("taxExemptionCard.uploaded")}
                        </s-text>
                      )
                    ) : (
                      <s-text>
                        {i18n.translate("taxExemptionCard.notUploaded")}
                      </s-text>
                    )}
                  </s-stack>
                )}
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
      </s-stack>

      {props.canEdit && (
        <s-modal
          id={modalId}
          ref={modalRef}
          heading={i18n.translate("taxExemptionCard.modalHeading")}
        >
          <s-form onSubmit={handleSubmit}>
            <s-stack direction="block" gap="large">
              <s-stack direction="block" gap="base">
                {isLocation && (
                  <s-text-field
                    label={i18n.translate("taxExemptionCard.taxIdLabel")}
                    value={newTaxIdentifier}
                    disabled={loading}
                    onChange={(e) => setNewTaxIdentifier(e.currentTarget.value)}
                  />
                )}

                <s-select
                  label={i18n.translate("taxExemptionCard.typeLabel")}
                  value={newTaxExemptionType}
                  onChange={handleTypeChange}
                >
                  <s-option value="">
                    {i18n.translate("taxExemptionCard.selectType")}
                  </s-option>
                  <s-option value="Resale">
                    {i18n.translate("taxExemptionCard.resale")}
                  </s-option>
                  <s-option value={TAX_FREE_CREDIT_CARD_TYPE}>
                    {i18n.translate(
                      "taxExemptionCard.governmentMilitaryCreditCard",
                    )}
                  </s-option>
                  <s-option value={FORM_1094_TYPE}>
                    {i18n.translate("taxExemptionCard.governmentMilitary")}
                  </s-option>
                  <s-option value="Manufacturing/Industrial">
                    {i18n.translate("taxExemptionCard.manufacturingIndustrial")}
                  </s-option>
                  <s-option value="Other">
                    {i18n.translate("taxExemptionCard.other")}
                  </s-option>
                </s-select>

                {/* Sits between the type and the drop-zone so the form is
                  offered in the order it's needed: pick the type, fetch the
                  blank form, upload the completed one. */}
                {newTaxExemptionType === FORM_1094_TYPE && (
                  <s-stack direction="block" gap="small-100">
                    <s-paragraph>
                      {i18n.translate("taxExemptionCard.form1094Help")}
                    </s-paragraph>
                    <s-link href={FORM_1094_URL} target="_blank">
                      {i18n.translate("taxExemptionCard.form1094LinkLabel")}
                    </s-link>
                  </s-stack>
                )}

                {certificateRequired && (
                  <>
                    {/*
                      s-drop-zone doesn't surface the chosen file itself, so the
                      filename is rendered here. Give it a bordered row and a
                      badge when the file is newly picked -- as plain text under
                      a label it read as static copy and the selection went
                      unnoticed.
                    */}
                    <s-stack direction="block" gap="small">
                      <s-text color="subdued">
                        {i18n.translate("taxExemptionCard.certificateLabel")}
                      </s-text>
                      {displayFilename && (
                        <s-stack
                          direction="inline"
                          gap="base"
                          alignItems="center"
                          background="subdued"
                          borderWidth="base"
                          borderRadius="base"
                          padding="base"
                        >
                          <s-text>{displayFilename}</s-text>
                          {pendingFile && (
                            <s-badge tone="info">
                              {i18n.translate("taxExemptionCard.fileSelected")}
                            </s-badge>
                          )}
                        </s-stack>
                      )}
                    </s-stack>

                    <s-drop-zone
                      label={
                        hasCertificate
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
                        {i18n.translate(
                          "taxExemptionCard.certificateUploadFailed",
                          {
                            error: uploadError,
                          },
                        )}
                      </s-text>
                    )}
                  </>
                )}
              </s-stack>

              {/*
                Kept outside the stack above, as a sibling of the button row,
                so it always sits last. Inside it, it was the only child that
                never unmounts while the drop-zone and the 1094 block come and
                go with the chosen type, and the nodes appearing around it were
                landing after it instead of before.

                The two flows certify different things -- one that a document is
                valid, the other that the card and the purchase qualify -- so
                the copy follows the same predicate that shows the drop-zone,
                and any future document-free type picks up the right wording
                without further changes.
              */}
              <s-checkbox
                checked={newTaxExemptionAttestation}
                required={hasCertificate || !certificateRequired}
                label={i18n.translate(
                  certificateRequired
                    ? "taxExemptionCard.attestationLabel"
                    : "taxExemptionCard.attestationLabelNoCertificate",
                )}
                onChange={(e) =>
                  setNewTaxExemptionAttestation(e.target.checked)
                }
              />

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
                  disabled={loading || !canSubmit}
                >
                  {i18n.translate("taxExemptionCard.save")}
                </s-button>
              </s-stack>
            </s-stack>
          </s-form>
        </s-modal>
      )}
    </>
  );
}

/** Metafield selection shared by the customer and company location queries. */
const TAX_EXEMPTION_METAFIELDS_FRAGMENT = `
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
`;

/**
 * Pull the certificate's public URL and a display filename out of the
 * file_reference metafield.
 */
function readCertificate(node) {
  let certificateFilename = null;
  let certificateUrl = null;
  const fileRef = node?.taxExemptionCertificate?.reference;
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
  return { certificateFilename, certificateUrl };
}

function readTaxExemptionFields(node) {
  const { certificateFilename, certificateUrl } = readCertificate(node);
  return {
    taxExemptionType: node?.taxExemptionType?.value,
    taxExemptionCertificate: node?.taxExemptionCertificate?.value,
    certificateFilename,
    certificateUrl,
    taxExemptionAttestation: node?.taxExemptionAttestation?.value === "true",
    taxExemptionExpiration: node?.taxExemptionExpiration?.value,
  };
}

const EMPTY_CUSTOMER = {
  customerId: null,
  taxExemptionType: null,
  taxExemptionCertificate: null,
  certificateFilename: null,
  certificateUrl: null,
  taxExemptionAttestation: false,
  taxExemptionExpiration: null,
};

async function getTaxExemptionData() {
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
            ${TAX_EXEMPTION_METAFIELDS_FRAGMENT}
            companyContacts(first: 10) {
              edges {
                node {
                  id
                  locations(first: 50) {
                    edges {
                      node {
                        id
                        name
                        taxIdentifier
                        roleAssignments(first: 250) {
                          edges {
                            node {
                              contact {
                                id
                              }
                              role {
                                name
                              }
                            }
                          }
                        }
                        ${TAX_EXEMPTION_METAFIELDS_FRAGMENT}
                      }
                    }
                  }
                }
              }
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

  const customerNode = json.data?.customer;
  if (!customerNode) {
    console.error("No customer data returned");
    return { customer: EMPTY_CUSTOMER, locations: [] };
  }

  const customer = {
    customerId: customerNode.id,
    ...readTaxExemptionFields(customerNode),
  };

  const locations = [];
  const seenLocationIds = new Set();

  for (const contactEdge of customerNode.companyContacts?.edges ?? []) {
    const contact = contactEdge.node;

    for (const locationEdge of contact.locations?.edges ?? []) {
      const location = locationEdge.node;

      // A customer can hold more than one contact record; de-duplicate so a
      // location never renders twice.
      if (seenLocationIds.has(location.id)) {
        continue;
      }
      seenLocationIds.add(location.id);

      const canEdit = (location.roleAssignments?.edges ?? []).some(
        ({ node }) =>
          node.contact?.id === contact.id &&
          node.role?.name?.trim().toLowerCase() === LOCATION_ADMIN_ROLE_NAME,
      );

      locations.push({
        id: location.id,
        name: location.name,
        taxIdentifier: location.taxIdentifier ?? "",
        canEdit,
        ...readTaxExemptionFields(location),
      });
    }
  }

  return { customer, locations };
}

/**
 * Write the type and attestation metafields.
 *
 * This goes through the worker rather than straight to the Customer Account
 * API: that API rejects metafieldsSet against a CompanyLocation owner with
 * "Access to this namespace and key on Metafields for this resource type is not
 * allowed". The worker re-checks the caller's role and writes through the Admin
 * API, which is the same path the certificate and Tax ID already take.
 */
async function saveTaxExemptionFields(
  ownerId,
  taxExemptionType,
  taxExemptionAttestation,
) {
  const sessionToken = await shopify.sessionToken.get();

  const response = await fetch(`${WORKER_URL}/api/b2b/tax-exemption-fields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      ownerId,
      taxExemptionType: taxExemptionType ?? "",
      taxExemptionAttestation: !!taxExemptionAttestation,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Failed to save tax exemption fields");
  }

  const result = await response.json();

  return {
    type: result.type ?? "",
    attestation: !!result.attestation,
  };
}

/**
 * Save a company location's built-in Tax ID.
 *
 * The Customer Account API exposes this as the read-only `taxIdentifier` field,
 * so the write goes through the worker, which uses the Admin API's
 * companyLocationTaxSettingsUpdate mutation after re-checking the caller's role.
 */
async function saveLocationTaxIdentifier(companyLocationId, taxRegistrationId) {
  const sessionToken = await shopify.sessionToken.get();

  const response = await fetch(`${WORKER_URL}/api/b2b/location-tax-id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      companyLocationId,
      taxRegistrationId: taxRegistrationId ?? "",
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Failed to save Tax ID");
  }

  const result = await response.json();
  return result.taxRegistrationId ?? "";
}
