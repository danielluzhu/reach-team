/**
 * The wording the tenant agrees to. Kept in one place so the page, the stored
 * record and the PDF can't drift apart — and stored on each submission rather
 * than only referenced, so a checklist signed today still prints the wording
 * that was on screen today if this file changes tomorrow.
 *
 * NOT drafted by a lawyer. Washington's Residential Landlord-Tenant Act
 * (RCW 59.18.260) requires a written checklist describing the condition of the
 * property, signed by both landlord and tenant, whenever a deposit is taken —
 * so the wording below, and in particular whether the agent's signature can be
 * optional, is worth an attorney's eye before this is relied on.
 */

export const CERTIFICATION =
  "I certify that all information provided is true and correct to the best of my knowledge.";

export const ACKNOWLEDGEMENTS = [
  "This checklist records the condition of the property on the date signed below and forms part of the tenancy record.",
  "It may be relied on by either party when assessing responsibility for damage, and any deductions from the security deposit at the end of the tenancy.",
  "Items left blank were not inspected, and are not agreed by either party to be in any particular condition.",
  "Anything not recorded here should be reported to the landlord or agent in writing as soon as it is noticed.",
  "The parties agree that the electronic signatures below have the same legal effect as handwritten signatures, and that this document may be signed and kept in electronic form.",
  "A copy of this signed checklist is provided to the tenant.",
];
