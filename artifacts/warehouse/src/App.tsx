import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Item, type Movement, type Unit, type Storage, type ShelfStatus } from "./api";
import { BarcodeScanner } from "./BarcodeScanner";
import { LangToggle, locale, t, useDocTitle, useLang } from "../../shared/i18n";
import { readOnly } from "../../shared/access";

// Labels are functions so they follow the 中／Eng switch.
function storageLabel(s: Storage): string {
  switch (s) {
    case "frozen":
      return t("冷凍（未定）", "Frozen (floor TBD)");
    case "frozen_1f":
      return t("冷凍 1F", "Frozen 1F");
    case "frozen_2f":
      return t("冷凍 2F", "Frozen 2F");
    case "dry":
      return t("乾貨", "Dry");
    case "fresh":
      return t("新鮮", "Fresh");
    default:
      return t("未分類", "Unclassified");
  }
}

function kindLabel(k: Movement["kind"]): string {
  switch (k) {
    case "initial":
      return t("期初", "Opening");
    case "in":
      return t("入貨", "Stock in");
    case "out":
      return t("出貨", "Stock out");
    default:
      return t("盤點調整", "Count adjustment");
  }
}

const shelfLabel = (s: ShelfStatus) => (s === "ok" ? t("貨架正常", "Shelf OK") : t("補貨架", "Refill shelf"));

/** Unit picker options (the stored value stays as-is). */
const unitOptions = () => (
  <>
    <option value="Case">{t("Case（箱）", "Case")}</option>
    <option value="Pack">{t("Pack（包）", "Pack")}</option>
    <option value="Box">{t("Box（盒）", "Box")}</option>
    <option value="KG">{t("KG（公斤）", "KG")}</option>
    <option value="個">{t("個", "個 (piece)")}</option>
  </>
);

type StorageFilter = "all" | Storage;
type StatusFilter = "all" | "out" | "low" | "tmp" | "shelf";

const storageFilters = (): Array<{ key: StorageFilter; label: string }> => [
  { key: "all", label: t("全部位置", "All locations") },
  { key: "frozen_1f", label: storageLabel("frozen_1f") },
  { key: "frozen_2f", label: storageLabel("frozen_2f") },
  { key: "frozen", label: storageLabel("frozen") },
  { key: "unclassified", label: storageLabel("unclassified") },
];

