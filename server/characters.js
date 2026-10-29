// Procedural board generation. Runs on the server only.
const { QUESTIONS } = require("./questions");

const BOARD_SIZE = 30;
const MIN_YES = 3;   // every question must say "yes" for at least 10% of the board
const MAX_YES = 24;  // and at most 80%
// Any two characters must LOOK clearly different: at least one big trait plus a bit more
// (see visualDiff). This stops "spot the difference" pairs like same hair + similar skin.
const MIN_VISUAL_DIFF = 4;

// Three clearly different skin tones, so "Light skin?" / "Dark skin?" are never a judgement call.
const SKINS = ["light", "medium", "dark"];
const HAIR_STYLES = ["bald", "short", "long", "curly", "ponytail", "bun"];
const HAIR_COLORS = ["black", "brown", "blond", "red", "grey"];
const FACIAL_HAIR = ["none", "beard", "mustache"];

const NAMES = {
  female: ["Aanya", "Diya", "Isha", "Kavya", "Meera", "Nisha", "Pooja", "Riya", "Sana", "Tara",
           "Anjali", "Divya", "Gauri", "Jaya", "Lakshmi", "Neha", "Priya", "Radha", "Sita", "Uma",
           "Asha", "Bhavna", "Chitra", "Deepa", "Esha", "Geeta", "Hema", "Indu", "Lata", "Rekha"],
  male:   ["Aarav", "Arjun", "Dev", "Ishaan", "Kabir", "Rohan", "Vikram", "Raj", "Sameer", "Aditya",
           "Shalin", "Karan", "Nikhil", "Varun", "Amit", "Ravi", "Sanjay", "Manoj", "Suresh", "Anil",
           "Gopal", "Harish", "Imran", "Jatin", "Mohan", "Naveen", "Pranav", "Rakesh", "Tarun", "Vijay"],
};

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const chance = p => Math.random() < p;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick from { option: weight }.
function weighted(weights) {
  const entries = Object.entries(weights);
  let r = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, w] of entries) if ((r -= w) < 0) return value;
  return entries[entries.length - 1][0];
}

// Hairstyle odds per gender, so "Female?" is easy to answer by looking: men mostly have
// short, bald or curly hair and women mostly long hair, ponytails, buns or curls.
// Every style still appears, so every question stays useful.
const HAIR_ODDS = {
  male:   { short: 4, bald: 2.5, curly: 2 },
  female: { long: 4, ponytail: 2, bun: 2, curly: 2 },
};
// Hats only go on hair that still shows clearly underneath (short hair would vanish,
// a bald head or a bun would be hidden).
const HAT_OK = ["long", "ponytail", "curly"];

function randomCharacter() {
  const gender = chance(0.5) ? "female" : "male";
  const hairStyle = weighted(HAIR_ODDS[gender]);
  const hairColor = hairStyle === "bald" ? "none" : pick(HAIR_COLORS); // bald = no hair colour
  const facialHair = gender === "female" ? "none" : pick(FACIAL_HAIR);

  const accessory = [];
  if (chance(0.3)) accessory.push("glasses");
  if (gender === "female" && chance(0.5)) accessory.push("earrings");

  const hat = HAT_OK.includes(hairStyle) && chance(0.35);

  return { gender, skin: pick(SKINS), hairStyle, hairColor, facialHair, accessory, hat };
}

// How different two characters LOOK. Big, obvious traits count 3, medium ones 2,
// subtle ones 1 (lashes/lips for gender, small earrings).
function visualDiff(a, b) {
  const has = (c, item) => c.accessory.includes(item);
  let d = 0;
  if (a.hairStyle !== b.hairStyle) d += 3;
  if (a.hat !== b.hat) d += 3;
  if (has(a, "glasses") !== has(b, "glasses")) d += 3;
  if (a.facialHair !== b.facialHair) d += 3;
  if (a.hairColor !== b.hairColor) d += a.hat && b.hat ? 1 : 2; // less hair shows under a hat
  if (a.gender !== b.gender) d += 1;
  if (has(a, "earrings") !== has(b, "earrings")) d += 1;
  if (a.skin !== b.skin) d += 2; // the three tones are far apart
  return d;
}

function questionSplits(board) {
  return QUESTIONS.map(q => ({ id: q.id, yes: board.filter(q.test).length }));
}

function tryBuildBoard() {
  const board = [];
  let attempts = 0;
  while (board.length < BOARD_SIZE && attempts < 5000) {
    attempts++;
    const c = randomCharacter();
    if (board.every(o => visualDiff(o, c) >= MIN_VISUAL_DIFF)) board.push(c);
  }
  if (board.length < BOARD_SIZE) return null;

  const splitsOk = questionSplits(board).every(s => s.yes >= MIN_YES && s.yes <= MAX_YES);
  return splitsOk ? board : null;
}

function generateBoard() {
  for (let i = 0; i < 2000; i++) {
    const board = tryBuildBoard();
    if (!board) continue;

    const names = { female: shuffle(NAMES.female), male: shuffle(NAMES.male) };
    return board.map((c, id) => ({ id, name: names[c.gender].pop(), ...c }));
  }
  throw new Error("Could not generate a valid board; loosen the constraints.");
}

module.exports = { generateBoard, questionSplits, visualDiff, MIN_VISUAL_DIFF, BOARD_SIZE };

// `npm run check-board` prints a sample board and how each question splits it.
if (require.main === module) {
  const t = Date.now();
  const board = generateBoard();
  console.log(`Generated in ${Date.now() - t}ms`);
  console.table(board.map(c => ({ ...c, accessory: c.accessory.join("+") || "-" })));
  console.table(questionSplits(board).map(s => ({ ...s, pct: Math.round((s.yes / board.length) * 100) + "%" })));
}
