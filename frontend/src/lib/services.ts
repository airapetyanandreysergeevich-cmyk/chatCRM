import { api } from "./api";

/**
 * Прайс мастерской: что она делает и почём.
 *
 * Справочник нужен ради двух вещей — чтобы мастер не набирал одно и то же
 * название по двадцать раз в неделю и чтобы цена бралась из одного места.
 * В заказ при этом уходит копия названия и цены, поэтому правка прайса
 * не переписывает суммы в уже закрытых ремонтах.
 */
export interface Service {
  id: string;
  name: string;
  price: number;
  note: string | null;
  /** Вынесена отдельной кнопкой в карточку заказа. */
  isPinned: boolean;
}

/** Сколько кнопок помещается в панель работ, не превращая её в стену. */
export const PINNED_LIMIT = 6;

/**
 * Подбор подсказок по набранному тексту.
 *
 * Сначала те, что начинаются с запроса, потом те, у кого он внутри: человек
 * набирает начало названия, и «Чистка» должна стоять выше, чем
 * «Профилактическая чистка».
 */
export function matchServices(all: Service[], query: string, limit = 6): Service[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const starts: Service[] = [];
  const inside: Service[] = [];
  for (const s of all) {
    const name = s.name.toLowerCase();
    if (name === q) continue; // уже набрано целиком — подсказывать нечего
    if (name.startsWith(q)) starts.push(s);
    else if (name.includes(q)) inside.push(s);
  }
  return [...starts, ...inside].slice(0, limit);
}

export const servicesApi = {
  list: () => api.get<Service[]>("/services"),
  create: (body: Omit<Service, "id">) => api.post<{ id: string; name: string }>("/services", body),
  update: (id: string, body: Partial<Omit<Service, "id">>) => api.patch(`/services/${id}`, body),
  remove: (id: string) => api.del(`/services/${id}`),
};
