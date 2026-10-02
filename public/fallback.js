/**
 * Fallback рекламной сети: pop-utka.app/fallback.js
 *
 * Рекламная сеть грузит этот скрипт, когда ей нечего показать в слоте
 * (нет материалов под гео или формат). По умолчанию слот не пустует —
 * показываем «свой баннер»: приглашение в бота доски. Захотите подключить
 * другую сеть или убрать подмену — просто отредактируйте этот файл:
 * кэш у файла короткий, 5 минут.
 *
 * Техника безопасности: скрипт может исполняться и вне рекламного iframe
 * (например, его открыли напрямую в браузере) — тогда ничего не делаем,
 * чтобы не трогать страницы сайта.
 */
(function () {
  'use strict';
  if (window.top === window.self) return; // не в рекламном iframe — выходим
  try {
    document.write(
      '<a href="https://t.me/parcel_transfer_bot" target="_blank" rel="noopener nofollow" '
      + 'style="display:block;box-sizing:border-box;width:100%;height:100%;margin:0;padding:12px 8px;'
      + 'font:14px/1.35 system-ui,-apple-system,sans-serif;text-align:center;text-decoration:none;'
      + 'color:#201d17;background:#f2eee5;border-radius:8px">'
      + 'Передать посылку попутно — бот доски «попутка.»</a>'
    );
  } catch (e) { /* слот недоступен — ничего не показываем */ }
})();
