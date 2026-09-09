/*
 * Service worker FineCRM.
 *
 * Он здесь ровно для оповещений: ни Chrome, ни Safari не покажут push без
 * зарегистрированного service worker. Кэшированием приложения он намеренно не
 * занимается — в CRM устаревший экран опаснее отсутствия офлайн-режима:
 * приёмщик увидит вчерашний список заказов и не поймёт, что смотрит в прошлое.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "FineCRM", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "FineCRM";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || undefined,
      // Оповещение о заказе должно дождаться человека, а не исчезнуть,
      // пока он держит отвёртку.
      requireInteraction: false,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Если приложение уже открыто — переводим его на нужный экран,
      // а не плодим вкладки при каждом оповещении.
      for (const client of list) {
        if (client.url.indexOf(self.registration.scope) === 0 && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
