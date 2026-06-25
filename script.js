/**
 * Double chess.com — game logic + UI
 * ChessEngine: pure rules (no DOM). GameLogic: state transitions. UI: rendering.
 */

const TIMER_SECONDS = 5 * 60;
const MATCHMAKING_DELAY_MS = 3000;

/**
 * Time controls (compatible with every chess mode).
 *  base       — starting seconds per side
 *  increment  — seconds added to a player's clock when that player's full turn completes
 * In Double Chess a "turn" can be two moves; the increment is applied exactly once, when the
 * turn passes to the opponent (handled in GameLogic.completeTurn), never after Move 1.
 */
const TIME_CONTROLS = {
  bullet: { id: "bullet", label: "Bullet", sub: "1 min", base: 60, increment: 0 },
  blitz: { id: "blitz", label: "Blitz", sub: "3 min", base: 180, increment: 0 },
  blitz33: { id: "blitz33", label: "Blitz 3|3", sub: "3 min + 3 sec / turn", base: 180, increment: 3 },
  rapid: { id: "rapid", label: "Rapid", sub: "10 min", base: 600, increment: 0 },
};
const DEFAULT_TIME_CONTROL = "blitz";

/** Clock granularity: tick 10×/second so sub-10s tenths update smoothly. */
const TICK_MS = 100;
const TICK_SECONDS = TICK_MS / 1000;

function getTimeControl(id) {
  return TIME_CONTROLS[id] || TIME_CONTROLS[DEFAULT_TIME_CONTROL];
}

/** UI-only RhosGFX piece assets (CC0). Game logic still uses piece.type. */
const PIECE_ASSET_TYPES = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "P" };

function getPieceAssetSrc(color, type) {
  const prefix = color === "w" ? "w" : "b";
  const code = PIECE_ASSET_TYPES[type] || "P";
  return `assets/pieces/rhosgfx/${prefix}${code}.svg`;
}

const SCREENS = [
  "home",
  "mode",
  "time",
  "match",
  "room-lobby",
  "room-join",
  "room-wait",
  "game",
];
const OPPONENT = { w: "b", b: "w" };

const FIREBASE_PLACEHOLDER_KEY = "YOUR_API_KEY";
/** true + Firebase 설정 완료 시 Firebase 사용 (현재는 로컬 테스트 모드) */
const USE_FIREBASE_MULTIPLAYER = false;
const LOCAL_ROOM_PREFIX = "dc_room_";
const BC_CHANNEL_NAME = "dc-chess-rooms";
const LOCAL_POLL_MS = 400;

/* ------------------------------------------------------------------ */
/* Chess engine (pure)                                                 */
/* ------------------------------------------------------------------ */