const statusFilters = (): Array<{ key: StatusFilter; label: string }> => [
  { key: "all", label: t("全部狀態", "All statuses") },
  { key: "out", label: t("缺貨", "Out of stock") },
  { key: "low", label: t("低存量", "Low stock") },
  { key: "shelf", label: t("補貨架", "Refill shelf") },
  { key: "tmp", label: t("待補編號", "Needs code") },
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
  return d.toLocaleString(locale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function App() {
  const lang = useLang();
  useDocTitle("倉庫存貨", "Warehouse Stock");
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

  const fail = (error: Error) => setNotice(error.message || t("操作失敗，請再試", "Something went wrong, please try again"));

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
      setNotice(
        t(
          "喺 Sheet 入面搵唔返呢項貨品，可能編號已經俾人改咗或者刪咗，請對返清單再試。",
          "This item is no longer in the Sheet — its code may have been changed or deleted. Check the list and try again.",
        ),
      );
      return;
    }
    setEditing(fresh);
  };
  const openBulk = async (item: Item, kind: "in" | "out") => {
    const fresh = await freshItem(item.stock_code);
    if (!fresh) {
      setNotice(
        t(
          "喺 Sheet 入面搵唔返呢項貨品，可能編號已經俾人改咗或者刪咗，請對返清單再試。",
          "This item is no longer in the Sheet — its code may have been changed or deleted. Check the list and try again.",
        ),
      );
      return;
    }
    if (kind === "out" && fresh.quantity <= 0) {
      setNotice(t(`「${fresh.name_zh || fresh.name_en}」存量係 0，冇貨可出。`, `"${fresh.name_zh || fresh.name_en}" has 0 in stock — nothing to take out.`));
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
          ? t("已標記補貨架（淨係轉狀態，冇改數量）。", "Marked for shelf refill (status only, quantity unchanged).")
          : t("已補好，已清標記（淨係轉狀態，冇改數量）。", "Shelf refilled, mark cleared (status only, quantity unchanged)."),
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
      parts.push(storageFilters().find((f) => f.key === storageFilter)?.label ?? storageFilter);
    }
    if (statusFilter !== "all") {
      parts.push(statusFilters().find((f) => f.key === statusFilter)?.label ?? statusFilter);
    }
    return parts.join(" + ");
  }, [storageFilter, statusFilter, lang]);

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
      setInfo(
        status === "need_refill"
          ? t(`已批量將 ${n} 項貨品標記做補貨架。`, `Marked ${n} item(s) for shelf refill.`)
          : t(`已批量將 ${n} 項貨品標記做已補好（貨架正常）。`, `Marked ${n} item(s) as refilled (shelf OK).`),
      );
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
        <section aria-label={t("存量概覽", "Stock overview")} className="pt-4">
          <div className="grid grid-cols-3 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] lg:grid-cols-6">
            <Stat label={t("總品項", "Items")} value={stats.count} text={String(stats.count)} />
            <Stat label={t("總箱數 Case", "Total Case")} value={stats.cases} text={fmtQty(stats.cases)} bordered />
            <Stat label={t("總包數 Pack", "Total Pack")} value={stats.packs} text={fmtQty(stats.packs)} bordered />
            <Stat label={t("總盒數 Box", "Total Box")} value={stats.boxes} text={fmtQty(stats.boxes)} bordered />
            <Stat label={t("總重量 KG", "Total KG")} value={stats.kg} text={fmtQty(stats.kg)} bordered />
            <div className="border-l border-[var(--border)] px-3 py-3">
              <p className={`num text-2xl font-semibold ${stats.out > 0 ? "text-[var(--bad)]" : ""}`}>
                {stats.out}
              </p>
              <p className="text-xs text-[var(--dim)]">
                {t("缺貨", "Out of stock")}
                {stats.low > 0 ? t(` · ${stats.low} 項低存量`, ` · ${stats.low} low`) : ""}
                {stats.refill > 0 ? t(` · ${stats.refill} 項補貨架`, ` · ${stats.refill} refill shelf`) : ""}
                {stats.tmp > 0 ? t(` · ${stats.tmp} 項待補編號`, ` · ${stats.tmp} need code`) : ""}
              </p>
            </div>
          </div>
        </section>

        {/* Google Sheet direct connection — compact single row */}
        <section aria-label={__DEMO__ ? t("示範資料", "Demo data") : t("Google Sheet 直連", "Google Sheet (live)")} className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium">{__DEMO__ ? t("示範資料（本機）", "Demo data (this browser)") : t("Google Sheet 直連", "Google Sheet (live)")}</span>
            {sheetStatusQuery.isPending ? (
              <span className="text-xs text-[var(--dim)]">{t("連接緊…", "Connecting…")}</span>
            ) : sheetConnected ? (
              <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--good)]">
                {__DEMO__ ? t("就緒", "Ready") : t("已連接", "Connected")}
              </span>
            ) : (
              <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--bad)]">
                {t("連唔到 Sheet", "Sheet unreachable")}
              </span>
            )}
            {readOnly && (
              <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--dim)]">
                {t("只可閱讀", "View only")}
              </span>
            )}
            {sheetConnected && sheetStatusQuery.data?.last_updated_at ? (
              <span className="text-[11px] text-[var(--dim)]">{t("最後更新：", "Last updated: ")}{sheetStatusQuery.data.last_updated_at}</span>
            ) : null}
            {!sheetConnected && (
              <span className="text-[11px] text-[var(--bad)]">{t("冇離線副本，連返線先用到", "No offline copy — works only when online")}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={invalidate}
                className="rounded-[var(--radius)] border border-[var(--accent)] px-2 py-1 text-xs font-semibold text-[var(--accent)]"
              >
                {t("重新載入", "Reload")}
              </button>
              <LangToggle />
            </span>
          </div>
        </section>

        {/* View toggle + add */}
        <div className="mt-4 flex items-center gap-2">
          <div className="flex rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-1" role="tablist" aria-label={t("檢視模式", "View")}>
            <button
              type="button"
              role="tab"
              aria-selected={view === "stock"}
              onClick={() => setView("stock")}
              className={`rounded-md px-4 py-1.5 text-sm font-medium ${view === "stock" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"}`}
            >
              {t("存貨", "Stock")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "history"}
              onClick={() => setView("history")}
              className={`rounded-md px-4 py-1.5 text-sm font-medium ${view === "history" ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--dim)]"}`}
            >
              {t("出入記錄", "Stock log")}
            </button>
          </div>
          {view === "stock" && !readOnly && (
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
              {selectMode ? t("完成多選", "Done selecting") : t("多選", "Select")}
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={openAdd}
              className={`${view === "stock" ? "" : "ml-auto "}rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)]`}
            >
              {t("＋ 新增貨品", "＋ Add item")}
            </button>
          )}
        </div>

        {notice && (
          <p role="alert" className="mt-3 rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--bad)]">
            {notice}
            <button type="button" className="ml-2 underline" onClick={() => setNotice("")}>{t("知道了", "OK")}</button>
          </p>
        )}

        {info && (
          <p className="mt-3 rounded-[var(--radius)] border border-[var(--good)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--good)]">
            {info}
            <button type="button" className="ml-2 underline" onClick={() => setInfo("")}>{t("知道了", "OK")}</button>
          </p>
        )}

        {view === "stock" ? (
          <>
            <div className="mt-3 flex items-stretch gap-2">
              <div className="w-28 shrink-0">
                <label htmlFor="search-code" className="sr-only">{t("搜尋編號 Key", "Search item code (Key)")}</label>
                <input
                  id="search-code"
                  type="search"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={codeSearch}
                  onChange={(e) => setCodeSearch(e.target.value.replace(/\D/g, ""))}
                  placeholder={t("編號 Key…", "Code…")}
                  autoComplete="off"
                  className="num h-full w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base"
                />
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor="search" className="sr-only">{t("搜尋貨品名、條碼同其他資料", "Search item name, barcode and other details")}</label>
                <input
                  id="search"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("搜尋貨品名、條碼、備註…", "Search name, barcode, notes…")}
                  className="h-full w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base"
                />
              </div>
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                aria-label={t("用相機掃描條碼搜尋", "Scan a barcode with the camera to search")}
                className="shrink-0 rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent)]"
              >
                {t("掃碼", "Scan")}
              </button>
            </div>
            <div className="mt-3 space-y-2.5" aria-label={t("篩選", "Filters")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-10 shrink-0 text-xs font-semibold text-[var(--dim)]">{t("位置", "Place")}</span>
                {storageFilters().map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStorageFilter(f.key)}
                    aria-pressed={storageFilter === f.key}
                    aria-label={t(`位置篩選：${f.label}`, `Location filter: ${f.label}`)}
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
                <span className="w-10 shrink-0 text-xs font-semibold text-[var(--dim)]">{t("狀態", "Status")}</span>
                {statusFilters().map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStatusFilter(f.key)}
                    aria-pressed={statusFilter === f.key}
                    aria-label={t(`狀態篩選：${f.label}`, `Status filter: ${f.label}`)}
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
                    {t("顯示緊：", "Showing: ")}<span className="font-semibold text-[var(--text)]">{activeFilterLabel}</span>
                    {" · "}
                    {t(`${visible.length} 項`, `${visible.length} item(s)`)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setStorageFilter("all");
                      setStatusFilter("all");
                    }}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 font-medium text-[var(--accent)]"
                  >
                    {t("清除篩選", "Clear filters")}
                  </button>
                </div>
              )}
            </div>

            {selectMode && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] px-3 py-2" aria-label={t("多選工具列", "Selection toolbar")}>
                <span className="text-sm font-semibold">{t(`已選 ${selectedCodes.size} 項`, `${selectedCodes.size} selected`)}</span>
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
                  {t(`全選可見（${visible.length} 項）`, `Select visible (${visible.length})`)}
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
                  {t(`全選全部（${items.length} 項）`, `Select all (${items.length})`)}
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selectedCodes.size === 0}
                  className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-medium disabled:opacity-40"
                >
                  {t("清除選取", "Clear selection")}
                </button>
                <span className="text-xs text-[var(--dim)]">
                  {t("撳貨品左邊個格仔嚟揀，揀好撳下面「批量操作」一次過改。", "Tick the box left of each item, then tap \"Bulk actions\" below to change them all at once.")}
                </span>
              </div>
            )}

            {itemsQuery.isPending ? (
              <p className="py-12 text-center text-[var(--dim)]">{t("載入緊存貨…", "Loading stock…")}</p>
            ) : itemsQuery.error ? (
              <p className="py-12 text-center text-[var(--bad)]">
                {t(
                  "連唔到 Google Sheet — 直連模式冇本機副本，請檢查網絡，撳上面「重新載入」再試。",
                  "Can't reach the Google Sheet — live mode keeps no local copy. Check your connection and tap \"Reload\" above.",
                )}
              </p>
            ) : items.length === 0 ? (
              <p className="py-12 text-center text-[var(--dim)]">
                {readOnly
                  ? t("倉庫仲未有任何貨品。", "No items in the warehouse yet.")
                  : t("倉庫仲未有任何貨品，撳「新增貨品」開始記錄。", "No items in the warehouse yet — tap \"Add item\" to start.")}
              </p>
            ) : visible.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-[var(--dim)]">
                  {hasActiveFilter
                    ? t(`冇符合「${activeFilterLabel}」嘅貨品。`, `No items match "${activeFilterLabel}".`)
                    : t("冇符合條件嘅貨品。", "No matching items.")}
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
                    {t("清除篩選睇全部", "Clear filters and show all")}
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
          <section aria-label={t("出入記錄", "Stock log")} className="mt-4">
            {movementsQuery.isPending ? (
              <p className="py-12 text-center text-[var(--dim)]">{t("載入緊記錄…", "Loading records…")}</p>
            ) : movementsQuery.error ? (
              <p className="py-12 text-center text-[var(--bad)]">
                {t(
                  "連唔到 Google Sheet — 直連模式冇本機副本，請檢查網絡，撳上面「重新載入」再試。",
                  "Can't reach the Google Sheet — live mode keeps no local copy. Check your connection and tap \"Reload\" above.",
                )}
              </p>
            ) : (movementsQuery.data?.movements.length ?? 0) === 0 ? (
              <p className="py-12 text-center text-[var(--dim)]">{t("暫時未有出入記錄。", "No stock records yet.")}</p>
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
                          aria-label={t(`睇 ${m.item_name} 嘅出入記錄`, `View stock log for ${m.item_name}`)}
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
                      {kindLabel(m.kind)}
                    </span>
                    <span className="num shrink-0 text-xs text-[var(--dim)]">{formatTime(m.created_at)}</span>
                    {!readOnly && <button
                      type="button"
                      onClick={() => setEditingMovement(m)}
                      aria-label={`${t("編輯記錄：", "Edit record: ")}${m.item_name} ${kindLabel(m.kind)} ${m.delta > 0 ? "+" : ""}${fmtQty(m.delta)}`}
                      className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
                    >
                      {t("編輯", "Edit")}
                    </button>}
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
            <span className="text-sm font-semibold">{t(`已選 ${selectedCodes.size} 項`, `${selectedCodes.size} selected`)}</span>
            <button
              type="button"
              onClick={() => setShowBulkOps(true)}
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-ink)]"
            >
              {t("批量操作", "Bulk actions")}
            </button>
            <button
              type="button"
              disabled={bulkShelf.isPending}
              onClick={() => bulkShelf.mutate("need_refill")}
              className="rounded-[var(--radius)] border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
            >
              {t("標記補貨架", "Mark refill shelf")}
            </button>
            <button
              type="button"
              disabled={bulkShelf.isPending}
              onClick={() => bulkShelf.mutate("ok")}
              className="rounded-[var(--radius)] border border-[var(--good)] px-3 py-2 text-sm font-medium text-[var(--good)] disabled:opacity-50"
            >
              {t("標記已補好", "Mark refilled")}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]"
            >
              {t("清除", "Clear")}
            </button>
          </div>
        </div>
      )}

      {showAdd && (
        <ItemFormDialog
          title={t("新增貨品", "Add item")}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            invalidate();
          }}
        />
      )}
      {editing && (
        <ItemFormDialog
          title={t("編輯貨品", "Edit item")}
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
            aria-label={t(`選取 ${displayName}`, `Select ${displayName}`)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
        )}
        <button
          type="button"
          onClick={onHistory}
          aria-label={t(`打開 ${displayName} 同佢嘅出入記錄`, `Open ${displayName} and its stock log`)}
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold leading-snug"
        >
          {displayName}
          {item.name_zh && (
            <span className="ml-1.5 font-normal text-[var(--dim)]">{item.name_en}</span>
          )}
        </button>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-xs text-[var(--dim)]">
            {storageLabel(item.storage)}
          </span>
          {item.shelf_status === "need_refill" && (
            <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-ink)]">{t("補貨架", "Refill shelf")}</span>
          )}
          {out && (
            <span className="rounded bg-[var(--bad)] px-1.5 py-0.5 text-xs font-semibold text-[var(--bad-ink)]">{t("缺貨", "Out of stock")}</span>
          )}
          {low && (
            <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-ink)]">{t("低存量", "Low stock")}</span>
          )}
          {isTmpKey(item.stock_code) && (
            <span className="rounded border border-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">{t("待補編號", "Needs code")}</span>
          )}
        </div>
      </div>

      {/* Line 2: packing / code / barcode / notes */}
      <p className="num mt-0.5 truncate text-xs text-[var(--dim)]">
        {item.packing}
        {item.stock_code && (
          <>
            {" "}· {t("編號 Key", "Code")} {item.stock_code}
            {isTmpKey(item.stock_code) ? t("（臨時）", " (temporary)") : ""}
          </>
        )}
        {item.barcode && <> · {t("條碼", "Barcode")} {item.barcode}</>}
      </p>

      {/* Line 3: quantity stepper + unit + shelf + bulk/edit actions */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {readOnly ? (
          <span
            className="num text-base font-semibold"
            aria-label={t(`${displayName} 目前存量`, `${displayName} current stock`)}
          >
            {fmtQty(item.quantity)}
          </span>
        ) : (
        <div className="flex items-center overflow-hidden rounded-md border border-[var(--border)]">
          <button
            type="button"
            aria-label={t(`減少 ${displayName} 存量`, `Decrease ${displayName} stock`)}
            disabled={busy || item.quantity <= 0}
            onClick={() => onQuick(-1)}
            className="flex h-8 w-8 items-center justify-center text-lg font-bold disabled:opacity-35"
          >
            −
          </button>
          <QtyInput item={item} onSaved={onSaved} onError={onError} />
          <button
            type="button"
            aria-label={t(`增加 ${displayName} 存量`, `Increase ${displayName} stock`)}
            disabled={busy}
            onClick={() => onQuick(1)}
            className="flex h-8 w-8 items-center justify-center text-lg font-bold text-[var(--accent)] disabled:opacity-35"
          >
            ＋
          </button>
        </div>
        )}
        <span className="text-xs text-[var(--dim)]">{item.unit}</span>

        <span className="text-xs text-[var(--dim)]">{t("貨架：", "Shelf: ")}{shelfLabel(item.shelf_status)}</span>
        {readOnly ? null : item.shelf_status === "ok" ? (
          <button
            type="button"
            disabled={shelfBusy}
            onClick={() => onShelf("need_refill")}
            aria-label={t(`標記 ${displayName} 補貨架（淨係轉狀態，唔改數量）`, `Mark ${displayName} for shelf refill (status only, quantity unchanged)`)}
            className="rounded-md border border-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
          >
            {t("補貨架", "Refill shelf")}
          </button>
        ) : (
          <button
            type="button"
            disabled={shelfBusy}
            onClick={() => onShelf("ok")}
            aria-label={t(`標記 ${displayName} 已補好（淨係清標記，唔改數量）`, `Mark ${displayName} as refilled (clears the mark, quantity unchanged)`)}
            className="rounded-md border border-[var(--good)] px-2 py-1 text-xs font-medium text-[var(--good)] disabled:opacity-50"
          >
            {t("已補好", "Refilled")}
          </button>
        )}

        {item.notes && (
          <span className="min-w-[10rem] flex-1 basis-40 break-words text-xs text-[var(--dim)]">
            {t("備註：", "Note: ")}{item.notes}
          </span>
        )}

        <div className="ml-auto flex shrink-0 gap-1.5">
          {!readOnly && (<>
          <button
            type="button"
            onClick={() => onBulk("in")}
            className="rounded-md border border-[var(--good)] px-2 py-1 text-xs font-medium text-[var(--good)]"
          >
            {t("入貨", "Stock in")}
          </button>
          <button
            type="button"
            onClick={() => onBulk("out")}
            disabled={item.quantity <= 0}
            className="rounded-md border border-[var(--bad)] px-2 py-1 text-xs font-medium text-[var(--bad)] disabled:opacity-35"
          >
            {t("出貨", "Stock out")}
          </button>
          </>)}
          <button
            type="button"
            onClick={onHistory}
            aria-label={t(`${displayName} 出入記錄`, `${displayName} stock log`)}
            className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
          >
            {t("記錄", "Log")}
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={t(`編輯 ${displayName}`, `Edit ${displayName}`)}
              className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
            >
              {t("編輯", "Edit")}
            </button>
          )}
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
      aria-label={t(`${item.name_zh || item.name_en} 目前存量（可直接改）`, `${item.name_zh || item.name_en} current stock (editable)`)}
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
    setError(e.message || t("操作失敗，請再試", "Something went wrong, please try again"));
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
        { onSuccess: () => onDone(t(`已清除 ${items.length} 項貨品嘅低存量提示。`, `Cleared the low-stock alert on ${items.length} item(s).`)) },
      );
      return;
    }
    const v = Number(lowStock);
    if (lowStock.trim() === "" || !Number.isFinite(v) || v < 0) {
      setError(t("低存量提示要係 0 或以上嘅數字", "The low-stock alert must be a number, 0 or more"));
      return;
    }
    update.mutate(
      { lowStock: v },
      { onSuccess: () => onDone(t(`已將 ${items.length} 項貨品嘅低存量提示設做 ${fmtQty(v)}。`, `Set the low-stock alert on ${items.length} item(s) to ${fmtQty(v)}.`)) },
    );
  };

  const applyQty = () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError(t("請輸入大過 0 嘅數量", "Enter a quantity greater than 0"));
      return;
    }
    adjust.mutate(qtyKind === "in" ? n : -n, {
      onSuccess: () =>
        onDone(
          qtyKind === "in"
            ? t(`已批量入貨：${items.length} 項貨品每項加 ${fmtQty(n)}。`, `Bulk stock in: added ${fmtQty(n)} to each of ${items.length} item(s).`)
            : t(`已批量出貨：${items.length} 項貨品每項減 ${fmtQty(n)}。`, `Bulk stock out: took ${fmtQty(n)} from each of ${items.length} item(s).`),
        ),
    });
  };

  return (
    <DialogShell title={t(`批量操作 · 已選 ${items.length} 項`, `Bulk actions · ${items.length} selected`)} onClose={onClose}>
      <div className="space-y-4">
        <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-[var(--dim)]">
          {items.map((it) => it.name_zh || it.name_en).join(t("、", ", "))}
        </p>

        {/* Storage — the main ask */}
        <section aria-label={t("批量改儲存位置", "Bulk change storage")} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">{t("儲存位置", "Storage location")}</p>
          <div className="mt-1 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-storage" className="sr-only">{t("儲存位置", "Storage location")}</label>
              <select id="bulk-storage" value={storage} onChange={(e) => setStorage(e.target.value as Storage)} className={fieldCls}>
                <option value="frozen_1f">{storageLabel("frozen_1f")}</option>
                <option value="frozen_2f">{storageLabel("frozen_2f")}</option>
                <option value="frozen">{storageLabel("frozen")}</option>
                <option value="unclassified">{storageLabel("unclassified")}</option>
              </select>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { storage },
                  { onSuccess: () => onDone(t(`已將 ${items.length} 項貨品嘅儲存位置改做「${storageLabel(storage)}」。`, `Moved ${items.length} item(s) to "${storageLabel(storage)}".`)) },
                )
              }
              className={applyBtn}
            >
              {t("套用", "Apply")}
            </button>
          </div>
        </section>

        {/* Shelf status */}
        <section aria-label={t("批量改貨架狀態", "Bulk change shelf status")} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">{t("貨架狀態", "Shelf status")}</p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            {t("標記淨係轉換貨架狀態，唔會改數量；數量要另外喺下面入貨／出貨嗰度改。", "Marking only changes the shelf status, not the quantity; change quantities in stock in / out below.")}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { shelfStatus: "need_refill" },
                  { onSuccess: () => onDone(t(`已將 ${items.length} 項貨品標記做補貨架。`, `Marked ${items.length} item(s) for shelf refill.`)) },
                )
              }
              className="flex-1 rounded-[var(--radius)] border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
            >
              {t("標記補貨架", "Mark refill shelf")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { shelfStatus: "ok" },
                  { onSuccess: () => onDone(t(`已將 ${items.length} 項貨品標記做已補好（貨架正常）。`, `Marked ${items.length} item(s) as refilled (shelf OK).`)) },
                )
              }
              className="flex-1 rounded-[var(--radius)] border border-[var(--good)] px-3 py-2 text-sm font-medium text-[var(--good)] disabled:opacity-50"
            >
              {t("標記已補好", "Mark refilled")}
            </button>
          </div>
        </section>

        {/* Quantity in/out */}
        <section aria-label={t("批量入貨出貨", "Bulk stock in / out")} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">{t("數量入貨／出貨（每項同一個數量）", "Stock in / out (same quantity for each)")}</p>
          <div className="mt-2 flex gap-2" role="group" aria-label={t("入貨定出貨", "Stock in or out")}>
            <button
              type="button"
              aria-pressed={qtyKind === "in"}
              onClick={() => setQtyKind("in")}
              className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium ${qtyKind === "in" ? "border-[var(--good)] bg-[var(--good)] text-[var(--good-ink)]" : "border-[var(--border)] text-[var(--dim)]"}`}
            >
              {t("入貨", "Stock in")}
            </button>
            <button
              type="button"
              aria-pressed={qtyKind === "out"}
              onClick={() => setQtyKind("out")}
              className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium ${qtyKind === "out" ? "border-[var(--bad)] bg-[var(--bad)] text-[var(--bad-ink)]" : "border-[var(--border)] text-[var(--dim)]"}`}
            >
              {t("出貨", "Stock out")}
            </button>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-qty-amount" className="text-sm font-medium">{t("每項數量（可小數）", "Quantity per item (decimals OK)")}</label>
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
              {t("套用", "Apply")}
            </button>
          </div>
          <div>
            <label htmlFor="bulk-qty-note" className="text-sm font-medium">{t("備註（可留空，會寫入出入記錄）", "Note (optional, saved to the stock log)")}</label>
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
        <section aria-label={t("批量改單位同低存量", "Bulk change unit and low-stock alert")} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <p className="text-sm font-semibold">{t("單位", "Unit")}</p>
          <div className="mt-1 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-unit" className="sr-only">{t("單位", "Unit")}</label>
              <select id="bulk-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={fieldCls}>
                {unitOptions()}
              </select>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { unit },
                  { onSuccess: () => onDone(t(`已將 ${items.length} 項貨品嘅單位改做 ${unit}。`, `Changed the unit of ${items.length} item(s) to ${unit}.`)) },
                )
              }
              className={applyBtn}
            >
              {t("套用", "Apply")}
            </button>
          </div>
          <p className="mt-3 text-sm font-semibold">{t("低存量提示", "Low-stock alert")}</p>
          <div className="mt-1 flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="bulk-low" className="sr-only">{t("低存量提示", "Low-stock alert")}</label>
              <input
                id="bulk-low"
                
                type="number"
                inputMode="decimal"
                step="any"
                value={lowStock}
                onChange={(e) => setLowStock(e.target.value)}
                placeholder={t("數量低過或等於呢個數就標示", "Flag when quantity is at or below this")}
                className={`num ${fieldCls}`}
              />
            </div>
            <button type="button" disabled={busy} onClick={() => applyLowStock(false)} className={applyBtn}>
              {t("套用", "Apply")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => applyLowStock(true)}
              className="shrink-0 rounded-[var(--radius)] border border-[var(--border)] px-3 py-2.5 text-sm font-medium text-[var(--dim)] disabled:opacity-50"
            >
              {t("清除提示", "Clear alert")}
            </button>
          </div>
        </section>

        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        {busy && <p className="text-sm text-[var(--dim)]">{t("處理緊…", "Working…")}</p>}

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--bad)] px-3 py-2">
            <p className="flex-1 text-sm text-[var(--bad)]">
              {t(`確定喺 Sheet 刪除呢 ${items.length} 項貨品？（出入記錄會保留做歷史）`, `Delete these ${items.length} item(s) from the Sheet? (Stock log is kept as history)`)}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => onDone(t(`已刪除 ${items.length} 項貨品。`, `Deleted ${items.length} item(s).`)),
                })
              }
              className="rounded-md bg-[var(--bad)] px-3 py-1.5 text-sm font-semibold text-[var(--bad-ink)] disabled:opacity-50"
            >
              {t("確定刪除", "Delete")}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1.5 text-sm">
              {t("唔刪", "Keep")}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className="w-full py-1 text-sm text-[var(--bad)]">
            {t(`刪除選取嘅 ${items.length} 項貨品`, `Delete the ${items.length} selected item(s)`)}
          </button>
        )}
        <button type="button" onClick={onClose} className="w-full rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
          {t("取消", "Cancel")}
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
      setError(e.message || t("操作失敗，請再試", "Something went wrong, please try again"));
      onError(e);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError(t("請輸入大過 0 嘅數量", "Enter a quantity greater than 0"));
      return;
    }
    if (kind === "out" && n > item.quantity) {
      setError(t(`出貨數量唔可以多過現有存量 ${fmtQty(item.quantity)}`, `Can't take out more than the ${fmtQty(item.quantity)} in stock`));
      return;
    }
    adjust.mutate(kind === "in" ? n : -n);
  };

  return (
    <DialogShell title={`${kind === "in" ? t("入貨", "Stock in") : t("出貨", "Stock out")} · ${item.name_zh || item.name_en}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="num text-sm text-[var(--dim)]">
          {t("現有存量：", "In stock: ")}{fmtQty(item.quantity)} {item.unit}
        </p>
        <div>
          <label htmlFor="bulk-amount" className="text-sm font-medium">
            {kind === "in"
              ? t(`入貨數量（${item.unit}，可小數）`, `Quantity in (${item.unit}, decimals OK)`)
              : t(`出貨數量（${item.unit}，可小數）`, `Quantity out (${item.unit}, decimals OK)`)}
          </label>
          <input
            id="bulk-amount"
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={kind === "in" ? t("入貨數量", "Quantity in") : t("出貨數量", "Quantity out")}
            className="num mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-lg"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="bulk-note" className="text-sm font-medium">{t("備註（可留空）", "Note (optional)")}</label>
          <input
            id="bulk-note"
            
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t("備註", "Note")}
            placeholder={kind === "in" ? t("例如：新貨單編號", "e.g. delivery note number") : t("例如：出貨去邊間分店", "e.g. which branch it went to")}
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
            {adjust.isPending
              ? t("處理緊…", "Working…")
              : kind === "in"
                ? t("確認入貨", "Confirm stock in")
                : t("確認出貨", "Confirm stock out")}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
            {t("取消", "Cancel")}
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
    <DialogShell title={`${t("出入記錄", "Stock log")} · ${name}`} onClose={onClose}>
      <div className="space-y-3">
        {item && (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
            <p className="text-sm font-semibold leading-snug">
              {item.name_zh || item.name_en}
              {item.name_zh && <span className="ml-1.5 font-normal text-[var(--dim)]">{item.name_en}</span>}
            </p>
            <p className="num mt-0.5 text-xs text-[var(--dim)]">
              {item.packing}
              {item.stock_code && <> · {t("編號 Key", "Code")} {item.stock_code}</>}
              {item.barcode && <> · {t("條碼", "Barcode")} {item.barcode}</>}
            </p>
            <p className="num mt-1 text-lg font-semibold">
              {fmtQty(item.quantity)} {item.unit}
              <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                {storageLabel(item.storage)}
                {item.shelf_status === "need_refill" ? ` · ${t("補貨架", "Refill shelf")}` : ""}
              </span>
            </p>
          </div>
        )}
        {history.isPending ? (
          <p className="py-8 text-center text-[var(--dim)]">{t("載入緊記錄…", "Loading records…")}</p>
        ) : history.error ? (
          <p role="alert" className="py-8 text-center text-[var(--bad)]">
            {history.error instanceof Error ? history.error.message : t("讀唔到出入記錄，請再試。", "Couldn't read the stock log, please try again.")}
          </p>
        ) : movements.length === 0 ? (
          <p className="py-8 text-center text-[var(--dim)]">{t("呢項貨品暫時未有出入記錄。", "No stock records for this item yet.")}</p>
        ) : (
          <>
            <p className="text-xs text-[var(--dim)]">
              {t(`共 ${movements.length} 筆（新嘅喺上面）`, `${movements.length} record(s) (newest first)`)}
            </p>
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
                      <span className="mr-1.5 rounded bg-[var(--surface-alt)] px-1.5 py-0.5">{kindLabel(m.kind)}</span>
                      <span className="num">{formatTime(m.created_at)}</span>
                    </p>
                    {m.note && <p className="mt-0.5 break-words text-sm">{m.note}</p>}
                  </div>
                  {!readOnly && <button
                    type="button"
                    onClick={() => onEditMovement(m)}
                    aria-label={`${t("編輯記錄：", "Edit record: ")}${m.item_name} ${kindLabel(m.kind)} ${m.delta > 0 ? "+" : ""}${fmtQty(m.delta)}`}
                    className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--dim)]"
                  >
                    {t("編輯", "Edit")}
                  </button>}
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
          ? t(
              `已更新記錄；「${movement.item_name}」現有存量而家係 ${fmtQty(data.quantity)}。`,
              `Record updated; "${movement.item_name}" now has ${fmtQty(data.quantity)} in stock.`,
            )
          : t(
              "已更新記錄（嗰項貨品已經唔喺存貨表，存量冇郁）。",
              "Record updated (that item is no longer in the stock list, so no stock changed).",
            ),
      );
    },
    onError: (e) => setError(e.message || t("儲存失敗，請再試", "Save failed, please try again")),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) {
      setError(t("請輸入唔係 0 嘅數量", "Enter a quantity other than 0"));
      return;
    }
    if (kind !== "adjust" && n < 0) {
      setError(t("數量請輸入正數，加定減由上面個種類決定", "Enter a positive number — the type above decides add or subtract"));
      return;
    }
    if (newDelta === movement.delta && kind === movement.kind && note.trim() === movement.note) {
      setError(t("冇改到任何嘢", "Nothing changed"));
      return;
    }
    save.mutate(newDelta);
  };

  const fieldCls = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5";

  return (
    <DialogShell title={`${t("編輯記錄", "Edit record")} · ${movement.item_name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="num text-sm text-[var(--dim)]">
          {movement.stock_code && <>{t("編號", "Code")} {movement.stock_code} · </>}
          {formatTime(movement.created_at)} · {t("原本：", "Was: ")}{kindLabel(movement.kind)}{" "}
          {movement.delta > 0 ? `+${fmtQty(movement.delta)}` : fmtQty(movement.delta)}
        </p>
        <div>
          <label htmlFor="mv-kind" className="text-sm font-medium">{t("種類", "Type")}</label>
          <select
            id="mv-kind"
            value={kind}
            onChange={(e) => changeKind(e.target.value as Movement["kind"])}
            className={fieldCls}
          >
            <option value="in">{kindLabel("in")}</option>
            <option value="out">{kindLabel("out")}</option>
            <option value="adjust">{kindLabel("adjust")}</option>
            <option value="initial">{kindLabel("initial")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="mv-amount" className="text-sm font-medium">
            {kind === "adjust"
              ? t("變動數量（可正可負，例如 -2 或者 3）", "Change (positive or negative, e.g. -2 or 3)")
              : t("數量（正數，方向由種類決定）", "Quantity (positive; the type sets the direction)")}
          </label>
          <input
            id="mv-amount"
            type="number"
            inputMode="decimal"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={t("記錄數量", "Record quantity")}
            className={`num ${fieldCls}`}
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="mv-note" className="text-sm font-medium">{t("備註（可留空）", "Note (optional)")}</label>
          <input
            id="mv-note"
            
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t("記錄備註", "Record note")}
            className={fieldCls}
          />
        </div>
        {diff !== 0 && (
          <p className="rounded-md bg-[var(--surface-alt)] px-3 py-2 text-sm text-[var(--dim)]">
            {diff > 0
              ? t(`數量變動改咗：嗰項貨品嘅現有存量會跟住加 ${fmtQty(Math.abs(diff))}，同新記錄對返。`, `The change was edited: the item's stock will go up by ${fmtQty(Math.abs(diff))} to match.`)
              : t(`數量變動改咗：嗰項貨品嘅現有存量會跟住減 ${fmtQty(Math.abs(diff))}，同新記錄對返。`, `The change was edited: the item's stock will go down by ${fmtQty(Math.abs(diff))} to match.`)}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={save.isPending}
            className="flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50"
          >
            {save.isPending ? t("儲存緊…", "Saving…") : t("儲存", "Save")}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
            {t("取消", "Cancel")}
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
    onError: (e) => setError(e.message || t("儲存失敗，請再試", "Save failed, please try again")),
  });

  const remove = useMutation({
    mutationFn: async (code: string) => await api.deleteItem({ stockCode: code }),
    onSuccess: () => {
      refresh();
      onSaved();
    },
    onError: (e) => setError(e.message || t("刪除失敗，請再試", "Delete failed, please try again")),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!nameZh.trim() && !nameEn.trim()) {
      setError(t("請填貨品名稱（中文或英文最少填一樣）", "Enter an item name (Chinese or English, at least one)"));
      return;
    }
    const sc = stockCode.trim();
    if (sc && sc.length !== 7 && !/^TMP-\d{3,}$/.test(sc)) {
      setError(
        t(
          `貨品編號 Key 要啱啱七個字，或者 TMP-001 呢種臨時代號（而家 ${sc.length} 個字）；唔啱就清空佢，儲存嗰陣系統會自動俾一個 TMP 代號`,
          `The item code (Key) must be exactly 7 characters, or a temporary code like TMP-001 (now ${sc.length}); otherwise clear it and a TMP code is assigned on save`,
        ),
      );
      return;
    }
    if (lowStock.trim() !== "" && (!Number.isFinite(Number(lowStock)) || Number(lowStock) < 0)) {
      setError(t("低存量提示要係 0 或以上嘅數字", "The low-stock alert must be a number, 0 or more"));
      return;
    }
    save.mutate();
  };

  const fieldCls = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5";

  return (
    <DialogShell title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="f-name-zh" className="text-sm font-medium">{t("中文名", "Chinese name")}</label>
          <input id="f-name-zh" type="text" value={nameZh} onChange={(e) => setNameZh(e.target.value)} placeholder={t("例如：龍江 鮮竹卷", "e.g. 龍江 鮮竹卷")} className={fieldCls} />
        </div>
        <div>
          <label htmlFor="f-name-en" className="text-sm font-medium">{t("英文名", "English name")}</label>
          <input id="f-name-en" type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder={t("例如：Dragon River Bean Curd Wrapping Roll", "e.g. Dragon River Bean Curd Wrapping Roll")} className={fieldCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-packing" className="text-sm font-medium">{t("包裝規格", "Packing")}</label>
            <input id="f-packing" type="text" value={packing} onChange={(e) => setPacking(e.target.value)} placeholder={t("例如：14 x 680g", "e.g. 14 x 680g")} className={fieldCls} />
          </div>
          <div>
            <label htmlFor="f-stock-code" className="text-sm font-medium">{t("貨品編號 Key（七個字；未有可留空）", "Item code Key (7 characters; blank if none)")}</label>
            <input id="f-stock-code" type="text" inputMode="numeric" pattern="[0-9]*" value={stockCode} onChange={(e) => setStockCode(e.target.value)} placeholder={t("未掃到就留空，自動俾 TMP 代號", "Blank = auto TMP code")} className={`num ${fieldCls}`} />
            {item && isTmpKey(item.stock_code) && (
              <p className="mt-1 text-xs text-[var(--dim)]">
                {t(
                  `而家用緊臨時代號 ${item.stock_code} 做 Key，掃到真編號就喺上面改返七個字嗰個，代號會自動俾返佢取代。`,
                  `Using temporary code ${item.stock_code} as the Key. When you get the real code, enter the 7-character code above and it replaces the temporary one.`,
                )}
              </p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-barcode" className="text-sm font-medium">{t("條碼", "Barcode")}</label>
            <input id="f-barcode" type="text" value={barcode} onChange={(e) => setBarcode(e.target.value)} className={`num ${fieldCls}`} />
          </div>
          <div>
            <label htmlFor="f-unit" className="text-sm font-medium">{t("單位", "Unit")}</label>
            <select id="f-unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={fieldCls}>
              {unitOptions()}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="f-storage" className="text-sm font-medium">{t("儲存類別", "Storage")}</label>
            <select id="f-storage" value={storage} onChange={(e) => setStorage(e.target.value as Storage)} className={fieldCls}>
              <option value="frozen_1f">{storageLabel("frozen_1f")}</option>
              <option value="frozen_2f">{storageLabel("frozen_2f")}</option>
              <option value="frozen">{t("冷凍（未定樓層）", "Frozen (floor TBD)")}</option>
              <option value="unclassified">{storageLabel("unclassified")}</option>
            </select>
          </div>
          {!item ? (
            <div>
              <label htmlFor="f-qty" className="text-sm font-medium">{t("期初數量（可小數）", "Opening quantity (decimals OK)")}</label>
              <input id="f-qty" type="number" inputMode="decimal" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`num ${fieldCls}`} />
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium">{t("目前存量", "Current stock")}</p>
              <p className="num mt-1 py-2.5 text-lg font-semibold">
                {fmtQty(item.quantity)} {item.unit}
                <span className="ml-2 text-xs font-normal text-[var(--dim)]">{t("（用清單上面嘅 ＋／− 改）", "(change with ＋/− in the list)")}</span>
              </p>
            </div>
          )}
        </div>
        <div>
          <label htmlFor="f-low" className="text-sm font-medium">
            {t("低存量提示（數量低過或等於呢個數就標示，留空＝唔提示）", "Low-stock alert (flag at or below this quantity; blank = no alert)")}
          </label>
          <input id="f-low" type="number" inputMode="decimal" step="any" value={lowStock} onChange={(e) => setLowStock(e.target.value)} className={`num ${fieldCls}`} />
        </div>
        <div>
          <label htmlFor="f-notes" className="text-sm font-medium">{t("備註", "Notes")}</label>
          <input id="f-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldCls} />
        </div>
        {item?.source_ref && <p className="text-xs text-[var(--dim)]">{t("來源：", "Source: ")}{item.source_ref}</p>}
        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={save.isPending} className="flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)] disabled:opacity-50">
            {save.isPending ? t("儲存緊…", "Saving…") : t("儲存", "Save")}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5">
            {t("取消", "Cancel")}
          </button>
        </div>
        {item &&
          (confirmDelete ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--bad)] px-3 py-2">
              <p className="flex-1 text-sm text-[var(--bad)]">
                {t("確定喺 Sheet 刪除呢項貨品？（出入記錄會保留做歷史）", "Delete this item from the Sheet? (Stock log is kept as history)")}
              </p>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(item.stock_code)}
                className="rounded-md bg-[var(--bad)] px-3 py-1.5 text-sm font-semibold text-[var(--bad-ink)] disabled:opacity-50"
              >
                {t("確定刪除", "Delete")}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1.5 text-sm">
                {t("唔刪", "Keep")}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="w-full py-1 text-sm text-[var(--bad)]">
              {t("刪除呢項貨品", "Delete this item")}
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
          <button type="button" onClick={onClose} aria-label={t("關閉", "Close")} className="shrink-0 rounded-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
