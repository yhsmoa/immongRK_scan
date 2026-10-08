/**
 * 가상스캔 배정 알고리즘 — 출고스캔(/shipScan) [가상스캔] 버튼
 * 설계: docs/plan-virtual-scan.md
 *
 * 순수 함수 (DOM·네트워크 없음). 브라우저에서는 window.VirtualPack, node 에서는 require 로 쓴다.
 *   const plan = VirtualPack.planVirtualScan({ products, boxItems, savedBoxes, boxSizeMap }, overrides);
 *
 * 핵심 규칙
 *  · 바코드별 목표 = min(출고예정 배정량(재고+입고), 확정수량) − 이미 스캔량
 *  · 부피 = coupang_items 가로×세로×높이(mm) → L. 임시값(300×300×20)·누락은 측정 중앙값(2.85 L)으로 가정
 *  · 용량 = 과거 출고 박스의 명목 부피 합으로 보정한 base × (1 + 10%)  — 박스 치수가 아니다 (옷이 눌림)
 *  · 박스당 무게는 25 kg 미만. 넘치면 다음 박스
 *  · 이미 있는 박스(저장분·세션분, 극소/중/대2)는 남은 용량부터 채운다
 *  · 신규 박스는 남은 전체가 들어가는 가장 작은 크기(극소→중→대2), 안 들어가면 대2
 *  · 상품은 수량 많은 것부터 담는다 (찾아 담기 편한 순서)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VirtualPack = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONFIG = {
    overfill: 0.10,                                   // 옷 포장 — 용량의 10% 를 더 담는다
    baseCapL: { '극소': 36, '중': 120, '대2': 280 },  // 10% 가산 전 용량 (명목 부피 합, L) — 과거 꽉 찬 박스의 상위 25~35% 수준
    newSizes: ['극소', '중', '대2'],                  // 신규 박스 후보 (작은 것부터). 소/대는 쓰지 않는다
    maxKg: 25,                                        // 박스당 무게 상한 (이 값 미만)
    defaultUnitL: 2.85,                               // 사이즈 임시값·누락 상품의 1개 부피 (측정 상품 중앙값)
    defaultUnitKg: 0.2,                               // 무게 누락 상품의 1개 무게 (중앙값 200 g)
    placeholder: { w: 300, l: 300, h: 20 },           // 쿠팡 등록 시 넣어 둔 임시 사이즈
    maxBoxNo: 20,                                     // 박스 번호 1~20 (화면 그리드와 동일)
    topUpExisting: true,                              // true = 기존 박스 남은 용량부터 채움 · false = 기존 박스는 그대로 두고 새 박스만
  };

  const EPS = 1e-9;

  function mergeConfig(overrides) {
    const cfg = Object.assign({}, CONFIG, overrides || {});
    cfg.baseCapL = Object.assign({}, CONFIG.baseCapL, (overrides && overrides.baseCapL) || {});
    cfg.placeholder = Object.assign({}, CONFIG.placeholder, (overrides && overrides.placeholder) || {});
    return cfg;
  }

  // 크기별 용량(L) — 10% 가산 포함. 모르는 크기(소/대 등)는 null
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

    // ── 1. 바코드별 단위·목표 ──
    const unitByBc = new Map();
    const items = [];       // 담을 것 [{barcode, productName, location, qty, unitL, unitKg, flag}]
    const excluded = [];    // 제외 [{barcode, productName, reason}]
    let assumedCount = 0;
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
      items.push({ barcode: bc, productName: p.productName || '', location: p.location || '', qty: remain,
        unitL: u.L, unitKg: u.kg, flag: u.flag, capped: alloc > conf });
    }
    // 수량 많은 것부터, 같으면 바코드순
    items.sort((a, b) => (b.qty - a.qty) || String(a.barcode).localeCompare(String(b.barcode), 'ko', { numeric: true }));

    const assumptions = {
      overfill: cfg.overfill, maxKg: cfg.maxKg, defaultUnitL: cfg.defaultUnitL, assumedCount, topUpExisting: !!cfg.topUpExisting,
      cap: Object.fromEntries(cfg.newSizes.map((s) => [s, capL(s, cfg)])),
    };
    const totals = { skus: items.length, qty: items.reduce((s, i) => s + i.qty, 0),
      L: items.reduce((s, i) => s + i.qty * i.unitL, 0), kg: items.reduce((s, i) => s + i.qty * i.unitKg, 0),
      newBoxes: 0, topUpBoxes: 0 };
    const warnings = [];
    if (!items.length) {
      return { ok: false, reason: products.length ? '담을 상품이 없습니다. (출고예정 배정이 없거나 이미 모두 스캔됨)' : '발주서 상품이 없습니다.',
        assumptions, boxes: [], excluded, totals, warnings };
    }

    // ── 2. 기존 박스 (남은 용량 채우기 대상) ──
    const existingNos = [...new Set([...savedBoxes.map((b) => Number(b.boxNo)), ...boxItems.map((i) => Number(i.boxNo))])]
      .filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b);
    const usedNos = new Set(existingNos);
    const boxes = [];
    const skippedExisting = [];
    for (const no of existingNos) {
      if (!cfg.topUpExisting) continue;              // 새 박스만: 기존 박스는 번호만 비켜 가고 채우지 않는다
      const size = sizeOfExisting(no, savedBoxes, input.boxSizeMap);
      const cap = capL(size, cfg);
      let usedL = 0, usedKg = 0, usedQty = 0;
      for (const it of boxItems) {
        if (Number(it.boxNo) !== no) continue;
        const u = unitByBc.get(String(it.barcode)) || unitOf(null, cfg);
        const q = parseInt(it.qty, 10) || 0;
        usedL += q * u.L; usedKg += q * u.kg; usedQty += q;
      }
      if (cap == null) { skippedExisting.push({ boxNo: no, size }); continue; } // 소/대 등 용량 미정 → 채우지 않음
      boxes.push({ boxNo: no, size, isNew: false, cap, usedL0: usedL, usedKg0: usedKg, usedQty0: usedQty,
        usedL, usedKg, items: [], warnings: [] });
    }
    if (skippedExisting.length) warnings.push(`용량 기준이 없는 기존 박스는 채우지 않았습니다: ${skippedExisting.map((b) => `📦${b.boxNo}(${b.size})`).join(', ')}`);
    if (!cfg.topUpExisting && existingNos.length) warnings.push(`기존 박스 ${existingNos.length}개(${existingNos.map((n) => `📦${n}`).join(', ')})는 그대로 두고 새 박스만 썼습니다.`);

    // ── 3. 채우기 ──
    const restL = () => items.reduce((s, i) => s + i.qty * i.unitL, 0);
    const restKg = () => items.reduce((s, i) => s + i.qty * i.unitKg, 0);
    const nextBoxNo = () => { for (let n = 1; n <= cfg.maxBoxNo; n++) if (!usedNos.has(n)) return n; return null; };
    const openNewBox = () => {
      const rL = restL(), rKg = restKg();
      let size = cfg.newSizes[cfg.newSizes.length - 1];
      for (const s of cfg.newSizes) { const c = capL(s, cfg); if (c != null && rL <= c + EPS) { size = s; break; } }
      const no = nextBoxNo();
      if (no == null) return null;
      usedNos.add(no);
      const b = { boxNo: no, size, isNew: true, cap: capL(size, cfg), usedL0: 0, usedKg0: 0, usedQty0: 0,
        usedL: 0, usedKg: 0, items: [], warnings: [] };
      void rKg;
      boxes.push(b);
      return b;
    };
    // 이 박스에 더 담을 수 있는 개수 (부피 ≤ 용량, 무게 < 상한)
    const fitCount = (b, it) => {
      const byL = Math.floor((b.cap - b.usedL) / it.unitL + EPS);
      const byKg = Math.ceil((cfg.maxKg - b.usedKg) / it.unitKg - EPS) - 1;
      return Math.max(0, Math.min(byL, byKg));
    };
    const put = (b, it, n) => {
      const ex = b.items.find((x) => x.barcode === it.barcode);
      if (ex) ex.qty += n;
      else b.items.push({ barcode: it.barcode, productName: it.productName, location: it.location, qty: n, unitL: it.unitL, unitKg: it.unitKg, flag: it.flag });
      b.usedL += n * it.unitL; b.usedKg += n * it.unitKg; it.qty -= n;
    };

    let cursor = 0;                 // boxes[] 의 현재 위치 (기존 박스 → 신규 박스 순)
    let stop = null;
    for (const it of items) {
      while (it.qty > 0) {
        let b = boxes[cursor];
        if (!b) { b = openNewBox(); if (!b) { stop = `박스 번호가 부족합니다 (1~${cfg.maxBoxNo} 모두 사용).`; break; } }
        const n = Math.min(it.qty, fitCount(b, it));
        if (n > 0) { put(b, it, n); continue; }
        // 이 박스에는 1개도 안 들어감
        if (b.isNew && b.usedL === 0 && b.items.length === 0) {
          // 새 박스인데 1개도 못 담는 상품 = 단일 상품이 용량/무게 한도를 넘음 → 1개 강제 + 경고
          put(b, it, 1);
          b.warnings.push(`${it.barcode} 1개가 박스 한도(부피 ${b.cap.toFixed(0)} L · ${cfg.maxKg} kg)를 넘습니다.`);
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
      if (b.usedKg >= cfg.maxKg * 0.9) b.warnings.push(`무게 ${b.usedKg.toFixed(1)} kg — 상한 ${cfg.maxKg} kg 에 근접`);
      if (b.items.some((i) => i.flag)) b.warnings.push(`사이즈 가정 상품 ${b.items.filter((i) => i.flag).length}종 포함`);
    }
    totals.newBoxes = result.filter((b) => b.isNew).length;
    totals.topUpBoxes = result.filter((b) => !b.isNew && b.items.length > 0).length;
    const untouchedExisting = result.filter((b) => !b.isNew && !b.items.length);
    if (untouchedExisting.length) warnings.push(`남은 용량이 없어 그대로 둔 기존 박스: ${untouchedExisting.map((b) => `📦${b.boxNo}`).join(', ')}`);
    if (items.some((i) => i.capped)) warnings.push(`배정량이 확정수량보다 큰 상품 ${items.filter((i) => i.capped).length}종은 확정수량까지만 담았습니다.`);
    if (excluded.some((e) => e.reason === '배정 없음')) warnings.push(`출고예정 배정이 없는 상품 ${excluded.filter((e) => e.reason === '배정 없음').length}종은 제외했습니다.`);

    if (stop) return { ok: false, reason: stop, assumptions, boxes: result, excluded, totals, warnings };
    return { ok: true, reason: null, assumptions, boxes: result, excluded, totals, warnings };
  }

  return { CONFIG, planVirtualScan, capL, unitOf };
}));