const ChessEngine = {
  cloneBoard(board) {
    return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  },

  cloneCastling(castling) {
    return {
      w: { ...castling.w },
      b: { ...castling.b },
    };
  },

  cloneCastlingRooks(rooks) {
    if (!rooks) return createInitialCastlingRooks();
    return { w: { ...rooks.w }, b: { ...rooks.b } };
  },

  cloneState(state) {
    return {
      ...state,
      board: this.cloneBoard(state.board),
      castling: this.cloneCastling(state.castling),
      castlingRooks: this.cloneCastlingRooks(state.castlingRooks),
      enPassant: state.enPassant ? { ...state.enPassant } : null,
      selectedSquare: state.selectedSquare ? { ...state.selectedSquare } : null,
      legalMoves: state.legalMoves ? state.legalMoves.map((m) => ({ ...m, to: { ...m.to } })) : [],
      lastMove: state.lastMove
        ? {
            ...state.lastMove,
            from: { ...state.lastMove.from },
            to: { ...state.lastMove.to },
          }
        : null,
      lastMovedSquare: state.lastMovedSquare ? { ...state.lastMovedSquare } : null,
    };
  },

  inBounds(row, col) {
    return row >= 0 && row < 8 && col >= 0 && col < 8;
  },

  getPiece(board, row, col) {
    if (!this.inBounds(row, col)) return null;
    return board[row][col];
  },

  findKing(board, color) {
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const p = board[row][col];
        if (p && p.color === color && p.type === "k") {
          return { row, col };
        }
      }
    }
    return null;
  },

  isSquareAttacked(board, row, col, byColor) {
    const pawnDir = byColor === "w" ? 1 : -1;
    for (const dc of [-1, 1]) {
      const pr = row + pawnDir;
      const pc = col + dc;
      const pawn = this.getPiece(board, pr, pc);
      if (pawn && pawn.color === byColor && pawn.type === "p") {
        return true;
      }
    }

    const knightOffsets = [
      [-2, -1], [-2, 1], [-1, -2], [-1, 2],
      [1, -2], [1, 2], [2, -1], [2, 1],
    ];
    for (const [dr, dc] of knightOffsets) {
      const p = this.getPiece(board, row + dr, col + dc);
      if (p && p.color === byColor && p.type === "n") return true;
    }

    const kingOffsets = [
      [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
    ];
    for (const [dr, dc] of kingOffsets) {
      const p = this.getPiece(board, row + dr, col + dc);
      if (p && p.color === byColor && p.type === "k") return true;
    }

    const bishopDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (const [dr, dc] of bishopDirs) {
      let r = row + dr;
      let c = col + dc;
      while (this.inBounds(r, c)) {
        const p = board[r][c];
        if (p) {
          if (p.color === byColor && (p.type === "b" || p.type === "q")) return true;
          break;
        }
        r += dr;
        c += dc;
      }
    }

    const rookDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dr, dc] of rookDirs) {
      let r = row + dr;
      let c = col + dc;
      while (this.inBounds(r, c)) {
        const p = board[r][c];
        if (p) {
          if (p.color === byColor && (p.type === "r" || p.type === "q")) return true;
          break;
        }
        r += dr;
        c += dc;
      }
    }

    return false;
  },

  isInCheck(state, color) {
    const king = this.findKing(state.board, color);
    if (!king) return false;
    return this.isSquareAttacked(state.board, king.row, king.col, OPPONENT[color]);
  },

  /**
   * Castling-only safety: the king may not start in, pass through, or land on an
   * attacked square. This walks every square from the king's origin to the destination.
   * NOTE: This must NOT be used for ordinary king moves — because it inspects the king's
   * CURRENT square, a king that is in check would always fail here, which previously made
   * legal escapes (including capturing the checking piece) look impossible. Ordinary king
   * moves are validated by the make-move simulation in isMoveLegal instead.
   */
  isKingPathSafe(board, fromRow, fromCol, toRow, toCol, color) {
    const dr = Math.sign(toRow - fromRow);
    const dc = Math.sign(toCol - fromCol);
    let r = fromRow;
    let c = fromCol;
    const opponent = OPPONENT[color];

    while (true) {
      if (this.isSquareAttacked(board, r, c, opponent)) {
        return false;
      }
      if (r === toRow && c === toCol) break;
      r += dr;
      c += dc;
    }
    return true;
  },

  /** FEN en-passant target: the square the double-advancing pawn passed over. */
  enPassantTarget(fromRow, toRow, fromCol) {
    return { row: (fromRow + toRow) / 2, col: fromCol };
  },

  enPassantCaptureColor(ep) {
    if (ep.captureColor) return ep.captureColor;
    return ep.row === 2 ? "w" : "b";
  },

  /**
   * Double Chess: the capturing side may only play en passant on Move 1 of its turn.
   * In standard chess it is always allowed on the (single) move that follows.
   */
  canPlayEnPassant(state, move) {
    if (!move.enPassant) return true;
    if (state.chessMode !== "double") return true;
    return state.movePhase === 1;
  },

  /** Active player can legally capture en passant in the current position right now. */
  canCaptureEnPassantNow(state) {
    if (!state.enPassant || state.gameOver) return false;
    if (this.enPassantCaptureColor(state.enPassant) !== state.activePlayer) return false;
    if (state.chessMode === "double" && state.movePhase !== 1) return false;
    return true;
  },

  /**
   * Recompute the en passant target after a move is applied.
   *  - A pawn that advances two squares in one move creates a fresh target for the opponent.
   *  - An en passant capture consumes the target.
   *  - A target the mover could have captured but didn't expires immediately (Double Chess
   *    rule 4: after the capturing side's Move 1 the right is gone).
   *  - A target the mover just created earlier this turn (Move 1 double push) is preserved
   *    through the rest of the mover's turn (rule 2).
   */
  resolveEnPassantAfterMove(state, move, next) {
    if (move.doublePawn) {
      next.enPassant = {
        ...this.enPassantTarget(move.from.row, move.to.row, move.from.col),
        captureColor: OPPONENT[move.piece.color],
      };
      return;
    }

    if (move.enPassant || !state.enPassant) {
      next.enPassant = null;
      return;
    }

    const moverIsCapturer =
      this.enPassantCaptureColor(state.enPassant) === move.piece.color;

    if (moverIsCapturer) {
      // Mover held the capture right but chose another move — right is lost at once.
      next.enPassant = null;
    }
    // Otherwise the target belongs to the opponent (mover created it this turn): keep it
    // (next.enPassant is already a clone of state.enPassant via cloneState).
  },

  /** Final castled positions are identical to standard chess for both variants. */
  castleDestCols(side) {
    return side === "K"
      ? { kingDestCol: 6, rookDestCol: 5 } // king g-file, rook f-file
      : { kingDestCol: 2, rookDestCol: 3 }; // king c-file, rook d-file
  },

  /**
   * Freestyle (Chess960) castling validation — fully separate from canCastle so that the
   * standard/double castling rules below are never touched. Start files are arbitrary but the
   * destinations match standard chess (Kingside: K g1 / R f1, Queenside: K c1 / R d1).
   */
  isValidFreestyleCastling(state, color, side) {
    if (state.chessMode !== "freestyle") return false;

    const rights = state.castling[color];
    if (side === "K" && !rights.kingside) return false;
    if (side === "Q" && !rights.queenside) return false;

    const rooks = state.castlingRooks && state.castlingRooks[color];
    if (!rooks) return false;
    const rookCol = side === "K" ? rooks.kingside : rooks.queenside;
    if (rookCol === undefined || rookCol === null) return false;

    const row = color === "w" ? 7 : 0;
    const king = this.findKing(state.board, color);
    if (!king || king.row !== row) return false;
    const kingCol = king.col;

    // The rook must still be sitting on its castling file.
    const rookPiece = state.board[row][rookCol];
    if (!rookPiece || rookPiece.type !== "r" || rookPiece.color !== color) return false;

    // Cannot castle while in check.
    if (this.isInCheck(state, color)) return false;

    const { kingDestCol, rookDestCol } = this.castleDestCols(side);
    const opponent = OPPONENT[color];

    const range = (a, b) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const cols = [];
      for (let c = lo; c <= hi; c += 1) cols.push(c);
      return cols;
    };

    // (1) Every square the king and rook cross — including their destinations — must be empty,
    //     except for the two castling pieces themselves (they don't block their own castling).
    const span = new Set([
      ...range(kingCol, kingDestCol),
      ...range(rookCol, rookDestCol),
    ]);
    for (const c of span) {
      if (c === kingCol || c === rookCol) continue;
      if (state.board[row][c] !== null) return false;
    }

    // (2) The king's current square, each square it passes through, and its destination must
    //     not be attacked. Lift the castling king & rook first so they can't falsely shield a
    //     square from an enemy sliding piece (FIDE: the king is not its own blocker here).
    const testBoard = this.cloneBoard(state.board);
    testBoard[row][kingCol] = null;
    testBoard[row][rookCol] = null;
    for (const c of range(kingCol, kingDestCol)) {
      if (this.isSquareAttacked(testBoard, row, c, opponent)) return false;
    }

    return true;
  },

  canCastle(state, color, side) {
    const rights = state.castling[color];
    if (side === "K" && !rights.kingside) return false;
    if (side === "Q" && !rights.queenside) return false;
    if (this.isInCheck(state, color)) return false;

    const row = color === "w" ? 7 : 0;
    const kingCol = 4;

    if (side === "K") {
      if (state.board[row][5] || state.board[row][6]) return false;
      if (
        this.isSquareAttacked(state.board, row, kingCol, OPPONENT[color]) ||
        this.isSquareAttacked(state.board, row, 5, OPPONENT[color]) ||
        this.isSquareAttacked(state.board, row, 6, OPPONENT[color])
      ) {
        return false;
      }
      const rook = state.board[row][7];
      return rook && rook.color === color && rook.type === "r";
    }

    if (state.board[row][1] || state.board[row][2] || state.board[row][3]) return false;
    if (
      this.isSquareAttacked(state.board, row, kingCol, OPPONENT[color]) ||
      this.isSquareAttacked(state.board, row, 3, OPPONENT[color]) ||
      this.isSquareAttacked(state.board, row, 2, OPPONENT[color])
    ) {
      return false;
    }
    const rook = state.board[row][0];
    return rook && rook.color === color && rook.type === "r";
  },

  generatePseudoMoves(state, fromRow, fromCol) {
    const board = state.board;
    const piece = board[fromRow][fromCol];
    if (!piece) return [];

    const moves = [];
    const { color, type } = piece;
    const forward = color === "w" ? -1 : 1;
    const startRow = color === "w" ? 6 : 1;
    const promoRow = color === "w" ? 0 : 7;

    const push = (toRow, toCol, extra = {}) => {
      if (!this.inBounds(toRow, toCol)) return;
      const target = board[toRow][toCol];
      if (target && target.color === color) return;
      moves.push({
        from: { row: fromRow, col: fromCol },
        to: { row: toRow, col: toCol },
        piece: { ...piece },
        captured: target ? { ...target } : null,
        promotion: null,
        castle: null,
        enPassant: false,
        ...extra,
      });
    };

    if (type === "p") {
      const oneRow = fromRow + forward;
      if (this.inBounds(oneRow, fromCol) && !board[oneRow][fromCol]) {
        if (oneRow === promoRow) {
          push(oneRow, fromCol, { promotion: "q" });
        } else {
          push(oneRow, fromCol);
          const twoRow = fromRow + forward * 2;
          if (fromRow === startRow && !board[twoRow][fromCol]) {
            push(twoRow, fromCol, { doublePawn: true });
          }
        }
      }

      for (const dc of [-1, 1]) {
        const capRow = fromRow + forward;
        const capCol = fromCol + dc;
        if (!this.inBounds(capRow, capCol)) continue;
        const target = board[capRow][capCol];
        if (target && target.color !== color) {
          const promo = capRow === promoRow ? { promotion: "q" } : {};
          push(capRow, capCol, { captured: { ...target }, ...promo });
        }
      }

      if (state.enPassant) {
        const ep = state.enPassant;
        const epRank = color === "w" ? 3 : 4;
        const victimRow = ep.row - forward;
        if (
          fromRow === epRank &&
          fromRow + forward === ep.row &&
          Math.abs(fromCol - ep.col) === 1 &&
          this.inBounds(victimRow, ep.col)
        ) {
          const victim = board[victimRow][ep.col];
          if (victim && victim.type === "p" && victim.color !== color) {
            moves.push({
              from: { row: fromRow, col: fromCol },
              to: { row: ep.row, col: ep.col },
              piece: { ...piece },
              captured: { ...victim },
              promotion: null,
              castle: null,
              enPassant: true,
              enPassantCapture: { row: victimRow, col: ep.col },
            });
          }
        }
      }
      return moves;
    }

    if (type === "n") {
      const offsets = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1],
      ];
      for (const [dr, dc] of offsets) {
        const tr = fromRow + dr;
        const tc = fromCol + dc;
        const target = this.getPiece(board, tr, tc);
        if (target && target.color === color) continue;
        if (this.inBounds(tr, tc)) {
          push(tr, tc, { captured: target ? { ...target } : null });
        }
      }
      return moves;
    }

    if (type === "k") {
      const offsets = [
        [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
      ];
      for (const [dr, dc] of offsets) {
        const tr = fromRow + dr;
        const tc = fromCol + dc;
        const target = this.getPiece(board, tr, tc);
        if (target && target.color === color) continue;
        if (this.inBounds(tr, tc)) {
          push(tr, tc, { captured: target ? { ...target } : null });
        }
      }
      if (state.chessMode === "freestyle") {
        // Freestyle: the castling move's destination square IS the rook's square, so the
        // "drop the king on your own rook" gesture maps straight to this move. Standard/double
        // castling below is left exactly as it was.
        const row = fromRow;
        for (const side of ["K", "Q"]) {
          if (this.isValidFreestyleCastling(state, color, side)) {
            const rookCol =
              side === "K"
                ? state.castlingRooks[color].kingside
                : state.castlingRooks[color].queenside;
            moves.push({
              from: { row: fromRow, col: fromCol },
              to: { row, col: rookCol },
              piece: { ...piece },
              captured: null,
              promotion: null,
              castle: side,
              enPassant: false,
            });
          }
        }
      } else {
        if (this.canCastle(state, color, "K")) {
          const row = color === "w" ? 7 : 0;
          moves.push({
            from: { row: fromRow, col: fromCol },
            to: { row, col: 6 },
            piece: { ...piece },
            captured: null,
            promotion: null,
            castle: "K",
            enPassant: false,
          });
        }
        if (this.canCastle(state, color, "Q")) {
          const row = color === "w" ? 7 : 0;
          moves.push({
            from: { row: fromRow, col: fromCol },
            to: { row, col: 2 },
            piece: { ...piece },
            captured: null,
            promotion: null,
            castle: "Q",
            enPassant: false,
          });
        }
      }
      return moves;
    }

    let directions = [];
    if (type === "r") directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    if (type === "b") directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    if (type === "q") {
      directions = [
        [-1, 0], [1, 0], [0, -1], [0, 1],
        [-1, -1], [-1, 1], [1, -1], [1, 1],
      ];
    }

    for (const [dr, dc] of directions) {
      let tr = fromRow + dr;
      let tc = fromCol + dc;
      while (this.inBounds(tr, tc)) {
        const target = board[tr][tc];
        if (!target) {
          push(tr, tc);
        } else {
          if (target.color !== color) {
            push(tr, tc, { captured: { ...target } });
          }
          break;
        }
        tr += dr;
        tc += dc;
      }
    }

    return moves;
  },

  /**
   * Apply a move onto a cloned board array only (no state metadata).
   * Order is strict so captured pieces never linger as ghost attackers:
   *   1) remove en-passant victim (if any)
   *   2) clear destination (capture / remove the checking piece)
   *   3) clear origin
   *   4) place the mover on destination  ← king's new coordinates for safety checks
   *   5) slide the rook (castling only)
   * Standard/double/freestyle piece moves all share this path; freestyle castling is
   * the only special board branch and is kept separate from canCastle/isKingPathSafe.
   */
  applyMoveToBoard(board, move, chessMode, castlingRooks) {
    const { from, to, piece } = move;
    const color = piece.color;

    if (move.castle && chessMode === "freestyle") {
      const row = color === "w" ? 7 : 0;
      const rookCol =
        move.castle === "K" ? castlingRooks[color].kingside : castlingRooks[color].queenside;
      const { kingDestCol, rookDestCol } = this.castleDestCols(move.castle);
      const kingPiece = board[from.row][from.col];
      const rookPiece = board[row][rookCol];
      board[from.row][from.col] = null;
      board[row][rookCol] = null;
      board[row][kingDestCol] = kingPiece;
      board[row][rookDestCol] = rookPiece;
      return;
    }

    if (move.enPassant && move.enPassantCapture) {
      board[move.enPassantCapture.row][move.enPassantCapture.col] = null;
    }

    const placed = move.promotion
      ? { color, type: move.promotion }
      : { ...piece };

    board[to.row][to.col] = null;
    board[from.row][from.col] = null;
    board[to.row][to.col] = placed;

    if (move.castle === "K") {
      const row = color === "w" ? 7 : 0;
      board[row][5] = board[row][7];
      board[row][7] = null;
    } else if (move.castle === "Q") {
      const row = color === "w" ? 7 : 0;
      board[row][3] = board[row][0];
      board[row][0] = null;
    }
  },

  /**
   * After a simulated move, is the given side's king still attacked?
   * For king moves we read the destination directly (step 4 above) instead of scanning
   * the board — this guarantees a king that captured its adjacent checker is evaluated
   * on the capture square only after that checker has been removed from the array.
   */
  isKingSafeAfterSimulatedMove(board, move, playerColor) {
    const kingLoc =
      move.piece.type === "k"
        ? { row: move.to.row, col: move.to.col }
        : this.findKing(board, playerColor);
    if (!kingLoc) return false;
    return !this.isSquareAttacked(board, kingLoc.row, kingLoc.col, OPPONENT[playerColor]);
  },

  /** Immutable apply — never mutates the incoming state or its board */
  applyMove(state, move) {
    const next = this.cloneState(state);
    const board = next.board;
    const { from, to, piece } = move;
    const color = piece.color;

    this.applyMoveToBoard(
      board,
      move,
      state.chessMode,
      state.castlingRooks || createInitialCastlingRooks()
    );

    if (move.castle && state.chessMode === "freestyle") {
      next.castling[color].kingside = false;
      next.castling[color].queenside = false;
      next.enPassant = null;
      return next;
    }

    if (piece.type === "k") {
      next.castling[color].kingside = false;
      next.castling[color].queenside = false;
    }
    if (piece.type === "r") {
      const row = color === "w" ? 7 : 0;
      if (next.chessMode === "freestyle") {
        // Freestyle rooks sit on arbitrary files, so compare against the recorded files.
        const rooks = state.castlingRooks && state.castlingRooks[color];
        if (rooks && from.row === row) {
          if (from.col === rooks.queenside) next.castling[color].queenside = false;
          if (from.col === rooks.kingside) next.castling[color].kingside = false;
        }
      } else {
        if (from.row === row && from.col === 0) next.castling[color].queenside = false;
        if (from.row === row && from.col === 7) next.castling[color].kingside = false;
      }
    }
    if (move.captured && move.captured.type === "r") {
      const capColor = move.captured.color;
      const row = capColor === "w" ? 7 : 0;
      if (next.chessMode === "freestyle") {
        const rooks = state.castlingRooks && state.castlingRooks[capColor];
        if (rooks && to.row === row) {
          if (to.col === rooks.queenside) next.castling[capColor].queenside = false;
          if (to.col === rooks.kingside) next.castling[capColor].kingside = false;
        }
      } else {
        if (to.row === row && to.col === 0) next.castling[capColor].queenside = false;
        if (to.row === row && to.col === 7) next.castling[capColor].kingside = false;
      }
    }

    this.resolveEnPassantAfterMove(state, move, next);

    return next;
  },

  movesMatch(a, b) {
    return (
      a.to.row === b.to.row &&
      a.to.col === b.to.col &&
      a.castle === b.castle &&
      a.enPassant === b.enPassant &&
      a.promotion === b.promotion
    );
  },

  /**
   * Legal if pseudo-legal, king path safe, and the moving player's king is not in check after.
   * @param {string} playerColor - side making the move (defaults to state.activePlayer)
   */
  isMoveLegal(state, move, playerColor = state.activePlayer) {
    if (!this.canPlayEnPassant(state, move)) return false;

    const board = state.board;
    const piece = board[move.from.row][move.from.col];
    if (!piece || piece.color !== playerColor) return false;

    const pseudo = this.generatePseudoMoves(state, move.from.row, move.from.col);
    if (!pseudo.some((m) => this.movesMatch(m, move))) return false;

    // Path-safety only applies to castling (king sliding across multiple squares). For a
    // normal king move/capture we rely solely on the simulated board below: applyMove removes
    // the captured piece, so a king that captures its checker is correctly seen as safe.
    if (piece.type === "k" && move.castle) {
      if (state.chessMode === "freestyle") {
        // Freestyle's `to` is the rook square, so the generic straight-line path check does not
        // apply; isValidFreestyleCastling already verified emptiness and king-path safety.
        if (!this.isValidFreestyleCastling(state, playerColor, move.castle)) return false;
      } else if (
        !this.isKingPathSafe(
          board,
          move.from.row,
          move.from.col,
          move.to.row,
          move.to.col,
          playerColor
        )
      ) {
        return false;
      }
    }

    // Clone the board so the live position is never touched. applyMoveToBoard enforces the
    // capture-first order, then isKingSafeAfterSimulatedMove reads the king on its NEW square
    // only after the captured checker has been removed — fixing false checkmates where a king
    // captures an adjacent, unprotected checking piece (contact check).
    const testBoard = this.cloneBoard(board);
    this.applyMoveToBoard(
      testBoard,
      move,
      state.chessMode,
      state.castlingRooks || createInitialCastlingRooks()
    );
    return this.isKingSafeAfterSimulatedMove(testBoard, move, playerColor);
  },

  hasLegalMoves(state, color) {
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const p = state.board[row][col];
        if (!p || p.color !== color) continue;
        const pseudo = this.generatePseudoMoves(state, row, col);
        for (const move of pseudo) {
          if (this.isMoveLegal(state, move, color)) return true;
        }
      }
    }
    return false;
  },

  getAllLegalMoves(state, color) {
    const moves = [];
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const p = state.board[row][col];
        if (!p || p.color !== color) continue;
        const pseudo = this.generatePseudoMoves(state, row, col);
        for (const move of pseudo) {
          if (this.isMoveLegal(state, move, color)) {
            moves.push(move);
          }
        }
      }
    }
    return moves;
  },

  getLegalMovesForSquare(state, fromRow, fromCol) {
    const color = state.activePlayer;
    const piece = state.board[fromRow][fromCol];
    if (!piece || piece.color !== color) return [];

    const pseudo = this.generatePseudoMoves(state, fromRow, fromCol);
    const legal = [];

    for (const move of pseudo) {
      if (this.isMoveLegal(state, move, color)) {
        legal.push({
          to: { row: move.to.row, col: move.to.col },
          capture: Boolean(move.captured || move.enPassant),
          castle: move.castle,
        });
      }
    }

    return legal;
  },

  /**
   * Checkmate / stalemate for the player who must move next on this position.
   * @param {string} sideToMove
   * @param {string|null} lastMover - who just moved (for checkmate winner); defaults to opponent of sideToMove
   */
  getGameResult(state, sideToMove, lastMover = OPPONENT[sideToMove]) {
    const hasMoves = this.hasLegalMoves(state, sideToMove);
    const inCheck = this.isInCheck(state, sideToMove);

    if (hasMoves) {
      return { status: "ongoing", winner: null };
    }
    if (inCheck) {
      return { status: "checkmate", winner: lastMover };
    }
    return { status: "stalemate", winner: null };
  },
};

