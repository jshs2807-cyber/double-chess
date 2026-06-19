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

// Black e7-e5 (move 1), Ng8-f6 (move 2) -> white EP on move 2
{
  const board = emptyBoard();
  set(board, 3, 3, p("w", "p"));
  set(board, 1, 4, p("b", "p"));
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  set(board, 0, 6, p("b", "n"));
  set(board, 7, 6, p("w", "n"));
  let state = base({ board, activePlayer: "b", movePhase: 1 });

  const dbl = ChessEngine.generatePseudoMoves(state, 1, 4).find((m) => m.doublePawn);
  assert(dbl, "black double pawn exists");
  state = GameLogic.afterMove(state, dbl);
  assert(state.enPassant?.row === 2 && state.enPassant?.col === 4, "EP target after black move 1");
  assert(state.movePhase === 2, "black move phase 2");

  const nf6 = ChessEngine.generatePseudoMoves(state, 0, 6).find(
    (m) => m.to.row === 2 && m.to.col === 5
  );
  assert(nf6, "black knight move exists");
  state = GameLogic.afterMove(state, nf6);
  assert(state.enPassant?.row === 2, "EP survives black move 2");
  assert(state.activePlayer === "w" && state.movePhase === 1, "white turn starts");

  const epLegalMove1 = ChessEngine.getLegalMovesForSquare(state, 3, 3);
  const epOnMove1 = epLegalMove1.some((m) => m.to.row === 2 && m.to.col === 4);
  assert(!epOnMove1, "EP blocked on white move 1");

  const wMove1 = ChessEngine.generatePseudoMoves(state, 7, 6).find(
    (m) => m.to.row === 5 && m.to.col === 5
  );
  state = GameLogic.afterMove(state, wMove1);
  assert(state.enPassant?.row === 2, "EP kept through white move 1");
  assert(state.movePhase === 2, "white move phase 2");

  const epLegalMove2 = ChessEngine.getLegalMovesForSquare(state, 3, 3);
  const epOnMove2 = epLegalMove2.some((m) => m.to.row === 2 && m.to.col === 4);
  assert(epOnMove2, "EP legal on white move 2");

  const epFull = ChessEngine.generatePseudoMoves(state, 3, 3).find((m) => m.enPassant);
  assert(epFull && ChessEngine.isMoveLegal(state, epFull, "w"), "EP fully legal");
  state = GameLogic.handleSquareClick(
    GameLogic.handleSquareClick(state, 3, 3),
    2,
    4
  );
  assert(state.board[3][4] === null, "handleSquareClick EP removes victim");
  assert(state.board[2][4]?.color === "w", "handleSquareClick EP lands pawn");
  console.log("PASS: handleSquareClick en passant on move 2");
}

// Standard chess EP on move 1 (immediate single-move turn)
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
  assert(epLegal, "standard EP legal immediately on next turn");
  console.log("PASS: standard EP immediate next turn");
}

// EP expires after response turn ends without capture (double)
{
  const board = emptyBoard();
  set(board, 3, 3, p("w", "p"));
  set(board, 1, 4, p("b", "p"));
  set(board, 7, 4, p("w", "k"));
  set(board, 0, 4, p("b", "k"));
  set(board, 7, 6, p("w", "n"));
  set(board, 0, 6, p("b", "n"));
  let state = base({ board, activePlayer: "b", movePhase: 1 });

  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 1, 4).find((m) => m.doublePawn)
  );
  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 0, 6).find((m) => m.to.row === 2 && m.to.col === 5)
  );
  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 7, 6).find((m) => m.to.row === 5 && m.to.col === 5)
  );
  assert(state.enPassant?.row === 2, "EP kept through white move 1");
  state = GameLogic.afterMove(
    state,
    ChessEngine.generatePseudoMoves(state, 5, 5).find((m) => m.to.row === 3 && m.to.col === 4)
  );
  assert(!state.enPassant, "EP expires after white uses both moves without capturing");
  assert(
    !ChessEngine.getLegalMovesForSquare(state, 3, 3).some(
      (m) => m.to.row === 2 && m.to.col === 4
    ),
    "EP no longer legal next turn"
  );
  console.log("PASS: EP expires after unused response turn");
}

console.log("All en passant tests passed.");
