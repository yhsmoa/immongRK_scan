/**
 * 통합 배정 계산기 — 신규 발주서 가상버전(/newOrderV) [배정] 모달 (설계: docs/plan-neworder-virtual.md §4)
 *
 * 순수 함수 (DOM·네트워크 없음). 브라우저에서는 window.AllocPlan, node 에서는 require 로 쓴다.
 *   const plan = AllocPlan.planAllocation({ orders, reservedByKey, scannedByKey, stockPool, inboundPool, sourceOrder });
 *
 * 핵심 규칙
 *  · 필요(needed) = 확정수량 − max(기존 예약(재고+입고 출고예정), 출고스캔 합)   ※ 더하지 않는다 (예약된 물건이 스캔되면 양쪽에 잡힌다)
 *  · 발주서 순서 = 입고예정일 오름차순 → 발주번호. 같은 바코드는 발주서들이 풀을 공유한다 (먼저 온 발주서가 먼저 가져감)
 *  · 출처 순서(sourceOrder) = 화면에서 고른 ['입고','재고'] 또는 ['재고','입고'] (고른 출처만). 앞 출처로 채우고 모자라면 다음 출처
 *  · 입고 풀: 남은 = 원본 − 출고배정 − 재고확정 (서버가 계산해 remain 으로 넘긴다).
 *      입고코드 오래된 순(codeRank) → 그 코드 안에서 "혼자 다 채울 수 있는 박스" 중 팔렛·박스명 순 첫 번째,
 *      없으면 많이 남은 박스부터 (분할 최소) → 다음 코드
 *  · 재고 풀(동선): 혼자 다 채울 수 있는 위치 우선 → 이 발주서가 이미 쓴 구역 우선 → 위치 오름차순.
 *      한 곳에서 못 채우면 많이 있는 위치부터 (분할 최소, 같으면 구역 우선 → 위치순)
 *      구역 = 위치에서 끝 숫자를 뗀 앞부분 ("305B34" → "305B", "26여름15" → "26여름")
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AllocPlan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOURCES = ['입고', '재고'];
  const cmpKo = (a, b) => String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), 'ko', { numeric: true });
  const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  const key = (orderNumber, barcode) => `${orderNumber}|${barcode}`;
  const getK = (m, k) => (m == null ? 0 : (typeof m.get === 'function' ? toInt(m.get(k)) : toInt(m[k])));

  // 구역 — 위치 끝의 숫자(칸 번호)를 뗀 앞부분. 숫자로만 된 위치는 그대로
  function zoneOf(location) {
    const s = String(location || '').trim();
    const z = s.replace(/\d+$/, '');
    return z || s;
  }

  // 표시용: 배정 1건 → "305B34" / "1018-BR5" (수량 없이)
  function allocPlace(a) {
    if (!a) return '';
    if (a.source === '입고') return `${a.code || '?'}-${a.boxName || '?'}`;
    return String(a.location || '');
  }
  // 표시용: 배정 목록 → { short:"305B34-3 외 2건", lines:["305B34 ×3", "1018-BR5 ×4"] }
  //   하나면 short 에 수량을 붙이지 않는다 (기존 신규발주서 위치 표시와 같은 규칙: 단일 "LO-A" · 분할 "LO-A-2")
  function allocSummary(allocs) {
    const list = (allocs || []).filter((a) => a && toInt(a.qty) > 0);
    if (!list.length) return { short: '', lines: [], count: 0 };
    const lines = list.map((a) => `${allocPlace(a)} ×${toInt(a.qty)}`);
    const first = list.length === 1 ? allocPlace(list[0]) : `${allocPlace(list[0])}-${toInt(list[0].qty)}`;
    return { short: list.length > 1 ? `${first} 외 ${list.length - 1}건` : first, lines, count: list.length };
  }

  /**
   * @param {object} input
   *   orders       : [{ orderNumber, center, shippingDate, rows:[{ barcode, productName, confirmedQty }] }]
   *   reservedByKey: Map|object "발주번호|바코드" → 출고예정 배정 합 (재고+입고)
   *   scannedByKey : Map|object "발주번호|바코드" → 출고스캔 합
   *   stockPool    : [{ stockId, barcode, location, qty }]         — qty = 지금 rk_stocks 수량 (>0 만 의미 있음)
   *   inboundPool  : [{ shipmentId, shipmentItemId, code, codeRank, barcode, pallet, boxName, remain }]
   *   sourceOrder  : ['입고','재고'] | ['재고','입고'] | ['입고'] | ['재고']
   *   zonesByOrder : (선택) Map|object 발주번호 → [이미 저장된 재고 배정의 위치…] — 동선 구역 우선에 같이 쓴다
   */
  function planAllocation(input) {
    const orders = Array.isArray(input.orders) ? input.orders : [];
    const sourceOrder = (Array.isArray(input.sourceOrder) ? input.sourceOrder : []).filter((s, i, a) => SOURCES.includes(s) && a.indexOf(s) === i);
    if (!sourceOrder.length) return { ok: false, reason: '출처(재고/입고)를 하나 이상 고르세요.', rows: [], summary: emptySummary(), excluded: [] };

    // 풀 복사 (입력을 바꾸지 않는다)
    const stockByBc = new Map();
    for (const s of (input.stockPool || [])) {
      const bc = String(s.barcode || '').trim(), loc = String(s.location || '').trim();
      const avail = toInt(s.qty);
      if (!bc || !loc || loc === '-' || avail <= 0) continue;
      if (!stockByBc.has(bc)) stockByBc.set(bc, []);
      stockByBc.get(bc).push({ stockId: s.stockId, location: loc, zone: zoneOf(loc), avail });
    }
    for (const list of stockByBc.values()) list.sort((a, b) => cmpKo(a.location, b.location) || (toInt(a.stockId) - toInt(b.stockId)));

    const inbByBc = new Map();
    for (const it of (input.inboundPool || [])) {
      const bc = String(it.barcode || '').trim();
      const remain = toInt(it.remain);
      if (!bc || remain <= 0) continue;
      if (!inbByBc.has(bc)) inbByBc.set(bc, []);
      inbByBc.get(bc).push({ shipmentId: it.shipmentId, shipmentItemId: it.shipmentItemId, code: it.code == null ? '' : String(it.code),
        codeRank: Number.isFinite(Number(it.codeRank)) ? Number(it.codeRank) : 0, pallet: it.pallet || '', boxName: it.boxName || '', avail: remain });
    }
    const inbBoxCmp = (a, b) => cmpKo(a.pallet, b.pallet) || cmpKo(a.boxName, b.boxName) || (toInt(a.shipmentItemId) - toInt(b.shipmentItemId));
    for (const list of inbByBc.values()) list.sort((a, b) => (a.codeRank - b.codeRank) || cmpKo(a.code, b.code) || inbBoxCmp(a, b));

    const zonesFor = (no) => {
      const z = input.zonesByOrder;
      const v = z == null ? null : (typeof z.get === 'function' ? z.get(no) : z[no]);
      return new Set((Array.isArray(v) ? v : []).map(zoneOf).filter(Boolean));
    };

    // 재고에서 need 만큼 — 동선 규칙
    function takeStock(bc, need, zones) {
      const out = [];
      const pool = (stockByBc.get(bc) || []).filter((p) => p.avail > 0);
      if (!pool.length || need <= 0) return out;
      const zoneRank = (p) => (zones.has(p.zone) ? 0 : 1);
      const whole = pool.filter((p) => p.avail >= need).sort((a, b) => (zoneRank(a) - zoneRank(b)) || cmpKo(a.location, b.location));
      if (whole.length) {
        const p = whole[0];
        p.avail -= need; zones.add(p.zone);
        out.push({ source: '재고', stockId: p.stockId, location: p.location, qty: need });
        return out;
      }
      const order = pool.slice().sort((a, b) => (b.avail - a.avail) || (zoneRank(a) - zoneRank(b)) || cmpKo(a.location, b.location));
      let left = need;
      for (const p of order) {
        if (left <= 0) break;
        const t = Math.min(left, p.avail);
        if (t <= 0) continue;
        p.avail -= t; left -= t; zones.add(p.zone);
        out.push({ source: '재고', stockId: p.stockId, location: p.location, qty: t });
      }
      return out;
    }

    // 입고에서 need 만큼 — 오래된 코드부터, 코드 안에서는 혼자 채우는 박스 → 많이 남은 박스
    function takeInbound(bc, need) {
      const out = [];
      const pool = (inbByBc.get(bc) || []).filter((p) => p.avail > 0);
      if (!pool.length || need <= 0) return out;
      const codes = [];
      for (const p of pool) if (!codes.some((c) => c.code === p.code)) codes.push({ code: p.code, rank: p.codeRank });
      codes.sort((a, b) => (a.rank - b.rank) || cmpKo(a.code, b.code));
      let left = need;
      for (const c of codes) {
        if (left <= 0) break;
        const inCode = pool.filter((p) => p.code === c.code && p.avail > 0);
        const whole = inCode.find((p) => p.avail >= left);   // pool 이 팔렛·박스명 순이라 첫 번째가 그 순서상 첫 박스
        const seq = whole ? [whole] : inCode.slice().sort((a, b) => (b.avail - a.avail) || inbBoxCmp(a, b));
        for (const p of seq) {
          if (left <= 0) break;
          const t = Math.min(left, p.avail);
          if (t <= 0) continue;
          p.avail -= t; left -= t;
          out.push({ source: '입고', shipmentId: p.shipmentId, shipmentItemId: p.shipmentItemId, code: p.code, boxName: p.boxName, pallet: p.pallet, qty: t });
        }
      }
      return out;
    }

    const sortedOrders = orders.map((o, i) => ({ o, i })).sort((a, b) =>
      cmpKo(a.o.shippingDate || '99999999', b.o.shippingDate || '99999999') || cmpKo(a.o.orderNumber, b.o.orderNumber) || (a.i - b.i)).map((x) => x.o);

    const rows = [];
    for (const o of sortedOrders) {
      const no = String(o.orderNumber || '').trim();
      const zones = zonesFor(no);
      for (const r of (o.rows || [])) {
        const bc = String(r.barcode || '').trim();
        if (!bc) continue;
        const k = key(no, bc);
        const confirmedQty = Math.max(0, toInt(r.confirmedQty));
        const reserved = Math.max(0, getK(input.reservedByKey, k));
        const scanned = Math.max(0, getK(input.scannedByKey, k));
        const needed = Math.max(0, confirmedQty - Math.max(reserved, scanned));
        const row = { orderNumber: no, center: o.center || '', shippingDate: o.shippingDate || '', barcode: bc, productName: r.productName || '',
          confirmedQty, reserved, scanned, needed, allocs: [], stockQty: 0, inboundQty: 0, shortage: 0, reason: null };
        if (needed <= 0) {
          row.reason = confirmedQty <= 0 ? '확정 0' : (reserved >= scanned ? '이미 배정' : '이미 스캔');
          rows.push(row);
          continue;
        }
        let left = needed;
        for (const src of sourceOrder) {
          if (left <= 0) break;
          const got = src === '재고' ? takeStock(bc, left, zones) : takeInbound(bc, left);
          for (const a of got) { row.allocs.push(a); left -= a.qty; if (a.source === '재고') row.stockQty += a.qty; else row.inboundQty += a.qty; }
        }
        row.shortage = left;
        if (left > 0) row.reason = row.allocs.length ? '일부 부족' : '재고·입고 없음';
        rows.push(row);
      }
    }

    const summary = emptySummary();
    summary.orders = new Set(rows.map((r) => r.orderNumber)).size;
    for (const r of rows) {
      summary.rows++;
      summary.needed += r.needed;
      summary.stock += r.stockQty;
      summary.inbound += r.inboundQty;
      summary.shortage += r.shortage;
      if (r.allocs.length) summary.allocRows++;
    }
    return { ok: true, reason: null, sourceOrder, rows, summary };
  }
  function emptySummary() { return { orders: 0, rows: 0, allocRows: 0, needed: 0, stock: 0, inbound: 0, shortage: 0 }; }

  // 입고 아이템 남은 수량 = 원본 − 출고배정 − 재고확정 (재고정리 화면 /api/inbound/stock-arranges 와 같은 공식)
  function inboundRemain(quantity, shipped, arranged) {
    return toInt(quantity) - toInt(shipped) - toInt(arranged);
  }

  return { SOURCES, planAllocation, zoneOf, allocPlace, allocSummary, inboundRemain };
}));