/* ------------------------------------------------------------------ */
/* Initial state                                                       */
/* ------------------------------------------------------------------ */

const STANDARD_BACK_RANK = ["r", "n", "b", "q", "k", "b", "n", "r"];

function buildBoardFromBackRank(backRank) {
  const board = [];
  for (let row = 0; row < 8; row += 1) {
    const rank = [];
    for (let col = 0; col < 8; col += 1) {
      if (row === 0) rank.push({ color: "b", type: backRank[col] });
      else if (row === 1) rank.push({ color: "b", type: "p" });
      else if (row === 6) rank.push({ color: "w", type: "p" });
      else if (row === 7) rank.push({ color: "w", type: backRank[col] });
      else rank.push(null);
    }
    board.push(rank);
  }
  return board;
}

function createInitialBoard() {
  return buildBoardFromBackRank(STANDARD_BACK_RANK);
}

function createInitialCastling() {
  return {
    w: { kingside: true, queenside: true },
    b: { kingside: true, queenside: true },
  };
}

/**
 * Freestyle (Chess960) starting back rank — random but FIDE-legal:
 *  - the two bishops sit on opposite-colour squares (even-file vs odd-file index),
 *  - the king is always between the two rooks: the final three empty files are filled
 *    left→right as rook, king, rook, which guarantees that ordering.
 */
