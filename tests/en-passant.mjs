import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
const trimmed = script.replace(/\nconst UI = \{[\s\S]*/m, "\n");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  `${trimmed}
this.ChessEngine = ChessEngine;
this.GameLogic = GameLogic;
this.createInitialBoard = createInitialBoard;
this.createInitialCastling = createInitialCastling;
`,
  sandbox
);

const { ChessEngine, GameLogic, createInitialBoard, createInitialCastling } = sandbox;

function emptyBoard() {
  const board = [];
  for (let r = 0; r < 8; r += 1) {
    board.push(Array(8).fill(null));
  }
  return board;
}

function base(overrides = {}) {
  return {
    chessMode: "double",
    board: emptyBoard(),
    castling: createInitialCastling(),
    enPassant: null,
    activePlayer: "w",
    movePhase: 1,
    turnStartedInCheck: false,
    screen: "game",
    gameOver: false,
    timers: { w: 300, b: 300 },
    timerRunning: false,
    ...overrides,
  };
}

function p(color, type) {
  return { color, type };
}

function set(board, row, col, piece) {
  board[row][col] = piece;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Rule 3: capturer plays en passant on Move 1.
// Black e7-e5 (Move 1) + Ng8-f6 (Move 2) -> white captures en passant on its Move 1.
{
  const board = emptyBoard();
  set(board, 3, 3, p("w", "p")); // d5
  set(board, 1, 4, p("b", "p")); // e7
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  set(board, 0, 6, p("b", "n")); // g8
  set(board, 7, 6, p("w", "n")); // g1
  let state = base({ board, activePlayer: "b", movePhase: 1 });

  const dbl = ChessEngine.generatePseudoMoves(state, 1, 4).find((m) => m.doublePawn);
  assert(dbl, "black double pawn exists");
  state = GameLogic.afterMove(state, dbl);
  assert(state.enPassant?.row === 2 && state.enPassant?.col === 4, "EP target after black Move 1");
  assert(state.movePhase === 2, "black Move phase 2");

  // Rule 2: target persists through the creator's own Move 2 (different piece).
  const nf6 = ChessEngine.generatePseudoMoves(state, 0, 6).find(
    (m) => m.to.row === 2 && m.to.col === 5
  );
  assert(nf6, "black knight move exists");
  state = GameLogic.afterMove(state, nf6);
  assert(state.enPassant?.row === 2, "EP survives black Move 2");
  assert(state.activePlayer === "w" && state.movePhase === 1, "white turn starts on Move 1");

  // Rule 3: en passant is legal on white's Move 1.
  const epOnMove1 = ChessEngine.getLegalMovesForSquare(state, 3, 3).some(
    (m) => m.to.row === 2 && m.to.col === 4
  );
  assert(epOnMove1, "EP legal on white Move 1");

  const epFull = ChessEngine.generatePseudoMoves(state, 3, 3).find((m) => m.enPassant);
  assert(epFull && ChessEngine.isMoveLegal(state, epFull, "w"), "EP fully legal on Move 1");
  state = GameLogic.handleSquareClick(GameLogic.handleSquareClick(state, 3, 3), 2, 4);
  assert(state.board[3][4] === null, "EP removes the passed pawn (e5)");
  assert(state.board[2][4]?.color === "w", "white pawn lands on e6");
  console.log("PASS: capturer plays en passant on Move 1");
}

// Rule 4: if the capturer skips EP on Move 1, the target dies before Move 2.
{
  const board = emptyBoard();
  set(board, 3, 3, p("w", "p")); // d5
  set(board, 1, 4, p("b", "p")); // e7
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  set(board, 0, 6, p("b", "n")); // g8
  set(board, 7, 6, p("w", "n")); // g1
  let state = base({ board, activePlayer: "b", movePhase: 1 });

  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 1, 4).find((m) => m.doublePawn)
  );
  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 0, 6).find((m) => m.to.row === 2 && m.to.col === 5)
  );
  assert(state.activePlayer === "w" && state.movePhase === 1, "white Move 1");

  // White makes a non-EP Move 1 instead.
  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 7, 6).find((m) => m.to.row === 5 && m.to.col === 5)
  );
  assert(state.movePhase === 2, "white Move phase 2");
  assert(!state.enPassant, "EP target cleared right after white Move 1");
  const epOnMove2 = ChessEngine.getLegalMovesForSquare(state, 3, 3).some(
    (m) => m.to.row === 2 && m.to.col === 4
  );
  assert(!epOnMove2, "EP impossible on white Move 2");
  console.log("PASS: en passant dies if Move 1 skips it");
}

