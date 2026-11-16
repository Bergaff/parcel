/**
 * Яндекс.Метрика — счётчик 114285172 (pop-utka.app).
 *
 * Зачем: кампания в Яндекс.Директе до этого была слепа по конверсиям —
 * воркер писал только pathname, клики из Директа тонули в «напрямую».
 * Метрика даёт воронку (показы → клики → действия на доске) и вебвизор.
 *
 * Скрипт ставится в начало <head> всех публичных страниц — требование
 * Яндекса: отправить просмотр как можно раньше, даже если посетитель
 * сразу закроет страницу. Код — ровно тот, что сгенерировал интерфейс
 * Метрики (ssr, webvisor, clickmap, accurateTrackBounce, trackLinks).
 *
 * Куда вставляется:
 *  - src/seo-routes.ts (seoPageShell) — все SSR-страницы: /r/*, /gorod/*,
 *    /item/*, /peredat*, /routes, /itogi;
 *  - src/index.ts (OUTAGE_PAGE) — страница «временно не отвечает»;
 *  - src/pages.ts — запасная 404-страница воркера (когда ассет недоступен);
 *  - public/index.html и public/404.html — статика (вклеен текстом:
 *    ассеты отдаются без воркера; SSR главной только подменяет SEO-блок,
 *    сниппет в head переживает подмену).
 *
 * Приватные страницы (админ-логины медиакита /mediakit, renderAudiencePage)
 * счётчик намеренно не несут: за логином нет «посетителей сайта», а визиты
 * владельца исказят рекламную статистику.
 */
export const METRIKA_ID = 114285172;

/** Сниппет для вставки в <head> — дословно из интерфейса Метрики. */
export const METRIKA_SNIPPET = `<!-- Yandex.Metrika counter -->
<script type="text/javascript">
    (function(m,e,t,r,i,k,a){
        m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
        m[i].l=1*new Date();
        for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
        k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
    })(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=114285172', 'ym');

    ym(114285172, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/114285172" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
<!-- /Yandex.Metrika counter -->`;
