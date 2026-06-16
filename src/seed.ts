/** Seeds the demo group from the pitch deck: "Copenhagen Easter trip". */
import { createGroup, addMember, addItem, addInsight, setKnowledgeDoc, listGroups, listConnectors, setConnectorStatus } from "./db.js";

if (listGroups().some(g => g.name === "Copenhagen Easter trip")) {
  console.log("Demo group already exists, skipping.");
  process.exit(0);
}

const g = createGroup("Copenhagen Easter trip");
const lassi = addMember(g.id, "Lassi", "Foodie");
const maya = addMember(g.id, "Maya Lindqvist", "Art & design");
const jordan = addMember(g.id, "Jordan Park", "Architecture");
const sam = addMember(g.id, "Sam Okoro", "Nightlife");

const items: Array<[string, string, string, string, string]> = [
  // member_id, type, title, content, url
  [maya.id, "note", "Hotel Sanders booked", "Check-in April 18, check-out April 24. Four rooms, on the Nyhavn waterfront.", ""],
  [lassi.id, "link", "Restaurant Barr", "New Nordic, five minutes from Hotel Sanders. Day 1 dinner candidate.", "https://restaurantbarr.com"],
  [sam.id, "link", "Kodbyens Fiskebar", "Seafood spot in the Meatpacking District. Sam's pick.", "https://fiskebaren.dk"],
  [jordan.id, "note", "Jordan is vegetarian", "Reminder for restaurant picks: no fish or meat.", ""],
  [maya.id, "link", "Designmuseum Danmark", "Maya wants the Danish chair exhibition. Near Nyhavn.", "https://designmuseum.dk"],
  [jordan.id, "link", "Louisiana Museum of Modern Art", "35 min by train from Osterport. Could be a Day 3 trip.", "https://louisiana.dk"],
  [lassi.id, "thought", "Day 1 plan", "Arrival, check in to Hotel Sanders, dinner at Restaurant Barr.", ""],
];
for (const [member_id, type, title, content, url] of items)
  addItem(g.id, { member_id, type, title, content, url });

addInsight(g.id, "connection", "Hotel Sanders and Restaurant Barr are a five-minute walk apart",
  "Both are on the Nyhavn waterfront. Worth grouping the Day 1 evening plan around this area.");
addInsight(g.id, "blind_spot", "Days 3 and 4 have nothing planned yet",
  "The group has filled out Days 1 and 2 in detail. The back half of the trip is still empty. Worth tackling Day 3 next.");
addInsight(g.id, "conflict", "Jordan is vegetarian and Kodbyens Fiskebar is mostly seafood",
  "The restaurant was added without context on dietary preferences. May want to swap or add a vegetarian-friendly alternative.");
addInsight(g.id, "pattern", "The group keeps gravitating toward Nyhavn",
  "Five of seven saved locations are in Nyhavn or within a 10-minute walk. The group's natural base is becoming clear.");
addInsight(g.id, "question", "Has anyone checked if Easter weekend affects opening hours?",
  "Many restaurants and museums in Copenhagen have reduced hours over Easter. The group has not discussed this yet.");

setKnowledgeDoc(g.id, `# Copenhagen Easter trip

_A four-day trip with four friends, April 18 to 24, 2026. Base in Nyhavn._

## Overview

The group is planning a relaxed Easter weekend in Copenhagen, anchored around **Nyhavn**. Five of seven saved locations sit within a 10-minute walk of the waterfront, making it the natural base for the trip.

## Where we're staying

- **Hotel Sanders** — booked by Maya, on the Nyhavn waterfront.
- Check-in April 18, check-out April 24. Four rooms.

## Where we're eating

- **Restaurant Barr** — Lassi's pick. Five minutes from Hotel Sanders.
- **Kodbyens Fiskebar** — Sam's pick. _Mostly seafood — Jordan is vegetarian, may need an alternative._

## Culture

- **Designmuseum Danmark** — Maya wants the Danish chair exhibition. Near Nyhavn.
- **Louisiana Museum of Modern Art** — 35 min by train. Day 3 candidate.

## Schedule

**Day 1 — Friday Apr 18.** Arrival, check in to Hotel Sanders, dinner at Restaurant Barr.

**Days 3-4.** _Nothing planned yet._

## Open questions

- Does Easter weekend affect opening hours?
- Vegetarian-friendly alternative to Kodbyens Fiskebar?
`);

// Mark Claude + Cursor connected, like the deck
for (const c of listConnectors(g.id))
  if (c.name === "Claude" || c.name === "Cursor") setConnectorStatus(c.id, "connected");

console.log(`Seeded "${g.name}"`);
console.log(`Group ID: ${g.id}`);
console.log(`API key:  ${g.api_key}`);
