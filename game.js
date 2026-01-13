let board = Util.makeBoard(N);
Util.rememberPosition();


// somewhere on startup, after Net exists:
(async () => {
  const r = await fetch("/api/game/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ N }),
  });
  const data = await r.json();
  Net.gameId = data.gameId;
  Net.applyState(data.state);
})();

// Start
Util.setTurnUI();
Util.setStatus('Ready');
Render.requestRender();