function createFreestyleBackRank() {
  const rank = new Array(8).fill(null);
  const emptyFiles = () => {
    const out = [];
    for (let i = 0; i < 8; i += 1) if (rank[i] === null) out.push(i);
    return out;
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  rank[pick([0, 2, 4, 6])] = "b"; // bishop on one square colour
  rank[pick([1, 3, 5, 7])] = "b"; // bishop on the opposite square colour
  rank[pick(emptyFiles())] = "q";
  rank[pick(emptyFiles())] = "n";
  rank[pick(emptyFiles())] = "n";
  const rest = emptyFiles(); // exactly three files, ascending
  rank[rest[0]] = "r";
  rank[rest[1]] = "k";
  rank[rest[2]] = "r";
  return rank;
}

/** Map a back rank to the castling rook files (queenside rook left of king, kingside right). */
function castlingRooksFromBackRank(backRank) {
  const kingCol = backRank.indexOf("k");
  const rookCols = [];
  backRank.forEach((t, i) => {
    if (t === "r") rookCols.push(i);
  });
  const queenside = rookCols.find((c) => c < kingCol);
  const kingside = rookCols.find((c) => c > kingCol);
  return {
    w: { kingside, queenside },
    b: { kingside, queenside },
  };
}

/** Standard / Double Chess rook files: queenside a-file (0), kingside h-file (7). */
function createInitialCastlingRooks() {
  return { w: { kingside: 7, queenside: 0 }, b: { kingside: 7, queenside: 0 } };
}

/**
 * Starting position for a mode. Freestyle randomises the back rank (Black mirrors White on
 * the same files); every other mode keeps the classic layout, so standard/double are untouched.
 */
function createInitialSetup(mode) {
  const backRank =
    mode === "freestyle" ? createFreestyleBackRank() : STANDARD_BACK_RANK;
  return {
    board: buildBoardFromBackRank(backRank),
    castlingRooks:
      mode === "freestyle"
        ? castlingRooksFromBackRank(backRank)
        : createInitialCastlingRooks(),
  };
}

function createAppState() {
  return {
    screen: "home",
    chessMode: null,
    matchType: null,
    board: createInitialBoard(),
    castling: createInitialCastling(),
    castlingRooks: createInitialCastlingRooks(),
    enPassant: null,
    activePlayer: "w",
    movePhase: 1,
    turnStartedInCheck: false,
    boardFlipped: false,
    timeControl: DEFAULT_TIME_CONTROL,
    increment: getTimeControl(DEFAULT_TIME_CONTROL).increment,
    timers: {
      w: getTimeControl(DEFAULT_TIME_CONTROL).base,
      b: getTimeControl(DEFAULT_TIME_CONTROL).base,
    },
    timerRunning: false,
    timerStarted: false,
    gameOver: false,
    gameOverReason: null,
    winner: null,
    selectedSquare: null,
    legalMoves: [],
    lastMove: null,
    lastMovedSquare: null,
    gameOverMessage: null,
    isOnline: false,
    roomCode: null,
    playerRole: null,
    roomRole: null,
    opponentDisconnected: false,
    syncFromRemote: false,
  };
}

function squareName(row, col) {
  return `${"abcdefgh"[col]}${8 - row}`;
}

function canPlayerAct(state) {
  if (state.gameOver || state.opponentDisconnected) return false;
  if (!state.isOnline) return true;
  return state.playerRole === state.activePlayer;
}

function serializeGameForFirebase(state) {
  return {
    board: state.board,
    castling: state.castling,
    castlingRooks: state.castlingRooks,
    enPassant: state.enPassant,
    activePlayer: state.activePlayer,
    movePhase: state.movePhase,
    turnStartedInCheck: state.turnStartedInCheck,
    boardFlipped: state.boardFlipped,
    timers: { ...state.timers },
    timerRunning: state.timerRunning,
    timerStarted: state.timerStarted,
    timeControl: state.timeControl,
    increment: state.increment,
    gameOver: state.gameOver,
    gameOverReason: state.gameOverReason,
    winner: state.winner,
    gameOverMessage: state.gameOverMessage,
    lastMove: state.lastMove,
    lastMovedSquare: state.lastMovedSquare,
    chessMode: state.chessMode,
  };
}

function mergeGameFromFirebase(state, game) {
  if (!game) return state;
  return {
    ...state,
    board: ChessEngine.cloneBoard(game.board),
    castling: ChessEngine.cloneCastling(game.castling),
    castlingRooks: ChessEngine.cloneCastlingRooks(game.castlingRooks),
    enPassant: game.enPassant ? { ...game.enPassant } : null,
    activePlayer: game.activePlayer,
    movePhase: game.movePhase,
    turnStartedInCheck: game.turnStartedInCheck,
    boardFlipped: game.boardFlipped,
    chessMode: game.chessMode ?? state.chessMode,
    timers: { ...game.timers },
    timerRunning: game.timerRunning,
    timerStarted: game.timerStarted ?? state.timerStarted,
    timeControl: game.timeControl ?? state.timeControl,
    increment: game.increment ?? state.increment,
    gameOver: game.gameOver,
    gameOverReason: game.gameOverReason,
    winner: game.winner,
    gameOverMessage: game.gameOverMessage,
    lastMove: game.lastMove,
    lastMovedSquare: game.lastMovedSquare
      ? { ...game.lastMovedSquare }
      : null,
    selectedSquare: null,
    legalMoves: [],
  };
}

/* ------------------------------------------------------------------ */
/* Game logic (state transitions)                                      */
/* ------------------------------------------------------------------ */

const GameLogic = {
  navigate(state, screen) {
    if (!SCREENS.includes(screen)) return state;
    return { ...state, screen };
  },

  setChessMode(state, mode) {
    // Pick the chess variant, then choose a time control before the match type.
    return { ...state, chessMode: mode, screen: "time" };
  },

  setTimeControl(state, timeControlId) {
    const tc = getTimeControl(timeControlId);
    return {
      ...state,
      timeControl: tc.id,
      increment: tc.increment,
      timers: { w: tc.base, b: tc.base },
      timerStarted: false,
      screen: "match",
    };
  },

  setMatchType(state, matchType) {
    return { ...state, matchType };
  },

  resetForNewGame(state) {
    // Freestyle randomises the back rank here; standard/double keep the classic layout.
    const setup = createInitialSetup(state.chessMode);
    const tc = getTimeControl(state.timeControl);
    return {
      ...state,
      board: setup.board,
      castling: createInitialCastling(),
      castlingRooks: setup.castlingRooks,
      enPassant: null,
      activePlayer: "w",
      movePhase: 1,
      turnStartedInCheck: false,
      boardFlipped: false,
      increment: tc.increment,
      timers: { w: tc.base, b: tc.base },
      timerRunning: false,
      timerStarted: false,
      gameOver: false,
      gameOverReason: null,
      winner: null,
      selectedSquare: null,
      legalMoves: [],
      lastMove: null,
      lastMovedSquare: null,
    };
  },

  startGame(state) {
    const next = this.resetForNewGame(state);
    return {
      ...next,
      screen: "game",
      timerRunning: true,
      // Edge case 1: White's clock runs the instant the game starts, regardless of
      // whether the opening move has been played yet.
      timerStarted: true,
      turnStartedInCheck: false,
    };
  },

  finishGame(state, result) {
    const winnerName = result.winner === "w" ? "White" : result.winner === "b" ? "Black" : null;
    let message = "The game has ended.";
    if (result.status === "checkmate") {
      message = `${winnerName} wins by checkmate.`;
    } else if (result.status === "stalemate") {
      message = "Draw by stalemate.";
    }

    return {
      ...state,
      timerRunning: false,
      gameOver: true,
      gameOverReason: result.status,
      winner: result.winner,
      selectedSquare: null,
      legalMoves: [],
      gameOverMessage: message,
    };
  },

  completeTurn(state, lastMove) {
    const mover = state.activePlayer;
    const nextPlayer = OPPONENT[mover];

    // Fischer increment. completeTurn is the single funnel through which a turn ends and passes
    // to the opponent — for standard/freestyle every move reaches it, and for Double Chess only
    // the FULL turn does (Move 2, or Move 1 that gives check). So adding the increment to the
    // mover here applies it exactly once per completed turn, never after Move 1.
    let timers = state.timers;
    if (state.increment > 0 && state.timerStarted) {
      timers = {
        ...timers,
        [mover]: Math.round((timers[mover] + state.increment) * 10) / 10,
      };
    }

    // The target was already resolved by applyMove: a pawn that just advanced two squares
    // leaves a target for nextPlayer (their Move 1); anything else has already been cleared.
    const next = {
      ...state,
      activePlayer: nextPlayer,
      movePhase: 1,
      timers,
      timerStarted: true,
      enPassant: state.enPassant,
      boardFlipped: nextPlayer === "b",
      selectedSquare: null,
      legalMoves: [],
      lastMove,
      lastMovedSquare: lastMove ? { ...lastMove.to } : null,
      turnStartedInCheck: false,
    };
    next.turnStartedInCheck = ChessEngine.isInCheck(next, nextPlayer);
    return next;
  },

  afterMove(state, move) {
    const mover = state.activePlayer;
    let next = ChessEngine.applyMove(state, move);
    next = {
      ...next,
      lastMove: move,
      lastMovedSquare: { ...move.to },
      selectedSquare: null,
      legalMoves: [],
    };

    const opponent = OPPONENT[mover];
    const opponentInCheck = ChessEngine.isInCheck(next, opponent);
    // Only Double Chess grants a second move; standard AND freestyle are single-move modes.
    const isDouble = next.chessMode === "double";

    const turnEndsNow =
      !isDouble ||
      next.movePhase === 2 ||
      (next.movePhase === 1 && opponentInCheck);

    // Only judge checkmate/stalemate when the opponent is about to receive the turn
    if (turnEndsNow) {
      const result = ChessEngine.getGameResult(next, opponent, mover);
      if (result.status !== "ongoing") {
        return this.finishGame(next, result);
      }
      return this.completeTurn(next, move);
    }

    // Double Chess: Move 1 without check — same player continues (no endgame check yet)
    return {
      ...next,
      movePhase: 2,
      turnStartedInCheck: false,
    };
  },

  tryMove(state, fromRow, fromCol, toRow, toCol) {
    if (!canPlayerAct(state)) return state;

    const legal = ChessEngine.getLegalMovesForSquare(state, fromRow, fromCol);
    const match = legal.find((m) => m.to.row === toRow && m.to.col === toCol);
    if (!match) return state;

    const pseudo = ChessEngine.generatePseudoMoves(state, fromRow, fromCol);
    const candidates = pseudo.filter(
      (m) =>
        m.to.row === toRow &&
        m.to.col === toCol &&
        legal.some((l) => l.to.row === m.to.row && l.to.col === m.to.col)
    );
    const fullMove =
      candidates.find((m) => m.enPassant) ||
      candidates.find((m) => ChessEngine.isMoveLegal(state, m, state.activePlayer));
    if (!fullMove || !ChessEngine.isMoveLegal(state, fullMove, state.activePlayer)) {
      return state;
    }

    return this.afterMove(state, fullMove);
  },

  handleSquareClick(state, row, col) {
    if (!canPlayerAct(state)) return state;

    const piece = state.board[row][col];
    const selected = state.selectedSquare;

    if (selected) {
      const selectedPiece = state.board[selected.row][selected.col];

      // Freestyle castling gesture: a selected king dropped onto one of its own rooks.
      // Because the freestyle castling move's destination IS the rook square, a legal castle
      // already lives in legalMoves; this branch just makes the intent explicit and reselects
      // the rook when the drop is not a legal castle. Standard/double are unaffected.
      if (
        state.chessMode === "freestyle" &&
        selectedPiece &&
        selectedPiece.type === "k" &&
        piece &&
        piece.type === "r" &&
        piece.color === selectedPiece.color
      ) {
        const castleMove = state.legalMoves.find(
          (m) => m.castle && m.to.row === row && m.to.col === col
        );
        if (castleMove) {
          return this.tryMove(state, selected.row, selected.col, row, col);
        }
        return this.selectSquare(state, row, col);
      }

      const isLegalDest = state.legalMoves.some(
        (m) => m.to.row === row && m.to.col === col
      );

      if (isLegalDest) {
        return this.tryMove(state, selected.row, selected.col, row, col);
      }

      if (piece && piece.color === state.activePlayer) {
        return this.selectSquare(state, row, col);
      }

      return { ...state, selectedSquare: null, legalMoves: [] };
    }

    if (piece && piece.color === state.activePlayer) {
      return this.selectSquare(state, row, col);
    }

    return state;
  },

  selectSquare(state, row, col) {
    const piece = state.board[row][col];
    if (!piece || piece.color !== state.activePlayer) {
      return { ...state, selectedSquare: null, legalMoves: [] };
    }

    const same =
      state.selectedSquare &&
      state.selectedSquare.row === row &&
      state.selectedSquare.col === col;

    if (same) {
      return { ...state, selectedSquare: null, legalMoves: [] };
    }

    const legalMoves = ChessEngine.getLegalMovesForSquare(state, row, col);
    return {
      ...state,
      selectedSquare: { row, col },
      legalMoves,
    };
  },

  tickTimer(state) {
    if (!state.timerRunning || state.gameOver || state.screen !== "game") {
      return state;
    }
    // Safety guard: clocks only tick once a game has actually started (timerStarted is set
    // true in startGame, so White's clock runs immediately — edge case 1).
    if (!state.timerStarted) return state;

    const key = state.activePlayer;
    const remaining = state.timers[key];
    if (remaining <= 0) return state;

    // Decrement one tick (0.1s) and round to a tenth to keep clean float values.
    const nextRemaining = Math.max(0, Math.round((remaining - TICK_SECONDS) * 10) / 10);
    const timers = { ...state.timers, [key]: nextRemaining };

    if (nextRemaining > 0) {
      return { ...state, timers };
    }

    return {
      ...state,
      timers,
      timerRunning: false,
      gameOver: true,
      gameOverReason: "timeout",
      winner: OPPONENT[key],
      selectedSquare: null,
      legalMoves: [],
      gameOverMessage: `${key === "w" ? "Black" : "White"} wins on time.`,
    };
  },

  leaveGame(state) {
    return this.resetForNewGame({
      ...state,
      screen: "home",
      chessMode: null,
      matchType: null,
      isOnline: false,
      roomCode: null,
      playerRole: null,
      roomRole: null,
      opponentDisconnected: false,
      syncFromRemote: false,
    });
  },
};

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

const UI = {
  elements: {},
  pulseClearTimer: null,

  cacheElements() {
    this.elements = {
      screens: {},
      board: document.getElementById("board"),
      boardFrame: document.getElementById("board-frame"),
      turnIndicator: document.getElementById("turn-indicator"),
      timerWhite: document.getElementById("timer-white"),
      timerBlack: document.getElementById("timer-black"),
      gameModeLabel: document.getElementById("game-mode-label"),
      gameOverOverlay: document.getElementById("game-over-overlay"),
      gameOverTitle: document.getElementById("game-over-title"),
      gameOverMessage: document.getElementById("game-over-message"),
      gameLayout: document.getElementById("game-layout"),
      playerBars: document.querySelectorAll(".player-bar"),
      roomCodeDisplay: document.getElementById("room-code-display"),
      roomCodeInput: document.getElementById("room-code-input"),
      roomJoinError: document.getElementById("room-join-error"),
      disconnectOverlay: document.getElementById("disconnect-overlay"),
      onlineRoomBadge: document.getElementById("online-room-badge"),
      onlineWaitHint: document.getElementById("online-wait-hint"),
    };

    document.querySelectorAll("[data-screen]").forEach((el) => {
      this.elements.screens[el.dataset.screen] = el;
    });
  },

  formatTime(seconds) {
    const total = Math.max(0, seconds);
    // Under 10 seconds: show tenths (e.g. "9.5") for last-second tension.
    if (total < 10) {
      return total.toFixed(1);
    }
    const whole = Math.ceil(total);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  },

  isLegalMoveSquare(state, row, col) {
    return state.legalMoves.some((m) => m.to.row === row && m.to.col === col);
  },

  isCaptureMove(state, row, col) {
    const m = state.legalMoves.find(
      (mv) => mv.to.row === row && mv.to.col === col
    );
    return m ? m.capture : false;
  },

  render(state, prevState = null) {
    SCREENS.forEach((name) => {
      const el = this.elements.screens[name];
      if (!el) return;
      const active = state.screen === name;
      el.classList.toggle("screen--active", active);
      el.hidden = !active;
    });

    if (state.screen === "room-wait" && state.roomCode) {
      this.updateRoomWaitDisplay(state.roomCode);
    }

    if (state.screen === "game") {
      this.renderGame(state, prevState);
    }
  },

  updateRoomWaitDisplay(code) {
    if (this.elements.roomCodeDisplay) {
      this.elements.roomCodeDisplay.textContent = code;
    }
  },

  showJoinError(message) {
    const el = this.elements.roomJoinError;
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  },

  selectionEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.row === b.row && a.col === b.col;
  },

  legalMovesEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((m, i) => m.to.row === b[i].to.row && m.to.col === b[i].to.col);
  },

  renderGame(state, prevState) {
    const modeLabel =
      state.chessMode === "standard"
        ? "Standard Chess"
        : state.chessMode === "freestyle"
        ? "Freestyle Chess"
        : "Double Chess";
    this.elements.gameModeLabel.textContent = modeLabel;

    this.elements.timerWhite.textContent = this.formatTime(state.timers.w);
    this.elements.timerBlack.textContent = this.formatTime(state.timers.b);

    const applyUrgency = (el, color) => {
      const t = state.timers[color];
      const active = state.activePlayer === color && !state.gameOver;
      // Amber warning under 20s, red+pulse under 10s — only for the side whose clock runs.
      el.classList.toggle("player-timer--low", active && t <= 20 && t > 10);
      el.classList.toggle("player-timer--critical", active && t <= 10 && t > 0);
    };
    applyUrgency(this.elements.timerWhite, "w");
    applyUrgency(this.elements.timerBlack, "b");

    this.elements.playerBars.forEach((bar) => {
      const player = bar.dataset.player;
      const isWhite = player === "white";
      const active =
        (isWhite && state.activePlayer === "w") ||
        (!isWhite && state.activePlayer === "b");
      bar.classList.toggle("player-bar--active", active && !state.gameOver);
    });

    const playerName = state.activePlayer === "w" ? "White" : "Black";
    const inCheck = ChessEngine.isInCheck(state, state.activePlayer);
    let phaseLabel = "";
    if (state.chessMode === "double" && !state.gameOver) {
      phaseLabel = ` · Move ${state.movePhase}`;
    }
    let epLabel = "";
    if (ChessEngine.canCaptureEnPassantNow(state)) {
      epLabel = ` · En passant ${squareName(state.enPassant.row, state.enPassant.col)} available`;
    }
    const checkLabel = inCheck && !state.gameOver ? " · Check!" : "";

    const roleLabel =
      state.isOnline && state.playerRole
        ? ` (${state.playerRole === "w" ? "You: White" : "You: Black"})`
        : "";

    this.elements.turnIndicator.textContent = state.gameOver
      ? "Game Over"
      : `${playerName}${phaseLabel}${epLabel}${checkLabel}${roleLabel}`;

    if (this.elements.onlineRoomBadge) {
      if (state.isOnline && state.roomCode) {
        this.elements.onlineRoomBadge.hidden = false;
        this.elements.onlineRoomBadge.textContent = `Room ${state.roomCode}`;
      } else {
        this.elements.onlineRoomBadge.hidden = true;
      }
    }

    if (this.elements.onlineWaitHint) {
      const waiting =
        state.isOnline &&
        !state.gameOver &&
        !canPlayerAct(state) &&
        !state.opponentDisconnected;
      this.elements.onlineWaitHint.hidden = !waiting;
    }

    if (this.elements.disconnectOverlay) {
      this.elements.disconnectOverlay.hidden = !state.opponentDisconnected;
    }

    /* UI only: rotate frame (border + coords + grid); game logic / #board structure unchanged */
    this.elements.boardFrame.classList.toggle(
      "board-frame--flipped",
      state.boardFlipped
    );

    this.elements.gameLayout.classList.toggle(
      "game-layout--flipped",
      state.boardFlipped
    );

    const boardDirty =
      !prevState ||
      prevState.board !== state.board ||
      prevState.boardFlipped !== state.boardFlipped ||
      prevState.movePhase !== state.movePhase ||
      JSON.stringify(prevState.enPassant) !== JSON.stringify(state.enPassant) ||
      !this.selectionEqual(prevState.selectedSquare, state.selectedSquare) ||
      !this.legalMovesEqual(prevState.legalMoves, state.legalMoves) ||
      !this.selectionEqual(prevState.lastMovedSquare, state.lastMovedSquare);

    if (boardDirty) {
      this.renderBoard(state);
    }

    const overlay = this.elements.gameOverOverlay;
    if (state.gameOver) {
      overlay.hidden = false;
      this.elements.gameOverTitle.textContent = "Game Over";
      if (state.gameOverReason === "timeout") {
        const winner = state.winner === "w" ? "White" : "Black";
        this.elements.gameOverMessage.textContent = `${winner} wins on time.`;
      } else if (state.gameOverMessage) {
        this.elements.gameOverMessage.textContent = state.gameOverMessage;
      } else {
        this.elements.gameOverMessage.textContent = "The game has ended.";
      }
    } else {
      overlay.hidden = true;
    }
  },

  renderBoard(state) {
    const boardEl = this.elements.board;
    boardEl.innerHTML = "";

    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const square = document.createElement("button");
        square.type = "button";
        square.className = "square";
        square.classList.add((row + col) % 2 === 0 ? "square--light" : "square--dark");

        if (
          state.selectedSquare &&
          state.selectedSquare.row === row &&
          state.selectedSquare.col === col
        ) {
          square.classList.add("square--selected");
        }

        if (this.isLegalMoveSquare(state, row, col)) {
          square.classList.add(
            this.isCaptureMove(state, row, col)
              ? "square--capture"
              : "square--legal"
          );
        }

        const king = ChessEngine.findKing(state.board, state.activePlayer);
        const opp = OPPONENT[state.activePlayer];
        const oppKing = ChessEngine.findKing(state.board, opp);
        if (
          king &&
          king.row === row &&
          king.col === col &&
          ChessEngine.isInCheck(state, state.activePlayer)
        ) {
          square.classList.add("square--in-check");
        }
        if (
          oppKing &&
          oppKing.row === row &&
          oppKing.col === col &&
          ChessEngine.isInCheck(state, opp)
        ) {
          square.classList.add("square--in-check");
        }

        square.dataset.row = String(row);
        square.dataset.col = String(col);

        if (!canPlayerAct(state)) {
          square.classList.add("square--disabled");
        }

        const piece = state.board[row][col];
        if (piece) {
          const span = document.createElement("span");
          span.className = `piece piece--${piece.color === "w" ? "white" : "black"}`;
          const img = document.createElement("img");
          img.className = "piece-img";
          img.src = getPieceAssetSrc(piece.color, piece.type);
          img.alt = "";
          img.setAttribute("aria-hidden", "true");
          span.appendChild(img);

          if (
            state.lastMovedSquare &&
            state.lastMovedSquare.row === row &&
            state.lastMovedSquare.col === col
          ) {
            span.classList.add("piece--just-moved");
          }

          square.appendChild(span);
        }

        boardEl.appendChild(square);
      }
    }

    if (this.pulseClearTimer) {
      clearTimeout(this.pulseClearTimer);
    }
    this.pulseClearTimer = setTimeout(() => {
      boardEl.querySelectorAll(".piece--just-moved").forEach((el) => {
        el.classList.remove("piece--just-moved");
      });
    }, 600);
  },
};

