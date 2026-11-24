import json
from playwright.sync_api import sync_playwright
mock = open('mock.js').read()
W="DEMO_WAREHOUSE_SHEET_ID"
def grid(pg, i, n=99): return pg.evaluate(f"window.__ss['{W}'].tabs[{i}].grid.slice(0,{n})")
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    pg = b.new_page(viewport={'width':430,'height':1000})
    errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.add_init_script(mock)
    pg.goto('file://' + __import__('os').path.abspath('../dist') + '/warehouse.html')
    pg.wait_for_selector('text=永達 嘉美雞', timeout=8000)
    pg.wait_for_timeout(600)
    print('TOP:', pg.inner_text('section[aria-label="存量概覽"]').replace('\n',' | '))
    print('SHEET:', pg.inner_text('section[aria-label="Google Sheet 直連"]').replace('\n',' | '))
    # +1 on chicken
    pg.click('button[aria-label="增加 永達 嘉美雞 存量"]'); pg.wait_for_timeout(700)
    g=grid(pg,0); print('QTY row2:', g[1][6], g[1][11][:10]); print('MOV:', grid(pg,1)[-1]); print('STATUS:', grid(pg,2))
    # shelf mark
    pg.click('button[aria-label^="標記 永達 嘉美雞 補貨架"]'); pg.wait_for_timeout(700)
    print('SHELF:', grid(pg,0)[1][12], 'qty', grid(pg,0)[1][6], 'movs', len(grid(pg,1)))
    # set quantity via input
    inp = pg.locator('input[aria-label^="第一家 春卷皮 目前存量"]'); inp.fill('9'); inp.press('Enter'); pg.wait_for_timeout(800)
    print('SET:', grid(pg,0)[3][6], grid(pg,1)[-1][4:])
    # add item
    pg.click('text=＋ 新增貨品'); pg.fill('#f-name-zh','測試貨'); pg.fill('#f-name-en','Test'); pg.fill('#f-barcode','0123456789'); pg.fill('#f-qty','3')
    pg.click('button[type=submit]'); pg.wait_for_timeout(900)
    g=grid(pg,0); print('ADD:', g[-1]); print('MOV:', grid(pg,1)[-1])
    # edit TMP item: set real code
    pg.click('button[aria-label="編輯 測試貨"]'); pg.wait_for_timeout(700)
    pg.fill('#f-stock-code','1234567'); pg.fill('#f-notes','改咗備註'); pg.click('button[type=submit]'); pg.wait_for_timeout(900)
    g=grid(pg,0); print('EDIT:', g[-1])
    # bulk select + storage change
    pg.get_by_role('button', name='多選', exact=True).click(); pg.wait_for_timeout(300)
    pg.locator('input[type=checkbox]').nth(0).check(); pg.locator('input[type=checkbox]').nth(1).check(); pg.wait_for_timeout(200)
    pg.get_by_role('button', name='批量操作', exact=True).click(); pg.wait_for_timeout(300)
    pg.screenshot(path='bulk.png')
    pg.select_option('#bulk-storage','frozen_2f'); pg.click('section[aria-label="批量改儲存位置"] >> text=套用'); pg.wait_for_timeout(900)
    g=grid(pg,0); print('BULK:', [r[8] for r in g[1:]], [r[11][:10] for r in g[1:]])
    # movements view + edit
    pg.click('button[role=tab]:has-text("出入記錄")'); pg.wait_for_timeout(600)
    print('HIST:', pg.inner_text('section[aria-label="出入記錄"]').replace('\n',' | ')[:250])
    pg.locator('button:has-text("編輯")').first.click(); pg.wait_for_timeout(300)
    pg.fill('#mv-amount','7'); pg.click('form button[type=submit]'); pg.wait_for_timeout(900)
    print('MV EDIT: qty row', [r[6] for r in grid(pg,0)[1:]], grid(pg,1)[-1])
    # delete item
    pg.click('button[role=tab]:has-text("存貨")'); pg.wait_for_timeout(400)
    pg.click('button[aria-label^="編輯 測試貨"]'); pg.wait_for_timeout(500)
    pg.click('text=刪除呢項貨品'); pg.click('text=確定刪除'); pg.wait_for_timeout(900)
    print('DEL:', [r[0] for r in grid(pg,0)], 'STATUS', grid(pg,2)[3])
    pg.screenshot(path='wh.png', full_page=True)
    print('ERRS', errs)
    b.close()
