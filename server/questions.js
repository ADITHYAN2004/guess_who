// Preset yes/no questions. Add new ones here; no other code changes needed.
//   text  - full question (shown before asking, in the log, and to screen readers)
//   short - caption under the picture
//   icon  - 1-2 example faces showing the trait. Each entry is merged over ICON_BASE
//           and drawn with the same renderer as the board characters. With two faces,
//           the trait they share is the one being asked about.
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
  // ---- Person: gender and skin tone ----
  { id: "female", group: "person", text: "Is the person female?", short: "Female?",
    icon: [{ gender: "female", hairStyle: "long", hairColor: "brown" }, { gender: "female", hairStyle: "bun", skin: "dark" }],
    test: c => c.gender === "female" },
  { id: "male", group: "person", text: "Is the person male?", short: "Male?",
    icon: [{ gender: "male", hairStyle: "short", hairColor: "brown" }, { gender: "male", hairStyle: "curly", skin: "dark" }],
    test: c => c.gender === "male" },
  { id: "lightskin", group: "person", text: "Does the person have light skin?", short: "Light skin?",
    icon: [{ skin: "light" }, { skin: "light", gender: "female", hairStyle: "long", hairColor: "brown" }],
    test: c => c.skin === "light" },
  { id: "mediumskin", group: "person", text: "Does the person have medium skin?", short: "Medium skin?",
    icon: [{ skin: "medium" }, { skin: "medium", gender: "female", hairStyle: "long", hairColor: "brown" }],
    test: c => c.skin === "medium" },
  { id: "darkskin", group: "person", text: "Does the person have dark skin?", short: "Dark skin?",
    icon: [{ skin: "dark" }, { skin: "dark", gender: "female", hairStyle: "long", hairColor: "brown" }],
    test: c => c.skin === "dark" },

  // ---- Hair style ----
  { id: "bald", group: "hair", text: "Is the person bald?", short: "Bald?",
    icon: [{ hairStyle: "bald", hairColor: "none" }],
    test: c => c.hairStyle === "bald" },
  // "Long straight hair" = worn loose. Ponytails/buns and curls are separate questions.
  { id: "longhair", group: "hair", text: "Does the person have long, straight hair worn loose?", short: "Long straight hair?",
    icon: [{ gender: "female", hairStyle: "long" }],
    test: c => c.hairStyle === "long" },
  { id: "curly", group: "hair", text: "Does the person have curly hair?", short: "Curly hair?",
    icon: [{ hairStyle: "curly" }],
    test: c => c.hairStyle === "curly" },
  { id: "tied", group: "hair", text: "Is the person's hair tied up (ponytail or bun)?", short: "Ponytail or bun?",
    icon: [{ gender: "female", hairStyle: "ponytail" }, { gender: "female", hairStyle: "bun" }],
    test: c => c.hairStyle === "ponytail" || c.hairStyle === "bun" },

  // ---- Hair colour ----
  { id: "darkhair", group: "color", text: "Does the person have black or brown hair?", short: "Black or brown hair?",
    icon: [{ hairColor: "black" }, { hairColor: "brown" }],
    test: c => c.hairColor === "black" || c.hairColor === "brown" },
  { id: "blond", group: "color", text: "Does the person have blond hair?", short: "Blond hair?",
    icon: [{ hairColor: "blond" }],
    test: c => c.hairColor === "blond" },
  { id: "red", group: "color", text: "Does the person have red hair?", short: "Red hair?",
    icon: [{ hairColor: "red" }],
    test: c => c.hairColor === "red" },
  { id: "grey", group: "color", text: "Does the person have grey hair?", short: "Grey hair?",
    icon: [{ hairColor: "grey" }],
    test: c => c.hairColor === "grey" },

  // ---- Facial hair ----
  { id: "beard", group: "facial", text: "Does the person have a beard?", short: "Beard?",
    icon: [{ facialHair: "beard" }],
    test: c => c.facialHair === "beard" },
  { id: "mustache", group: "facial", text: "Does the person have only a mustache (no beard)?", short: "Mustache only?",
    icon: [{ facialHair: "mustache" }],
    test: c => c.facialHair === "mustache" },
  { id: "facial", group: "facial", text: "Does the person have any facial hair?", short: "Any facial hair?",
    icon: [{ facialHair: "beard" }, { facialHair: "mustache" }],
    test: c => c.facialHair !== "none" },

  // ---- Extras ----
  { id: "glasses", group: "extras", text: "Is the person wearing glasses?", short: "Glasses?",
    icon: [{ accessory: ["glasses"] }],
    test: c => c.accessory.includes("glasses") },
  { id: "earrings", group: "extras", text: "Is the person wearing earrings?", short: "Earrings?",
    icon: [{ gender: "female", hairStyle: "bun", accessory: ["earrings"] }],
    test: c => c.accessory.includes("earrings") },
  { id: "hat", group: "extras", text: "Is the person wearing a hat?", short: "Hat?",
    icon: [{ hat: true, hairStyle: "curly" }],
    test: c => c.hat },
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