/* ------------------------------------------------------------------ */
/* Local multiplayer (localStorage + BroadcastChannel) — test mode     */
/* ------------------------------------------------------------------ */

const LocalMultiplayer = {
  channel: null,
  pollTimer: null,
  currentCode: null,
  roomRole: null,
  clientId: null,
  lastRemoteUpdatedAt: 0,
  lastSeenUpdatedAt: 0,

  init() {
    this.clientId =
      sessionStorage.getItem("dc_clientId") ||
      `c_${Math.random().toString(36).slice(2, 11)}`;
    sessionStorage.setItem("dc_clientId", this.clientId);

    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(BC_CHANNEL_NAME);
      this.channel.onmessage = (event) => this.onBroadcast(event.data);
    }

    window.addEventListener("storage", (event) => this.onStorage(event));

    console.info(
      "[Double Chess] Local multiplayer: localStorage + BroadcastChannel. " +
        "Open two tabs in the same browser to test (Create / Join with the same code)."
    );
    return true;
  },

  storageKey(code) {
    return `${LOCAL_ROOM_PREFIX}${code}`;
  },

  readRoom(code) {
    try {
      const raw = localStorage.getItem(this.storageKey(code));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  writeRoom(code, room) {
    if (room === null) {
      localStorage.removeItem(this.storageKey(code));
    } else {
      localStorage.setItem(this.storageKey(code), JSON.stringify(room));
    }
    this.publish(code, room);
  },

  publish(code, room) {
    if (this.channel) {
      this.channel.postMessage({ type: "room", code, room });
    }
    this.deliver(code, room);
  },

  deliver(code, room) {
    if (code !== this.currentCode) return;
    if (!room) {
      App.onRoomUpdate(null, code);
      return;
    }
    if (room.updatedBy === this.clientId) return;
    if (room.updatedAt <= this.lastSeenUpdatedAt) return;
    this.lastSeenUpdatedAt = room.updatedAt;
    App.onRoomUpdate(room, code);
  },

  onBroadcast(data) {
    if (!data || data.code !== this.currentCode) return;
    if (data.type === "room-deleted") {
      App.onRoomUpdate(null, data.code);
      return;
    }
    if (data.type === "room") {
      this.deliver(data.code, data.room);
    }
  },

  onStorage(event) {
    if (!event.key || !event.key.startsWith(LOCAL_ROOM_PREFIX)) return;
    const code = event.key.slice(LOCAL_ROOM_PREFIX.length);
    if (code !== this.currentCode) return;
    if (event.newValue === null) {
      App.onRoomUpdate(null, code);
      return;
    }
    try {
      const room = JSON.parse(event.newValue);
      this.deliver(code, room);
    } catch {
      /* ignore */
    }
  },

  generateUniqueRoomCode() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      if (!this.readRoom(code)) return code;
    }
    throw new Error("Could not generate a unique room code.");
  },

  buildInitialGamePayload(chessMode, timeControl) {
    const base = createAppState();
    base.chessMode = chessMode;
    if (timeControl) base.timeControl = timeControl;
    return serializeGameForFirebase(GameLogic.startGame(base));
  },

  async createRoom(chessMode, timeControl) {
    const code = this.generateUniqueRoomCode();
    const room = {
      chessMode,
      timeControl: timeControl || DEFAULT_TIME_CONTROL,
      status: "waiting",
      createdAt: Date.now(),
      host: { clientId: this.clientId, connected: true, color: "w" },
      guest: { clientId: null, connected: false, color: "b" },
      game: null,
      updatedAt: Date.now(),
      updatedBy: this.clientId,
    };
    this.writeRoom(code, room);
    this.attachRoom(code, "host");
    return code;
  },

  async joinRoom(code) {
    const room = this.readRoom(code);
    if (!room) {
      throw new Error("Room not found. Check the code and try again.");
    }
    if (room.status !== "waiting" || room.guest?.clientId) {
      throw new Error("This room is full or already in progress.");
    }

    const updated = {
      ...room,
      status: "playing",
      guest: { clientId: this.clientId, connected: true, color: "b" },
      game: this.buildInitialGamePayload(room.chessMode, room.timeControl),
      updatedAt: Date.now(),
      updatedBy: this.clientId,
    };
    this.writeRoom(code, updated);
    this.attachRoom(code, "guest");
  },

  attachRoom(code, role) {
    this.detachRoom();
    this.currentCode = code;
    this.roomRole = role;
    this.lastSeenUpdatedAt = 0;
    this.startPolling(code);
    const room = this.readRoom(code);
    if (room) this.deliver(code, room);
  },

  detachRoom() {
    this.stopPolling();
    this.currentCode = null;
    this.roomRole = null;
  },

  startPolling(code) {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      const room = this.readRoom(code);
      if (room) this.deliver(code, room);
      else if (this.currentCode === code) App.onRoomUpdate(null, code);
    }, LOCAL_POLL_MS);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async leaveRoom(state) {
    const code = state.roomCode;
    if (!code) {
      this.detachRoom();
      return;
    }

    const room = this.readRoom(code);
    const role = state.roomRole;

    if (role === "host") {
      localStorage.removeItem(this.storageKey(code));
      if (this.channel) {
        this.channel.postMessage({ type: "room-deleted", code });
      }
    } else if (role === "guest" && room) {
      this.writeRoom(code, {
        ...room,
        guest: { ...room.guest, clientId: room.guest.clientId, connected: false },
        status: "ended",
        updatedAt: Date.now(),
        updatedBy: this.clientId,
      });
    }

    this.detachRoom();
  },

  async pushGameState(state) {
    if (!this.currentCode || !state.isOnline || state.syncFromRemote) return;

    const room = this.readRoom(this.currentCode);
    if (!room) return;

    this.writeRoom(this.currentCode, {
      ...room,
      game: serializeGameForFirebase(state),
      updatedAt: Date.now(),
      updatedBy: this.clientId,
    });
  },
};

