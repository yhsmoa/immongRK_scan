-- ============================================================
-- 와우출고 — 위해 창고 배정 · 위해 박스 (docs/plan-wow.md §4-1) · 2026-11-18
-- immong-rocket 에 사용자가 SQL Editor 로 실행한다. 다시 실행해도 안전하다.
--
-- 1) rk_shipping_list.source 에 '위해' — 위해 창고 배정 행 (재고 차감 없음, 구매 DB 예약은 routes/rkWow.js 가 맞춘다)
--    발주번호+바코드당 1행(부분 unique) — 늘리면 qty 를 더하고, 줄이면 그 행을 줄인다
-- 2) rk_ship_boxes.origin : '위해' = 중국에서 바로 출고하는 박스 (한국 박스와 섞지 않는다), null = 한국 박스
-- 3) rk_allocate_save(jsonb) : p->'weihai' = [{orderNumber, center, shippingDate, barcode, productName, qty}] 를 더 받는다.
--      확정수량 한도는 기존 검증이 모든 source 를 센다. 반환 weihai = 이번에 더한 수량 (연결 오류 때 되돌리기용)
-- ============================================================

-- 1) source check — 처음 만들 때 인라인 check 라 이름이 정해져 있지 않을 수 있다 → source 값 목록을 보는 check 만 지우고 다시 만든다
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.rk_shipping_list'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%source = any%'
  loop
    execute format('alter table public.rk_shipping_list drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.rk_shipping_list
  add constraint rk_shipping_list_source_check check (source in ('입고', '재고', '위해'));
create unique index if not exists rk_shipping_list_weihai_uq
  on public.rk_shipping_list (order_number, barcode) where source = '위해' and status = '출고예정';

-- 2) 위해 박스 표시
alter table public.rk_ship_boxes add column if not exists origin text;
alter table public.rk_ship_boxes drop constraint if exists rk_ship_boxes_origin_check;
alter table public.rk_ship_boxes add constraint rk_ship_boxes_origin_check check (origin is null or origin = '위해');
create index if not exists rk_ship_boxes_origin_idx on public.rk_ship_boxes (order_number) where origin is not null;

