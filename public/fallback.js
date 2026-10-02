/**
 * Ad network fallback: pop-utka.app/fallback.js
 *
 * The ad network loads this script into its slot when it has nothing to
 * show (no materials for the geo/format). By default the slot is not left
 * empty: we render a "house banner" inviting people to the board bot.
 *
 * The file is deliberately 100 percent ASCII (Russian text goes through
 * \uXXXX escapes and is decoded at runtime): viewers, editors and ad
 * panels with any default encoding (UTF-8, Windows-1251, Latin-1) all
 * see the same thing, and the banner still shows proper Russian in
 * the browser.
 *
 * Safety: the script may also run outside an ad iframe (e.g. opened
 * directly in a browser) - then we do nothing, so pages of the site are
 * never touched.
 */
(function () {
  'use strict';
  if (window.top === window.self) return; // not inside an ad iframe - exit
  try {
    document.write(
      '<a href="https://t.me/parcel_transfer_bot" target="_blank" rel="noopener nofollow" '
      + 'style="display:block;box-sizing:border-box;width:100%;height:100%;margin:0;padding:12px 8px;'
      + 'font:14px/1.35 system-ui,-apple-system,sans-serif;text-align:center;text-decoration:none;'
      + 'color:#201d17;background:#f2eee5;border-radius:8px">'
      + '\u041f\u0435\u0440\u0435\u0434\u0430\u0442\u044c \u043f\u043e\u0441\u044b\u043b\u043a\u0443 \u043f\u043e\u043f\u0443\u0442\u043d\u043e \u2014 \u0431\u043e\u0442 \u0434\u043e\u0441\u043a\u0438 \u00ab\u043f\u043e\u043f\u0443\u0442\u043a\u0430.\u00bb</a>'
    );
  } catch (e) { /* slot unavailable - show nothing */ }
})();