/* ------------------------------------------------------------------ */
/* Firebase multiplayer (주석 해제 + USE_FIREBASE_MULTIPLAYER = true)   */
/* ------------------------------------------------------------------ */

/*
const FirebaseMultiplayer = {
  db: null,
  roomRef: null,
  roomUnsubscribe: null,
  clientId: null,
  roomRole: null,
  lastRemoteUpdatedAt: 0,

  isConfigured() {
    return (
      typeof FIREBASE_CONFIG !== "undefined" &&
      FIREBASE_CONFIG.apiKey &&
      FIREBASE_CONFIG.apiKey !== FIREBASE_PLACEHOLDER_KEY &&
      FIREBASE_CONFIG.databaseURL &&
      !FIREBASE_CONFIG.databaseURL.includes("YOUR_PROJECT_ID")
    );
  },

  init() {
    if (typeof firebase === "undefined") {
      console.warn("Firebase SDK not loaded.");
      return false;
    }
    if (!this.isConfigured()) {
      console.warn("Firebase config not set. Paste your keys in index.html.");
      return false;
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    this.db = firebase.database();
    this.clientId =
      sessionStorage.getItem("dc_clientId") ||
      `c_${Math.random().toString(36).slice(2, 11)}`;
    sessionStorage.setItem("dc_clientId", this.clientId);
    return true;
  },

  roomPath(code) {
    return `rooms/${code}`;
  },

  async generateUniqueRoomCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      const snap = await this.db.ref(this.roomPath(code)).once("value");
      if (!snap.exists()) return code;
    }
    throw new Error("Could not generate a unique room code.");
  },

  async createRoom(chessMode, timeControl) {
    const code = await this.generateUniqueRoomCode();
    const ref = this.db.ref(this.roomPath(code));
    await ref.set({
      chessMode,
      timeControl: timeControl || DEFAULT_TIME_CONTROL,
      status: "waiting",
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      host: { clientId: this.clientId, connected: true, color: "w" },
      guest: { clientId: null, connected: false, color: "b" },
      game: null,
      updatedAt: Date.now(),
      updatedBy: this.clientId,
    });
    ref.child("host/connected").onDisconnect().set(false);
    this.attachRoom(code, "host");
    return code;
  },

  buildInitialGamePayload(chessMode, timeControl) {
    const base = createAppState();
    base.chessMode = chessMode;
    if (timeControl) base.timeControl = timeControl;
    return serializeGameForFirebase(GameLogic.startGame(base));
  },

  async joinRoom(code) {
    const ref = this.db.ref(this.roomPath(code));
    const snap = await ref.once("value");
    if (!snap.exists()) {
      throw new Error("Room not found. Check the code and try again.");
    }
    const room = snap.val();
    if (room.status !== "waiting" || room.guest?.clientId) {
      throw new Error("This room is full or already in progress.");
    }
    const game = this.buildInitialGamePayload(room.chessMode, room.timeControl);
    await ref.update({
      status: "playing",
      guest: { clientId: this.clientId, connected: true, color: "b" },
      game,
      updatedAt: Date.now(),
      updatedBy: this.clientId,
    });
    ref.child("guest/connected").onDisconnect().set(false);
    this.attachRoom(code, "guest");
  },

  attachRoom(code, role) {
    this.detachRoom();
    this.roomRole = role;
    this.roomRef = this.db.ref(this.roomPath(code));
    const connectedPath = role === "host" ? "host/connected" : "guest/connected";
    this.roomRef.child(connectedPath).onDisconnect().set(false);
    this.roomRef.child(connectedPath).set(true);
    this.roomUnsubscribe = this.roomRef.on("value", (snapshot) => {
      App.onRoomUpdate(snapshot.val(), code);
    });
  },

  detachRoom() {
    if (this.roomRef && this.roomUnsubscribe) {
      this.roomRef.off("value", this.roomUnsubscribe);
    }
    this.roomRef = null;
    this.roomUnsubscribe = null;
    this.roomRole = null;
  },

  async leaveRoom(state) {
    if (!this.roomRef || !state.roomCode) {
      this.detachRoom();
      return;
    }
    const code = state.roomCode;
    const role = state.roomRole;
    try {
      if (role === "host") {
        await this.db.ref(this.roomPath(code)).remove();
      } else if (role === "guest") {
        await this.roomRef.update({
          "guest/connected": false,
          status: "ended",
          updatedAt: Date.now(),
          updatedBy: this.clientId,
        });
      }
    } catch (err) {
      console.warn("Room cleanup error:", err);
    }
    const connectedPath = role === "host" ? "host/connected" : "guest/connected";
    try {
      await this.roomRef.child(connectedPath).set(false);
    } catch (err) {
      // ignore
    }
    this.detachRoom();
  },

  async pushGameState(state) {
    if (!this.roomRef || !state.isOnline || state.syncFromRemote) return;
    await this.roomRef.update({
      game: serializeGameForFirebase(state),
      updatedAt: Date.now(),
      updatedBy: this.clientId,
    });
  },
};
*/