-- 3) 통합 배정 저장 — rk_allocate.sql 의 정의 + 위해
create or replace function public.rk_allocate_save(p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_now        timestamptz := now();
  v_note       text := coalesce(nullif(p->>'note', ''), '가상버전 배정');
  r            record;
  r2           record;
  v_cnt        int;
  v_batch_stk  int := null;
  v_batch      int;
  v_cn_id      bigint;
  v_saved_stk  int := 0;
  v_saved_inb  int := 0;
  v_batch_by_code jsonb := '{}'::jsonb;
  v_weihai     jsonb := '[]'::jsonb;
begin
  -- 입력 펼치기
  drop table if exists _a;
  create temp table _a (
    src text, order_number text, center text, shipping_date text, barcode text, product_name text,
    stock_id bigint, location text, shipment_id bigint, shipment_item_id bigint, qty int
  ) on commit drop;

  -- 발주번호·바코드는 넣을 때부터 trim (Supabase API 세션은 safeupdate 가 켜져 있어 WHERE 없는 UPDATE 가 거부된다)
  insert into _a
  select '재고', trim(x->>'orderNumber'), x->>'center', x->>'shippingDate', trim(x->>'barcode'), x->>'productName',
         (x->>'stockId')::bigint, x->>'location', null, null, (x->>'qty')::int
    from jsonb_array_elements(coalesce(p->'stock', '[]'::jsonb)) x;
  insert into _a
  select '입고', trim(x->>'orderNumber'), x->>'center', x->>'shippingDate', trim(x->>'barcode'), x->>'productName',
         null, null, (x->>'shipmentId')::bigint, (x->>'shipmentItemId')::bigint, (x->>'qty')::int
    from jsonb_array_elements(coalesce(p->'inbound', '[]'::jsonb)) x;
  insert into _a
  select '위해', trim(x->>'orderNumber'), x->>'center', x->>'shippingDate', trim(x->>'barcode'), x->>'productName',
         null, null, null, null, (x->>'qty')::int
    from jsonb_array_elements(coalesce(p->'weihai', '[]'::jsonb)) x;

  if exists (select 1 from _a where coalesce(qty, 0) <= 0 or coalesce(order_number, '') = '' or coalesce(barcode, '') = '') then
    raise exception 'ALLOC:수량·발주번호·바코드가 비어 있는 배정이 있습니다.';
  end if;
  if exists (select 1 from _a where src = '재고' and stock_id is null) or exists (select 1 from _a where src = '입고' and shipment_item_id is null) then
    raise exception 'ALLOC:재고 위치(stockId) 또는 입고 아이템(shipmentItemId)이 없는 배정이 있습니다.';
  end if;
  select count(*) into v_cnt from _a;
  if v_cnt = 0 then
    return jsonb_build_object('savedStock', 0, 'savedInbound', 0, 'batchStock', null, 'batchByCode', '{}'::jsonb, 'weihai', '[]'::jsonb);
  end if;

  -- 발주서 단위 잠금 (같은 발주서를 동시에 저장하면 한쪽은 기다렸다가 아래 재검증을 받는다)
  for r in select distinct order_number from _a order by order_number loop
    perform pg_advisory_xact_lock(hashtext('rk_alloc:' || r.order_number));
  end loop;

  -- 발주서 존재·처리완료
  for r in select distinct a.order_number, o.id, o.status from _a a left join rk_orders o on o.order_number = a.order_number loop
    if r.id is null then raise exception 'ALLOC:등록되지 않은 발주서입니다: %', r.order_number; end if;
    if r.status = 'DONE' then raise exception 'ALLOC:처리완료된 발주서입니다: %', r.order_number; end if;
  end loop;

  -- 발주번호+바코드 확정수량 한도
  for r in
    with want as (select order_number, barcode, sum(qty) q from _a group by 1, 2),
    conf as (
      select o.order_number, i.barcode, sum(coalesce(i.confirmed_qty, 0)) q
        from rk_orders o join rk_order_items i on i.order_id = o.id
       where i.box_info is null and o.order_number in (select order_number from want)
       group by 1, 2),
    resv as (
      select order_number, barcode, sum(qty) q from rk_shipping_list
       where status = '출고예정' and order_number in (select order_number from want) group by 1, 2),
    scan as (
      select order_number, barcode, sum(qty) q from rk_ship_box_items
       where order_number in (select order_number from want) group by 1, 2)
    select w.order_number, w.barcode, w.q want_q, coalesce(c.q, 0) conf_q, coalesce(rv.q, 0) resv_q, coalesce(s.q, 0) scan_q
      from want w
      left join conf c on c.order_number = w.order_number and c.barcode = w.barcode
      left join resv rv on rv.order_number = w.order_number and rv.barcode = w.barcode
      left join scan s on s.order_number = w.order_number and s.barcode = w.barcode
  loop
    if r.conf_q <= 0 then raise exception 'ALLOC:발주서 %에 없는 바코드입니다: %', r.order_number, r.barcode; end if;
    if r.want_q + greatest(r.resv_q, r.scan_q) > r.conf_q then
      raise exception 'ALLOC:확정수량 초과 — % / % : 확정 %, 기존 배정·스캔 %, 새 배정 %. 다시 계산하세요.',
        r.order_number, r.barcode, r.conf_q, greatest(r.resv_q, r.scan_q), r.want_q;
    end if;
  end loop;

  -- ── 재고 ──
  if exists (select 1 from _a where src = '재고') then
    perform 1 from rk_stocks where id in (select stock_id from _a where src = '재고') order by id for update;
    for r in
      select s.id, s.barcode, s.location, s.qty cur, t.take, t.bc, t.loc
        from (select stock_id, sum(qty) take, min(barcode) bc, min(location) loc from _a where src = '재고' group by stock_id) t
        left join rk_stocks s on s.id = t.stock_id
       order by t.stock_id
    loop
      if r.id is null then raise exception 'ALLOC:재고 위치가 사라졌습니다 (%). 다시 계산하세요.', r.loc; end if;
      if r.barcode is distinct from r.bc then raise exception 'ALLOC:재고 위치 %의 바코드가 다릅니다. 다시 계산하세요.', r.location; end if;
      if coalesce(r.cur, 0) < r.take then
        raise exception 'ALLOC:재고 부족 — % / % : 있음 %, 필요 %. 다시 계산하세요.', r.bc, r.location, coalesce(r.cur, 0), r.take;
      end if;
    end loop;

    select coalesce(max(batch_no), 0) + 1 into v_batch_stk from rk_shipping_list where source = '재고' and batch_no is not null;

    insert into rk_shipping_list (source, status, barcode, product_name, order_number, center, shipping_date, qty, location, stock_id, batch_no, prepared_at)
    select '재고', '출고예정', a.barcode, nullif(a.product_name, ''), a.order_number, nullif(a.center, ''), nullif(a.shipping_date, ''),
           a.qty, s.location, a.stock_id, v_batch_stk, v_now
      from _a a join rk_stocks s on s.id = a.stock_id
     where a.src = '재고';
    get diagnostics v_saved_stk = row_count;

    insert into rk_stock_histories (stock_id, sku_id, barcode, location, change_type, qty, qty_before, qty_after, note)
    select s.id, s.sku_id, s.barcode, s.location, 'deduct', t.take, coalesce(s.qty, 0), coalesce(s.qty, 0) - t.take, v_note
      from (select stock_id, sum(qty) take from _a where src = '재고' group by stock_id) t join rk_stocks s on s.id = t.stock_id;

    update rk_stocks s set qty = coalesce(s.qty, 0) - t.take
      from (select stock_id, sum(qty) take from _a where src = '재고' group by stock_id) t
     where s.id = t.stock_id;
  end if;

  -- ── 입고 ──
  if exists (select 1 from _a where src = '입고') then
    perform 1 from rk_cn_shipment_items where id in (select shipment_item_id from _a where src = '입고') order by id for update;
    for r in
      select it.id, it.barcode, it.shipment_id, t.take, t.bc, t.sid,
             coalesce(substring(trim(it.quantity) from '^-?\d+')::int, 0)
               - coalesce((select sum(ship_qty) from rk_cn_shipping c where c.shipment_item_id = it.id), 0)
               - coalesce((select sum(qty) from rk_cn_stock_arranges sa where sa.shipment_item_id = it.id), 0) remain
        from (select shipment_item_id, sum(qty) take, min(barcode) bc, min(shipment_id) sid from _a where src = '입고' group by shipment_item_id) t
        left join rk_cn_shipment_items it on it.id = t.shipment_item_id
       order by t.shipment_item_id
    loop
      if r.id is null then raise exception 'ALLOC:입고 아이템이 사라졌습니다 (재업로드?). 다시 계산하세요.'; end if;
      if r.barcode is distinct from r.bc then raise exception 'ALLOC:입고 아이템의 바코드가 다릅니다 (%). 다시 계산하세요.', r.bc; end if;
      if r.sid is not null and r.sid <> r.shipment_id then raise exception 'ALLOC:입고 아이템의 입고코드가 다릅니다 (%). 다시 계산하세요.', r.bc; end if;
      if r.remain < r.take then
        raise exception 'ALLOC:입고 남은 수량 부족 — % : 남음 %, 필요 %. 다시 계산하세요.', r.bc, greatest(r.remain, 0), r.take;
      end if;
    end loop;

    for r in
      select it.shipment_id, sh.shipment_code from _a a join rk_cn_shipment_items it on it.id = a.shipment_item_id
        join rk_cn_shipments sh on sh.id = it.shipment_id
       where a.src = '입고' group by 1, 2 order by 1
    loop
      select coalesce(max(batch_no), 0) + 1 into v_batch from rk_cn_shipping where shipment_id = r.shipment_id;
      v_batch_by_code := v_batch_by_code || jsonb_build_object(r.shipment_code, v_batch);
      for r2 in
        select a.*, it.shipment_id sid, it.product_name item_name
          from _a a join rk_cn_shipment_items it on it.id = a.shipment_item_id
         where a.src = '입고' and it.shipment_id = r.shipment_id
         order by a.order_number, a.shipment_item_id
      loop
        insert into rk_cn_shipping (shipment_item_id, shipment_id, barcode, order_number, center, ship_qty, shipping_date, batch_no, prepared_at)
        values (r2.shipment_item_id, r2.sid, r2.barcode, r2.order_number, nullif(r2.center, ''), r2.qty, coalesce(r2.shipping_date, ''), v_batch, v_now)
        returning id into v_cn_id;
        insert into rk_shipping_list (source, status, barcode, product_name, order_number, center, shipping_date, qty,
                                      shipment_id, shipment_item_id, cn_shipping_id, batch_no, prepared_at)
        values ('입고', '출고예정', r2.barcode, coalesce(r2.item_name, nullif(r2.product_name, '')), r2.order_number, nullif(r2.center, ''),
                nullif(r2.shipping_date, ''), r2.qty, r2.sid, r2.shipment_item_id, v_cn_id, v_batch, v_now);
        v_saved_inb := v_saved_inb + 1;
      end loop;
    end loop;
  end if;

  -- ── 위해 창고 ── 재고 차감 없음 (구매 DB 예약은 서버가 저장 뒤에 맞춘다). 발주번호+바코드당 1행에 더한다
  if exists (select 1 from _a where src = '위해') then
    insert into rk_shipping_list (source, status, barcode, product_name, order_number, center, shipping_date, qty, prepared_at)
    select '위해', '출고예정', barcode, nullif(min(product_name), ''), order_number, nullif(min(center), ''), nullif(min(shipping_date), ''), sum(qty), v_now
      from _a where src = '위해' group by order_number, barcode
    on conflict (order_number, barcode) where source = '위해' and status = '출고예정'
    do update set qty = rk_shipping_list.qty + excluded.qty, prepared_at = excluded.prepared_at;
    select coalesce(jsonb_agg(jsonb_build_object('orderNumber', order_number, 'barcode', barcode, 'qty', q) order by order_number, barcode), '[]'::jsonb)
      into v_weihai
      from (select order_number, barcode, sum(qty) q from _a where src = '위해' group by 1, 2) w;
  end if;

  return jsonb_build_object('savedStock', v_saved_stk, 'savedInbound', v_saved_inb, 'batchStock', v_batch_stk,
                            'batchByCode', v_batch_by_code, 'preparedAt', v_now, 'weihai', v_weihai);
end;
$$;
