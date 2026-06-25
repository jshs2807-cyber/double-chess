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
this.TIME_CONTROLS = TIME_CONTROLS;
this.getTimeControl = getTimeControl;
this.createAppState = createAppState;
`,
  sandbox
);

const { ChessEngine, GameLogic, TIME_CONTROLS, createAppState } = sandbox;

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}
function move(state, fr, fc, tr, tc) {
  return GameLogic.tryMove(state, fr, fc, tr, tc);
}

// Start a standard solo game on a given time control.
function startGame(timeControl) {
  return GameLogic.startGame({
    ...createAppState(),
    chessMode: "standard",
    timeControl,
  });
}

// Time control mapping is correct.
{
  assert(TIME_CONTROLS.bullet.base === 60 && TIME_CONTROLS.bullet.increment === 0, "bullet 1+0");
  assert(TIME_CONTROLS.blitz.base === 180 && TIME_CONTROLS.blitz.increment === 0, "blitz 3+0");
  assert(TIME_CONTROLS.blitz33.base === 180 && TIME_CONTROLS.blitz33.increment === 3, "blitz 3|3");
  assert(TIME_CONTROLS.rapid.base === 600 && TIME_CONTROLS.rapid.increment === 0, "rapid 10+0");
  console.log("PASS: four time controls defined correctly");
}

// Initial timers match the chosen base; clock frozen until first move.
{
  const s = startGame("rapid");
  assert(s.timers.w === 600 && s.timers.b === 600, "rapid starts at 600 each");
  assert(s.timerStarted === false, "timer frozen before first move");
  const frozen = GameLogic.tickTimer(s);
  assert(frozen.timers.w === 600, "tick does nothing before first move");
  console.log("PASS: initial timers + frozen-until-first-move");
}

// Edge case 1: White's opening move arms the clock; afterwards the side-to-move ticks.
{
  let s = startGame("blitz"); // 180 + 0
  s = move(s, 6, 4, 4, 4); // 1.e4
  assert(s.timerStarted === true, "clock armed after White's first move");
  assert(s.activePlayer === "b", "black to move");
  const ticked = GameLogic.tickTimer(s);
  assert(Math.abs(ticked.timers.b - 179.9) < 1e-9, "black clock ticks 0.1s");
  assert(ticked.timers.w === 180, "white clock untouched on black's turn");
  console.log("PASS: clock arms on first move, active side ticks");
}

// Increment: Blitz 3|3 adds exactly +3 to the player who completed a turn (standard chess).
{
  let s = startGame("blitz33");
  s = move(s, 6, 4, 4, 4); // White 1.e4 — first turn, no increment (free opening), arms clock
  assert(s.timers.w === 180, "no increment on White's free opening turn");
  s = move(s, 1, 4, 3, 4); // Black 1...e5 — completed turn -> +3
  assert(s.timers.b === 183, "black gets +3 on completed turn");
  s = move(s, 6, 3, 4, 3); // White 2.d4 — completed turn -> +3
  assert(s.timers.w === 183, "white gets +3 on its second completed turn");
  console.log("PASS: Blitz 3|3 increment applied once per completed turn");
}

// Increment in Double Chess: +3 only when the FULL turn ends, never after Move 1.
{
  let s = GameLogic.startGame({
    ...createAppState(),
    chessMode: "double",
    timeControl: "blitz33",
  });
  // White turn 1: Move 1 (e2-e4) then Move 2 (d2-d4) — free opening turn, no increment.
  s = move(s, 6, 4, 4, 4);
  assert(s.movePhase === 2 && s.activePlayer === "w", "white still on Move 2");
  assert(s.timers.w === 180, "no increment mid-turn after Move 1");
  s = move(s, 6, 3, 4, 3);
  assert(s.activePlayer === "b", "turn passed to black after Move 2");
  assert(s.timers.w === 180, "white free opening turn earns no increment");

  // Black turn: Move 1 (e7-e5), Move 2 (d7-d5) -> +3 once at turn end.
  s = move(s, 1, 4, 3, 4);
  assert(s.movePhase === 2 && s.activePlayer === "b", "black on Move 2");
  assert(s.timers.b === 180, "no increment after black Move 1");
  s = move(s, 1, 3, 3, 3);
  assert(s.activePlayer === "w", "turn passed to white");
  assert(s.timers.b === 183, "black gets +3 exactly once for the full turn");
  console.log("PASS: Double Chess increment only at full-turn end (not after Move 1)");
}

// Timeout: clock hitting zero ends the game with a time-out result.
{
  let s = startGame("bullet");
  s = move(s, 6, 4, 4, 4); // arm clock; black to move
  s = { ...s, timers: { ...s.timers, b: 0.1 } };
  const out = GameLogic.tickTimer(s);
  assert(out.gameOver === true, "game over on timeout");
  assert(out.gameOverReason === "timeout", "reason is timeout");
  assert(out.winner === "w", "white wins when black flags");
  assert(out.timerRunning === false, "timer stops on timeout");
  console.log("PASS: timeout ends game and stops the clock");
}

console.log("All timer tests passed.");
