// Board checks (no server needed): npm run test:board
// Generates many boards and checks every rule the game relies on.
const assert = require("assert");
const { generateBoard, questionSplits, visualDiff, MIN_VISUAL_DIFF, BOARD_SIZE } = require("../server/characters");

const BOARDS = 300;
for (let i = 0; i < BOARDS; i++) {
  const board = generateBoard();
  assert.strictEqual(board.length, BOARD_SIZE, "board size");
  assert.strictEqual(new Set(board.map(c => c.name)).size, BOARD_SIZE, "names are unique");
  board.forEach((c, idx) => assert.strictEqual(c.id, idx, "ids match positions"));

  for (let a = 0; a < board.length; a++) {
    for (let b = a + 1; b < board.length; b++) {
      const d = visualDiff(board[a], board[b]);
      assert(d >= MIN_VISUAL_DIFF, `${board[a].name} and ${board[b].name} look too alike (diff ${d})`);
    }
  }
  for (const c of board) {
    if (c.gender === "female") assert.strictEqual(c.facialHair, "none", "no facial hair on female characters");
    if (c.hairStyle === "bald") assert(!c.hat && c.hairColor === "none", "bald characters show their head");
    if (c.hairStyle === "bun") assert(!c.hat, "a hat would hide a bun");
  }
  for (const s of questionSplits(board)) {
    assert(s.yes >= 3 && s.yes <= 24, `question ${s.id} splits the board badly (${s.yes} yes)`);
  }
}
console.log(`✓ ${BOARDS} boards: no duplicates or look-alikes, unique names, every question useful`);
