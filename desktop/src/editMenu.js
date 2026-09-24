"use strict";

/**
 * «Копировать / Вставить» по правой кнопке в полях ввода.
 *
 * У окна Electron своего меню по правой кнопке нет вовсе: в браузере оно
 * есть всегда, и человек привык вставлять телефон клиента мышью. В программе
 * правый щелчок по полю молча ничего не делал — оставались только Ctrl+C и
 * Ctrl+V, про которые у стойки помнят не все.
 *
 * Меню показывается только в полях ввода. Всё остальное — дело страницы: на
 * телефоне, имени клиента, номере заказа у неё своё меню «Копировать …», и
 * тогда сюда событие просто не доходит — страница его уже обработала.
 */

/**
 * Какие пункты показать. Отдельно от Electron — чтобы проверять без окна.
 *
 * @param {{ isEditable: boolean, selectionText?: string, editFlags?: { canCopy?: boolean, canPaste?: boolean } }} params
 * @param {string} clipboardText что сейчас лежит в буфере обмена
 * @returns {Array<{ label: string, role: "copy" | "paste", enabled: boolean }>} пусто — меню не нужно
 */
function editMenuItems(params, clipboardText) {
  if (!params || !params.isEditable) return [];
  const flags = params.editFlags || {};
  const selected = Boolean(params.selectionText && params.selectionText.length);
  return [
    // Нечего копировать — пункт есть, но серый: так видно, что он вообще бывает.
    { label: "Копировать", role: "copy", enabled: selected && flags.canCopy !== false },
    // Пустой буфер — вставлять нечего.
    { label: "Вставить", role: "paste", enabled: Boolean(clipboardText) && flags.canPaste !== false },
  ];
}

/** Подключить меню к окну. */
function attachEditMenu(webContents, { Menu, clipboard }) {
  webContents.on("context-menu", (_event, params) => {
    let text = "";
    try {
      text = clipboard.readText();
    } catch {
      text = "";
    }
    const items = editMenuItems(params, text);
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup();
  });
}

module.exports = { editMenuItems, attachEditMenu };
