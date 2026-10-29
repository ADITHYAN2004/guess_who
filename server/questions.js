// Preset yes/no questions. Add new ones here; no other code changes needed.
//   text  - full question (screen readers, log)
//   short - caption under the picture
//   icon  - 1-2 example faces showing the trait. Each entry is merged over ICON_BASE
//           and drawn with the same renderer as the board characters.
//   test  - runs on the server only and is never sent to clients.
const ICON_BASE = {
  gender: "male", skin: "medium", hairStyle: "short", hairColor: "black",
  facialHair: "none", accessory: [], hat: false,
};

// Related questions are batched into groups; the client shows one icon per group,
// and tapping it reveals that group's question pictures. Order here = order on screen.
const GROUPS = [
  { id: "person", label: "Person" },
  { id: "hair",   label: "Hair style" },
  { id: "color",  label: "Hair colour" },
  { id: "facial", label: "Facial hair" },
  { id: "extras", label: "Extras" },
];

const QUESTIONS = [
  { id: "female", group: "person",    text: "Are they female?",            short: "Female?",
    icon: [{ gender: "female", hairStyle: "long", hairColor: "brown" }],
    test: c => c.gender === "female" },
  { id: "glasses", group: "extras",   text: "Do they wear glasses?",       short: "Glasses?",
    icon: [{ accessory: ["glasses"] }],
    test: c => c.accessory.includes("glasses") },
  { id: "earrings", group: "extras",  text: "Do they wear earrings?",      short: "Earrings?",
    icon: [{ gender: "female", hairStyle: "bun", accessory: ["earrings"] }],
    test: c => c.accessory.includes("earrings") },
  { id: "hat", group: "extras",       text: "Are they wearing a hat?",     short: "Hat?",
    icon: [{ hat: true, hairStyle: "curly" }],
    test: c => c.hat },
  { id: "bald", group: "hair",      text: "Are they bald?",              short: "Bald?",
    icon: [{ hairStyle: "bald", hairColor: "none" }],
    test: c => c.hairStyle === "bald" },
  { id: "beard", group: "facial",     text: "Do they have a beard?",       short: "Beard?",
    icon: [{ facialHair: "beard" }],
    test: c => c.facialHair === "beard" },
  { id: "mustache", group: "facial",  text: "Do they have a mustache only?", short: "Mustache only?",
    icon: [{ facialHair: "mustache" }],
    test: c => c.facialHair === "mustache" },
  { id: "facial", group: "facial",    text: "Do they have any facial hair?", short: "Any facial hair?",
    icon: [{ facialHair: "beard" }, { facialHair: "mustache" }],
    test: c => c.facialHair !== "none" },
  // "Long straight hair" = worn loose. Ponytails/buns and curls are separate questions.
  { id: "longhair", group: "hair",  text: "Do they have long, straight hair worn loose?", short: "Long straight hair?",
    icon: [{ gender: "female", hairStyle: "long" }],
    test: c => c.hairStyle === "long" },
  { id: "curly", group: "hair",     text: "Is their hair curly?",        short: "Curly hair?",
    icon: [{ hairStyle: "curly" }],
    test: c => c.hairStyle === "curly" },
  { id: "tied", group: "hair",      text: "Is their hair tied up (ponytail or bun)?", short: "Ponytail or bun?",
    icon: [{ gender: "female", hairStyle: "ponytail" }, { gender: "female", hairStyle: "bun" }],
    test: c => c.hairStyle === "ponytail" || c.hairStyle === "bun" },
  { id: "darkhair", group: "color",  text: "Is their hair black or brown?", short: "Black or brown hair?",
    icon: [{ hairColor: "black" }, { hairColor: "brown" }],
    test: c => c.hairColor === "black" || c.hairColor === "brown" },
  { id: "blond", group: "color",     text: "Do they have blond hair?",    short: "Blond hair?",
    icon: [{ hairColor: "blond" }],
    test: c => c.hairColor === "blond" },
  { id: "red", group: "color",       text: "Do they have red hair?",      short: "Red hair?",
    icon: [{ hairColor: "red" }],
    test: c => c.hairColor === "red" },
  { id: "grey", group: "color",      text: "Do they have grey hair?",     short: "Grey hair?",
    icon: [{ hairColor: "grey" }],
    test: c => c.hairColor === "grey" },
  { id: "darkskin", group: "person",  text: "Do they have dark skin?",     short: "Dark skin?",
    icon: [{ skin: "dark" }],
    test: c => c.skin === "dark" },
  { id: "lightskin", group: "person", text: "Do they have light skin?",    short: "Light skin?",
    icon: [{ skin: "light" }],
    test: c => c.skin === "light" },
];

const QUESTION_MAP = new Map(QUESTIONS.map(q => [q.id, q]));

// Client-safe list (no test functions); icons are fully expanded characters.
const PUBLIC_QUESTIONS = QUESTIONS.map(({ id, group, text, short, icon }) => ({
  id, group, text, short,
  icon: icon.map(part => ({ ...ICON_BASE, ...part })),
}));

// Every question must belong to a known group.
for (const q of QUESTIONS) {
  if (!GROUPS.some(g => g.id === q.group)) throw new Error(`Question "${q.id}" has unknown group "${q.group}"`);
}

module.exports = { QUESTIONS, QUESTION_MAP, PUBLIC_QUESTIONS, GROUPS };
