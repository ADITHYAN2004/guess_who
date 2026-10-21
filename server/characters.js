// Procedural board generation. Runs on the server only.
const { QUESTIONS } = require("./questions");

const BOARD_SIZE = 30;
const MIN_YES = 3;   // every question must say "yes" for at least 10% of the board
const MAX_YES = 24;  // and at most 80%
const MIN_DIFF = 2;  // any two characters must differ in at least 2 traits (no near-duplicates)

const SKINS = ["light", "tan", "olive", "brown", "dark"];
const HAIR_STYLES = ["bald", "short", "long", "curly", "ponytail", "bun"];
const HAIR_COLORS = ["black", "brown", "blond", "red", "grey"];
const FACIAL_HAIR = ["none", "beard", "mustache"];

const NAMES = {
  female: ["Maya", "Anya", "Clara", "Priya", "Zoe", "Lena", "Ines", "Rosa", "Hana", "Nora",
           "Yara", "Ivy", "Mia", "Tara", "Leila", "Sofia", "Amara", "June", "Kira", "Elsa",
           "Nina", "Ruth", "Gwen", "Aiko", "Bea", "Dina", "Faye", "Lucia", "Olga", "Wren"],
  male:   ["Omar", "Leo", "Sam", "Raj", "Hugo", "Ben", "Kofi", "Ivan", "Tom", "Diego",
           "Max", "Eli", "Kai", "Noah", "Felix", "Arjun", "Jonas", "Theo", "Marco", "Yusuf",
           "Paul", "Hank", "Otto", "Liam", "Bruno", "Cyrus", "Dev", "Emil", "Finn", "Gus"],
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

function randomCharacter() {
  const gender = chance(0.5) ? "female" : "male";
  // Bald is mostly a male trait here, and bald characters have no hair color.
  const hairStyle = gender === "male"
    ? pick(["bald", "short", "short", "long", "curly", "ponytail", "bun"])
    : pick(["bald", "short", "long", "long", "curly", "ponytail", "bun"].filter(s => s !== "bald" || chance(0.3)));
  const hairColor = hairStyle === "bald" ? "none" : pick(HAIR_COLORS);
  const facialHair = gender === "female" ? "none" : pick(FACIAL_HAIR);

  const accessory = [];
  if (chance(0.3)) accessory.push("glasses");
  if (chance(gender === "female" ? 0.45 : 0.15)) accessory.push("earrings");

  // A hat would hide a bald head or a bun, which makes the board unfair, so we forbid those combos.
  const hat = hairStyle !== "bald" && hairStyle !== "bun" && chance(0.25);

  return { gender, skin: pick(SKINS), hairStyle, hairColor, facialHair, accessory, hat };
}

// Flatten into comparable traits so we can count differences.
function traits(c) {
  return [
    c.gender, c.skin, c.hairStyle, c.hairColor, c.facialHair,
    c.accessory.includes("glasses"), c.accessory.includes("earrings"), c.hat,
  ];
}

function diffCount(a, b) {
  const ta = traits(a), tb = traits(b);
  let n = 0;
  for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) n++;
  return n;
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
    if (board.every(o => diffCount(o, c) >= MIN_DIFF)) board.push(c);
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

module.exports = { generateBoard, questionSplits, diffCount, BOARD_SIZE };

// `npm run check-board` prints a sample board and how each question splits it.
if (require.main === module) {
  const t = Date.now();
  const board = generateBoard();
  console.log(`Generated in ${Date.now() - t}ms`);
  console.table(board.map(c => ({ ...c, accessory: c.accessory.join("+") || "-" })));
  console.table(questionSplits(board).map(s => ({ ...s, pct: Math.round((s.yes / board.length) * 100) + "%" })));
}
