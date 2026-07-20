/**
 * 재사용 숫자패드 모달 컴포넌트 (터치 입력용)
 * 사용: <script src="/numpad.js"></script> 후
 *   NumPad.open({ title:'개수 수정 · <b>A-01</b>', value:5, min:0, onConfirm:(n)=>{...} })
 * - 열릴 때 기존값(value)이 표시되지만, 첫 '숫자' 버튼을 누르면 기존값이 자동 초기화됨
 */
(function () {
  const css = `
  .np-back{position:fixed;inset:0;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;z-index:11000;}
  .np-back.show{display:flex;}
  .np{background:#fff;border-radius:16px;padding:18px;width:300px;max-width:92vw;box-shadow:0 20px 50px rgba(15,23,42,.3);}
  .np-title{font-size:13px;color:#94a3b8;margin:0 0 4px;}
  .np-title b{color:#1e293b;}
  .np-display{height:58px;border:2px solid #e5e9f0;border-radius:12px;display:flex;align-items:center;justify-content:flex-end;padding:0 16px;font-size:28px;font-weight:800;color:#0f172a;margin-bottom:12px;font-variant-numeric:tabular-nums;}
  .np-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
  .np-grid button{height:56px;border:1px solid #e2e8f0;background:#fff;border-radius:12px;font-size:22px;font-weight:700;color:#1e293b;cursor:pointer;}
  .np-grid button:hover{background:#f8faff;border-color:#c7d2fe;}
  .np-grid button.fn{font-size:18px;color:#64748b;background:#f8fafc;}
  .np-btns{display:flex;gap:8px;margin-top:12px;}
  .np-btns button{flex:1;height:46px;border-radius:9px;border:1px solid #e2e8f0;background:#fff;font-size:14px;font-weight:600;color:#334155;cursor:pointer;}
  .np-btns .np-ok{background:#4f46e5;color:#fff;border-color:#4f46e5;}
  `;
  function init() {
    if (window.NumPad) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const back = document.createElement('div'); back.className = 'np-back';
    back.innerHTML = `<div class="np">
      <p class="np-title" id="__npTitle"></p>
      <div class="np-display" id="__npDisplay">0</div>
      <div class="np-grid">
        <button data-d="1">1</button><button data-d="2">2</button><button data-d="3">3</button>
        <button data-d="4">4</button><button data-d="5">5</button><button data-d="6">6</button>
        <button data-d="7">7</button><button data-d="8">8</button><button data-d="9">9</button>
        <button class="fn" data-d="C">C</button><button data-d="0">0</button><button class="fn" data-d="back">←</button>
      </div>
      <div class="np-btns"><button class="np-cancel">취소</button><button class="np-ok">확인</button></div>
    </div>`;
    document.body.appendChild(back);
    const disp = back.querySelector('#__npDisplay');
    const titleEl = back.querySelector('#__npTitle');
    const np = back.querySelector('.np');
    let val = '', fresh = false, min = 1, max = null, onConfirm = null;
    const upd = () => { disp.textContent = val || '0'; };
    function tap(d) {
      if (d === 'C') { val = ''; fresh = false; upd(); return; }
      if (d === 'back') { fresh = false; val = val.slice(0, -1); upd(); return; }
      if (fresh) { val = ''; fresh = false; }           // 첫 숫자 입력 → 기존값 초기화
      val = (val + d).replace(/^0+(?=\d)/, '').slice(0, 6);
      if (max != null && parseInt(val, 10) > max) val = String(max); // 상한 초과 시 상한으로 고정
      upd();
    }
    back.querySelectorAll('.np-grid button').forEach(b => b.onclick = () => tap(b.dataset.d));
    function close() { back.classList.remove('show'); onConfirm = null; }
    back.querySelector('.np-cancel').onclick = close;
    np.onclick = e => e.stopPropagation();
    back.onclick = close; // 배경 클릭 닫기
    back.querySelector('.np-ok').onclick = () => {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < min) { return; }
      const cb = onConfirm; close(); if (cb) cb(n);
    };
    window.NumPad = {
      open(opts) {
        opts = opts || {};
        val = (opts.value != null ? String(opts.value) : '');
        fresh = true;                                    // 기존값 표시 + 첫 숫자에 초기화
        min = (opts.min != null ? opts.min : 1);
        max = (opts.max != null ? opts.max : null);
        onConfirm = opts.onConfirm || null;
        titleEl.innerHTML = opts.title || '수량 입력';
        upd();
        back.classList.add('show');
      }
    };
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
