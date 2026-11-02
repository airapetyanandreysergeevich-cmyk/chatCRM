import { useState } from "react";
import { ServicePicker, type PickerItem, type PickerText } from "./ServicePicker";
import { IconBox } from "./icons";
import { Button } from "./ui";
import { stockApi, type StockCategory, type StockItem } from "../lib/workshop";

/**
 * «Со склада» в запчастях заказа (03.11.2026, Сергей КОМП+: «очень не
 * хватает кнопочки „Со склада“, такой как „Из прайса“»).
 *
 * Та же панель, что «Из прайса»: категории склада папками, поиск, отметить
 * несколько, «Выбрать (N)». Под названием — артикул, остаток и место; чего
 * нет на складе — видно, но не отмечается: сохранение заказа всё равно
 * отказало бы «не хватает на складе».
 */

const TEXT: PickerText = {
  title: "Со склада",
  search: "Найти на складе: название, артикул",
  all: "Весь склад",
  none: "Такого на складе нет",
  empty: "Склад пуст — позиции заводят в разделе «Склад»",
};

type Item = PickerItem & { item: StockItem };

const qty = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");

export function StockPickerButton({ onPick }: { onPick: (items: StockItem[]) => void }) {
  const [state, setState] = useState<{ anchor: HTMLElement; items: Item[]; cats: StockCategory[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(anchor: HTMLElement) {
    if (state) return setState(null);
    setLoading(true);
    setError(null);
    try {
      const [list, catalog] = await Promise.all([stockApi.list({ all: "1", sort: "name" }), stockApi.catalog()]);
      setState({
        anchor,
        cats: catalog.items,
        items: list.items.map((i) => ({
          id: i.id,
          name: i.name,
          price: i.salePrice ?? 0,
          note: i.note ?? null,
          categoryId: i.categoryId ?? null,
          item: i,
        })),
      });
    } catch {
      setError("Склад не открылся — проверьте связь");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        icon={<IconBox />}
        disabled={loading}
        onClick={(e) => void open(e.currentTarget)}
        data-stock-picker-add
        title={error ?? undefined}
      >
        {loading ? "Открываем склад…" : "Со склада"}
      </Button>
      {state && (
        <ServicePicker<Item>
          services={state.items}
          categories={state.cats}
          anchor={state.anchor}
          text={TEXT}
          openKey="finecrm.stockpicker.open"
          subOf={(s) =>
            [s.item.sku, `в наличии ${qty(s.item.qty)} ${s.item.unit}`, s.item.warehouse, s.item.location ? `место: ${s.item.location}` : null]
              .filter(Boolean)
              .join(" · ")
          }
          disabledOf={(s) => (s.item.qty > 0 ? null : `${s.item.sku ? s.item.sku + " · " : ""}нет на складе`)}
          onClose={() => setState(null)}
          onPick={(picked) => {
            onPick(picked.map((p) => p.item));
            setState(null);
          }}
        />
      )}
    </>
  );
}
