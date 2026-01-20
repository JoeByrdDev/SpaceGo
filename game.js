let board = Util.makeBoard(N);
Util.rememberPosition();

(async () => {
  // Ensure picker exists even before we have games
  Util.initGamePicker();

  const params = new URLSearchParams(window.location.search);
  const wantId = params.get('gameId');

  if (Engine.isNetMode && Engine.isNetMode()) {
    if (wantId) {
      await Net.loadGame(wantId);
      const lg = await Net.listGames();
      if (lg.ok) Util.setGameList(lg.games, wantId);
    } else {
      const lg = await Net.listGames();
      if (lg.ok && lg.games && lg.games.length) {
        // load most recently updated
        const first = lg.games[0].gameId;
        await Net.loadGame(first);
        Util.setGameList(lg.games, first);
      } else {
        // no runtime games yet -> create one
        const r = await fetch("/api/game/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ N }),
        });
        const data = await r.json();
        Net.gameId = data.gameId;
        Net.applyState(data.state);

        // refresh list so the picker shows it
        const lg2 = await Net.listGames();
        if (lg2.ok) Util.setGameList(lg2.games, Net.gameId);
      }
    }
  }

  Util.setTurnUI();
  Util.setStatus('Ready');
  Render.requestRender();
})();

// Start
/*
Util.setTurnUI();
Util.setStatus('Ready');
Render.requestRender();
*/