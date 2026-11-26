import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Item, type Movement, type Unit, type Storage, type ShelfStatus } from "./api";
import { BarcodeScanner } from "./BarcodeScanner";

const STORAGE_LABEL: Record<Storage, string> = {
  frozen: "冷凍（未定）",
  frozen_1f: "冷凍 1F",
  frozen_2f: "冷凍 2F",
  dry: "乾貨",
  fresh: "新鮮",
  unclassified: "未分類",
};

const KIND_LABEL: Record<Movement["kind"], string> = {
  initial: "期初",
  in: "入貨",
  out: "出貨",
  adjust: "盤點調整",
};

const SHELF_LABEL: Record<ShelfStatus, string> = {
  ok: "貨架正常",
  need_refill: "補貨架",
};

type StorageFilter = "all" | Storage;
type StatusFilter = "all" | "out" | "low" | "tmp" | "shelf";

const STORAGE_FILTERS: Array<{ key: StorageFilter; label: string }> = [
  { key: "all", label: "全部位置" },
  { key: "frozen_1f", label: "冷凍 1F" },
  { key: "frozen_2f", label: "冷凍 2F" },
  { key: "frozen", label: "冷凍（未定）" },
  { key: "unclassified", label: "未分類" },
];

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "全部狀態" },
  { key: "out", label: "缺貨" },
  { key: "low", label: "低存量" },
  { key: "shelf", label: "補貨架" },
  { key: "tmp", label: "待補編號" },
];

/** TMP-xxx is a placeholder Key for an item whose real 7-character stock
 *  code has not been scanned yet. */
function isTmpKey(code: string) {
  return code.startsWith("TMP-");
}

function isLow(item: Item) {
  // Quantity 0 counts as low too: an item at 0 is below any threshold the
  // user set (e.g. 水雲 at 0 Case with threshold 2 must appear under the
  // 低存量 filter, not only under 缺貨).
  return item.low_stock != null && item.quantity <= item.low_stock;
}

/** Quantities can be fractional (e.g. 1.2916 Case printed on an order). Show up to 4 decimal places, trimming trailing zeros. */
function fmtQty(n: number) {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(4)));
}

function formatTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-Hant", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"stock" | "history">("stock");
  const [codeSearch, setCodeSearch] = useState("");
  const [search, setSearch] = useState("");
  const [historyCode, setHistoryCode] = useState<string | null>(null);
  const [storageFilter, setStorageFilter] = useState<StorageFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [editingMovement, setEditingMovement] = useState<Movement | null>(null);
  const [bulk, setBulk] = useState<{ item: Item; kind: "in" | "out" } | null>(null);
  const [notice, setNotice] = useState("");
  const [info, setInfo] = useState("");
  // Multi-select (user, 2026-11-19: 「加入multi select item，等我可以
  // 大規模咁改佢個存貨位置」): selection is a set of 貨品編號 Keys.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<ReadonlySet<string>>(new Set());
  const [showBulkOps, setShowBulkOps] = useState(false);

  const toggleSelect = (code: string) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };
  const clearSelection = () => setSelectedCodes(new Set());
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedCodes(new Set());
    setShowBulkOps(false);
  };

  const itemsQuery = useQuery({
    queryKey: ["items"],
    queryFn: () => api.listItems({}),
  });
  const movementsQuery = useQuery({
    queryKey: ["movements"],
    queryFn: () => api.listMovements({ limit: 80 }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["items"] });
    void queryClient.invalidateQueries({ queryKey: ["movements"] });
    void queryClient.invalidateQueries({ queryKey: ["itemMovements"] });
    void queryClient.invalidateQueries({ queryKey: ["sheetStatus"] });
  };

  const fail = (error: Error) => setNotice(error.message || "操作失敗，請再試");

  // Direct mode: the Sheet IS the data. This status query only reports
  // reachability + what the 「Space 更新狀態」 tab last recorded; there
  // is no sync, no pending count, nothing stored locally.
  const sheetStatusQuery = useQuery({
    queryKey: ["sheetStatus"],
    queryFn: () => api.getSheetStatus({}),
  });
  const sheetConnected = sheetStatusQuery.data?.connected ?? true;

  /** Re-read the Sheet live and return the freshest copy of an item,
   *  matched by its 貨品編號 Key. */
  const freshItem = async (stockCode: string): Promise<Item | null> => {
    try {
      const data = await api.listItems({});
      queryClient.setQueryData(["items"], data);
      return data.items.find((i) => i.stock_code === stockCode) ?? null;
    } catch {
      const cached = queryClient.getQueryData<{ items: Item[] }>(["items"]);
      return cached?.items.find((i) => i.stock_code === stockCode) ?? null;
    }
  };
  const openAdd = () => setShowAdd(true);
  const openEdit = async (item: Item) => {
    const fresh = await freshItem(item.stock_code);
    if (!fresh) {
      setNotice("喺 Sheet 入面搵唔返呢項貨品，可能編號已經俾人改咗或者刪咗，請對返清單再試。");
      return;
    }
    setEditing(fresh);
  };
  const openBulk = async (item: Item, kind: "in" | "out") => {
    const fresh = await freshItem(item.stock_code);
    if (!fresh) {
      setNotice("喺 Sheet 入面搵唔返呢項貨品，可能編號已經俾人改咗或者刪咗，請對返清單再試。");
      return;
    }
    if (kind === "out" && fresh.quantity <= 0) {
      setNotice(`「${fresh.name_zh || fresh.name_en}」存量係 0，冇貨可出。`);
      return;
    }
    setBulk({ item: fresh, kind });
  };

  const quickAdjust = useMutation({
    mutationFn: async (args: { stockCode: string; delta: number }) =>
      await api.adjustQuantity({
        stockCode: args.stockCode,
        delta: args.delta,
        kind: args.delta > 0 ? "in" : "out",
        note: "",
      }),
    onSuccess: invalidate,
    onError: fail,
  });

  const shelfStatus = useMutation({
    mutationFn: async (args: { stockCode: string; status: ShelfStatus }) =>
      await api.setShelfStatus({ stockCode: args.stockCode, status: args.status }),
    onSuccess: (_data, variables) => {
      invalidate();
      // Pure status change (user, 2026-11-20 final decision): both
      // 補貨架 and 已補好 only flip the shelf flag — no quantity change,
      // no movement record.
      setNotice("");
      setInfo(
        variables.status === "need_refill"
          ? "已標記補貨架（淨係轉狀態，冇改數量）。"
          : "已補好，已清標記（淨係轉狀態，冇改數量）。",
      );
    },
    onError: fail,
  });

  const items = itemsQuery.data?.items ?? [];

  const stats = useMemo(() => {
    let cases = 0;
    let packs = 0;
    let boxes = 0;
    let kg = 0;
    let pieces = 0;
    let out = 0;
    let low = 0;
    let tmp = 0;
    let refill = 0;
    for (const it of items) {
      if (it.unit === "Case") cases += it.quantity;
      else if (it.unit === "Pack") packs += it.quantity;
      else if (it.unit === "Box") boxes += it.quantity;
      else if (it.unit === "KG") kg += it.quantity;
      else pieces += it.quantity;
      if (it.quantity === 0) out += 1;
      if (isLow(it)) low += 1;
      if (isTmpKey(it.stock_code)) tmp += 1;
      if (it.shelf_status !== "ok") refill += 1;
    }
    return { count: items.length, cases, packs, boxes, kg, pieces, out, low, tmp, refill };
  }, [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cq = codeSearch.trim().toLowerCase();
    return items.filter((it) => {
      // Two filters combine (AND): storage location + stock status.
      // e.g. 冷凍 1F + 缺貨 shows only 1F items that are out of stock.
      if (storageFilter !== "all" && it.storage !== storageFilter) return false;
      if (statusFilter === "out" && it.quantity !== 0) return false;
      if (statusFilter === "low" && !isLow(it)) return false;
      if (statusFilter === "shelf" && it.shelf_status === "ok") return false;
      if (statusFilter === "tmp" && !isTmpKey(it.stock_code)) return false;
      // Left box: 貨品編號 Key only. Right box: everything else
      // (names, packing, barcode, notes). Both combine (AND).
      if (cq && !it.stock_code.toLowerCase().includes(cq)) return false;
      if (!q) return true;
      const hay = `${it.name_en} ${it.name_zh} ${it.packing} ${it.barcode} ${it.notes}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, search, codeSearch, storageFilter, statusFilter]);

  const hasActiveFilter = storageFilter !== "all" || statusFilter !== "all";
  const activeFilterLabel = useMemo(() => {
    const parts: string[] = [];
    if (storageFilter !== "all") {
      parts.push(STORAGE_FILTERS.find((f) => f.key === storageFilter)?.label ?? storageFilter);
    }
    if (statusFilter !== "all") {
      parts.push(STATUS_FILTERS.find((f) => f.key === statusFilter)?.label ?? statusFilter);
    }
    return parts.join(" + ");
  }, [storageFilter, statusFilter]);

  const selectedItems = useMemo(
    () => items.filter((it) => selectedCodes.has(it.stock_code)),
    [items, selectedCodes],
  );

  // Quick bulk shelf marking from the sticky bar (same bulk action the
  // dialog uses, just without opening it).
  const bulkShelf = useMutation({
    mutationFn: async (status: ShelfStatus) =>
      await api.bulkUpdateItems({ stockCodes: [...selectedCodes], shelfStatus: status }),
    onSuccess: (_data, status) => {
      const n = selectedCodes.size;
      setInfo(`已批量將 ${n} 項貨品${status === "need_refill" ? "標記做補貨架" : "標記做已補好（貨架正常）"}。`);
      exitSelectMode();
      invalidate();
    },
    onError: fail,
  });

  // The list is always flat — including the 全部 view (user, 2026-11-19:
  // 「全部嗰陣可以唔使咁樣摺疊埋，我通常只會用 filter 制直接分」). Splitting
  // by storage is what the filter chips are for; no collapsible groups.
  const renderItem = (item: Item) => (
    <ItemCard
      key={item.stock_code || item.row_number}
      item={item}
      busy={quickAdjust.isPending && quickAdjust.variables?.stockCode === item.stock_code}
      shelfBusy={shelfStatus.isPending && shelfStatus.variables?.stockCode === item.stock_code}
      onShelf={(status) => shelfStatus.mutate({ stockCode: item.stock_code, status })}
      onQuick={(delta) => quickAdjust.mutate({ stockCode: item.stock_code, delta })}
      onBulk={(kind) => void openBulk(item, kind)}
      onEdit={() => void openEdit(item)}
      onHistory={() => setHistoryCode(item.stock_code)}
      onSaved={invalidate}
      onError={fail}
      selectMode={selectMode}
      selected={selectedCodes.has(item.stock_code)}
      onToggleSelect={() => toggleSelect(item.stock_code)}
    />
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <main className="mx-auto max-w-5xl px-4 pb-10">
        {/* Summary strip */}
        <section aria-label="存量概覽" className="pt-4">
          <div className="grid grid-cols-3 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-6">
            <Stat label="總品項" value={stats.count} text={String(stats.count)} />
            <Stat label="總箱數 Case" value={stats.cases} text={fmtQty(stats.cases)} bordered />
            <Stat label="總包數 Pack" value={stats.packs} text={fmtQty(stats.packs)} bordered />
            <Stat label="總盒數 Box" value={stats.boxes} text={fmtQty(stats.boxes)} bordered />
            <Stat label="總重量 KG" value={stats.kg} text={fmtQty(stats.kg)} bordered />
            <div className="border-l border-[var(--border)] px-3 py-3">
              <p className={`num text-2xl font-semibold ${stats.out > 0 ? "text-[var(--bad)]" : ""}`}>
                {stats.out}
              </p>
              <p className="text-xs text-[var(--dim)]">
                缺貨{stats.low > 0 ? ` · ${stats.low} 項低存量` : ""}
                {stats.refill > 0 ? ` · ${stats.refill} 項補貨架` : ""}
                {stats.tmp > 0 ? ` · ${stats.tmp} 項待補編號` : ""}
              </p>
            </div>
          </div>
        </section>

        {/* Google Sheet direct connection — compact single row */}
        <section aria-label="Google Sheet 直連" className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium">Google Sheet 直連</span>
            {sheetStatusQuery.isPending ? (
              <span className="text-xs text-[var(--dim)]">連接緊…</span>
            ) : sheetConnected ? (
              <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--good)]">
                已連接
              </span>
            ) : (
              <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--bad)]">
                連唔到 Sheet
              </span>
            )}
            {sheetConnected && sheetStatusQuery.data?.last_updated_at ? (
              <span className="text-[11px] text-[var(--dim)]">最後更新：{sheetStatusQuery.data.last_updated_at}</span>
            ) : null}
            {!sheetConnected && (
              <span className="text-[11px] text-[var(--bad)]">冇離線副本，連返線先用到</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={invalidate}
                className="rounded-[var(--radius)] border border-[var(--accent)] px-2 py-1 text-xs font-semibold text-[var(--accent)]"
              >
                重新載入
              </button>
            </span>
          </div>
        </section>

        {/* View toggle + add */}
        <div className="mt-4 flex items-center gap-2">
          <div className="flex rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-1" role="tablist" aria-label="檢視模式">
            <button
              type="button"
              role="tab"
              aria-selected={view === "stock"}
              onClick={() => setView("stock")}
              className={`rounded-md px-4 py-1.5 text-sm font-medium ${view === "stock" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"}`}
            >
              存貨
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "history"}
              onClick={() => setView("history")}
              className={`rounded-md px-4 py-1.5 text-sm font-medium ${view === "history" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"}`}
            >
              出入記錄
            </button>
          </div>
          {view === "stock" && (
            <button
              type="button"
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              aria-pressed={selectMode}
              className={`ml-auto rounded-[var(--radius)] border px-4 py-2 text-sm font-semibold ${
                selectMode
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                  : "border-[var(--accent)] text-[var(--accent)]"
              }`}
            >
              {selectMode ? "完成多選" : "多選"}
            </button>
          )}
          <button
            type="button"
            onClick={openAdd}
            className={`${view === "stock" ? "" : "ml-auto "}rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)]`}
          >
            ＋ 新增貨品
          </button>
        </div>

        {notice && (
          <p role="alert" className="mt-3 rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--bad)]">
            {notice}
            <button type="button" className="ml-2 underline" onClick={() => setNotice("")}>知道了</button>
          </p>
        )}

        {info && (
          <p className="mt-3 rounded-[var(--radius)] border border-[var(--good)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--good)]">
            {info}
            <button type="button" className="ml-2 underline" onClick={() => setInfo("")}>知道了</button>
          </p>
        )}

        {view === "stock" ? (
          <>
            <div className="mt-3 flex items-stretch gap-2">
              <div className="w-28 shrink-0">
                <label htmlFor="search-code" className="sr-only">搜尋編號 Key</label>
                <input
                  id="search-code"
                  type="search"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={codeSearch}
                  onChange={(e) => setCodeSearch(e.target.value.replace(/\D/g, ""))}
                  placeholder="編號 Key…"
                  autoComplete="off"
                  className="num h-full w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor="search" className="sr-only">搜尋貨品名、條碼同其他資料</label>
                <input
                  id="search"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜尋貨品名、條碼、備註…"
                  className="h-full w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base"
                />
              </div>
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                aria-label="用相機掃描條碼搜尋"
                className="shrink-0 rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent)]"
              >
                掃碼
              </button>
            </div>
            <div className="mt-3 space-y-2.5" aria-label="篩選">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-10 shrink-0 text-xs font-semibold text-[var(--dim)]">位置</span>
                {STORAGE_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStorageFilter(f.key)}
                    aria-pressed={storageFilter === f.key}
                    aria-label={`位置篩選：${f.label}`}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
                      storageFilter === f.key
                        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-10 shrink-0 text-xs font-semibold text-[var(--dim)]">狀態</span>
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStatusFilter(f.key)}
                    aria-pressed={statusFilter === f.key}
                    aria-label={`狀態篩選：${f.label}`}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium ${
                      statusFilter === f.key
                        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]"
                        : "border-[var(--border)] bg-[var(--surface)] text-[var(--dim)]"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {hasActiveFilter && (
                <div className="flex flex-wrap items-center gap-2 pl-12 text-xs text-[var(--dim)]">
                  <span>
                    顯示緊：<span className="font-semibold text-[var(--text)]">{activeFilterLabel}</span>
                    {" · "}
                    {visible.length} 項
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setStorageFilter("all");
                      setStatusFilter("all");
                    }}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--accent)]"
                  >
                    清除篩選
                  </button>
                </div>
              )}
            </div>

            {selectMode && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] px-3 py-2" aria-label="多選工具列">
                <span className="text-sm font-semibold">已選 {selectedCodes.size} 項</span>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedCodes((prev) => {
                      const next = new Set(prev);
                      for (const it of visible) if (it.stock_code) next.add(it.stock_code);
                      return next;
                    })
                  }
                  className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium"
                >
                  全選可見（{visible.length} 項）
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedCodes((prev) => {
                      const next = new Set(prev);
                      for (const it of items) if (it.stock_code) next.add(it.stock_code);
                      return next;
                    })
                  }
                  className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium"
                >
                  全選全部（{items.length} 項）
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selectedCodes.size === 0}
                  className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium disabled:opacity-40"
                >
                  清除選取
                </button>
                <span className="text-xs text-[var(--dim)]">撳貨品左邊個格仔嚟揀，揀好撳下面「批量操作」一次過改。</span>
              </div>
            )}

            {itemsQuery.isPending ? (
              <p className="py-12 text-center text-[var(--dim)]">載入緊存貨…</p>
            ) : itemsQuery.error ? (
              <p className="py-12 text-center text-[var(--bad)]">連唔到 Google Sheet — 直連模式冇本機副本，請檢查網絡，撳上面「重新載入」再試。</p>
            ) : items.length === 0 ? (
              <p className="py-12 text-center text-[var(--dim)]">倉庫仲未有任何貨品，撳「新增貨品」開始記錄。</p>
            ) : visible.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-[var(--dim)]">
                  {hasActiveFilter
                    ? `冇符合「${activeFilterLabel}」嘅貨品。`
                    : "冇符合條件嘅貨品。"}
                </p>
                {hasActiveFilter && (
                  <button
                    type="button"
                    onClick={() => {
                      setStorageFilter("all");
                      setStatusFilter("all");
                    }}
                    className="mt-3 rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)]"
                  >
                    清除篩選睇全部
                  </button>
                )}
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                {visible.map(renderItem)}
              </ul>
            )}
          </>
        ) : (
          <section aria-label="出入記錄" className="mt-4">
            {movementsQuery.isPending ? (
              <p className="py-12 text-center text-[var(--dim)]">載入緊記錄…</p>
            ) : movementsQuery.error ? (
              <p className="py-12 text-center text-[var(--bad)]">連唔到 Google Sheet — 直連模式冇本機副本，請檢查網絡，撳上面「重新載入」再試。</p>
            ) : (movementsQuery.data?.movements.length ?? 0) === 0 ? (
              <p className="py-12 text-center text-[var(--dim)]">暫時未有出入記錄。</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                {movementsQuery.data?.movements.map((m) => (
                  <li key={m.id} className="flex items-baseline gap-3 px-3 py-2.5">
                    <span
                      className={`num w-14 shrink-0 text-right text-base font-semibold ${
                        m.delta > 0 ? "text-[var(--good)]" : m.delta < 0 ? "text-[var(--bad)]" : "text-[var(--dim)]"
                      }`}
                    >
                      {m.delta > 0 ? `+${fmtQty(m.delta)}` : fmtQty(m.delta)}
                    </span>
                    <div className="min-w-0 flex-1">
                      {m.stock_code ? (
                        <button
                          type="button"
                          onClick={() => setHistoryCode(m.stock_code)}
                          aria-label={`睇 ${m.item_name} 嘅出入記錄`}
                          className="block max-w-full truncate text-left text-sm font-medium underline decoration-[var(--border)] decoration-dotted underline-offset-4 hover:decoration-[var(--accent)]"
                        >
                          {m.item_name}
                        </button>
                      ) : (
                        <p className="truncate text-sm font-medium">{m.item_name}</p>
                      )}
                      {m.note && <p className="truncate text-xs text-[var(--dim)]">{m.note}</p>}
                    </div>
                    <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-xs text-[var(--dim)]">
                      {KIND_LABEL[m.kind]}
                    </span>
                    <span className="num shrink-0 text-xs text-[var(--dim)]">{formatTime(m.created_at)}</span>
                    <button
                      type="button"
                      onClick={() => setEditingMovement(m)}
                      aria-label={`編輯記錄：${m.item_name} ${KIND_LABEL[m.kind]} ${m.delta > 0 ? "+" : ""}${fmtQty(m.delta)}`}
                      className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
                    >
                      編輯
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {selectMode && selectedCodes.size > 0 && <div aria-hidden="true" className="h-24" />}
      </main>

      {/* Sticky bulk action bar — shown while items are selected */}
      {view === "stock" && selectMode && selectedCodes.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-2px_12px_rgba(0,0,0,0.18)]">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">已選 {selectedCodes.size} 項</span>
            <button
              type="button"
              onClick={() => setShowBulkOps(true)}
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)]"
            >
              批量操作
            </button>
            <button
              type="button"
              disabled={bulkShelf.isPending}
              onClick={() => bulkShelf.mutate("need_refill")}
              className="rounded-[var(--radius)] border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
            >
              標記補貨架
            </button>
            <button
              type="button"
              disabled={bulkShelf.isPending}
              onClick={() => bulkShelf.mutate("ok")}
              className="rounded-[var(--radius)] border border-[var(--good)] px-3 py-2 text-sm font-medium text-[var(--good)] disabled:opacity-50"
            >
              標記已補好
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]"
            >
              清除
            </button>
          </div>
        </div>
      )}

      {showAdd && (
        <ItemFormDialog
          title="新增貨品"
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            invalidate();
          }}
        />
      )}
      {editing && (
        <ItemFormDialog
          title="編輯貨品"
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      {showBulkOps && selectedItems.length > 0 && (
        <BulkOpsDialog
          items={selectedItems}
          onClose={() => setShowBulkOps(false)}
          onDone={(message) => {
            setShowBulkOps(false);
            exitSelectMode();
            setInfo(message);
            invalidate();
          }}
          onError={fail}
        />
      )}
      {historyCode !== null && (
        <ItemHistoryDialog
          stockCode={historyCode}
          item={items.find((i) => i.stock_code === historyCode) ?? null}
          onClose={() => setHistoryCode(null)}
          onEditMovement={(m) => setEditingMovement(m)}
        />
      )}
      {editingMovement && (
        <EditMovementDialog
          movement={editingMovement}
          onClose={() => setEditingMovement(null)}
          onSaved={(message) => {
            setEditingMovement(null);
            setInfo(message);
            invalidate();
          }}
        />
      )}
      {bulk && (
        <BulkAdjustDialog
          item={bulk.item}
          kind={bulk.kind}
          onClose={() => setBulk(null)}
          onSaved={() => {
            setBulk(null);
            invalidate();
          }}
          onError={fail}
        />
      )}
      {scannerOpen && (
        <BarcodeScanner
          onClose={() => setScannerOpen(false)}
          onResult={(value) => {
            // A scan fills the right-hand search box (barcode is part of
            // the matched fields), which runs the search immediately.
            setSearch(value);
            setScannerOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, text, bordered }: { label: string; value?: number; text: string; bordered?: boolean }) {
  return (
    <div className={`px-3 py-3 ${bordered ? "border-l border-[var(--border)]" : ""}`}>
      <p className="num text-2xl font-semibold">{text}</p>
      <p className="text-xs text-[var(--dim)]">{label}</p>
    </div>
  );
}

function ItemCard({
  item,
  busy,
  shelfBusy,
  onShelf,
  onQuick,
  onBulk,
  onEdit,
  onHistory,
  onSaved,
  onError,
  selectMode,
  selected,
  onToggleSelect,
}: {
  item: Item;
  busy: boolean;
  shelfBusy: boolean;
  onShelf: (status: ShelfStatus) => void;
  onQuick: (delta: number) => void;
  onBulk: (kind: "in" | "out") => void;
  onEdit: () => void;
  onHistory: () => void;
  onSaved: () => void;
  onError: (e: Error) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const out = item.quantity === 0;
  const low = isLow(item);
  const displayName = item.name_zh || item.name_en;
  return (
    <li className={`px-3 py-2 ${selectMode && selected ? "bg-[var(--surface-alt)]" : ""}`}>
      {/* Line 1: name + status badges */}
      <div className="flex items-center gap-2">
        {selectMode && (
          <input
            type="checkbox"
            checked={selected}
            disabled={!item.stock_code}
            onChange={onToggleSelect}
            aria-label={`選取 ${displayName}`}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
        )}
        <button
          type="button"
          onClick={onHistory}
          aria-label={`打開 ${displayName} 同佢嘅出入記錄`}
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold leading-snug"
        >
          {displayName}
          {item.name_zh && (
            <span className="ml-1.5 font-normal text-[var(--dim)]">{item.name_en}</span>
          )}
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-xs text-[var(--dim)]">
            {STORAGE_LABEL[item.storage]}
          </span>
          {item.shelf_status === "need_refill" && (
            <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-ink)]">補貨架</span>
          )}
          {out && (
            <span className="rounded bg-[var(--bad)] px-1.5 py-0.5 text-xs font-semibold text-[var(--bad-ink)]">缺貨</span>
          )}
          {low && (
            <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-ink)]">低存量</span>
          )}
          {isTmpKey(item.stock_code) && (
            <span className="rounded border border-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">待補編號</span>
          )}
        </div>
      </div>

      {/* Line 2: packing / code / barcode / notes */}
      <p className="num mt-0.5 truncate text-xs text-[var(--dim)]">
        {item.packing}
        {item.stock_code && (
          <>
            {" "}· 編號 Key {item.stock_code}
            {isTmpKey(item.stock_code) ? "（臨時）" : ""}
          </>
        )}
        {item.barcode && <> · 條碼 {item.barcode}</>}
      </p>

      {/* Line 3: quantity stepper + unit + shelf + bulk/edit actions */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="flex items-center overflow-hidden rounded-md border border-[var(--border)]">
          <button
            type="button"
            aria-label={`減少 ${displayName} 存量`}
            disabled={busy || item.quantity <= 0}
            onClick={() => onQuick(-1)}
            className="flex h-8 w-8 items-center justify-center text-lg font-bold disabled:opacity-35"
          >
            −
          </button>
          <QtyInput item={item} onSaved={onSaved} onError={onError} />
          <button
            type="button"
            aria-label={`增加 ${displayName} 存量`}
            disabled={busy}
            onClick={() => onQuick(1)}
            className="flex h-8 w-8 items-center justify-center text-lg font-bold text-[var(--accent)] disabled:opacity-35"
          >
            ＋
          </button>
        </div>
        <span className="text-xs text-[var(--dim)]">{item.unit}</span>

        <span className="text-xs text-[var(--dim)]">貨架：{SHELF_LABEL[item.shelf_status]}</span>
        {item.shelf_status === "ok" ? (
          <button
            type="button"
            disabled={shelfBusy}
            onClick={() => onShelf("need_refill")}
            aria-label={`標記 ${displayName} 補貨架（淨係轉狀態，唔改數量）`}
            className="rounded-md border border-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
          >
            補貨架
          </button>
        ) : (
          <button
            type="button"
            disabled={shelfBusy}
            onClick={() => onShelf("ok")}
            aria-label={`標記 ${displayName} 已補好（淨係清標記，唔改數量）`}
            className="rounded-md border border-[var(--good)] px-2 py-1 text-xs font-medium text-[var(--good)] disabled:opacity-50"
          >
            已補好
          </button>
        )}

        {item.notes && (
          <span className="min-w-[10rem] flex-1 basis-40 break-words text-xs text-[var(--dim)]">
            備註：{item.notes}
          </span>
        )}

        <div className="ml-auto flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => onBulk("in")}
            className="rounded-md border border-[var(--good)] px-2 py-1 text-xs font-medium text-[var(--good)]"
          >
            入貨
          </button>
          <button
            type="button"
            onClick={() => onBulk("out")}
            disabled={item.quantity <= 0}
            className="rounded-md border border-[var(--bad)] px-2 py-1 text-xs font-medium text-[var(--bad)] disabled:opacity-35"
          >
            出貨
          </button>
          <button
            type="button"
            onClick={onHistory}
            aria-label={`${displayName} 出入記錄`}
            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
          >
            記錄
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`編輯 ${displayName}`}
            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
          >
            編輯
          </button>
        </div>
      </div>
    </li>
  );
}

function QtyInput({
  item,
  onSaved,
  onError,
}: {
  item: Item;
  onSaved: () => void;
  onError: (e: Error) => void;
}) {
  const setQty = useMutation({
    mutationFn: async (quantity: number) =>
      await api.setQuantity({ stockCode: item.stock_code, quantity, note: "" }),
    onSuccess: onSaved,
    onError,
  });
  return (
    <input
      key={`${item.stock_code}:${item.quantity}`}
      
      type="number"
      inputMode="decimal"
      step="any"
      defaultValue={fmtQty(item.quantity)}
      aria-label={`${item.name_zh || item.name_en} 目前存量（可直接改）`}
      className="num h-8 w-14 border-x border-[var(--border)] bg-[var(--surface-alt)] text-center text-base font-semibold"
      onBlur={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v !== item.quantity && v >= 0) setQty.mutate(v);
        else e.target.value = fmtQty(item.quantity);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function BulkOpsDialog({
  items,
  onClose,
  onDone,
  onError,
}: {
  items: Item[];
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (e: Error) => void;
}) {
  const codes = items.map((it) => it.stock_code);
  const [storage, setStorage] = useState<Storage>("frozen_1f");
  const [unit, setUnit] = useState<Unit>("Case");
  const [lowStock, setLowStock] = useState("");
  const [amount, setAmount] = useState("");
  const [qtyKind, setQtyKind] = useState<"in" | "out">("in");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const failLocal = (e: Error) => {
    setError(e.message || "操作失敗，請再試");
    onError(e);
  };

  const update = useMutation({
    mutationFn: async (args: {
      storage?: Storage;
      shelfStatus?: ShelfStatus;
      unit?: Unit;
      lowStock?: number | null;
    }) => await api.bulkUpdateItems({ stockCodes: codes, ...args }),
    onError: failLocal,
  });

  const adjust = useMutation({
    mutationFn: async (delta: number) =>
      await api.bulkAdjustQuantity({
        stockCodes: codes,
        delta,
        kind: qtyKind,
        note: note.trim(),
      }),
    onError: failLocal,
  });

  const remove = useMutation({
    mutationFn: async () => await api.bulkDeleteItems({ stockCodes: codes }),
    onError: failLocal,
  });

  const busy = update.isPending || adjust.isPending || remove.isPending;
  const fieldCls = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5";
  const applyBtn =
    "shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-50";

  const applyLowStock = (clear: boolean) => {
    if (clear) {
      update.mutate(
        { lowStock: null },
        { onSuccess: () => onDone(`已清除 ${items.length} 項貨品嘅低存量提示。`) },
      );
      return;
    }
    const v = Number(lowStock);
    if (lowStock.trim() === "" || !Number.isFinite(v) || v < 0) {
      setError("低存量提示要係 0 或以上嘅數字");
      return;
    }
    update.mutate(
      { lowStock: v },
      { onSuccess: () => onDone(`已將 ${items.length} 項貨品嘅低存量提示設做 ${fmtQty(v)}。`) },
    );
  };

  const applyQty = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("請輸入大過 0 嘅數量");
      return;
    }
    adjust.mutate(qtyKind === "in" ? n : -n, {
      onSuccess: () =>
        onDone(`已批量${qtyKind === "in" ? "入貨" : "出貨"}：${items.length} 項貨品每項${qtyKind === "in" ? "加" : "減"} ${fmtQty(n)}。`),
    });
  };

  return (
    <DialogShell title={`批量操作 · 已選 ${items.length} 項`} onClose={onClose}>
      <div className="space-y-4">
        <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-[var(--dim)]">
          {items.map((it) => it.name_zh || it.name_en).join("、")}
        </p>

        {/* Storage — the main ask */}
        <section aria-label="批量改儲存位置" className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">儲存位置</p>
          <div className="mt-1 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-storage" className="sr-only">儲存位置</label>
              <select id="bulk-storage" value={storage} onChange={(e) => setStorage(e.target.value as Storage)} className={fieldCls}>
                <option value="frozen_1f">冷凍 1F</option>
                <option value="frozen_2f">冷凍 2F</option>
                <option value="frozen">冷凍（未定）</option>
                <option value="unclassified">未分類</option>
              </select>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { storage },
                  { onSuccess: () => onDone(`已將 ${items.length} 項貨品嘅儲存位置改做「${STORAGE_LABEL[storage]}」。`) },
                )
              }
              className={applyBtn}
            >
              套用
            </button>
          </div>
        </section>

        {/* Shelf status */}
        <section aria-label="批量改貨架狀態" className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">貨架狀態</p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">標記淨係轉換貨架狀態，唔會改數量；數量要另外喺下面入貨／出貨嗰度改。</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { shelfStatus: "need_refill" },
                  { onSuccess: () => onDone(`已將 ${items.length} 項貨品標記做補貨架。`) },
                )
              }
              className="flex-1 rounded-[var(--radius)] border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
            >
              標記補貨架
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { shelfStatus: "ok" },
                  { onSuccess: () => onDone(`已將 ${items.length} 項貨品標記做已補好（貨架正常）。`) },
                )
              }
              className="flex-1 rounded-[var(--radius)] border border-[var(--good)] px-3 py-2 text-sm font-medium text-[var(--good)] disabled:opacity-50"
            >
              標記已補好
            </button>
          </div>
        </section>

        {/* Quantity in/out */}
        <section aria-label="批量入貨出貨" className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">數量入貨／出貨（每項同一個數量）</p>
          <div className="mt-2 flex gap-2" role="group" aria-label="入貨定出貨">
            <button
              type="button"
              aria-pressed={qtyKind === "in"}
              onClick={() => setQtyKind("in")}
              className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium ${qtyKind === "in" ? "border-[var(--good)] bg-[var(--good)] text-[var(--good-ink)]" : "border-[var(--border)] text-[var(--dim)]"}`}
            >
              入貨
            </button>
            <button
              type="button"
              aria-pressed={qtyKind === "out"}
              onClick={() => setQtyKind("out")}
              className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium ${qtyKind === "out" ? "border-[var(--bad)] bg-[var(--bad)] text-[var(--bad-ink)]" : "border-[var(--border)] text-[var(--dim)]"}`}
            >
              出貨
            </button>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-qty-amount" className="text-sm font-medium">每項數量（可小數）</label>
              <input
                id="bulk-qty-amount"
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`num ${fieldCls}`}
              />
            </div>
            <button type="button" disabled={busy} onClick={applyQty} className={applyBtn}>
              套用
            </button>
          </div>
          <div>
            <label htmlFor="bulk-qty-note" className="text-sm font-medium">備註（可留空，會寫入出入記錄）</label>
            <input
              id="bulk-qty-note"
              
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={fieldCls}
            />
          </div>
        </section>

        {/* Unit + low stock */}
        <section aria-label="批量改單位同低存量" className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">單位</p>
          <div className="mt-1 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-unit" className="sr-only">單位</label>
              <select id="bulk-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={fieldCls}>
                <option value="Case">Case（箱）</option>
                <option value="Pack">Pack（包）</option>
                <option value="Box">Box（盒）</option>
                <option value="KG">KG（公斤）</option>
                <option value="個">個</option>
              </select>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { unit },
                  { onSuccess: () => onDone(`已將 ${items.length} 項貨品嘅單位改做 ${unit}。`) },
                )
              }
              className={applyBtn}
            >
              套用
            </button>
          </div>
          <p className="mt-3 text-sm font-semibold">低存量提示</p>
          <div className="mt-1 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-low" className="sr-only">低存量提示</label>
              <input
                id="bulk-low"
                
                type="number"
                inputMode="decimal"
                step="any"
                value={lowStock}
                onChange={(e) => setLowStock(e.target.value)}
                placeholder="數量低過或等於呢個數就標示"
                className={`num ${fieldCls}`}
              />
            </div>
            <button type="button" disabled={busy} onClick={() => applyLowStock(false)} className={applyBtn}>
              套用
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => applyLowStock(true)}
              className="shrink-0 rounded-[var(--radius)] border border-[var(--border)] px-3 py-2.5 text-sm font-medium text-[var(--dim)] disabled:opacity-50"
            >
              清除提示
            </button>
          </div>
        </section>

        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        {busy && <p className="text-sm text-[var(--dim)]">處理緊…</p>}

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--bad)] px-3 py-2">
            <p className="flex-1 text-sm text-[var(--bad)]">確定喺 Sheet 刪除呢 {items.length} 項貨品？（出入記錄會保留做歷史）</p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => onDone(`已刪除 ${items.length} 項貨品。`),
                })
              }
              className="rounded-md bg-[var(--bad)] px-3 py-1.5 text-sm font-semibold text-[var(--bad-ink)] disabled:opacity-50"
            >
              確定刪除
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1.5 text-sm">
              唔刪
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className="w-full py-1 text-sm text-[var(--bad)]">
            刪除選取嘅 {items.length} 項貨品
          </button>
        )}
        <button type="button" onClick={onClose} className="w-full rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
          取消
        </button>
      </div>
    </DialogShell>
  );
}

