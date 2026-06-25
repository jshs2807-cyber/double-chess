import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
const trimmed = script.replace(/\nconst UI = \{[\s\S]*/m, "\n");
const sandbox = { console, Math };
vm.createContext(sandbox);
vm.runInContext(
  `${trimmed}
this.ChessEngine = ChessEngine;
this.GameLogic = GameLogic;
this.createFreestyleBackRank = createFreestyleBackRank;
this.castlingRooksFromBackRank = castlingRooksFromBackRank;
this.buildBoardFromBackRank = buildBoardFromBackRank;
this.createInitialSetup = createInitialSetup;
this.createInitialCastling = createInitialCastling;
`,
  sandbox
);

const {
  ChessEngine,
  GameLogic,
  createFreestyleBackRank,
  castlingRooksFromBackRank,
  buildBoardFromBackRank,
  createInitialCastling,
} = sandbox;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}
function p(color, type) {
  return { color, type };
}
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}
function freestyleState(board, castlingRooks, overrides = {}) {
  return {
    chessMode: "freestyle",
    board,
    castling: createInitialCastling(),
    castlingRooks,
    enPassant: null,
    activePlayer: "w",
    movePhase: 1,
    ...overrides,
  };
}
function squareCol(idx) {
  return idx % 2; // parity = colour bucket
}

// Rule 1: generator always satisfies the FIDE constraints.
{
  for (let i = 0; i < 5000; i += 1) {
    const rank = createFreestyleBackRank();
    assert(rank.length === 8, "back rank length 8");
    const counts = {};
    rank.forEach((t) => (counts[t] = (counts[t] || 0) + 1));
    assert(counts.r === 2 && counts.n === 2 && counts.b === 2 && counts.q === 1 && counts.k === 1,
      "exactly r,r,n,n,b,b,q,k");

    const bishops = rank.map((t, idx) => (t === "b" ? idx : -1)).filter((x) => x >= 0);
    assert(squareCol(bishops[0]) !== squareCol(bishops[1]), "bishops on opposite colours");

    const kingCol = rank.indexOf("k");
    const rookCols = rank.map((t, idx) => (t === "r" ? idx : -1)).filter((x) => x >= 0);
    assert(rookCols[0] < kingCol && kingCol < rookCols[1], "king between the two rooks");
  }
  console.log("PASS: 5000 random freestyle back ranks are all FIDE-legal");
}

// Helper: build a freestyle position from a white back-rank arrangement (kings only on back rank).
function positionFromArrangement(arr) {
  const board = emptyBoard();
  arr.forEach((t, col) => {
    if (t) board[7][col] = p("w", t);
  });
  board[0][4] = p("b", "k"); // lone black king out of the way
  const backRank = arr.slice();
  return { board, castlingRooks: castlingRooksFromBackRank(backRank) };
}

// Rule 2 + 3: destinations are standard (g1/f1, c1/d1) regardless of start files.
{
  // King on b1 (col1), rooks on a1 (col0, queenside) and h1 (col7, kingside).
  const arr = ["r", "k", null, null, null, null, null, "r"];
  const { board, castlingRooks } = positionFromArrangement(arr);
  const s = freestyleState(board, castlingRooks);

  // Kingside castling -> click the h1 rook (col 7).
  const ksMoves = ChessEngine.getLegalMovesForSquare(s, 7, 1);
  const ks = ksMoves.find((m) => m.castle === "K");
  assert(ks && ks.to.row === 7 && ks.to.col === 7, "kingside castle target is the h1 rook");

  const afterKs = GameLogic.tryMove(s, 7, 1, 7, 7);
  assert(afterKs.board[7][6]?.type === "k" && afterKs.board[7][6]?.color === "w", "king to g1");
  assert(afterKs.board[7][5]?.type === "r" && afterKs.board[7][5]?.color === "w", "rook to f1");
  assert(afterKs.board[7][1] === null, "old king square empty");
  assert(afterKs.board[7][7] === null, "old kingside rook square empty");
  assert(afterKs.board[7][0]?.type === "r", "queenside rook untouched");
  assert(afterKs.castling.w.kingside === false && afterKs.castling.w.queenside === false,
    "castling rights cleared after castling");
  console.log("PASS: freestyle kingside castling lands on g1/f1");

  // Queenside castling from the same start -> click the a1 rook (col 0).
  const qs = ChessEngine.getLegalMovesForSquare(s, 7, 1).find((m) => m.castle === "Q");
  assert(qs && qs.to.col === 0, "queenside castle target is the a1 rook");
  const afterQs = GameLogic.tryMove(s, 7, 1, 7, 0);
  assert(afterQs.board[7][2]?.type === "k", "king to c1");
  assert(afterQs.board[7][3]?.type === "r", "rook to d1");
  console.log("PASS: freestyle queenside castling lands on c1/d1");
}