// Rule 1 + 2: target created from a Move 1 double push survives the creator's full turn,
// and the opponent may capture it on their Move 1.
{
  const board = emptyBoard();
  set(board, 6, 3, p("w", "p")); // d2
  set(board, 4, 2, p("b", "p")); // c4
  set(board, 7, 1, p("w", "n")); // b1
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  let state = base({ board, activePlayer: "w", movePhase: 1 });

  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 6, 3).find((m) => m.doublePawn)
  );
  assert(state.enPassant?.row === 5 && state.enPassant?.col === 3, "EP target d3 after d2-d4");
  assert(state.movePhase === 2, "white Move phase 2");

  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 7, 1).find((m) => m.to.row === 5 && m.to.col === 2)
  );
  assert(state.enPassant?.row === 5, "EP target survives white Move 2");
  assert(state.activePlayer === "b" && state.movePhase === 1, "black turn starts on Move 1");

  const epLegal = ChessEngine.getLegalMovesForSquare(state, 4, 2).some(
    (m) => m.to.row === 5 && m.to.col === 3
  );
  assert(epLegal, "black EP legal on Move 1");
  state = GameLogic.handleSquareClick(GameLogic.handleSquareClick(state, 4, 2), 5, 3);
  assert(state.board[4][3] === null, "EP removes the passed pawn (d4)");
  assert(state.board[5][3]?.color === "b", "black pawn lands on d3");
  console.log("PASS: Move 1 double push target persists and is captured on opponent Move 1");
}

// Rule 1: two separate single-square pushes never create an en passant target.
{
  const board = emptyBoard();
  set(board, 6, 3, p("w", "p")); // d2
  set(board, 4, 2, p("b", "p")); // c4
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  let state = base({ board, activePlayer: "w", movePhase: 1 });

  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 6, 3).find((m) => m.to.row === 5 && !m.doublePawn)
  );
  assert(!state.enPassant, "no EP target after single push (Move 1)");
  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 5, 3).find((m) => m.to.row === 4)
  );
  assert(!state.enPassant, "no EP target after second single push (Move 2)");
  assert(state.activePlayer === "b", "black to move");
  const epLegal = ChessEngine.getLegalMovesForSquare(state, 4, 2).some(
    (m) => m.to.row === 5 && m.to.col === 3
  );
  assert(!epLegal, "no en passant against two single pushes");
  console.log("PASS: two single pushes never enable en passant");
}

// Standard chess unchanged: en passant on the single immediate reply move.
{
  const board = emptyBoard();
  set(board, 3, 3, p("w", "p"));
  set(board, 1, 4, p("b", "p"));
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  let state = base({ board, chessMode: "standard", activePlayer: "b", movePhase: 1 });

  const dbl = ChessEngine.generatePseudoMoves(state, 1, 4).find((m) => m.doublePawn);
  state = GameLogic.afterMove(state, dbl);
  assert(state.activePlayer === "w", "white to move in standard");
  const epLegal = ChessEngine.getLegalMovesForSquare(state, 3, 3).some(
    (m) => m.to.row === 2 && m.to.col === 4
  );
  assert(epLegal, "standard EP legal immediately on the reply move");
  console.log("PASS: standard en passant immediate reply");
}

console.log("All en passant tests passed.");
