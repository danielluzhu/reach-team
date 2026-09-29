/**
 * The wording an applicant agrees to. Kept in one place so the page, the stored
 * record and the PDF can't drift apart — and stored on each application, so one
 * submitted today still prints today's wording after this file changes.
 *
 * NOT drafted by a lawyer. Two Washington rules shape it:
 *
 * - RCW 59.18.257 — before a screening report is obtained, the applicant must
 *   be told in writing what will be looked at and the criteria that may lead
 *   to a denial. SCREENING_NOTICE is that notice, and the applicant ticks it
 *   before they can sign; the office's actual criteria belong in it.
 * - Seattle's Fair Chance Housing Ordinance (SMC 14.09) — which is why this
 *   form asks nothing about arrests or convictions. Don't add that question
 *   without an attorney saying it is allowed.
 *
 * Nor does it ask for a Social Security number: the screening provider collects
 * that from the applicant directly, so it never sits in this app's database.
 */

export const SCREENING_NOTICE =
  "We may obtain a tenant screening report, which may include credit history, rental and eviction " +
  "history, and verification of the income, employment and landlord references you give here. " +
  "An application may be denied for: information on it that is false or incomplete; income that " +
  "cannot be verified or is insufficient for the rent; unfavourable rental references; or a credit " +
  "history showing unpaid rental debt. If we take adverse action based on a screening report, you " +
  "will be told in writing and given the name of the agency that supplied it.";

export const CERTIFICATION =
  "I certify that the information in this application is true and complete, and I authorize the " +
  "landlord or its agent to verify it and to obtain a tenant screening report about me.";

export const ACKNOWLEDGEMENTS = [
  "Submitting this application does not create a tenancy or reserve the property; a tenancy begins only when a lease is signed by both parties.",
  "Every adult who will live at the property should submit an application of their own.",
  "False or misleading information on this application may be grounds for denying it, or for ending a tenancy entered into on the strength of it.",
  "I agree that my electronic signature below has the same legal effect as a handwritten signature.",
];