// Rule 3 (zero-square): king already on g1, kingside rook on h1.
{
  const arr = [null, null, null, null, "r", null, "k", "r"]; // queenside rook e1, king g1, rook h1
  const { board, castlingRooks } = positionFromArrangement(arr);
  const s = freestyleState(board, castlingRooks);
  const after = GameLogic.tryMove(s, 7, 6, 7, 7); // king g1 "moves" onto rook h1
  assert(after.board[7][6]?.type === "k", "king stays on g1 (zero-square king move)");
  assert(after.board[7][5]?.type === "r", "rook moved from h1 to f1");
  assert(after.board[7][7] === null, "h1 emptied");
  console.log("PASS: zero-square king move (king already on g1) handled cleanly");
}

// Rook destination overlaps king's start: king f1, kingside rook g1 -> after: king g1, rook f1.
{
  const arr = [null, null, null, null, "r", "k", "r", null]; // qs rook e1, king f1, ks rook g1
  const { board, castlingRooks } = positionFromArrangement(arr);
  const s = freestyleState(board, castlingRooks);
  const after = GameLogic.tryMove(s, 7, 5, 7, 6); // king f1 onto rook g1
  assert(after.board[7][6]?.type === "k", "king to g1");
  assert(after.board[7][5]?.type === "r", "rook to f1 (onto king's old square)");
  assert(after.board[7][4]?.type === "r", "queenside rook e1 untouched");
  console.log("PASS: rook-onto-king's-old-square overlap handled");
}

// Edge: cannot castle through an attacked square.
{
  const arr = ["r", "k", null, null, null, null, null, "r"]; // king b1, rooks a1/h1
  const { board, castlingRooks } = positionFromArrangement(arr);
  board[0][6] = p("b", "r"); // black rook on g8 attacks the whole g-file incl. king dest g1
  const s = freestyleState(board, castlingRooks);
  const ks = ChessEngine.getLegalMovesForSquare(s, 7, 1).find((m) => m.castle === "K");
  assert(!ks, "kingside castling illegal when king destination g1 is attacked");
  console.log("PASS: castling blocked when the king path/destination is attacked");
}

// Edge: cannot castle when a square between is occupied by a non-castling piece.
{
  const arr = ["r", "k", null, "n", null, null, null, "r"]; // knight on d1 blocks kingside path
  const { board, castlingRooks } = positionFromArrangement(arr);
  const s = freestyleState(board, castlingRooks);
  const ks = ChessEngine.getLegalMovesForSquare(s, 7, 1).find((m) => m.castle === "K");
  assert(!ks, "kingside castling illegal when path is blocked");
  console.log("PASS: castling blocked when a piece sits in the path");
}

// Edge: moving the rook first forfeits that side's castling right (arbitrary file).
{
  const arr = ["r", "k", null, null, null, null, null, "r"];
  const { board, castlingRooks } = positionFromArrangement(arr);
  let s = freestyleState(board, castlingRooks);
  // Move the kingside rook h1 -> h5, then back, rights should be gone.
  s = GameLogic.afterMove(s, ChessEngine.generatePseudoMoves(s, 7, 7).find((m) => m.to.row === 3 && m.to.col === 7));
  assert(s.castling.w.kingside === false, "kingside right lost after moving the h-file rook");
  assert(s.castling.w.queenside === true, "queenside right intact");
  console.log("PASS: moving a freestyle rook forfeits only its own castling right");
}

// Regression: standard chess castling is untouched (kingside e1->g1, rook h1->f1).
{
  const board = emptyBoard();
  board[7][4] = p("w", "k"); // e1
  board[7][7] = p("w", "r"); // h1
  board[7][0] = p("w", "r"); // a1
  board[0][4] = p("b", "k"); // e8
  const s = {
    chessMode: "standard",
    board,
    castling: createInitialCastling(),
    castlingRooks: { w: { kingside: 7, queenside: 0 }, b: { kingside: 7, queenside: 0 } },
    enPassant: null,
    activePlayer: "w",
    movePhase: 1,
  };

  const ks = ChessEngine.getLegalMovesForSquare(s, 7, 4).find((m) => m.castle === "K");
  assert(ks && ks.to.col === 6, "standard kingside castle target is g1 (col 6)");
  const after = GameLogic.tryMove(s, 7, 4, 7, 6);
  assert(after.board[7][6]?.type === "k", "standard: king to g1");
  assert(after.board[7][5]?.type === "r", "standard: rook to f1");
  assert(after.board[7][4] === null && after.board[7][7] === null, "standard: origins cleared");

  const qs = ChessEngine.getLegalMovesForSquare(s, 7, 4).find((m) => m.castle === "Q");
  assert(qs && qs.to.col === 2, "standard queenside castle target is c1 (col 2)");
  const afterQ = GameLogic.tryMove(s, 7, 4, 7, 2);
  assert(afterQ.board[7][2]?.type === "k" && afterQ.board[7][3]?.type === "r", "standard queenside ok");
  console.log("PASS: standard chess castling unchanged");
}

console.log("All freestyle tests passed.");
