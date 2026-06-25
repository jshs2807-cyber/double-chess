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
this.createInitialCastling = createInitialCastling;
`,
  sandbox
);

const { ChessEngine, createInitialCastling } = sandbox;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}
function p(color, type) {
  return { color, type };
}
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}
function state(board, activePlayer, overrides = {}) {
  return {
    chessMode: "double",
    board,
    castling: createInitialCastling(),
    enPassant: null,
    activePlayer,
    movePhase: 1,
    ...overrides,
  };
}
{
  const board = emptyBoard();
  board[7][4] = p("w", "k"); // e1
  board[6][4] = p("b", "q"); // e2
  board[0][4] = p("b", "k"); // e8
  const s = state(board, "w", { chessMode: "standard" });

  assert(ChessEngine.isInCheck(s, "w"), "king in contact check from queen");
  const cap = ChessEngine.getLegalMovesForSquare(s, 7, 4).find(
    (m) => m.to.row === 6 && m.to.col === 4
  );
  assert(cap, "king must capture adjacent checking queen");
  assert(
    ChessEngine.getGameResult(s, "w", "b").status === "ongoing",
    "capturing the checker is not checkmate"
  );
  console.log("PASS: contact check — king captures adjacent unprotected queen");
}

// Contact check: horizontal adjacent rook.
{
  const board = emptyBoard();
  board[7][4] = p("w", "k");
  board[7][5] = p("b", "r");
  board[0][0] = p("b", "k");
  const s = state(board, "w");
  assert(
    ChessEngine.getLegalMovesForSquare(s, 7, 4).some((m) => m.to.row === 7 && m.to.col === 5),
    "king captures adjacent rook"
  );
  assert(ChessEngine.getGameResult(s, "w", "b").status === "ongoing");
  console.log("PASS: contact check — king captures adjacent rook");
}

// Contact check in double chess on Move 1 while in check.
{
  const board = emptyBoard();
  board[7][7] = p("w", "k");
  board[6][6] = p("b", "q");
  board[0][0] = p("b", "k");
  const s = state(board, "w", { chessMode: "double", movePhase: 1 });
  assert(ChessEngine.getGameResult(s, "w", "b").status === "ongoing");
  console.log("PASS: double chess contact check capture on Move 1");
}

// Discovered check after capture: queen unprotected but landing square still attacked -> checkmate.
{
  const board = emptyBoard();
  board[7][4] = p("w", "k"); // e1
  board[6][4] = p("b", "q"); // e2 checks
  board[0][4] = p("b", "r"); // e8 rook still attacks e-file after capture
  const s = state(board, "w");
  const cap = ChessEngine.getLegalMovesForSquare(s, 7, 4).find(
    (m) => m.to.row === 6 && m.to.col === 4
  );
  assert(!cap, "capturing queen on e2 still leaves king on attacked e2");
  assert(ChessEngine.getGameResult(s, "w", "b").status === "checkmate");
  console.log("PASS: capture illegal when landing square stays attacked (not a false mate bug)");
}

// Scenario: white king on a1 (7,0) is checked by an unprotected black pawn on b2 (6,1).
// The pawn attacks a1 diagonally. The king's only escape is to capture the pawn.
// Expected: NOT checkmate (king can capture the unprotected checker).
{
  const board = emptyBoard();
  board[7][0] = p("w", "k"); // a1
  board[6][1] = p("b", "p"); // b2 -> attacks a1
  board[0][7] = p("b", "k"); // h8 (far away)
  const s = state(board, "w");

  assert(ChessEngine.isInCheck(s, "w"), "white king should be in check");

  // King capturing the checking pawn must be a legal move.
  const kingMoves = ChessEngine.getLegalMovesForSquare(s, 7, 0);
  const capturesChecker = kingMoves.some((m) => m.to.row === 6 && m.to.col === 1);
  assert(capturesChecker, "king must be able to capture the unprotected checking pawn");

  const result = ChessEngine.getGameResult(s, "w", "b");
  assert(result.status === "ongoing", `expected ongoing, got ${result.status}`);
  console.log("PASS: king captures the only (unprotected) checker -> not checkmate");
}

// Scenario: real checkmate is still detected. Black king h8 (0,7), white queen g7 (1,6)
// protected by white king f6 (2,5). No escape, no capture, no block.
{
  const board = emptyBoard();
  board[0][7] = p("b", "k"); // h8
  board[1][6] = p("w", "q"); // g7 (protected by king, attacks h8)
  board[2][5] = p("w", "k"); // f6 protects g7
  const s = state(board, "b");

  assert(ChessEngine.isInCheck(s, "b"), "black king should be in check");
  const result = ChessEngine.getGameResult(s, "b", "w");
  assert(result.status === "checkmate", `expected checkmate, got ${result.status}`);
  console.log("PASS: genuine back-rank-style checkmate still detected");
}

// Scenario: king cannot capture a *protected* checker -> still checkmate.
// White king h1 (7,7); black queen g2 (6,6) checks it and is protected by black bishop f3 (5,5).
// King squares g1 (7,6) and h2 (6,7) are attacked by the queen; capturing g2 is illegal
// because the bishop defends it. No other escape -> checkmate.
{
  const board = emptyBoard();
  board[7][7] = p("w", "k"); // h1
  board[6][6] = p("b", "q"); // g2 checks h1
  board[5][5] = p("b", "b"); // f3 protects g2
  board[0][0] = p("b", "k"); // a8 (far away)
  const s = state(board, "w");

  assert(ChessEngine.isInCheck(s, "w"), "white king should be in check");
  const capturesChecker = ChessEngine.getLegalMovesForSquare(s, 7, 7).some(
    (m) => m.to.row === 6 && m.to.col === 6
  );
  assert(!capturesChecker, "king must NOT be able to capture a protected checker");
  const result = ChessEngine.getGameResult(s, "w", "b");
  assert(result.status === "checkmate", `expected checkmate, got ${result.status}`);
  console.log("PASS: capturing a protected checker is illegal -> checkmate stands");
}

// Scenario: stalemate unaffected. Black king h8, white queen f7 (controls escapes,
// not giving check), white king f6. Black not in check, no legal move -> stalemate.
{
  const board = emptyBoard();
  board[0][7] = p("b", "k"); // h8
  board[1][5] = p("w", "q"); // f7
  board[2][5] = p("w", "k"); // f6
  const s = state(board, "b");

  assert(!ChessEngine.isInCheck(s, "b"), "black king should NOT be in check");
  const result = ChessEngine.getGameResult(s, "b", "w");
  assert(result.status === "stalemate", `expected stalemate, got ${result.status}`);
  console.log("PASS: stalemate still detected");
}

console.log("All checkmate tests passed.");
