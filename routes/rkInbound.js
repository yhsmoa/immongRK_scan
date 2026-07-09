/**
 * CN입고 도메인 — 입고리스트 (엑셀 원본 적재)
 * 구조: rk_cn_shipments (출고코드 헤더) 1 : N rk_cn_shipment_items (아이템)
 * 파싱 규칙은 기존 importChina 와 동일 (Sheet3 / B열 'BR' 박스만 / A=팔렛 B=박스명 C=중국번호 H=상품명 J=수량 K=바코드)
 */
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const S = require('./rkShared');

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();
const sb = S.supabase;

function toKorean(r) {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    shipmentCode: r.rk_cn_shipments ? r.rk_cn_shipments.shipment_code : null,
    status: r.rk_cn_shipments ? r.rk_cn_shipments.status : null,
    boxName: r.box_name,
    orderNumber: r.order_number,
    productName: r.product_name,
    quantity: r.quantity,
    barcode: r.barcode,
    note: r.note,
  };
}

// 아이템 전체 조회 (헤더 join) — 1000행 우회
async function fetchAllItems() {
  const all = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await sb
      .from('rk_cn_shipment_items')
      .select('*, rk_cn_shipments(shipment_code, status)')
      .order('id', { ascending: true })
      .range(from, from + size - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// 출고코드 목록 (코드별 요약: 아이템 수)
router.get('/api/inbound/shipments', async (req, res) => {
  try {
    const { data: shipments, error } = await sb
      .from('rk_cn_shipments').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const items = await fetchAllItems();
    const countByShip = {};
    for (const it of items) countByShip[it.shipment_id] = (countByShip[it.shipment_id] || 0) + 1;
    res.json(shipments.map(s => ({
      id: s.id, shipmentCode: s.shipment_code, status: s.status, memo: s.memo,
      itemCount: countByShip[s.id] || 0, createdAt: s.created_at, updatedAt: s.updated_at,
    })));
  } catch (e) {
    console.error('[rk] inbound/shipments:', e);
    res.status(500).json({ error: '출고코드 목록을 불러오는데 실패했습니다.' });
  }
});

// 입고리스트 아이템 목록 (전체 또는 특정 출고코드)
router.get('/api/inbound/list', async (req, res) => {
  try {
    let rows = await fetchAllItems();
    const code = (req.query.shipmentCode || '').trim();
    if (code) rows = rows.filter(r => r.rk_cn_shipments && r.rk_cn_shipments.shipment_code === code);
    rows.sort((a, b) =>
      String(a.box_name || '').localeCompare(String(b.box_name || '')) ||
      String(a.barcode || '').localeCompare(String(b.barcode || '')));
    res.json(rows.map(toKorean));
  } catch (e) {
    console.error('[rk] inbound/list:', e);
    res.status(500).json({ error: '입고리스트를 불러오는데 실패했습니다.' });
  }
});

// 엑셀 원본 업로드 (헤더 upsert → 아이템 교체)
router.post('/api/inbound/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 업로드되지 않았습니다.' });
    const shipmentCode = (req.body.shipmentCode || '').trim();
    if (!shipmentCode) return res.status(400).json({ error: '출고코드가 입력되지 않았습니다.' });

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    if (!workbook.SheetNames.includes('Sheet3')) return res.status(400).json({ error: 'Sheet3를 찾을 수 없습니다.' });
    const data = xlsx.utils.sheet_to_json(workbook.Sheets['Sheet3'], { header: 'A' });
    const filtered = data.filter((row) => { const b = row['B']; return b && b.toString().startsWith('BR'); });

    // 1) 출고코드 헤더 upsert → id 확보
    const { data: sh, error: e1 } = await sb
      .from('rk_cn_shipments')
      .upsert({ shipment_code: shipmentCode }, { onConflict: 'shipment_code' })
      .select('id').single();
    if (e1) throw e1;
    const shipmentId = sh.id;

    // 2) 기존 아이템 교체
    const { error: e2 } = await sb.from('rk_cn_shipment_items').delete().eq('shipment_id', shipmentId);
    if (e2) throw e2;

    const rows = filtered.map((row) => ({
      shipment_id: shipmentId,
      pallet: row['A'] != null ? String(row['A']) : null,
      box_name: row['B'] != null ? String(row['B']) : null,
      order_number: row['C'] != null ? String(row['C']) : null,
      product_name: row['H'] != null ? String(row['H']) : null,
      quantity: row['J'] != null ? String(row['J']) : '0',
      barcode: row['K'] != null ? String(row['K']) : null,
      note: null,
    }));

    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await sb.from('rk_cn_shipment_items').insert(rows.slice(i, i + BATCH));
      if (error) throw error;
    }

    res.json({ message: `업로드 완료 (${rows.length}건)`, count: rows.length, shipmentId });
  } catch (e) {
    console.error('[rk] inbound/upload:', e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 비고 수정 (아이템 id 기준)
router.post('/api/inbound/update-note', async (req, res) => {
  try {
    const { id, note } = req.body;
    if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
    const { error } = await sb.from('rk_cn_shipment_items').update({ note: note ?? null }).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('[rk] inbound/update-note:', e);
    res.status(500).json({ error: '비고 저장 중 오류가 발생했습니다.' });
  }
});

// 아이템 + 배정(alloc)으로 { shipping(출고리스트), stock(남은상품) } 구성
function buildArranged(items, allocs) {
  const byItem = new Map();
  for (const a of allocs) {
    if (!byItem.has(a.shipment_item_id)) byItem.set(a.shipment_item_id, []);
    byItem.get(a.shipment_item_id).push(a);
  }
  const shipping = [], stock = [];
  for (const it of items) {
    const base = {
      출고코드: it.rk_cn_shipments ? it.rk_cn_shipments.shipment_code : null,
      박스명: it.box_name, 중국번호: it.order_number, 상품명: it.product_name, 바코드: it.barcode,
    };
    const total = parseInt(it.quantity) || 0;
    const list = byItem.get(it.id) || [];
    let allocated = 0;
    for (const a of list) {
      shipping.push({ ...base, 수량: total, 출고번호: a.order_number, 센터: a.center, 출고개수: a.ship_qty, 출고예정일: a.shipping_date || '' });
      allocated += a.ship_qty || 0;
    }
    const leftover = total - allocated;
    if (leftover > 0) stock.push({ ...base, 수량: leftover });
  }
  return { shipping, stock };
}

// 저장된 출고배정 조회 → { shipping, stock }
router.get('/api/inbound/arranged', async (req, res) => {
  try {
    const shipmentCode = (req.query.shipmentCode || '').trim();
    let items = await fetchAllItems();
    if (shipmentCode) items = items.filter(i => i.rk_cn_shipments && i.rk_cn_shipments.shipment_code === shipmentCode);
    const itemIds = new Set(items.map(i => i.id));
    const { data: allocs, error } = await sb.from('rk_cn_shipping').select('*');
    if (error) throw error;
    res.json(buildArranged(items, (allocs || []).filter(a => itemIds.has(a.shipment_item_id))));
  } catch (e) {
    console.error('[rk] inbound/arranged:', e);
    res.status(500).json({ error: '출고배정 조회 중 오류가 발생했습니다: ' + e.message });
  }
});

// 출고준비: 선택 발주서 기준으로 아이템을 배정 → rk_cn_shipping 에 저장 후 { shipping, stock } 반환
// importChina organize 논리 이식: (확정-스캔-입고1-입고2 - 기존배정) 필요분에 입고예정일 FIFO 배분.
router.post('/api/inbound/prepare', async (req, res) => {
  try {
    const shipmentCode = (req.body.shipmentCode || '').trim();
    const orderNumbers = Array.isArray(req.body.orderNumbers) ? req.body.orderNumbers : null;

    // 대상 아이템
    let items = await fetchAllItems();
    if (shipmentCode) items = items.filter(i => i.rk_cn_shipments && i.rk_cn_shipments.shipment_code === shipmentCode);
    const targetShipmentIds = [...new Set(items.map(i => i.shipment_id))];

    // 대상 출고코드의 기존 배정 삭제 (재계산)
    if (targetShipmentIds.length) {
      const { error } = await sb.from('rk_cn_shipping').delete().in('shipment_id', targetShipmentIds);
      if (error) throw error;
    }

    // 남은(다른 출고코드) 배정을 발주별 소진량으로 반영
    const { data: existing, error: eEx } = await sb.from('rk_cn_shipping').select('*');
    if (eEx) throw eEx;
    const existingMap = new Map(); // barcode -> Map(order -> qty)
    for (const e of (existing || [])) {
      if (!existingMap.has(e.barcode)) existingMap.set(e.barcode, new Map());
      const m = existingMap.get(e.barcode);
      m.set(e.order_number, (m.get(e.order_number) || 0) + (e.ship_qty || 0));
    }

    // 발주서 (선택된 것만)
    let orders = await S.listOrdersFull('rk_orders', 'rk_order_items');
    if (orderNumbers && orderNumbers.length) orders = orders.filter(o => orderNumbers.includes(o.발주번호));

    const barcodesInItems = new Set(items.map(i => i.barcode).filter(Boolean));
    const orderProductMap = new Map(); // barcode -> [{order, availableQuantity}]
    for (const order of orders) {
      for (const p of (order.상품정보 || [])) {
        if (!p.상품바코드 || p.박스정보) continue;
        if (!barcodesInItems.has(p.상품바코드)) continue;
        const 스캔 = parseInt(p.스캔수량) || 0;
        const already = existingMap.has(p.상품바코드) && existingMap.get(p.상품바코드).has(order.발주번호)
          ? existingMap.get(p.상품바코드).get(order.발주번호) : 0;
        // 가용 = 확정 - 스캔 - (다른 출고코드 기존배정). 입고1/입고2 는 차감하지 않음.
        const avail = (parseInt(p.확정수량) || 0) - 스캔 - already;
        if (avail > 0) {
          if (!orderProductMap.has(p.상품바코드)) orderProductMap.set(p.상품바코드, []);
          orderProductMap.get(p.상품바코드).push({
            order: { 발주번호: order.발주번호, 물류센터: order.물류센터, 입고예정일: order.입고예정일 },
            availableQuantity: avail,
          });
        }
      }
    }

    // 배정
    const allocRows = [];
    for (const it of items) {
      let remaining = parseInt(it.quantity) || 0;
      const entries = (orderProductMap.get(it.barcode) || []).slice()
        .sort((a, b) => String(a.order.입고예정일 || '').localeCompare(String(b.order.입고예정일 || '')));
      for (const entry of entries) {
        if (remaining <= 0) break;
        const assign = Math.min(remaining, entry.availableQuantity);
        if (assign > 0) {
          allocRows.push({
            shipment_item_id: it.id, shipment_id: it.shipment_id, barcode: it.barcode,
            order_number: entry.order.발주번호, center: entry.order.물류센터, ship_qty: assign, shipping_date: entry.order.입고예정일 || '',
          });
          entry.availableQuantity -= assign;
          remaining -= assign;
        }
      }
    }

    // 저장
    if (allocRows.length) {
      const BATCH = 1000;
      for (let i = 0; i < allocRows.length; i += BATCH) {
        const { error } = await sb.from('rk_cn_shipping').insert(allocRows.slice(i, i + BATCH));
        if (error) throw error;
      }
    }

    const result = buildArranged(items, allocRows);
    res.json({ ...result, saved: allocRows.length });
  } catch (e) {
    console.error('[rk] inbound/prepare:', e);
    res.status(500).json({ error: '출고준비 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 출고코드 단위 삭제 (헤더 삭제 → 아이템 cascade)
router.delete('/api/inbound/delete/:shipmentCode', async (req, res) => {
  try {
    const { error } = await sb.from('rk_cn_shipments').delete().eq('shipment_code', req.params.shipmentCode);
    if (error) throw error;
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error('[rk] inbound/delete:', e);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

module.exports = router;
