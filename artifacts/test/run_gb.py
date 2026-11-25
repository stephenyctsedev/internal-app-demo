import json, sys
from playwright.sync_api import sync_playwright
mock = open('mock.js').read()
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox'])
    pg = b.new_page(viewport={'width':430,'height':900})
    errs=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.add_init_script(mock)
    pg.goto('file://' + __import__('os').path.abspath('../dist') + '/groupbuy.html')
    pg.wait_for_selector('text=已領取', timeout=8000)
    pg.wait_for_timeout(500)
    print('TEXT1:', pg.inner_text('body')[:300].replace('\n',' | '))
    def thumb(no, undo=False):
        return pg.locator('[role=slider][aria-label^="訂單 %d %s"]' % (no, '改返未領取' if undo else '標記已領取'))
    def swipe(loc, frac, left=False):
        bb = loc.bounding_box()
        track = loc.locator('xpath=..').bounding_box()
        x0, y0 = bb['x'] + bb['width']/2, bb['y'] + bb['height']/2
        travel = (track['width'] - bb['width'] - 8) * frac * (-1 if left else 1)
        pg.mouse.move(x0, y0); pg.mouse.down()
        pg.mouse.move(x0 + travel, y0, steps=8); pg.mouse.up()
    # a plain tap, a half-way swipe and a 90% swipe must NOT write anything
    thumb(1).click(); pg.wait_for_timeout(300)
    swipe(thumb(1), 0.5); pg.wait_for_timeout(500)
    swipe(thumb(1), 0.9); pg.wait_for_timeout(500)
    g = pg.evaluate("window.__ss['DEMO_GROUPBUY_SHEET_ID'].tabs[1].grid.slice(1,2)")
    print('NO-WRITE:', json.dumps(g, ensure_ascii=False))
    print('THUMB RESET:', thumb(1).get_attribute('aria-valuenow'))
    pg.screenshot(path='gb_slider.png')
    # slow write: the thumb must stay at the end (no jump back / across) while saving
    pg.evaluate("window.__lat = 800")
    swipe(thumb(1), 1.0)
    for ms in (150, 700, 1200):
        pg.wait_for_timeout(150 if ms == 150 else ms - 150 if ms == 700 else 500)
        u = thumb(1, True); bb = u.bounding_box(); tr = u.locator('xpath=..').bounding_box()
        print('SAVING +%dms thumb at right edge:' % ms, bb['x'] + bb['width'] > tr['x'] + tr['width'] - 8)
    pg.wait_for_timeout(3500)
    pg.evaluate("window.__lat = 30")
    pg.wait_for_timeout(700)
    grid = pg.evaluate("window.__ss['DEMO_GROUPBUY_SHEET_ID'].tabs[1].grid.slice(0,4)")
    print('GRID:', json.dumps(grid, ensure_ascii=False))
    t2 = thumb(2, True)
    # undo slider starts at the RIGHT edge; a right swipe / half swipe must not write
    b2 = t2.bounding_box(); tr2 = t2.locator('xpath=..').bounding_box()
    print('UNDO AT RIGHT:', b2['x'] + b2['width'] > tr2['x'] + tr2['width'] - 8)
    swipe(t2, -0.5); pg.wait_for_timeout(300); swipe(t2, 0.5, left=True); pg.wait_for_timeout(500)
    g2 = pg.evaluate("window.__ss['DEMO_GROUPBUY_SHEET_ID'].tabs[1].grid.slice(3,4)")
    print('UNDO NO-WRITE:', json.dumps(g2, ensure_ascii=False))
    pg.screenshot(path='gb_slider2.png')
    swipe(t2, 1.0, left=True)
    pg.wait_for_timeout(700)
    grid = pg.evaluate("window.__ss['DEMO_GROUPBUY_SHEET_ID'].tabs[1].grid.slice(0,5)")
    print('GRID2:', json.dumps(grid, ensure_ascii=False))
    # keyboard path: focus the slider and press Enter
    t3 = thumb(3); t3.focus(); pg.keyboard.press('Enter'); pg.wait_for_timeout(700)
    print('KEY:', thumb(3, True).count())
    pg.fill('input[aria-label="搜尋編號"]','3')
    print('SEARCH:', pg.inner_text('ul.mt-4').replace('\n',' | ')[:120])
    pg.screenshot(path='gb.png')
    print('ERRS', errs)
    b.close()
