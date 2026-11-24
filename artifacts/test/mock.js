(() => {
  const SS = {
    "DEMO_GROUPBUY_SHEET_ID": {
      tabs: [
        { sheetId: 865178293, title: "test", grid: [["x"]] },
        { sheetId: 2127330413, title: "2026-11-23", grid: [
          ["訂單編號","姓名","客人備註","貨品","數量","單位","備註","已領取","領取日期時間"],
          ["1","Alice","","無激素雞翅","15","Lb","","FALSE"],
          ["1","Alice","","蒲燒鰻魚","2","包"],
          ["2","小明","","無激素雞翅","5","Lb","","TRUE","2026-11-23 10:00"],
          ["2","小明","","鮑魚","3","包"],
          ["3","Ben","204","紫芋卷","2","包","","FALSE"],
        ]},
      ],
    },
    "DEMO_WAREHOUSE_SHEET_ID": {
      tabs: [
        { sheetId: 0, title: "Sheet1", grid: [
          ["貨品編號","來源貨單","英文名","中文名","包裝/規格","條碼","數量","單位","儲存","低存量提示","備註","最後更新","貨架狀態"],
          ["1212965","貨單 #99187","Wingtat Free Range Chicken","永達 嘉美雞","7's","","5","Case","冷凍 1F","","","2026-11-21T16:28:56.465Z",""],
          ["1349040","手動新增","Metro Gold Shrimp","26-30去腸有尾白蝦肉","10 x 1.6LB","065717034311","8","Case","冷凍 1F","","貨架標籤","2026-11-19T19:58:34.499Z",""],
          ["1032552","手動新增","TYJ Spring Roll Pastry","第一家 春卷皮","6.0\"","8888003150500","4","Case","冷凍 2F","4","","2026-11-19T19:41:22.763Z","補貨架"],
          ["TMP-001","手動新增","Unknown thing","","", "","0","Pack","unclassified","2","","2026-11-19T19:41:22.763Z",""],
        ]},
        { sheetId: 1968802720, title: "出入記錄", grid: [
          ["ID","日期","貨品ID","貨品","變動","種類","備註"],
          ["1","2026-11-18T16:11:47.766Z","1212965","永達 嘉美雞 · Wingtat","5","initial","期初存量"],
          ["2","2026-11-18T16:12:47.766Z","1032552","第一家 春卷皮 · TYJ","4","initial","期初存量"],
        ]},
        { sheetId: 1923115386, title: "Space 更新狀態", grid: [
          ["項目","內容"],
          ["呢版係乜（交接文件）","手寫"],
          ["最後更新時間 (Winnipeg)","old"],
          ["貨品總數","4"],
        ]},
      ],
    },
  };
  const log = [];
  const colNum = (s) => s.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
  const parseRange = (r) => {
    const m = r.match(/^'?((?:[^']|'')+)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    return { tab: m[1].replace(/''/g, "'"), c1: colNum(m[2]) - 1, r1: +m[3] - 1, c2: colNum(m[4]) - 1, r2: +m[5] - 1 };
  };
  const find = (id, title) => SS[id].tabs.find((t) => t.title === title);
  const setCell = (g, r, c, v) => { while (g.length <= r) g.push([]); const row = g[r]; while (row.length <= c) row.push(""); row[c] = v; };
  const cv = (cd) => { const u = cd && cd.userEnteredValue; if (!u) return ""; if ("numberValue" in u) return String(u.numberValue); return u.stringValue ?? ""; };
  const tools = {
    get_values: ({ spreadsheetId, range }) => {
      const p = parseRange(range); const t = find(spreadsheetId, p.tab);
      if (!t) throw { code: "tool_error", message: "Unable to parse range: " + range };
      let rows = t.grid.slice(p.r1, p.r2 + 1).map((r) => r.slice(p.c1, p.c2 + 1));
      rows = rows.map((r) => { const x = r.slice(); while (x.length && x[x.length - 1] === "") x.pop(); return x; });
      while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
      return { range, values: rows };
    },
    get_spreadsheet: ({ spreadsheetId }) => ({ content: { sheets: SS[spreadsheetId].tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })) } }),
    update_spreadsheet: ({ spreadsheetId, requests }) => {
      const byId = (id) => SS[spreadsheetId].tabs.find((t) => t.sheetId === id);
      for (const rq of requests) {
        if (rq.updateCells) {
          const { start, rows } = rq.updateCells; const t = byId(start.sheetId);
          rows.forEach((row, i) => row.values.forEach((cd, j) => setCell(t.grid, start.rowIndex + i, start.columnIndex + j, cv(cd))));
        } else if (rq.appendCells) {
          const t = byId(rq.appendCells.sheetId);
          let last = t.grid.length; while (last > 0 && t.grid[last - 1].every((x) => x === "")) last--;
          t.grid.length = last;
          for (const row of rq.appendCells.rows) t.grid.push(row.values.map(cv));
        } else if (rq.deleteDimension) {
          const { sheetId, startIndex, endIndex } = rq.deleteDimension.range; byId(sheetId).grid.splice(startIndex, endIndex - startIndex);
        } else throw { code: "tool_error", message: "unsupported " + Object.keys(rq) };
      }
      log.push(requests.length);
      return { content: { spreadsheetId, replies: requests.map(() => ({})) } };
    },
  };
  window.__ss = SS; window.__log = log;
  window.claude = { use: async (name) => name !== "mcp" ? null : ({
    callTool: async (server, tool, input) => {
      await new Promise((r) => setTimeout(r, 30));
      if (server !== "Google Sheets") throw { code: "server_not_connected", message: server };
      if (!tools[tool]) throw { code: "not_in_manifest", message: tool };
      return { payload: tools[tool](input), content: [] };
    },
  }) };
})();
