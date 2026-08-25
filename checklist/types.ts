import type { Condition, RoomKind } from "./rooms";
import type { Attachment } from "./uploads";

export type ChecklistItem = {
  label: string;
  /** Empty when the tenant left it unanswered — printed as a dash, not a blank. */
  condition: Condition | "";
  notes: string;
};

export type ChecklistRoom = {
  kind: RoomKind;
  name: string;
  /** About the room itself — which bedroom it is, how to find it. Often blank. */
  notes: string;
  items: ChecklistItem[];
};

export type Checklist = {
  id: string;
  name: string;
  email: string;
  address: string;
  bedrooms: number;
  bathrooms: number;
  rooms: ChecklistRoom[];
  /** Anything that didn't belong to a room. Blank when nothing was added. */
  generalNotes: string;
  /** Photos and videos taken during the walkthrough, in the order added. */
  attachments: Attachment[];
  /** The signature as a PNG data URL, exactly as the canvas produced it. */
  signature: string;
  /** The certification the tenant ticked. Stored as text, so the PDF prints
   *  the wording that was actually agreed to rather than today's wording. */
  certification: string;
  /** The acknowledgements shown above the signature, for the same reason. */
  acknowledgements: string[];
  signedAt: string;
  /** The agent counter-signs where one is present; both are absent otherwise. */
  agentName?: string;
  agentSignature?: string;
};
