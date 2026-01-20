// game.js (net mode requires a gameId; otherwise bounce to lobby)
let board = Util.makeBoard(N);
Util.rememberPosition();

(async () => {
  const params = new URLSearchParams(window.location.search);
  const wantId = params.get('gameId');

  if (Engine.isNetMode && Engine.isNetMode()) {
    if (!wantId) {
      window.location.href = '/';
      return;
    }
    await Net.loadGame(wantId);
  }

  Util.setTurnUI();
  Util.setStatus('Ready');
  Render.requestRender();
})();