/** 통합 멀티플레이어 API — 기본은 로컬, Firebase는 플래그로 전환 */
const Multiplayer = {
  mode: "local",
  clientId: null,
  roomRole: null,
  lastRemoteUpdatedAt: 0,

  init() {
    LocalMultiplayer.init();
    this.clientId = LocalMultiplayer.clientId;
    this.mode = "local";

    /*
    if (USE_FIREBASE_MULTIPLAYER && typeof FirebaseMultiplayer !== "undefined") {
      if (FirebaseMultiplayer.init()) {
        this.mode = "firebase";
        this.clientId = FirebaseMultiplayer.clientId;
        console.info("[Double Chess] Firebase multiplayer enabled.");
        return true;
      }
    }
    */

    return true;
  },

  async createRoom(chessMode, timeControl) {
    const code = await (this.mode === "firebase"
      ? FirebaseMultiplayer.createRoom(chessMode, timeControl)
      : LocalMultiplayer.createRoom(chessMode, timeControl));
    this.roomRole = this.mode === "firebase" ? FirebaseMultiplayer.roomRole : LocalMultiplayer.roomRole;
    return code;
  },

  async joinRoom(code) {
    await (this.mode === "firebase"
      ? FirebaseMultiplayer.joinRoom(code)
      : LocalMultiplayer.joinRoom(code));
    this.roomRole = this.mode === "firebase" ? FirebaseMultiplayer.roomRole : LocalMultiplayer.roomRole;
  },

  async leaveRoom(state) {
    if (this.mode === "firebase") {
      await FirebaseMultiplayer.leaveRoom(state);
    } else {
      await LocalMultiplayer.leaveRoom(state);
    }
  },

  async pushGameState(state) {
    if (this.mode === "firebase") {
      await FirebaseMultiplayer.pushGameState(state);
    } else {
      await LocalMultiplayer.pushGameState(state);
    }
  },

  readRoom(code) {
    return this.mode === "firebase"
      ? null
      : LocalMultiplayer.readRoom(code);
  },
};

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const App = {
  state: createAppState(),
  timerIntervalId: null,
  multiplayerReady: false,

  init() {
    UI.cacheElements();
    this.multiplayerReady = Multiplayer.init();
    this.bindEvents();
    window.addEventListener("beforeunload", () => {
      if (this.state.isOnline) {
        Multiplayer.leaveRoom(this.state);
      }
    });
    UI.render(this.state);
  },

  setState(updater, options = {}) {
    const prev = this.state;
    const next = typeof updater === "function" ? updater(prev) : updater;
    this.state = next;
    UI.render(this.state, prev);

    if (
      !options.skipSync &&
      next.isOnline &&
      !next.syncFromRemote &&
      next.screen === "game" &&
      this.shouldSyncToFirebase(prev, next)
    ) {
      Multiplayer.pushGameState(next).catch((err) =>
        console.warn("Online sync failed:", err)
      );
    }

    this.syncTimerLoop();
  },

  shouldSyncToFirebase(prev, next) {
    if (!prev || prev.screen !== "game") return true;
    return (
      prev.board !== next.board ||
      prev.activePlayer !== next.activePlayer ||
      prev.movePhase !== next.movePhase ||
      JSON.stringify(prev.enPassant) !== JSON.stringify(next.enPassant) ||
      prev.boardFlipped !== next.boardFlipped ||
      prev.timers.w !== next.timers.w ||
      prev.timers.b !== next.timers.b ||
      prev.gameOver !== next.gameOver ||
      prev.timerRunning !== next.timerRunning
    );
  },

  applyRemoteGame(room, code) {
    if (!room || !room.game) return;
    if (room.updatedBy === Multiplayer.clientId) return;
    if (room.updatedAt <= Multiplayer.lastRemoteUpdatedAt) return;

    Multiplayer.lastRemoteUpdatedAt = room.updatedAt;

    this.setState(
      (s) => {
        let merged = mergeGameFromFirebase(
          {
            ...s,
            syncFromRemote: true,
            roomCode: code,
            isOnline: true,
            chessMode: room.chessMode,
            playerRole: s.playerRole,
            roomRole: s.roomRole,
          },
          room.game
        );
        merged.syncFromRemote = false;
        return merged;
      },
      { skipSync: true }
    );
  },

  onRoomUpdate(room, code) {
    if (!room) {
      if (this.state.isOnline && this.state.screen === "game") {
        this.showOpponentDisconnected();
      }
      return;
    }

    const opponentKey = this.state.roomRole === "host" ? "guest" : "host";
    const opponent = room[opponentKey];
    const inActiveGame =
      this.state.screen === "game" && this.state.isOnline && !this.state.opponentDisconnected;

    if (
      inActiveGame &&
      opponent &&
      opponent.clientId &&
      opponent.connected === false
    ) {
      this.showOpponentDisconnected();
      return;
    }

    if (room.status === "playing" && room.game) {
      if (this.state.screen === "room-wait") {
        this.startOnlineGame(room, code, "w");
        return;
      }
      if (this.state.screen === "game") {
        this.applyRemoteGame(room, code);
      } else if (
        this.state.screen === "room-join" ||
        (this.state.roomRole === "guest" && !this.state.isOnline)
      ) {
        this.startOnlineGame(room, code, "b");
      }
    }
  },

  startOnlineGame(room, code, playerRole) {
    const base = GameLogic.startGame({
      ...createAppState(),
      chessMode: room.chessMode,
      timeControl: room.timeControl || DEFAULT_TIME_CONTROL,
      matchType: "multiplayer",
      isOnline: true,
      roomCode: code,
      playerRole,
      roomRole: playerRole === "w" ? "host" : "guest",
    });
    let merged = mergeGameFromFirebase(base, room.game);
    merged.screen = "game";
    merged.timerRunning = true;
    Multiplayer.lastRemoteUpdatedAt = room.updatedAt || 0;
    this.setState(() => merged, { skipSync: playerRole !== "w" });
  },

  showOpponentDisconnected() {
    if (this.state.opponentDisconnected) return;
    this.setState(
      (s) => ({
        ...s,
        opponentDisconnected: true,
        timerRunning: false,
        selectedSquare: null,
        legalMoves: [],
      }),
      { skipSync: true }
    );
    if (UI.elements.disconnectOverlay) {
      UI.elements.disconnectOverlay.hidden = false;
    }
  },

  syncTimerLoop() {
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }

    const s = this.state;
    const mayRunTimer =
      s.timerRunning &&
      s.timerStarted && // frozen until White's first move completes (edge case 1)
      s.screen === "game" &&
      !s.gameOver &&
      !s.opponentDisconnected &&
      (!s.isOnline || s.playerRole === s.activePlayer);

    if (mayRunTimer) {
      // Ticks 10×/second; clearInterval above guarantees no duplicate/leaked timers.
      this.timerIntervalId = setInterval(() => {
        this.setState((prev) => GameLogic.tickTimer(prev));
      }, TICK_MS);
    }
  },

  bindEvents() {
    document.getElementById("app").addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target) return;

      switch (target.dataset.action) {
        case "go-mode":
          this.setState((s) => GameLogic.navigate(s, "mode"));
          break;
        case "back-home":
          this.leaveSession();
          break;
        case "back-mode":
          this.setState((s) =>
            GameLogic.navigate({ ...s, chessMode: null }, "mode")
          );
          break;
        case "back-match":
          this.setState((s) => GameLogic.navigate(s, "match"));
          break;
        case "back-room-lobby":
          this.setState((s) => GameLogic.navigate(s, "room-lobby"));
          break;
        case "select-mode":
          this.setState((s) => GameLogic.setChessMode(s, target.dataset.mode));
          break;
        case "select-time":
          this.setState((s) => GameLogic.setTimeControl(s, target.dataset.time));
          break;
        case "back-time":
          this.setState((s) => GameLogic.navigate(s, "time"));
          break;
        case "select-match":
          this.handleMatchSelect(target.dataset.match);
          break;
        case "create-room":
          this.handleCreateRoom();
          break;
        case "go-join-room":
          this.setState((s) => GameLogic.navigate(s, "room-join"));
          break;
        case "join-room":
          this.handleJoinRoom();
          break;
        case "copy-room-code":
          this.copyRoomCode();
          break;
        case "leave-game":
          this.leaveSession();
          break;
        default:
          break;
      }
    });

    UI.elements.board.addEventListener("click", (e) => {
      const square = e.target.closest(".square");
      if (!square) return;
      const row = Number(square.dataset.row);
      const col = Number(square.dataset.col);
      this.setState((s) => GameLogic.handleSquareClick(s, row, col));
    });
  },

  async leaveSession() {
    if (this.state.isOnline) {
      await Multiplayer.leaveRoom(this.state);
    }
    this.setState((s) => GameLogic.leaveGame(s));
  },

  handleMatchSelect(matchType) {
    this.setState((s) => GameLogic.setMatchType(s, matchType));

    if (matchType === "solo") {
      this.setState((s) => GameLogic.startGame(s));
      return;
    }

    if (!this.multiplayerReady) {
      alert("Multiplayer could not start. Please refresh the page.");
      return;
    }

    this.setState((s) => GameLogic.navigate(s, "room-lobby"));
  },

  async handleCreateRoom() {
    try {
      const code = await Multiplayer.createRoom(
        this.state.chessMode,
        this.state.timeControl
      );
      this.setState((s) => ({
        ...s,
        screen: "room-wait",
        roomCode: code,
        roomRole: "host",
        playerRole: "w",
        isOnline: true,
      }));
      UI.updateRoomWaitDisplay(code);
    } catch (err) {
      alert(err.message || "Could not create room.");
    }
  },

  async handleJoinRoom() {
    const input = UI.elements.roomCodeInput;
    const code = (input?.value || "").replace(/\D/g, "");
    if (code.length !== 4) {
      UI.showJoinError("Enter a valid 4-digit room code.");
      return;
    }
    UI.showJoinError(null);
    try {
      await Multiplayer.joinRoom(code);
      const room = Multiplayer.readRoom(code);
      this.setState((s) => ({
        ...s,
        roomCode: code,
        roomRole: "guest",
        playerRole: "b",
        isOnline: true,
        screen: "room-join",
      }));
      if (room && room.status === "playing" && room.game) {
        this.startOnlineGame(room, code, "b");
      }
    } catch (err) {
      UI.showJoinError(err.message || "Could not join room.");
    }
  },

  copyRoomCode() {
    const code = this.state.roomCode;
    if (!code) return;
    navigator.clipboard.writeText(code).catch(() => {
      /* fallback ignored */
    });
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