function BulkAdjustDialog({
  item,
  kind,
  onClose,
  onSaved,
  onError,
}: {
  item: Item;
  kind: "in" | "out";
  onClose: () => void;
  onSaved: () => void;
  onError: (e: Error) => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const adjust = useMutation({
    mutationFn: async (delta: number) =>
      await api.adjustQuantity({ stockCode: item.stock_code, delta, kind, note: note.trim() }),
    onSuccess: onSaved,
    onError: (e) => {
      setError(e.message || "操作失敗，請再試");
      onError(e);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("請輸入大過 0 嘅數量");
      return;
    }
    if (kind === "out" && n > item.quantity) {
      setError(`出貨數量唔可以多過現有存量 ${fmtQty(item.quantity)}`);
      return;
    }
    adjust.mutate(kind === "in" ? n : -n);
  };

  return (
    <DialogShell title={`${kind === "in" ? "入貨" : "出貨"} · ${item.name_zh || item.name_en}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="num text-sm text-[var(--dim)]">
          現有存量：{fmtQty(item.quantity)} {item.unit}
        </p>
        <div>
          <label htmlFor="bulk-amount" className="text-sm font-medium">
            {kind === "in" ? "入貨" : "出貨"}數量（{item.unit}，可小數）
          </label>
          <input
            id="bulk-amount"
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={`${kind === "in" ? "入貨" : "出貨"}數量`}
            className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-lg"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="bulk-note" className="text-sm font-medium">備註（可留空）</label>
          <input
            id="bulk-note"
            
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="備註"
            placeholder={kind === "in" ? "例如：新貨單編號" : "例如：出貨去邊間分店"}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
          />
        </div>
        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={adjust.isPending}
            className={`flex-1 rounded-[var(--radius)] px-4 py-2.5 font-semibold disabled:opacity-50 ${
              kind === "in" ? "bg-[var(--good)] text-[var(--good-ink)]" : "bg-[var(--bad)] text-[var(--bad-ink)]"
            }`}
          >
            {adjust.isPending ? "處理緊…" : `確認${kind === "in" ? "入貨" : "出貨"}`}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
            取消
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function ItemHistoryDialog({
  stockCode,
  item,
  onClose,
  onEditMovement,
}: {
  stockCode: string;
  item: Item | null;
  onClose: () => void;
  onEditMovement: (m: Movement) => void;
}) {
  const history = useQuery({
    queryKey: ["itemMovements", stockCode],
    queryFn: () => api.listItemMovements({ stockCode }),
  });
  const name = item ? item.name_zh || item.name_en : stockCode;
  const movements = history.data?.movements ?? [];
  return (
    <DialogShell title={`出入記錄 · ${name}`} onClose={onClose}>
      <div className="space-y-3">
        {item && (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
            <p className="text-sm font-semibold leading-snug">
              {item.name_zh || item.name_en}
              {item.name_zh && <span className="ml-1.5 font-normal text-[var(--dim)]">{item.name_en}</span>}
            </p>
            <p className="num mt-0.5 text-xs text-[var(--dim)]">
              {item.packing}
              {item.stock_code && <> · 編號 Key {item.stock_code}</>}
              {item.barcode && <> · 條碼 {item.barcode}</>}
            </p>
            <p className="num mt-1 text-lg font-semibold">
              {fmtQty(item.quantity)} {item.unit}
              <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                {STORAGE_LABEL[item.storage]}
                {item.shelf_status === "need_refill" ? " · 補貨架" : ""}
              </span>
            </p>
          </div>
        )}
        {history.isPending ? (
          <p className="py-8 text-center text-[var(--dim)]">載入緊記錄…</p>
        ) : history.error ? (
          <p role="alert" className="py-8 text-center text-[var(--bad)]">
            {history.error instanceof Error ? history.error.message : "讀唔到出入記錄，請再試。"}
          </p>
        ) : movements.length === 0 ? (
          <p className="py-8 text-center text-[var(--dim)]">呢項貨品暫時未有出入記錄。</p>
        ) : (
          <>
            <p className="text-xs text-[var(--dim)]">共 {movements.length} 筆（新嘅喺上面）</p>
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
              {movements.map((m) => (
                <li key={m.id} className="flex items-baseline gap-2.5 px-3 py-2.5">
                  <span
                    className={`num w-14 shrink-0 text-right text-base font-semibold ${
                      m.delta > 0 ? "text-[var(--good)]" : m.delta < 0 ? "text-[var(--bad)]" : "text-[var(--dim)]"
                    }`}
                  >
                    {m.delta > 0 ? `+${fmtQty(m.delta)}` : fmtQty(m.delta)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-[var(--dim)]">
                      <span className="mr-1.5 rounded bg-[var(--surface-alt)] px-1.5 py-0.5">{KIND_LABEL[m.kind]}</span>
                      <span className="num">{formatTime(m.created_at)}</span>
                    </p>
                    {m.note && <p className="mt-0.5 break-words text-sm">{m.note}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => onEditMovement(m)}
                    aria-label={`編輯記錄：${m.item_name} ${KIND_LABEL[m.kind]} ${m.delta > 0 ? "+" : ""}${fmtQty(m.delta)}`}
                    className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
                  >
                    編輯
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </DialogShell>
  );
}

function EditMovementDialog({
  movement,
  onClose,
  onSaved,
}: {
  movement: Movement;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [kind, setKind] = useState<Movement["kind"]>(movement.kind);
  const [amount, setAmount] = useState(
    movement.kind === "adjust" ? String(movement.delta) : String(Math.abs(movement.delta)),
  );
  const [note, setNote] = useState(movement.note);
  const [error, setError] = useState("");

  /** Signed delta implied by a kind + the amount currently typed. */
  const signedFrom = (k: Movement["kind"], amt: string): number => {
    const n = Number(amt);
    if (!Number.isFinite(n)) return NaN;
    if (k === "out") return -Math.abs(n);
    if (k === "adjust") return n;
    return Math.abs(n);
  };

  const changeKind = (k: Movement["kind"]) => {
    const cur = signedFrom(kind, amount);
    setKind(k);
    if (Number.isFinite(cur)) {
      setAmount(k === "adjust" ? String(cur) : String(Math.abs(cur)));
    }
  };

  const newDelta = signedFrom(kind, amount);
  const diff = Number.isFinite(newDelta) ? newDelta - movement.delta : 0;

  const save = useMutation({
    mutationFn: async (delta: number) =>
      await api.updateMovement({
        movementId: movement.id,
        delta,
        kind,
        note: note.trim(),
      }),
    onSuccess: (data) => {
      onSaved(
        data.quantity != null
          ? `已更新記錄；「${movement.item_name}」現有存量而家係 ${fmtQty(data.quantity)}。`
          : `已更新記錄（嗰項貨品已經唔喺存貨表，存量冇郁）。`,
      );
    },
    onError: (e) => setError(e.message || "儲存失敗，請再試"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) {
      setError("請輸入唔係 0 嘅數量");
      return;
    }
    if (kind !== "adjust" && n < 0) {
      setError("數量請輸入正數，加定減由上面個種類決定");
      return;
    }
    if (newDelta === movement.delta && kind === movement.kind && note.trim() === movement.note) {
      setError("冇改到任何嘢");
      return;
    }
    save.mutate(newDelta);
  };

  const fieldCls = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5";

  return (
    <DialogShell title={`編輯記錄 · ${movement.item_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="num text-sm text-[var(--dim)]">
          {movement.stock_code && <>編號 {movement.stock_code} · </>}
          {formatTime(movement.created_at)} · 原本：{KIND_LABEL[movement.kind]}{" "}
          {movement.delta > 0 ? `+${fmtQty(movement.delta)}` : fmtQty(movement.delta)}
        </p>
        <div>
          <label htmlFor="mv-kind" className="text-sm font-medium">種類</label>
          <select
            id="mv-kind"
            value={kind}
            onChange={(e) => changeKind(e.target.value as Movement["kind"])}
            className={fieldCls}
          >
            <option value="in">入貨</option>
            <option value="out">出貨</option>
            <option value="adjust">盤點調整</option>
            <option value="initial">期初</option>
          </select>
        </div>
        <div>
          <label htmlFor="mv-amount" className="text-sm font-medium">
            {kind === "adjust" ? "變動數量（可正可負，例如 -2 或者 3）" : "數量（正數，方向由種類決定）"}
          </label>
          <input
            id="mv-amount"
            type="number"
            inputMode="decimal"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="記錄數量"
            className={`num ${fieldCls}`}
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="mv-note" className="text-sm font-medium">備註（可留空）</label>
          <input
            id="mv-note"
            
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="記錄備註"
            className={fieldCls}
          />
        </div>
        {diff !== 0 && (
          <p className="rounded-md bg-[var(--surface-alt)] px-3 py-2 text-sm text-[var(--dim)]">
            數量變動改咗：嗰項貨品嘅現有存量會跟住{diff > 0 ? "加" : "減"} {fmtQty(Math.abs(diff))}，同新記錄對返。
          </p>
        )}
        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={save.isPending}
            className="flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50"
          >
            {save.isPending ? "儲存緊…" : "儲存"}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
            取消
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function ItemFormDialog({
  title,
  item,
  onClose,
  onSaved,
}: {
  title: string;
  item?: Item;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [nameZh, setNameZh] = useState(item?.name_zh ?? "");
  const [nameEn, setNameEn] = useState(item?.name_en ?? "");
  const [packing, setPacking] = useState(item?.packing ?? "");
  const [stockCode, setStockCode] = useState(item?.stock_code ?? "");
  const [barcode, setBarcode] = useState(item?.barcode ?? "");
  const [unit, setUnit] = useState<Unit>(item?.unit ?? "Case");
  const [storage, setStorage] = useState<Storage>(item?.storage ?? "unclassified");
  const [quantity, setQuantity] = useState(item ? "" : "0");
  const [lowStock, setLowStock] = useState(item?.low_stock != null ? String(item.low_stock) : "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["items"] });
    void queryClient.invalidateQueries({ queryKey: ["movements"] });
    void queryClient.invalidateQueries({ queryKey: ["sheetStatus"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const en = nameEn.trim() || nameZh.trim();
      const zh = nameZh.trim();
      const low = lowStock.trim() === "" ? null : Number(lowStock);
      if (item) {
        return await api.updateItem({
          stockCode: item.stock_code,
          nameEn: en,
          nameZh: zh,
          packing: packing.trim(),
          newStockCode: stockCode.trim(),
          barcode: barcode.trim(),
          unit,
          storage,
          lowStock: low,
          notes: notes.trim(),
        });
      }
      return await api.addItem({
        nameEn: en,
        nameZh: zh,
        packing: packing.trim(),
        stockCode: stockCode.trim(),
        barcode: barcode.trim(),
        unit,
        storage,
        quantity: Math.max(0, Number(quantity) || 0),
        lowStock: low,
        notes: notes.trim(),
      });
    },
    onSuccess: () => {
      refresh();
      onSaved();
    },
    onError: (e) => setError(e.message || "儲存失敗，請再試"),
  });

  const remove = useMutation({
    mutationFn: async (code: string) => await api.deleteItem({ stockCode: code }),
    onSuccess: () => {
      refresh();
      onSaved();
    },
    onError: (e) => setError(e.message || "刪除失敗，請再試"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!nameZh.trim() && !nameEn.trim()) {
      setError("請填貨品名稱（中文或英文最少填一樣）");
      return;
    }
    const sc = stockCode.trim();
    if (sc && sc.length !== 7 && !/^TMP-\d{3,}$/.test(sc)) {
      setError(`貨品編號 Key 要啱啱七個字，或者 TMP-001 呢種臨時代號（而家 ${sc.length} 個字）；唔啱就清空佢，儲存嗰陣系統會自動俾一個 TMP 代號`);
      return;
    }
    if (lowStock.trim() !== "" && (!Number.isFinite(Number(lowStock)) || Number(lowStock) < 0)) {
      setError("低存量提示要係 0 或以上嘅數字");
      return;
    }
    save.mutate();
  };

  const fieldCls = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5";

  return (
    <DialogShell title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="f-name-zh" className="text-sm font-medium">中文名</label>
          <input id="f-name-zh" type="text" value={nameZh} onChange={(e) => setNameZh(e.target.value)} placeholder="例如：龍江 鮮竹卷" className={fieldCls} />
        </div>
        <div>
          <label htmlFor="f-name-en" className="text-sm font-medium">英文名</label>
          <input id="f-name-en" type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="例如：Dragon River Bean Curd Wrapping Roll" className={fieldCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-packing" className="text-sm font-medium">包裝規格</label>
            <input id="f-packing" type="text" value={packing} onChange={(e) => setPacking(e.target.value)} placeholder="例如：14 x 680g" className={fieldCls} />
          </div>
          <div>
            <label htmlFor="f-stock-code" className="text-sm font-medium">貨品編號 Key（七個字；未有可留空）</label>
            <input id="f-stock-code" type="text" inputMode="numeric" pattern="[0-9]*" value={stockCode} onChange={(e) => setStockCode(e.target.value)} placeholder="未掃到就留空，自動俾 TMP 代號" className={`num ${fieldCls}`} />
            {item && isTmpKey(item.stock_code) && (
              <p className="mt-1 text-xs text-[var(--dim)]">
                而家用緊臨時代號 {item.stock_code} 做 Key，掃到真編號就喺上面改返七個字嗰個，代號會自動俾返佢取代。
              </p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-barcode" className="text-sm font-medium">條碼</label>
            <input id="f-barcode" type="text" value={barcode} onChange={(e) => setBarcode(e.target.value)} className={`num ${fieldCls}`} />
          </div>
          <div>
            <label htmlFor="f-unit" className="text-sm font-medium">單位</label>
            <select id="f-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={fieldCls}>
              <option value="Case">Case（箱）</option>
              <option value="Pack">Pack（包）</option>
              <option value="Box">Box（盒）</option>
              <option value="KG">KG（公斤）</option>
              <option value="個">個</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-storage" className="text-sm font-medium">儲存類別</label>
            <select id="f-storage" value={storage} onChange={(e) => setStorage(e.target.value as Storage)} className={fieldCls}>
              <option value="frozen_1f">冷凍 1F</option>
              <option value="frozen_2f">冷凍 2F</option>
              <option value="frozen">冷凍（未定樓層）</option>
              <option value="unclassified">未分類</option>
            </select>
          </div>
          {!item ? (
            <div>
              <label htmlFor="f-qty" className="text-sm font-medium">期初數量（可小數）</label>
              <input id="f-qty" type="number" inputMode="decimal" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`num ${fieldCls}`} />
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium">目前存量</p>
              <p className="num mt-1 py-2.5 text-lg font-semibold">
                {fmtQty(item.quantity)} {item.unit}
                <span className="ml-2 text-xs font-normal text-[var(--dim)]">（用清單上面嘅 ＋／− 改）</span>
              </p>
            </div>
          )}
        </div>
        <div>
          <label htmlFor="f-low" className="text-sm font-medium">低存量提示（數量低過或等於呢個數就標示，留空＝唔提示）</label>
          <input id="f-low" type="number" inputMode="decimal" step="any" value={lowStock} onChange={(e) => setLowStock(e.target.value)} className={`num ${fieldCls}`} />
        </div>
        <div>
          <label htmlFor="f-notes" className="text-sm font-medium">備註</label>
          <input id="f-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldCls} />
        </div>
        {item?.source_ref && <p className="text-xs text-[var(--dim)]">來源：{item.source_ref}</p>}
        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={save.isPending} className="flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50">
            {save.isPending ? "儲存緊…" : "儲存"}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
            取消
          </button>
        </div>
        {item &&
          (confirmDelete ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--bad)] px-3 py-2">
              <p className="flex-1 text-sm text-[var(--bad)]">確定喺 Sheet 刪除呢項貨品？（出入記錄會保留做歷史）</p>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(item.stock_code)}
                className="rounded-md bg-[var(--bad)] px-3 py-1.5 text-sm font-semibold text-[var(--bad-ink)] disabled:opacity-50"
              >
                確定刪除
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1.5 text-sm">
                唔刪
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="w-full py-1 text-sm text-[var(--bad)]">
              刪除呢項貨品
            </button>
          ))}
      </form>
    </DialogShell>
  );
}

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" role="dialog" aria-label={title}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-4 pb-6 text-[var(--text)] sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="關閉" className="shrink-0 rounded-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
