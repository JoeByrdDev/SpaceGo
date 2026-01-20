// game.js (net mode requires a gameId; otherwise bounce to lobby)
let board = Util.makeBoard(N);
Util.rememberPosition();

(async () => {
  const params = new URLSearchParams(window.location.search);
  const wantId = params.get('gameId');

  // player selection is stored per-game so you can be Black in one game and White in another
  Util.setPlayerCookieKey('sg_player_' + (wantId || 'local'));

  if (Engine.isNetMode && Engine.isNetMode()) {
    if (!wantId) {
      window.location.href = '/';
      return;
    }
    await Net.loadGame(wantId);
  }

  Util.setTurnUI();
  Util.setPlayerUI();
  Util.setStatus('Ready');
  Render.requestRender();
})();
