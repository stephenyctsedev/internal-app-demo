// 團購記錄 — pickup counter for the weekly group-buy Sheet.
//
// Direct mode: orders come from the Google Sheet live via the
// getWeek action; the only write is setPickedUp, which flips the
// 已領取 cell (column H) on the order group's first Sheet row and
// records the pickup date-time in column I beside it (cleared again
// when the order is marked back to not picked up). Picked-up cards
// show that stored time under the customer name.
// Local state is only the in-flight UI: chosen tab, number search
// (訂單編號 only), general search text (姓名／貨品), status filter,
// selected product filters (tapping an item on a card toggles it),
// a customer filter (tapping a name on a card shows only that
// customer's orders; tapping again clears it), which toggle is
// mid-write, and whether a manual ↻ 載入 refetch is in flight (the
// button shows「載入緊…」and disables until both queries settle).
// When products are selected, a summary panel shows each
// selected product with its still-unpicked total quantity
// (未領取 orders only), computed client-side.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SwipeToConfirm } from "./SwipeToConfirm";
import { api, nowWinnipeg, type Order, type WeekData } from "./api";

type Filter = "all" | "pending" | "done";

// The last-opened week tab is remembered per device so reopening the
// app lands on it again. Storage can be blocked (private mode,
// previews), so every access is guarded and falls back to the default.
const LAST_TAB_KEY = "groupbuy.lastTab";
function loadLastTab(): string {
  try {
    return localStorage.getItem(LAST_TAB_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveLastTab(tab: string) {
  try {
    localStorage.setItem(LAST_TAB_KEY, tab);
  } catch {
    // ignore
  }
}

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<string>("");
  const [numberSearch, setNumberSearch] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [itemFilters, setItemFilters] = useState<string[]>([]);
  const [nameFilter, setNameFilter] = useState<string>("");
  const [showProducts, setShowProducts] = useState(false);
  const [writeError, setWriteError] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

  const toggleItemFilter = (product: string) =>
    setItemFilters((prev) =>
      prev.includes(product) ? prev.filter((p) => p !== product) : [...prev, product],
    );

  // Tapping a customer name shows only that customer's orders;
  // tapping the same name again clears the filter.
  const toggleNameFilter = (name: string) =>
    setNameFilter((prev) => (prev === name ? "" : name));

  const weeks = useQuery({
    queryKey: ["weeks"],
    queryFn: () => api.listWeeks(),
  });

  useEffect(() => {
    if (tab || !weeks.data) return;
    const last = loadLastTab();
    // Only reuse the saved tab if it still exists in the Sheet.
    const initial = last && weeks.data.tabs.includes(last) ? last : weeks.data.default_tab;
    if (initial) setTab(initial);
  }, [tab, weeks.data]);

  useEffect(() => {
    if (tab) saveLastTab(tab);
  }, [tab]);

  const week = useQuery({
    queryKey: ["week", tab],
    queryFn: () => api.getWeek({ tab }),
    enabled: tab.length > 0,
  });

  const toggle = useMutation({
    mutationFn: async (args: { order_no: string; picked_up: boolean }) =>
      await api.setPickedUp({ tab, order_no: args.order_no, picked_up: args.picked_up }),
    onMutate: async (args) => {
      // Optimistic flip so the counter tap feels instant; the Sheet
      // write confirms in the background and refetch reconciles.
      await queryClient.cancelQueries({ queryKey: ["week", tab] });
      const prev = queryClient.getQueryData<WeekData>(["week", tab]);
      if (prev) {
        const orders = prev.orders.map((o) =>
          o.order_no === args.order_no
            ? {
                ...o,
                picked_up: args.picked_up,
                // Mirror what the server writes to column I; the
                // refetch on settle replaces it with the stored value.
                picked_at: args.picked_up ? nowWinnipeg() : "",
              }
            : o,
        );
        queryClient.setQueryData(["week", tab], {
          ...prev,
          orders,
          picked_count: orders.filter((o) => o.picked_up).length,
        });
      }
      return { prev };
    },
    onError: (error, _args, context) => {
      if (context?.prev) queryClient.setQueryData(["week", tab], context.prev);
      setWriteError(error instanceof Error ? error.message : "寫入失敗，請再試。");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["week", tab] });
    },
  });

  const orders = week.data?.orders ?? [];

  // Distinct products this week with how many orders contain each —
  // the pool for the multi-select product filter.
  const products = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of orders) {
      for (const p of new Set(o.items.map((it) => it.product))) {
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([product, count]) => ({ product, count }))
      .sort((a, b) => b.count - a.count || a.product.localeCompare(b.product));
  }, [orders]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const nq = numberSearch.trim().toLowerCase();
    return orders.filter((o) => {
      if (filter === "pending" && o.picked_up) return false;
      if (filter === "done" && !o.picked_up) return false;
      // Customer filter: exact name match — a substring would pull in
      // other customers whose names merely contain this one.
      if (nameFilter && o.name !== nameFilter) return false;
      // Number search matches 訂單編號 only — digits inside product
      // names (240g, 250g…) must not pull in unrelated orders.
      if (nq && !o.order_no.toLowerCase().includes(nq)) return false;
      // Multiple product filters combine with OR: an order shows when
      // it contains at least one of the selected products.
      if (
        itemFilters.length > 0 &&
        !o.items.some((it) => itemFilters.includes(it.product))
      )
        return false;
      if (!q) return true;
      return (
        o.name.toLowerCase().includes(q) ||
        o.items.some((it) => it.product.toLowerCase().includes(q))
      );
    });
  }, [orders, search, numberSearch, filter, itemFilters, nameFilter]);

  // For each selected product: how much is still unpicked. Always
  // counts 未領取 orders only (whatever the status filter shows),
  // respecting the two searches, so the counter knows how many
  // packs are still to hand out for the chosen items.
  const selectedTotals = useMemo(() => {
    if (itemFilters.length === 0) return [];
    const q = search.trim().toLowerCase();
    const nq = numberSearch.trim().toLowerCase();
    return itemFilters.map((product) => {
      const byUnit = new Map<string, number>();
      let orderCount = 0;
      for (const o of orders) {
        if (o.picked_up) continue;
        if (nq && !o.order_no.toLowerCase().includes(nq)) continue;
        if (
          q &&
          !(
            o.name.toLowerCase().includes(q) ||
            o.items.some((it) => it.product.toLowerCase().includes(q))
          )
        )
          continue;
        const matching = o.items.filter((it) => it.product === product);
        if (matching.length === 0) continue;
        orderCount += 1;
        for (const it of matching) {
          const n = Number.parseFloat(it.qty.replace(/,/g, ""));
          if (!Number.isFinite(n)) continue;
          byUnit.set(it.unit, (byUnit.get(it.unit) ?? 0) + n);
        }
      }
      return { product, orderCount, totals: [...byUnit.entries()] };
    });
  }, [orders, itemFilters, search, numberSearch]);

  const total = week.data?.total_orders ?? 0;
  const picked = week.data?.picked_count ?? 0;
  const pct = total > 0 ? Math.round((picked / total) * 100) : 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
      {/* Week picker + progress */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <label htmlFor="week-tab" className="text-[13px] font-medium text-(--dim)">
            星期
          </label>
          <select
            id="week-tab"
            aria-label="揀星期"
            className="mt-0.5 block min-h-11 rounded-lg border border-(--border) bg-(--surface) px-2 text-lg font-semibold text-(--text)"
            value={tab}
            onChange={(e) => {
              setTab(e.target.value);
              setNumberSearch("");
              setSearch("");
              setFilter("all");
              setItemFilters([]);
              setNameFilter("");
            }}
          >
            {(weeks.data?.tabs ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-2xl font-bold leading-tight text-(--text)" aria-live="polite">
          已領取 {picked} <span className="text-(--dim)">/ {total} 單</span>
          {total > 0 && picked < total ? (
            <span className="ml-2 align-middle text-base font-semibold text-amber-700 dark:text-amber-500">
              仲有 {total - picked} 單未領
            </span>
          ) : null}
          {total > 0 && picked === total ? (
            <span className="ml-2 align-middle text-base font-semibold text-(--accent)">
              全部領晒 ✓
            </span>
          ) : null}
        </p>
        <div
          className="mt-2 h-2.5 overflow-hidden rounded-full bg-(--border)"
          role="progressbar"
          aria-valuenow={picked}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="已領取進度"
        >
          <div
            className="h-full rounded-full bg-(--accent) transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Search + filter */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            type="search"
            inputMode="numeric"
            aria-label="搜尋編號"
            placeholder="編號…"
            className="min-h-12 w-24 shrink-0 rounded-xl border border-(--border) bg-(--surface) px-3 text-base text-(--text) placeholder:text-(--dim)"
            value={numberSearch}
            onChange={(e) => setNumberSearch(e.target.value)}
          />
          <input
            type="search"
            aria-label="搜尋訂單"
            placeholder="搜尋姓名或貨品…"
            className="min-h-12 min-w-0 flex-1 rounded-xl border border-(--border) bg-(--surface) px-4 text-base text-(--text) placeholder:text-(--dim)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2" role="group" aria-label="篩選狀態">
          {(
            [
              ["all", "全部"],
              ["pending", "未領取"],
              ["done", "已領取"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`min-h-10 flex-1 rounded-full border px-3 text-sm font-semibold ${
                filter === key
                  ? "border-(--accent) bg-(--accent) text-white"
                  : "border-(--border) bg-(--surface) text-(--text)"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-label="重新載入"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={async () => {
              if (refreshing) return;
              setRefreshing(true);
              try {
                await Promise.all([weeks.refetch(), week.refetch()]);
              } finally {
                setRefreshing(false);
              }
            }}
            className="min-h-10 rounded-full border border-(--border) bg-(--surface) px-4 text-sm font-semibold text-(--text) disabled:opacity-60"
          >
            {refreshing ? "載入緊…" : "↻ 載入"}
          </button>
        </div>
      </div>

      {/* Product filter: multi-select. Tapping an item on any card
          toggles the same filter. */}
      {products.length > 0 ? (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-expanded={showProducts}
              onClick={() => setShowProducts((v) => !v)}
              className="min-h-10 rounded-full border border-(--border) bg-(--surface) px-4 text-sm font-semibold text-(--text)"
            >
              {showProducts ? "收起貨品篩選" : "按貨品篩選"}
              {itemFilters.length > 0 ? `（已揀 ${itemFilters.length} 樣）` : ""}
            </button>
            {itemFilters.length > 0 ? (
              <button
                type="button"
                onClick={() => setItemFilters([])}
                className="min-h-10 rounded-full px-3 text-sm font-semibold text-(--accent) underline underline-offset-2"
              >
                清除全部
              </button>
            ) : null}
          </div>

          {itemFilters.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="已揀貨品篩選">
              {itemFilters.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => toggleItemFilter(p)}
                    aria-label={`移除貨品篩選 ${p}`}
                    className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-(--accent) px-3 py-1 text-sm font-semibold text-white"
                  >
                    <span className="truncate">{p}</span>
                    <span aria-hidden="true">✕</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {showProducts ? (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="全部貨品">
              {products.map(({ product, count }) => {
                const active = itemFilters.includes(product);
                return (
                  <li key={product}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleItemFilter(product)}
                      className={`inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${
                        active
                          ? "border-(--accent) bg-(--accent) text-white"
                          : "border-(--border) bg-(--surface) text-(--text)"
                      }`}
                    >
                      <span className="truncate">{product}</span>
                      <span className={active ? "text-white/80" : "text-(--dim)"}>{count} 單</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Active customer filter: only this customer's orders show */}
      {nameFilter ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNameFilter("")}
            aria-label={`移除客人篩選 ${nameFilter}`}
            className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full bg-(--accent) px-3 py-1 text-sm font-semibold text-white"
          >
            <span className="truncate">客人：{nameFilter}</span>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ) : null}

      {/* Selected products: still-unpicked totals per product */}
      {itemFilters.length > 0 && week.data ? (
        <div
          className="mt-3 rounded-2xl border border-(--accent) bg-(--surface) p-4"
          aria-label="已選貨品未領取總數"
        >
          <ul className="flex flex-col gap-3">
            {selectedTotals.map(({ product, orderCount, totals }) => (
              <li key={product} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-base font-semibold leading-snug text-(--text)">
                  {product}
                  <span className="mt-0.5 block text-[13px] font-normal text-(--dim)">
                    未領取 {orderCount} 單
                  </span>
                </span>
                <span className="shrink-0 text-right text-xl font-bold tabular-nums text-(--text)">
                  {totals.length > 0
                    ? totals
                        .map(([unit, sum]) => `${formatQty(sum)}${unit ? ` ${unit}` : ""}`)
                        .join(" · ")
                    : "0"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {writeError ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
          {writeError}
        </p>
      ) : null}

      {/* States */}
      {weeks.isPending || (tab && week.isPending) ? (
        <p className="mt-10 text-center text-(--dim)">載入緊 Sheet…</p>
      ) : weeks.isError ? (
        <div className="mt-10 text-center">
          <p className="text-red-700 dark:text-red-300">
            {weeks.error instanceof Error ? weeks.error.message : "連唔到 Google Sheet。"}
          </p>
          <button
            type="button"
            onClick={() => void weeks.refetch()}
            className="mt-3 min-h-11 rounded-lg bg-(--accent) px-4 font-semibold text-white"
          >
            再試
          </button>
        </div>
      ) : week.isError ? (
        <div className="mt-10 text-center">
          <p className="text-red-700 dark:text-red-300">
            {week.error instanceof Error ? week.error.message : "讀唔到呢個星期嘅訂單。"}
          </p>
          <button
            type="button"
            onClick={() => void week.refetch()}
            className="mt-3 min-h-11 rounded-lg bg-(--accent) px-4 font-semibold text-white"
          >
            再試
          </button>
        </div>
      ) : orders.length === 0 ? (
        <p className="mt-10 text-center text-(--dim)">呢個星期未有訂單。</p>
      ) : visible.length === 0 ? (
        <div className="mt-10 text-center">
          <p className="text-(--dim)">冇符合嘅訂單。</p>
          {numberSearch || search || filter !== "all" || itemFilters.length > 0 || nameFilter ? (
            <button
              type="button"
              onClick={() => {
                setNumberSearch("");
                setSearch("");
                setFilter("all");
                setItemFilters([]);
                setNameFilter("");
              }}
              className="mt-3 min-h-11 rounded-lg bg-(--accent) px-4 font-semibold text-white"
            >
              清除搜尋同篩選
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {visible.map((order) => (
            <OrderCard
              key={order.order_no}
              order={order}
              busy={toggle.isPending && toggle.variables?.order_no === order.order_no}
              itemFilters={itemFilters}
              nameFilter={nameFilter}
              onToggleName={toggleNameFilter}
              onToggleItem={toggleItemFilter}
              onToggle={() =>
                toggle.mutate({ order_no: order.order_no, picked_up: !order.picked_up })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Sums can be fractional (e.g. 1.5); show integers without a
 *  trailing .0 and trim float noise otherwise. */
function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function OrderCard({
  order,
  busy,
  itemFilters,
  nameFilter,
  onToggleName,
  onToggleItem,
  onToggle,
}: {
  order: Order;
  busy: boolean;
  itemFilters: string[];
  nameFilter: string;
  onToggleName: (name: string) => void;
  onToggleItem: (product: string) => void;
  onToggle: () => void;
}) {
  const done = order.picked_up;
  const nameActive = nameFilter !== "" && nameFilter === order.name;
  return (
    <li
      className={`rounded-2xl border bg-(--surface) p-4 ${
        done ? "border-(--accent)" : "border-(--border)"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[28px] font-bold leading-none text-(--text)">
              #{order.order_no}
            </span>
            <button
              type="button"
              aria-pressed={nameActive}
              aria-label={
                nameActive
                  ? `取消只睇客人「${order.name}」嘅單`
                  : `只睇客人「${order.name}」嘅所有單`
              }
              onClick={() => onToggleName(order.name)}
              className={`-mx-1 min-w-0 truncate rounded-lg px-1 py-0.5 text-left text-lg font-semibold ${
                nameActive
                  ? "bg-(--accent) text-white"
                  : "text-(--text) underline decoration-(--border) underline-offset-4"
              }`}
            >
              {order.name}
            </button>
          </p>
          {order.customer_note ? (
            <p className="mt-1 text-[13px] text-(--dim)">客人備註：{order.customer_note}</p>
          ) : null}
          {done && order.picked_at ? (
            <p className="mt-1 text-[13px] text-(--dim)">領取時間：{order.picked_at}</p>
          ) : null}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[13px] font-bold ${
            done
              ? "bg-(--accent) text-white"
              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          }`}
        >
          {done ? "已領取" : "未領取"}
        </span>
      </div>

      <ul className="mt-2 divide-y divide-(--border) border-t border-(--border)">
        {order.items.map((item, i) => {
          const active = itemFilters.includes(item.product);
          return (
            <li key={i} className="flex items-baseline justify-between gap-3 py-1">
              <button
                type="button"
                aria-pressed={active}
                aria-label={
                  active
                    ? `取消用「${item.product}」篩選`
                    : `用「${item.product}」篩選訂單`
                }
                onClick={() => onToggleItem(item.product)}
                className={`-mx-1 min-w-0 rounded-lg px-1 py-0.5 text-left text-base ${
                  active
                    ? "bg-(--accent) font-semibold text-white"
                    : "text-(--text) underline decoration-(--border) underline-offset-4"
                }`}
              >
                {item.product}
                {item.note ? (
                  <span className={`block text-[13px] ${active ? "text-white/80" : "text-(--dim)"}`}>
                    {item.note}
                  </span>
                ) : null}
              </button>
              <span className="shrink-0 text-base font-semibold tabular-nums text-(--text)">
                {item.qty}
                {item.unit ? <span className="ml-0.5 text-sm font-normal text-(--dim)">{item.unit}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>

      <SwipeToConfirm
        // remount when the state flips so the thumb always starts at the left
        key={done ? "undo" : "pick"}
        busy={busy}
        tone={done ? "neutral" : "primary"}
        direction={done ? "left" : "right"}
        icon={done ? "↩" : "✓"}
        label={done ? "向左掃，改返未領取" : "向右掃，標記已領取"}
        ariaLabel={
          done
            ? `訂單 ${order.order_no} 改返未領取（向左掃）`
            : `訂單 ${order.order_no} 標記已領取（向右掃）`
        }
        onConfirm={onToggle}
      />
    </li>
  );
}
