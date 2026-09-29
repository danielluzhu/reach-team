import type { Attachment } from "./uploads";

export type Residence = {
  address: string;
  /** Month the applicant moved in, as typed ("2024-03"). */
  from: string;
  /** Blank for where they live now. */
  to: string;
  rent: string;
  landlordName: string;
  landlordPhone: string;
  reason: string;
};

export type Job = {
  employer: string;
  position: string;
  from: string;
  monthlyIncome: string;
  contactName: string;
  contactPhone: string;
};

export type Occupant = { name: string; relationship: string; adult: boolean };

export type Vehicle = { make: string; model: string; color: string; plate: string; state: string };

export type Application = {
  id: string;
  submittedAt: string;

  /** What they are applying for, as they typed it or as the link filled it in. */
  property: string;
  moveIn: string;
  leaseTerm: string;

  name: string;
  email: string;
  phone: string;
  dob: string;

  /** Where they live now first, then earlier addresses. Always at least one. */
  residences: Residence[];
  /** Empty for somebody with no job to list — income may be all "other". */
  jobs: Job[];
  otherIncome: string;

  occupants: Occupant[];
  pets: string;
  vehicles: Vehicle[];

  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;

  notes: string;
  /** ID, pay stubs, offer letter — uploaded as they were picked. */
  attachments: Attachment[];

  /** PNG data URL, exactly as the canvas produced it. */
  signature: string;
  /** Stored as text, so the PDF prints the wording that was on screen. */
  certification: string;
  screeningNotice: string;
  acknowledgements: string[];
};
