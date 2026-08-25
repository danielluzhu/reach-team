/**
 * What a room is checked for. One template per kind of room, so a bedroom is
 * asked about its closet and a kitchen about its dishwasher rather than both
 * getting a generic list nobody reads.
 *
 * Shared by the page (which builds the form from it) and the PDF (which prints
 * whatever the submission actually carries) — the templates are only a starting
 * point, since items can be added or dropped before signing.
 */

export type RoomKind =
  | "bedroom"
  | "bathroom"
  | "living"
  | "kitchen"
  | "hallway"
  | "exterior"
  | "furnishings"
  | "other";

export const CONDITIONS = ["Excellent", "Good", "Fair", "Poor", "N/A"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Every room is asked these; the templates below add what's particular to it. */
const COMMON = ["Walls & ceiling", "Flooring", "Lighting & outlets"];

export const ROOM_TEMPLATES: Record<RoomKind, { label: string; items: string[] }> = {
  bedroom: {
    label: "Bedroom",
    items: [...COMMON, "Windows & screens", "Door & lock", "Closet & shelving", "Smoke detector"],
  },
  bathroom: {
    label: "Bathroom",
    items: [...COMMON, "Sink & vanity", "Toilet", "Tub / shower", "Mirror & cabinet", "Ventilation fan", "Water pressure"],
  },
  living: {
    label: "Living room",
    items: [...COMMON, "Windows & screens", "Door & lock", "Heating / cooling", "Smoke detector"],
  },
  kitchen: {
    label: "Kitchen",
    items: [
      ...COMMON, "Countertops", "Cabinets & drawers", "Sink & faucet", "Refrigerator",
      "Oven & range", "Range hood", "Dishwasher", "Garbage disposal",
    ],
  },
  hallway: {
    label: "Hallway",
    items: [...COMMON, "Stairs & handrails", "Smoke detector", "Closet / storage"],
  },
  exterior: {
    label: "Exterior premises",
    items: [
      "Entry door & lock", "Porch / steps", "Walkway & driveway", "Yard & landscaping",
      "Fencing & gates", "Roof & gutters", "Exterior lighting", "Bins & recycling area",
    ],
  },
  // What's in it depends on which rooms the property has, so this template
  // carries no fixed list — see furnishingItems below.
  furnishings: {
    label: "Furnishings",
    items: [],
  },
  other: {
    label: "Other room",
    items: [...COMMON, "Windows", "Door & lock", "Storage"],
  },
};

/**
 * What a furnished let is checked for, built from the rooms it actually has:
 * a bed and a desk per bedroom, the kitchen sets if there's a kitchen, the
 * seating if there's a living room. A one-bedroom flat gets "Bed" rather than
 * "Bed (Bedroom)" — the room name only earns its place once there are two to
 * tell apart.
 */
export function furnishingItems(rooms: { kind: RoomKind; name: string }[]): string[] {
  const bedrooms = rooms.filter((r) => r.kind === "bedroom");
  const items: string[] = [];
  for (const bedroom of bedrooms) {
    const where = bedrooms.length > 1 ? ` (${bedroom.name})` : "";
    items.push(`Bed${where}`, `Desk${where}`);
  }
  if (rooms.some((r) => r.kind === "kitchen")) items.push("Cookware", "Ceramicware", "Silverware");
  if (rooms.some((r) => r.kind === "living")) items.push("Couch", "Table / chairs");
  return items;
}

/**
 * The rooms a checklist starts with: one per bedroom and bathroom asked for,
 * plus the four every unit has. Bedrooms and bathrooms are numbered only when
 * there's more than one — "Bedroom" reads better than "Bedroom 1" in a studio.
 */
export function defaultRooms(bedrooms: number, bathrooms: number, furnished = false) {
  const rooms: { kind: RoomKind; name: string; items: string[] }[] = [];
  const add = (kind: RoomKind, name: string) =>
    rooms.push({ kind, name, items: [...ROOM_TEMPLATES[kind].items] });

  for (let i = 1; i <= bedrooms; i++) add("bedroom", bedrooms === 1 ? "Bedroom" : `Bedroom ${i}`);
  for (let i = 1; i <= bathrooms; i++) add("bathroom", bathrooms === 1 ? "Bathroom" : `Bathroom ${i}`);
  add("living", "Living room");
  add("kitchen", "Kitchen");
  add("hallway", "Hallway");
  add("exterior", "Exterior premises");

  if (furnished) {
    // Last, as its own section — and only when there is something in it. A
    // studio with no kitchen and no living room would otherwise get an empty
    // heading to scroll past.
    const items = furnishingItems(rooms);
    if (items.length) rooms.push({ kind: "furnishings", name: "Furnishings", items });
  }
  return rooms;
}
