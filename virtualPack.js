/**
 * 가상스캔 배정 알고리즘 — 출고스캔(/shipScan) [가상스캔] 버튼 · 입고정리(/inboundArrange) [가상스캔] 일괄(서버에서 같은 함수)
 * 설계: docs/plan-virtual-scan.md
 *
 * 순수 함수 (DOM·네트워크 없음). 브라우저에서는 window.VirtualPack, node 에서는 require 로 쓴다.
 *   const plan = VirtualPack.planVirtualScan({ products, boxItems, savedBoxes, boxSizeMap }, overrides);
 *   const body = VirtualPack.applyPlan({ boxItems, savedBoxes, boxSizeMap }, plan);   // 저장 API body (서버 일괄 가상스캔이 사용)
 *
 * 핵심 규칙
 *  · 바코드별 목표 = min(출고예정 배정량(재고+입고), 확정수량) − 이미 스캔량
 *  · 부피 = coupang_items 가로×세로×높이(mm) → L. 임시값(300×300×20)·누락은 측정 중앙값(2.85 L)으로 가정
 *  · 용량 = 실제로 포장한 박스 중 가장 많이 담긴 상위 10개 표본의 최솟값 (극소 100 · 중 200 · 대2 480 L) — 박스 치수가 아니다 (옷이 눌림). 2026-10-15 교체
 *  · 박스당 무게는 25 kg 미만 (CONFIG.maxKg). 넘치면 다음 박스. null 이면 제한 없음
 *  · 이미 있는 박스는 **마지막 박스(가장 큰 번호) 하나만** 남은 용량부터 채운다 — 앞 박스들은 이미 마감(테이핑)된 것으로 본다
 *  · 마지막 박스가 극소/중인데 남은 상품이 다 안 들어가면 크기를 올린다 (극소→중→대2). 확정 시 DB 의 box_size 도 바뀐다
 *  · 신규 박스는 남은 전체가 들어가는 가장 작은 크기(극소→중→대2), 안 들어가면 대2
 *  · 상품은 수량 많은 것부터 담는다 (찾아 담기 편한 순서)
 *  · 출처별 분리(splitBySource, 2026-10-15): 배정량을 입고분/재고분으로 나눠 **입고분을 먼저, 재고분을 그다음** 담고
 *    출처가 바뀌는 자리에서 박스를 마감해 새 박스부터 시작한다 → 한 박스는 한 작업대(입고 작업대 / 재고 선반)에서 끝난다.
 *    기존 마지막 박스 채우기는 먼저 담는 출처(입고)만 한다. 그 대신 출처당 마지막 박스가 덜 찰 수 있다 (박스가 하나 더 나올 수 있음).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VirtualPack = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONFIG = {
    overfill: 0,                                      // 보정 가산 없음 — 용량 자체를 실제 포장 통계로 잡았다 (2026-10-15. 그전엔 보수적 용량 + 5~10% 가산)
    baseCapL: { '극소': 100, '중': 200, '대2': 480 }, // 용량(명목 부피 합, L) = 실제로 스캔·포장한 박스 중 **가장 많이 담긴 상위 10개 표본의 최솟값** (2026-10-15, docs §7-14)
                                                      //   표본: 2026-07~10 실제 스캔 박스 1,970개. 크기 기록 의심(수량이 그 크기 상위 5% 초과)은 빼고 상위 10개 → 극소 99 · 중 198 · 대2 478
                                                      //   (한 박스만 보면 극소 145 · 중 282 · 대2 616 까지 있지만 한 표본은 믿지 않는다)
    newSizes: ['극소', '중', '대2'],                  // 신규 박스 후보 (작은 것부터). 소/대는 쓰지 않는다
    maxKg: 25,                                        // 박스당 무게 상한 (이 값 미만). null 이면 제한 없음 (2026-10-15 잠깐 해제했다가 같은 날 25 kg 로 되돌림 — 투피스 30개가 24.6 kg)
    defaultUnitL: 2.85,                               // 사이즈 임시값·누락 상품의 1개 부피 (측정 상품 중앙값)
    defaultUnitKg: 0.2,                               // 무게 누락 상품의 1개 무게 (중앙값 200 g)
    placeholder: { w: 300, l: 300, h: 20 },           // 쿠팡 등록 시 넣어 둔 임시 사이즈
    maxBoxNo: 20,                                     // 박스 번호 1~20 (화면 그리드와 동일)
    topUpExisting: true,                              // true = 기존 박스 남은 용량부터 채움 · false = 기존 박스는 그대로 두고 새 박스만
    upgradeLastBox: true,                             // 마지막 기존 박스(극소/중)에 남은 상품이 다 안 들어가면 크기를 올린다 (극소→중→대2). 확정 시 DB box_size 도 바뀜
    splitBySource: true,                              // true = 입고분/재고분을 다른 박스에 담는다 (products 에 allocInbound/allocStock 이 있을 때만 효과)
    sourceOrder: ['입고', '재고'],                     // 담는 순서 — 앞 출처가 기존 마지막 박스를 채운다
    sourceFilter: null,                               // null = 전체 · '입고' | '재고' = 그 출처 배정분만 담는다 (모달의 대상 선택)
    inboundCodes: null,                               // null = 입고분 전부 · ['1011', …] = 그 입고코드의 입고분만 (다른 코드 분량은 '다른 입고코드' 로 제외)
  };

  const EPS = 1e-9;

  function mergeConfig(overrides) {
    const cfg = Object.assign({}, CONFIG, overrides || {});
    cfg.baseCapL = Object.assign({}, CONFIG.baseCapL, (overrides && overrides.baseCapL) || {});
    cfg.placeholder = Object.assign({}, CONFIG.placeholder, (overrides && overrides.placeholder) || {});
    return cfg;
  }

  // 크기별 용량(L) — overfill 가산 포함(현재 0). 모르는 크기(소/대 등)는 null
  function capL(size, cfg) {
    const base = cfg.baseCapL[size];
    return base == null ? null : base * (1 + cfg.overfill);
  }

  // 상품 1개의 부피(L)·무게(kg) + 가정 여부
  function unitOf(size, cfg) {
    const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
    const w = size && n(size.w), l = size && n(size.l), h = size && n(size.h), g = size && n(size.g);
    let L, flag = null;
    if (!w || !l || !h) { L = cfg.defaultUnitL; flag = 'missing'; }
    else if (w === cfg.placeholder.w && l === cfg.placeholder.l && h === cfg.placeholder.h) { L = cfg.defaultUnitL; flag = 'placeholder'; }
    else L = (w * l * h) / 1e6;
    const kg = g ? g / 1000 : cfg.defaultUnitKg;
    return { L, kg, flag };
  }

  function sizeOfExisting(no, savedBoxes, boxSizeMap) {
    const saved = (savedBoxes || []).find((b) => Number(b.boxNo) === no);
    if (saved && saved.boxSize) return String(saved.boxSize);
    if (boxSizeMap) {
      const v = typeof boxSizeMap.get === 'function' ? boxSizeMap.get(no) : boxSizeMap[no];
      if (v) return String(v);
    }
    return '극소'; // doScan 의 기본값과 동일
  }

  /**
   * @param {object} input
   *   products : [{barcode, productName, orderQty(확정), allocQty(출고예정 배정), scannedQty, size:{w,l,h,g}|null, location}]
   *   boxItems : [{boxNo, barcode, qty}]            — 저장분 + 세션분 (현재 화면 상태)
   *   savedBoxes: [{boxNo, boxSize}]
   *   boxSizeMap: Map|object boxNo → size            — 세션에서 정한 크기
   * @param {object} overrides CONFIG 덮어쓰기 (테스트·튜닝용)
   */
  function planVirtualScan(input, overrides) {
    const cfg = mergeConfig(overrides);
    const products = Array.isArray(input.products) ? input.products : [];
    const boxItems = Array.isArray(input.boxItems) ? input.boxItems : [];
    const savedBoxes = Array.isArray(input.savedBoxes) ? input.savedBoxes : [];

    // 이미 담긴 개수를 실제 스캔분/가상스캔분으로 나눠 둔다 (출처 귀속이 다르다 — 아래 주석)
    const scannedVirtualByBc = new Map(), scannedRealByBc = new Map();
    for (const it of boxItems) {
      const k = String(it.barcode || '').trim(); if (!k) continue;
      const q = Math.max(0, parseInt(it.qty, 10) || 0), v = Math.min(q, Math.max(0, parseInt(it.virtualQty, 10) || 0));
      scannedVirtualByBc.set(k, (scannedVirtualByBc.get(k) || 0) + v);
      scannedRealByBc.set(k, (scannedRealByBc.get(k) || 0) + (q - v));
    }

    // ── 1. 바코드별 단위·목표 ──
    const unitByBc = new Map();
    const items = [];       // 담을 것 [{barcode, productName, location, qty, unitL, unitKg, flag}]
    const excluded = [];    // 제외 [{barcode, productName, reason}]
    let assumedCount = 0;
    let attributedScan = false;   // 입고코드가 여럿인 상품에서 이미 담긴 개수를 오래된 코드부터 뺐다 (경고용)
    for (const p of products) {
      const bc = String(p.barcode || '').trim();
      if (!bc) continue;
      const u = unitOf(p.size, cfg);
      unitByBc.set(bc, u);
      const alloc = Math.max(0, parseInt(p.allocQty, 10) || 0);
      const conf = Math.max(0, parseInt(p.orderQty, 10) || 0);
      const scanned = Math.max(0, parseInt(p.scannedQty, 10) || 0);
      const target = Math.min(alloc, conf);
      const remain = Math.max(0, target - scanned);
      if (alloc <= 0) { excluded.push({ barcode: bc, productName: p.productName || '', reason: '배정 없음' }); continue; }
      if (remain <= 0) { excluded.push({ barcode: bc, productName: p.productName || '', reason: '이미 완료' }); continue; }
      if (u.flag) assumedCount++;
      const base = { barcode: bc, productName: p.productName || '', location: p.location || '',
        unitL: u.L, unitKg: u.kg, flag: u.flag, capped: alloc > conf };
      // 출처별 분리: 배정량을 입고분/재고분으로 나눈다. 확정수량이 배정보다 작으면 재고분부터 줄이고,
      // 이미 스캔한 개수는 입고분부터 뺀다 (입고분을 먼저 담는 순서와 맞춤).
      const inbAll = Math.max(0, parseInt(p.allocInbound, 10) || 0), stk = Math.max(0, parseInt(p.allocStock, 10) || 0);
      const filter = cfg.sourceFilter || null;
      if ((cfg.splitBySource || filter) && (inbAll > 0 || stk > 0)) {
        // 입고분을 입고코드별로 본다. 코드 정보가 없으면 '*' 하나로.
        //   목표(target)는 입고코드 오래된 순 → 재고 순으로 채우고, 이미 스캔(담은) 개수도 같은 순서로 뺀다.
        //   (담긴 개수에는 코드 표시가 없어서 "오래된 입고코드부터 처리했다" 고 보는 것 — 입고코드 순서대로 돌리는 운영 전제)
        const rawByCode = p.allocInboundByCode && typeof p.allocInboundByCode === 'object' ? p.allocInboundByCode : {};
        let codes = Object.keys(rawByCode).filter((c) => (parseInt(rawByCode[c], 10) || 0) > 0)
          .sort((a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true }));
        const byCode = {};
        for (const c of codes) byCode[c] = Math.max(0, parseInt(rawByCode[c], 10) || 0);
        if (!codes.length && inbAll > 0) { codes = ['*']; byCode['*'] = inbAll; }
        let left = target;
        const capQ = {};
        for (const c of codes) { capQ[c] = Math.min(byCode[c], left); left -= capQ[c]; }
        const stkT = Math.min(stk, left);
        // 이미 담긴 개수를 출처에서 뺀다 (2026-10-15 수정):
        //   · 가상스캔으로 담긴 분량(virtualQty) → 입고 오래된 코드부터, 그다음 재고 (가상스캔은 입고분을 먼저 담으므로)
        //   · 실제 스캔으로 담긴 분량 → 재고부터, 그다음 입고 (출고스캔은 재고 선반에서 먼저 하는 흐름. 재고 8개를 실제로 담은 뒤 입고 1개가
        //     들어온 발주서에서, 실제 8개를 입고분으로 치는 바람에 입고 1개가 '재고' 로 밀려 입고 가상스캔에서 빠지던 문제)
        //   · 어느 쪽인지 모르는 분량(boxItems 없이 scannedQty 만 준 경우)은 가상 분량처럼 다룬다
        const sv = scannedVirtualByBc.get(bc) || 0, sr = scannedRealByBc.get(bc) || 0;
        let sVirt = Math.min(scanned, sv + Math.max(0, scanned - sv - sr)), sReal = Math.max(0, scanned - sVirt);
        const remByCode = {};
        for (const c of codes) { const t = Math.min(capQ[c], sVirt); remByCode[c] = capQ[c] - t; sVirt -= t; }
        let remStk = Math.max(0, stkT - sVirt);
        { const t = Math.min(remStk, sReal); remStk -= t; sReal -= t; }
        for (const c of codes) { const t = Math.min(remByCode[c], sReal); remByCode[c] -= t; sReal -= t; }
        if (sv > 0 && codes.length > 1) attributedScan = true;
        // 입고코드 선택: 고른 코드의 남은 입고분만 담고, 다른 코드 분량은 '다른 입고코드' 로 제외 (코드 정보 없는 '*' 도 다른 코드 취급)
        const sel = Array.isArray(cfg.inboundCodes) && cfg.inboundCodes.length ? new Set(cfg.inboundCodes.map(String)) : null;
        let remInb = 0, remOther = 0;
        for (const c of codes) { if (!sel || sel.has(String(c))) remInb += remByCode[c]; else remOther += remByCode[c]; }
        if (remOther > 0) excluded.push({ barcode: bc, productName: p.productName || '', reason: '다른 입고코드', qty: remOther });
        if (filter) {
          // 대상 선택(입고만/재고만): 그 출처 분량만 담고 나머지는 제외로 기록
          const q = filter === '입고' ? remInb : filter === '재고' ? remStk : remain;
          if (q > 0) items.push(Object.assign({}, base, { qty: q, source: filter }));
          else excluded.push({ barcode: bc, productName: p.productName || '', reason: `${filter} 배정 없음` });
        } else {
          if (remInb > 0) items.push(Object.assign({}, base, { qty: remInb, source: '입고' }));
          if (remStk > 0) items.push(Object.assign({}, base, { qty: remStk, source: '재고' }));
        }
      } else if (filter) {
        excluded.push({ barcode: bc, productName: p.productName || '', reason: '출처 정보 없음' });
      } else {
        items.push(Object.assign({}, base, { qty: remain, source: null }));
      }
    }
    // 출처 순서(입고 → 재고, 출처 정보 없는 것은 맨 앞) → 수량 많은 것부터 → 바코드순
    const srcRank = (s) => { if (s == null) return 0; const i = cfg.sourceOrder.indexOf(s); return i < 0 ? 99 : i + 1; };
    items.sort((a, b) => (srcRank(a.source) - srcRank(b.source)) || (b.qty - a.qty)
      || String(a.barcode).localeCompare(String(b.barcode), 'ko', { numeric: true }));
    const sources = [...new Set(items.map((i) => i.source))];   // 담는 순서대로의 출처 목록
    const splitActive = sources.length > 1;

    const assumptions = {
      overfill: cfg.overfill, maxKg: cfg.maxKg, defaultUnitL: cfg.defaultUnitL, assumedCount, topUpExisting: !!cfg.topUpExisting,
      splitBySource: !!cfg.splitBySource, splitActive, sourceFilter: cfg.sourceFilter || null,
      inboundCodes: Array.isArray(cfg.inboundCodes) && cfg.inboundCodes.length ? cfg.inboundCodes.slice() : null,
      cap: Object.fromEntries(cfg.newSizes.map((s) => [s, capL(s, cfg)])),
    };
    const bySource = {};
    for (const i of items) bySource[i.source || '미구분'] = (bySource[i.source || '미구분'] || 0) + i.qty;
    const totals = { skus: new Set(items.map((i) => i.barcode)).size, qty: items.reduce((s, i) => s + i.qty, 0),
      L: items.reduce((s, i) => s + i.qty * i.unitL, 0), kg: items.reduce((s, i) => s + i.qty * i.unitKg, 0),
      newBoxes: 0, topUpBoxes: 0, bySource };
    const warnings = [];
    if (!items.length) {
      return { ok: false, reason: !products.length ? '발주서 상품이 없습니다.'
          : cfg.sourceFilter ? `${cfg.sourceFilter} 배정분이 없습니다. (그 출처의 출고예정 배정이 없거나 이미 모두 스캔됨)`
          : '담을 상품이 없습니다. (출고예정 배정이 없거나 이미 모두 스캔됨)',
        assumptions, boxes: [], excluded, totals, warnings };
    }

    // ── 2. 기존 박스 (남은 용량 채우기 대상) ──
    const existingNos = [...new Set([...savedBoxes.map((b) => Number(b.boxNo)), ...boxItems.map((i) => Number(i.boxNo))])]
      .filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b);
    const usedNos = new Set(existingNos);
    const boxes = [];
    // 기존 박스 중 채울 수 있는 것은 마지막 박스(가장 큰 번호) 하나뿐 — 앞 박스들은 이미 마감된 것으로 본다.
    // 새 박스만 모드면 기존 박스는 번호만 비켜 가고 채우지 않는다.
    const lastNo = existingNos.length ? existingNos[existingNos.length - 1] : null;
    const closedNos = existingNos.filter((n) => n !== lastNo);
    if (cfg.topUpExisting && lastNo != null) {
      const size0 = sizeOfExisting(lastNo, savedBoxes, input.boxSizeMap);
      let size = size0, cap = capL(size0, cfg);
      let usedL = 0, usedKg = 0, usedQty = 0;
      for (const it of boxItems) {
        if (Number(it.boxNo) !== lastNo) continue;
        const u = unitByBc.get(String(it.barcode)) || unitOf(null, cfg);
        const q = parseInt(it.qty, 10) || 0;
        usedL += q * u.L; usedKg += q * u.kg; usedQty += q;
      }
      // 크기 UP: 지금 크기로는 남은 상품이 다 안 들어가면, 다 들어가는 가장 작은 큰 크기로 (없으면 가장 큰 크기로) 바꾼다.
      // 부피 기준으로만 판단한다 — 무게 때문에 안 들어가는 건 박스를 키워도 해결되지 않으므로.
      if (cap != null && cfg.upgradeLastBox) {
        const needL = usedL + totals.L;
        if (needL > cap + EPS) {
          const bigger = cfg.newSizes.slice(cfg.newSizes.indexOf(size0) + 1);
          const pick = bigger.find((s) => capL(s, cfg) >= needL - EPS) || bigger[bigger.length - 1];
          if (pick) { size = pick; cap = capL(pick, cfg); }
        }
      }
      if (cap == null) warnings.push(`마지막 박스 📦${lastNo}(${size0})는 용량 기준이 없는 크기라 채우지 않았습니다.`); // 소/대 등 용량 미정
      else boxes.push({ boxNo: lastNo, size, sizeFrom: size !== size0 ? size0 : null, isNew: false, cap,
        usedL0: usedL, usedKg0: usedKg, usedQty0: usedQty, usedL, usedKg, items: [], warnings: [] });
    }
    if (cfg.topUpExisting && closedNos.length) warnings.push(`앞 박스 ${closedNos.map((n) => `📦${n}`).join(', ')}는 마감된 것으로 보고 채우지 않았습니다 (마지막 박스 📦${lastNo}만 채움).`);
    if (!cfg.topUpExisting && existingNos.length) warnings.push(`기존 박스 ${existingNos.length}개(${existingNos.map((n) => `📦${n}`).join(', ')})는 그대로 두고 새 박스만 썼습니다.`);

    // ── 3. 채우기 ──
    //   새 박스 크기는 "지금 담는 출처의 남은 부피" 로 정한다 (다른 출처 분량은 다른 박스로 가므로 셈에 넣지 않는다)
    const restL = (src) => items.reduce((s, i) => s + (i.source === src ? i.qty * i.unitL : 0), 0);
    const nextBoxNo = () => { for (let n = 1; n <= cfg.maxBoxNo; n++) if (!usedNos.has(n)) return n; return null; };
    const openNewBox = (src) => {
      const rL = restL(src);
      let size = cfg.newSizes[cfg.newSizes.length - 1];
      for (const s of cfg.newSizes) { const c = capL(s, cfg); if (c != null && rL <= c + EPS) { size = s; break; } }
      const no = nextBoxNo();
      if (no == null) return null;
      usedNos.add(no);
      const b = { boxNo: no, size, isNew: true, cap: capL(size, cfg), usedL0: 0, usedKg0: 0, usedQty0: 0,
        usedL: 0, usedKg: 0, items: [], warnings: [], source: null };
      boxes.push(b);
      return b;
    };
    // 이 박스에 더 담을 수 있는 개수 (부피 ≤ 용량, 무게 < 상한 — maxKg 가 null 이면 무게는 보지 않는다)
    const hasKg = Number.isFinite(cfg.maxKg) && cfg.maxKg > 0;
    const fitCount = (b, it) => {
      const byL = Math.floor((b.cap - b.usedL) / it.unitL + EPS);
      const byKg = hasKg ? Math.ceil((cfg.maxKg - b.usedKg) / it.unitKg - EPS) - 1 : Infinity;
      return Math.max(0, Math.min(byL, byKg));
    };
    const put = (b, it, n) => {
      const ex = b.items.find((x) => x.barcode === it.barcode && (x.source || null) === (it.source || null));
      if (ex) ex.qty += n;
      else b.items.push({ barcode: it.barcode, productName: it.productName, location: it.location, qty: n, unitL: it.unitL, unitKg: it.unitKg, flag: it.flag, source: it.source || null });
      b.usedL += n * it.unitL; b.usedKg += n * it.unitKg; it.qty -= n;
      // 박스의 출처 표시 — 한 출처면 그 출처, 둘 이상이면 '혼합' (출처 분리 중에는 새 박스가 섞이지 않는다)
      if (b.source === undefined || b.source === null) b.source = it.source || null;
      else if (it.source && b.source !== it.source) b.source = '혼합';
    };

    let cursor = 0;                 // boxes[] 의 현재 위치 (기존 박스 → 신규 박스 순)
    let stop = null;
    let curSrc, started = false;
    for (const it of items) {
      // 출처가 바뀌면 지금 박스를 마감하고 새 박스부터 — 한 박스에 입고분·재고분을 섞지 않는다
      if (started && it.source !== curSrc) cursor = boxes.length;
      started = true; curSrc = it.source;
      while (it.qty > 0) {
        let b = boxes[cursor];
        if (!b) { b = openNewBox(it.source); if (!b) { stop = `박스 번호가 부족합니다 (1~${cfg.maxBoxNo} 모두 사용).`; break; } }
        const n = Math.min(it.qty, fitCount(b, it));
        if (n > 0) { put(b, it, n); continue; }
        // 이 박스에는 1개도 안 들어감
        if (b.isNew && b.usedL === 0 && b.items.length === 0) {
          // 새 박스인데 1개도 못 담는 상품 = 단일 상품이 용량/무게 한도를 넘음 → 1개 강제 + 경고
          put(b, it, 1);
          b.warnings.push(`${it.barcode} 1개가 박스 한도(부피 ${b.cap.toFixed(0)} L${hasKg ? ` · ${cfg.maxKg} kg` : ''})를 넘습니다.`);
          cursor++; continue;
        }
        cursor++;                    // 박스 마감 → 다음 박스
      }
      if (stop) break;
    }

    // ── 4. 정리 ──
    const result = boxes.filter((b) => b.items.length > 0 || !b.isNew);
    for (const b of result) {
      b.fillPct = b.cap ? (b.usedL / b.cap) * 100 : 0;
      b.fillPct0 = b.cap ? (b.usedL0 / b.cap) * 100 : 0;
      b.addQty = b.items.reduce((s, i) => s + i.qty, 0);
      if (b.sizeFrom) b.warnings.push(`크기 변경 ${b.sizeFrom} → ${b.size} — 확정하면 박스 크기도 바뀝니다.`);
      if (hasKg && b.usedKg >= cfg.maxKg * 0.9) b.warnings.push(`무게 ${b.usedKg.toFixed(1)} kg — 상한 ${cfg.maxKg} kg 에 근접`);
      if (b.items.some((i) => i.flag)) b.warnings.push(`사이즈 가정 상품 ${b.items.filter((i) => i.flag).length}종 포함`);
    }
    totals.newBoxes = result.filter((b) => b.isNew).length;
    totals.topUpBoxes = result.filter((b) => !b.isNew && b.items.length > 0).length;
    totals.upgradedBoxes = result.filter((b) => b.sizeFrom).length;
    if (splitActive) {
      const cnt = (src) => result.filter((b) => b.items.length && b.source === src).length;
      totals.boxesBySource = Object.fromEntries(sources.map((s) => [s || '미구분', cnt(s)]));
      warnings.push(`출처별로 나눠 담았습니다 — ${sources.map((s) => `${s || '미구분'} ${cnt(s)}박스`).join(' · ')}${result.some((b) => b.source === '혼합') ? ' · 기존 박스에 더한 분량은 섞임' : ''}.`);
    }
    const untouchedExisting = result.filter((b) => !b.isNew && !b.items.length);
    if (untouchedExisting.length) warnings.push(`남은 용량이 없어 그대로 둔 기존 박스: ${untouchedExisting.map((b) => `📦${b.boxNo}`).join(', ')}`);
    if (items.some((i) => i.capped)) warnings.push(`배정량이 확정수량보다 큰 상품 ${items.filter((i) => i.capped).length}종은 확정수량까지만 담았습니다.`);
    if (excluded.some((e) => e.reason === '배정 없음')) warnings.push(`출고예정 배정이 없는 상품 ${excluded.filter((e) => e.reason === '배정 없음').length}종은 제외했습니다.`);
    if (attributedScan) warnings.push('가상으로 이미 담긴 개수는 오래된 입고코드부터 담은 것으로 보고 뺐습니다 (입고코드 순서대로 돌리는 것을 전제). 실제 스캔분은 재고부터 뺍니다.');
    if (excluded.some((e) => e.reason === '다른 입고코드')) {
      const oth = excluded.filter((e) => e.reason === '다른 입고코드');
      warnings.push(`고른 입고코드가 아닌 입고분 ${oth.reduce((s, e) => s + (e.qty || 0), 0)}개(${oth.length}종)는 담지 않았습니다 — 그 입고코드로 다시 돌리세요.`);
    }

    if (stop) return { ok: false, reason: stop, assumptions, boxes: result, excluded, totals, warnings };
    return { ok: true, reason: null, assumptions, boxes: result, excluded, totals, warnings };
  }

  /**
   * 계획을 저장 형식으로 반영 — 출고스캔 [확정](confirmVirtualScan) 과 같은 규칙. 순수 함수 (입력을 바꾸지 않는다)
   *   · 박스 아이템: 같은 박스·바코드 행이 있으면 qty 와 virtualQty 에 담는 개수를 더하고, 없으면 새 행(qty = virtualQty = 담는 개수)
   *   · 박스 크기: 신규 박스·크기 UP 박스는 계획의 크기, 나머지 기존 박스는 지금 크기(boxSizeMap → savedBoxes → '극소')
   *   · 박스 목록: 아이템이 있는 박스 + 저장된(빈) 박스 전부 — 저장 API 가 SET 이라 빠뜨리면 그 박스가 사라진다
   * @param {object} input  planVirtualScan 과 같은 { boxItems:[{boxNo,barcode,productName,qty,virtualQty}], savedBoxes, boxSizeMap }
   * @param {object} plan   planVirtualScan 결과 (ok 인 것)
   * @returns {{ boxes:[{boxNo,boxSize}], items:[{boxNo,barcode,productName,qty,virtualQty}], addQty, boxCnt, upCnt }}
   *          — POST /api/ship-scan/save 의 body 그대로 + 반영 요약
   */
  function applyPlan(input, plan) {
    const items = (Array.isArray(input.boxItems) ? input.boxItems : []).map((i) => ({
      boxNo: Number(i.boxNo), barcode: String(i.barcode || '').trim(), productName: i.productName || '',
      qty: Math.max(0, parseInt(i.qty, 10) || 0), virtualQty: Math.max(0, parseInt(i.virtualQty, 10) || 0) }));
    const sizeByNo = new Map();
    for (const b of (Array.isArray(input.savedBoxes) ? input.savedBoxes : [])) if (b && b.boxSize) sizeByNo.set(Number(b.boxNo), b.boxSize);
    const m = input.boxSizeMap;
    if (m) {
      const entries = typeof m.entries === 'function' ? [...m.entries()] : Object.entries(m);
      for (const [no, size] of entries) if (size) sizeByNo.set(Number(no), size);
    }
    let addQty = 0, boxCnt = 0, upCnt = 0;
    for (const b of (plan && Array.isArray(plan.boxes)) ? plan.boxes : []) {
      if (!b.items || !b.items.length) continue;
      boxCnt++;
      if (b.isNew || b.sizeFrom || !sizeByNo.has(b.boxNo)) sizeByNo.set(b.boxNo, b.size);
      if (b.sizeFrom) upCnt++;
      for (const it of b.items) {
        const q = Math.max(0, parseInt(it.qty, 10) || 0);
        if (!q) continue;
        const x = items.find((r) => r.boxNo === b.boxNo && r.barcode === it.barcode);
        if (x) { x.qty += q; x.virtualQty += q; }
        else items.push({ boxNo: b.boxNo, barcode: it.barcode, productName: it.productName || '', qty: q, virtualQty: q });
        addQty += q;
      }
    }
    const boxNos = [...new Set([...items.map((i) => i.boxNo), ...sizeByNo.keys()])]
      .filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b);
    const boxes = boxNos.map((no) => ({ boxNo: no, boxSize: sizeByNo.get(no) || '극소' }));
    return { boxes, items, addQty, boxCnt, upCnt };
  }

  return { CONFIG, planVirtualScan, applyPlan, capL, unitOf };
}));
